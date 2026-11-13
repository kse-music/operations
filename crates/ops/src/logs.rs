use super::*;
use serverdeck_core::ops::{LogEvent, LogInput, LogSession};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use tokio::{sync::watch, task::JoinHandle};
pub type LogSink = Arc<dyn Fn(LogEvent) -> bool + Send + Sync>;
pub(crate) struct LogControl {
    pub info: LogSession,
    stop: CancellationToken,
    paused: watch::Sender<bool>,
    ack: watch::Sender<u64>,
    awaiting: AtomicU64,
    task: tokio::sync::Mutex<Option<JoinHandle<Result<(), Error>>>>,
    cleanup_failed: AtomicBool,
}
impl Operations {
    pub fn log_open(&self, id: &str, input: LogInput, sink: LogSink) -> Result<LogSession, Error> {
        let command = input.command()?;
        self.command_stream(id, command, sink)
    }
    pub fn command_stream(
        &self,
        id: &str,
        command: String,
        sink: LogSink,
    ) -> Result<LogSession, Error> {
        // Register before a disconnect takes its drain snapshot, or reject during drain.
        let _opening = self.log_lifecycle.try_read().map_err(|_| Error::Busy)?;
        if command.is_empty() || command.len() > 64 * 1024 || command.contains('\0') {
            return Err(Error::Validation("远程流命令无效"));
        }
        if self.stop.is_cancelled() {
            return Err(Error::ShuttingDown);
        }
        if !self.engine.ops_ready(id)? {
            return Err(error("OPS_NOT_READY", "运维连接尚未就绪"));
        }
        let session = self.engine.session_info(id)?;
        let mut logs = lock(&self.logs)?;
        if logs.len() >= 8 {
            return Err(error(
                "LOG_LIMIT",
                "最多同时打开 8 个日志标签，请关闭不用的标签",
            ));
        }
        let info = LogSession {
            id: uuid::Uuid::new_v4().to_string(),
            session_id: id.into(),
            host_id: session.host_id,
        };
        let (paused, pause) = watch::channel(false);
        let (ack, acknowledged) = watch::channel(0);
        let control = Arc::new(LogControl {
            info: info.clone(),
            stop: CancellationToken::new(),
            paused,
            ack,
            awaiting: AtomicU64::new(0),
            task: tokio::sync::Mutex::new(None),
            cleanup_failed: AtomicBool::new(false),
        });
        logs.insert(info.id.clone(), control.clone());
        let operations = self.clone();
        let running = control.clone();
        let task = tokio::spawn(async move {
            let (result, cleanup) = operations
                .run_log(&running, &command, &sink, pause, acknowledged)
                .await;
            let result = if result.is_ok() && cleanup.is_err() {
                Err(error(
                    "LOG_STOP_UNCONFIRMED",
                    "未收到远端日志命令退出确认，请独立核对远端进程",
                ))
            } else {
                result
            };
            match result {
                Ok(()) => {
                    sink(LogEvent::State {
                        state: "closed",
                        code: None,
                        message: None,
                    });
                }
                Err(e) => {
                    let ipc = IpcError::from(e);
                    tracing::warn!(
                        operation = "log_stream",
                        code = ipc.code,
                        "log stream failed; content not logged"
                    );
                    sink(LogEvent::State {
                        state: "failed",
                        code: Some(ipc.code),
                        message: Some(ipc.message),
                    });
                }
            }
            cleanup
        });
        *control.task.try_lock().map_err(|_| Error::Busy)? = Some(task);
        Ok(info)
    }
    pub fn log_pause(&self, id: &str, paused: bool) -> Result<(), Error> {
        let control = lock(&self.logs)?.get(id).cloned().ok_or(Error::NotFound)?;
        control.paused.send_if_modified(|p| {
            let changed = *p != paused;
            *p = paused;
            changed
        });
        Ok(())
    }
    pub fn log_ack(&self, id: &str, sequence: u64) -> Result<(), Error> {
        let control = lock(&self.logs)?.get(id).cloned().ok_or(Error::NotFound)?;
        if sequence == 0 || sequence > control.awaiting.load(Ordering::Acquire) {
            return Err(Error::Validation("日志 ACK 序号无效"));
        }
        control.ack.send_if_modified(|last| {
            if sequence > *last {
                *last = sequence;
                true
            } else {
                false
            }
        });
        Ok(())
    }
    pub async fn log_close(&self, id: &str) -> Result<(), Error> {
        let control = lock(&self.logs)?.get(id).cloned();
        if let Some(control) = control {
            control.stop.cancel();
            // Concurrent window/host/app closes must all wait for the same cleanup.
            // Keep the JoinHandle here across cancellation of a close caller.
            let mut running = control.task.lock().await;
            if let Some(task) = running.as_mut() {
                let result = task
                    .await
                    .map_err(|e| Error::Worker(Box::new(e)))
                    .and_then(|result| result);
                *running = None;
                control
                    .cleanup_failed
                    .store(result.is_err(), Ordering::Release);
                lock(&self.logs)?.remove(id);
                return result;
            }
            if control.cleanup_failed.load(Ordering::Acquire) {
                return Err(error(
                    "LOG_STOP_UNCONFIRMED",
                    "未收到远端日志命令退出确认，请独立核对远端进程",
                ));
            }
        }
        Ok(())
    }
    pub async fn close_logs(&self, session: &str) -> Result<(), Error> {
        let ids = lock(&self.logs)?
            .values()
            .filter(|l| l.info.session_id == session)
            .map(|l| l.info.id.clone())
            .collect::<Vec<_>>();
        for id in ids {
            self.log_close(&id).await?;
        }
        Ok(())
    }
    pub async fn close_all_logs(&self) -> Result<(), Error> {
        let ids = lock(&self.logs)?.keys().cloned().collect::<Vec<_>>();
        for id in ids {
            self.log_close(&id).await?;
        }
        Ok(())
    }
    pub async fn close_host_logs(&self, host: &str) -> Result<(), Error> {
        let ids = lock(&self.logs)?
            .values()
            .filter(|log| {
                log.info.host_id == host
                    || self
                        .engine
                        .session_info(&log.info.session_id)
                        .is_ok_and(|session| session.route_host_ids.iter().any(|id| id == host))
            })
            .map(|log| log.info.id.clone())
            .collect::<Vec<_>>();
        for id in ids {
            self.log_close(&id).await?;
        }
        Ok(())
    }
    pub fn log_count(&self) -> Result<usize, Error> {
        Ok(lock(&self.logs)?.len())
    }
    async fn run_log(
        &self,
        control: &LogControl,
        command: &str,
        sink: &LogSink,
        mut pause: watch::Receiver<bool>,
        mut ack: watch::Receiver<u64>,
    ) -> (Result<(), Error>, Result<(), Error>) {
        let opened = tokio::select! {value=self.engine.open_ops_channel(&control.info.session_id)=>value,_=control.stop.cancelled()=>return (Ok(()), Ok(())),_=self.stop.cancelled()=>return (Ok(()), Ok(()))};
        let mut opened = match opened {
            Ok(opened) => opened,
            Err(error) => return (Err(error), Ok(())),
        };
        let mut remote_exited = false;
        let reading = async {
            opened.channel.exec(true, command).await.map_err(network)?;
            tokio::time::timeout(Duration::from_secs(5), async {
                loop {
                    match opened.channel.wait().await {
                        Some(russh::ChannelMsg::Success) => return Ok(()),
                        Some(russh::ChannelMsg::Failure)
                        | None
                        | Some(russh::ChannelMsg::Close) => {
                            return Err(error("LOG_EXEC_DENIED", "服务器拒绝日志命令"));
                        }
                        _ => (),
                    }
                }
            })
            .await
            .map_err(|_| error("LOG_TIMEOUT", "日志 exec 请求确认超时"))??;
            if !sink(LogEvent::State {
                state: "running",
                code: None,
                message: None,
            }) {
                return Ok(());
            }
            let mut sequence = 0;
            let mut status = None;
            loop {
                if !wait_resume(&mut pause, sink).await {
                    return Ok(());
                }
                let message = tokio::select! {value=opened.channel.wait()=>value,result=pause.changed()=>{if result.is_err(){return Ok(());}continue;}};
                let (data, stream) = match message {
                    Some(russh::ChannelMsg::Data { data }) => (data, "stdout"),
                    Some(russh::ChannelMsg::ExtendedData { data, .. }) => (data, "stderr"),
                    Some(russh::ChannelMsg::ExitStatus { exit_status }) => {
                        remote_exited = true;
                        status = Some(exit_status);
                        continue;
                    }
                    Some(russh::ChannelMsg::ExitSignal { .. }) => {
                        remote_exited = true;
                        return Err(error("LOG_SIGNAL", "日志命令被信号终止"));
                    }
                    Some(russh::ChannelMsg::Close) | None => break,
                    _ => continue,
                };
                for chunk in data.chunks(16384) {
                    if !wait_resume(&mut pause, sink).await {
                        return Ok(());
                    }
                    sequence += 1;
                    control.awaiting.store(sequence, Ordering::Release);
                    if !sink(LogEvent::Data {
                        sequence,
                        stream,
                        data: chunk.to_vec(),
                        at: now(),
                    }) {
                        return Ok(());
                    }
                    while *ack.borrow_and_update() < sequence {
                        ack.changed()
                            .await
                            .map_err(|_| error("LOG_ACK", "日志消费者已关闭"))?;
                    }
                }
            }
            if status != Some(0) {
                return Err(error(
                    "LOG_COMMAND",
                    "日志读取失败，可能是权限、文件/容器不存在或日志驱动不支持",
                ));
            }
            Ok(())
        };
        let result = tokio::select! {
            value = reading => value,
            _ = control.stop.cancelled() => Ok(()),
            _ = self.stop.cancelled() => Ok(()),
            _ = opened.session_closed.cancelled() => Err(error("LOG_DISCONNECTED", "运维连接关闭，日志流已停止")),
            _ = opened.transport_closed.cancelled() => Err(error("LOG_DISCONNECTED", "SSH 断线，无法确认远端日志命令已退出，请恢复连接后核对")),
        };
        // Stopping consumption (including a failed sink/ACK) must stop the command too.
        // Keep the channel and transport alive until the server confirms process exit.
        let cleanup = if remote_exited {
            Ok(())
        } else if opened.transport_closed.is_cancelled() {
            Err(error(
                "LOG_STOP_UNCONFIRMED",
                "SSH 已断开，无法确认远端日志命令已退出，请恢复连接后核对",
            ))
        } else {
            stop_remote(&mut opened.channel).await
        };
        let _ = tokio::time::timeout(Duration::from_millis(500), opened.channel.close()).await;
        (result, cleanup)
    }
}

