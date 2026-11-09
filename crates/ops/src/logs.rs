use super::*;
use serverdeck_core::ops::{LogEvent, LogInput, LogSession};
use std::sync::atomic::{AtomicU64, Ordering};
use tokio::{sync::watch, task::JoinHandle};
pub type LogSink = Arc<dyn Fn(LogEvent) -> bool + Send + Sync>;
pub(crate) struct LogControl {
    pub info: LogSession,
    stop: CancellationToken,
    paused: watch::Sender<bool>,
    ack: watch::Sender<u64>,
    awaiting: AtomicU64,
    task: Mutex<Option<JoinHandle<()>>>,
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
            task: Mutex::new(None),
        });
        logs.insert(info.id.clone(), control.clone());
        let operations = self.clone();
        let running = control.clone();
        let task = tokio::spawn(async move {
            let result = operations
                .run_log(&running, &command, &sink, pause, acknowledged)
                .await;
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
        });
        *lock(&control.task)? = Some(task);
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
        let control = lock(&self.logs)?.remove(id);
        if let Some(control) = control {
            control.stop.cancel();
            let task = lock(&control.task)?.take();
            if let Some(task) = task {
                task.await.map_err(|e| Error::Worker(Box::new(e)))?;
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
    ) -> Result<(), Error> {
        let mut opened = tokio::select! {value=self.engine.open_ops_channel(&control.info.session_id)=>value?,_=control.stop.cancelled()=>return Ok(()),_=self.stop.cancelled()=>return Ok(())};
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
                if *pause.borrow_and_update() {
                    sink(LogEvent::State {
                        state: "paused",
                        code: None,
                        message: None,
                    });
                    while *pause.borrow_and_update() {
                        if pause.changed().await.is_err() {
                            return Ok(());
                        }
                    }
                    sink(LogEvent::State {
                        state: "running",
                        code: None,
                        message: None,
                    });
                }
                let message = tokio::select! {value=opened.channel.wait()=>value,result=pause.changed()=>{if result.is_err(){return Ok(());}continue;}};
                let (data, stream) = match message {
                    Some(russh::ChannelMsg::Data { data }) => (data, "stdout"),
                    Some(russh::ChannelMsg::ExtendedData { data, .. }) => (data, "stderr"),
                    Some(russh::ChannelMsg::ExitStatus { exit_status }) => {
                        status = Some(exit_status);
                        continue;
                    }
                    Some(russh::ChannelMsg::ExitSignal { .. }) => {
                        return Err(error("LOG_SIGNAL", "日志命令被信号终止"));
                    }
                    Some(russh::ChannelMsg::Close) | None => break,
                    _ => continue,
                };
                for chunk in data.chunks(16384) {
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
        let result = tokio::select! {value=reading=>value,_=control.stop.cancelled()=>Ok(()),_=self.stop.cancelled()=>Ok(()),_=opened.session_closed.cancelled()=>Err(error("LOG_DISCONNECTED","运维连接关闭，日志流已停止")),_=opened.transport_closed.cancelled()=>Err(error("LOG_DISCONNECTED","SSH 断线，日志流已停止"))};
        if control.stop.is_cancelled() || self.stop.is_cancelled() {
            let _ = tokio::time::timeout(
                Duration::from_millis(250),
                opened.channel.signal(russh::Sig::TERM),
            )
            .await;
        }
        let _ = tokio::time::timeout(Duration::from_millis(500), opened.channel.close()).await;
        result
    }
}