async fn stop_remote(channel: &mut russh::Channel<russh::client::Msg>) -> Result<(), Error> {
    for (signal, grace) in [
        (russh::Sig::TERM, Duration::from_secs(2)),
        (russh::Sig::KILL, Duration::from_secs(1)),
    ] {
        let _ = tokio::time::timeout(Duration::from_millis(250), channel.signal(signal)).await;
        // EOF also lets commands with a stdin lifetime guard stop without SSH signal support.
        let _ = tokio::time::timeout(Duration::from_millis(250), channel.eof()).await;
        if tokio::time::timeout(grace, async {
            loop {
                match channel.wait().await {
                    Some(
                        russh::ChannelMsg::ExitStatus { .. } | russh::ChannelMsg::ExitSignal { .. },
                    ) => return true,
                    Some(russh::ChannelMsg::Close) | None => return false,
                    _ => (),
                }
            }
        })
        .await
            == Ok(true)
        {
            return Ok(());
        }
    }
    tracing::warn!(
        operation = "log_stop",
        "remote command exit was not confirmed"
    );
    Err(error(
        "LOG_STOP_UNCONFIRMED",
        "未收到远端日志命令退出确认，请独立核对远端进程",
    ))
}

async fn wait_resume(pause: &mut watch::Receiver<bool>, sink: &LogSink) -> bool {
    if !*pause.borrow_and_update() {
        return true;
    }
    if !sink(LogEvent::State {
        state: "paused",
        code: None,
        message: None,
    }) {
        return false;
    }
    while *pause.borrow_and_update() {
        if pause.changed().await.is_err() {
            return false;
        }
    }
    sink(LogEvent::State {
        state: "running",
        code: None,
        message: None,
    })
}
