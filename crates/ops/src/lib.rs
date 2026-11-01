mod logs;
pub mod parse;
use logs::LogControl;
pub use logs::LogSink;
use serverdeck_core::{Error, IpcError, ops::*};
use serverdeck_ssh::Engine;
use std::{
    collections::{HashMap, VecDeque},
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;

pub(crate) fn error(code: &'static str, message: &'static str) -> Error {
    Error::Connection {
        code,
        message,
        source: None,
    }
}
pub(crate) fn lock<T>(value: &Mutex<T>) -> Result<std::sync::MutexGuard<'_, T>, Error> {
    value
        .lock()
        .map_err(|_| error("OPS_STATE", "运维状态不可用"))
}
pub(crate) fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|t| t.as_millis() as u64)
        .unwrap_or(0)
}
#[derive(Clone)]
pub struct Operations {
    engine: Engine,
    slots: Arc<Semaphore>,
    mutations: Arc<tokio::sync::Mutex<()>>,
    stop: CancellationToken,
    logs: Arc<Mutex<HashMap<String, Arc<LogControl>>>>,
    feedback: Arc<Mutex<VecDeque<Feedback>>>,
}
impl Operations {
    pub fn new(engine: Engine) -> Self {
        Self {
            engine,
            slots: Arc::new(Semaphore::new(8)),
            mutations: Arc::default(),
            stop: CancellationToken::new(),
            logs: Arc::default(),
            feedback: Arc::default(),
        }
    }
    pub fn feedback(&self) -> Result<Vec<Feedback>, Error> {
        Ok(lock(&self.feedback)?.iter().cloned().collect())
    }
    pub async fn query(&self, id: &str, request: Request) -> Result<Response, Error> {
        let command = request.command()?;
        if self.stop.is_cancelled() {
            return Err(Error::ShuttingDown);
        }
        if !self.engine.ops_ready(id)? {
            return Err(error("OPS_NOT_READY", "运维连接尚未就绪"));
        }
        let _slot = tokio::time::timeout(Duration::from_secs(3), self.slots.acquire())
            .await
            .map_err(|_| Error::Busy)?
            .map_err(|_| Error::ShuttingDown)?;
        if self.stop.is_cancelled() {
            return Err(Error::ShuttingDown);
        }
        let context = self.engine.session_info(id)?;
        let action = request.action();
        let result=async {
            let _mutation=if action.is_some(){Some(tokio::time::timeout(Duration::from_secs(3),self.mutations.lock()).await.map_err(|_|Error::Busy)?)}else{None};
            if let Request::Probe{location:ProbeLocation::Local,target,port}=&request {
                let start=std::time::Instant::now();
                let result=tokio::time::timeout(Duration::from_secs(3),tokio::net::TcpStream::connect((target.as_str(),*port))).await;
                return Ok(Response::detail(serde_json::json!({"reachable":matches!(result,Ok(Ok(_))),"milliseconds":start.elapsed().as_secs_f64()*1000.0,"location":"local"})));
            }
            let output=self.execute(id,&command).await?;
            if output.status!=Some(0){return Ok(Response{success:false,code:Some(if output.status==Some(78){"UNSUPPORTED"}else{"REMOTE_COMMAND"}.into()),message:Some(if output.stderr.is_empty(){"远端命令失败或权限不足，请刷新核对状态；未自动提权".into()}else{clean_message(&output.stderr)}),records:vec![],detail:None});}
            let mut response=parse::response(&request,&output.stdout)?;
            if !output.stderr.is_empty(){response.message=Some(clean_message(&output.stderr));}
            Ok(response)
        }.await;
        if let Some((operation, target)) = action {
            let host_id = context.host_id;
            let outcome = if result.as_ref().is_ok_and(|r| r.success) {
                "completed"
            } else {
                "failed_or_unknown"
            };
            let mut history = lock(&self.feedback)?;
            history.push_back(Feedback {
                at: now(),
                host_id,
                operation,
                target,
                outcome: outcome.into(),
            });
            while history.len() > 100 {
                history.pop_front();
            }
        }
        if let Err(ref e) = result {
            let code = IpcError::from(error_code(e));
            tracing::warn!(
                operation = "host_operation",
                code = code.code,
                "host operation failed; output was not logged"
            );
        }
        result
    }
    async fn execute(&self, id: &str, command: &str) -> Result<ExecOutput, Error> {
        if self.stop.is_cancelled() {
            return Err(Error::ShuttingDown);
        }
        let mut opened = self.engine.open_ops_channel(id).await?;
        let collecting = async {
            opened.channel.exec(true, command).await.map_err(network)?;
            let mut stdout = Vec::new();
            let mut stderr = Vec::new();
            let mut status = None;
            let mut accepted = false;
            while let Some(message) = opened.channel.wait().await {
                match message {
                    russh::ChannelMsg::Success => accepted = true,
                    russh::ChannelMsg::Failure => {
                        return Err(error("OPS_EXEC_DENIED", "服务器拒绝 exec 请求"));
                    }
                    russh::ChannelMsg::Data { data } => {
                        if stdout.len() + data.len() > 2 * 1024 * 1024 {
                            return Err(error(
                                "OPS_OUTPUT_LIMIT",
                                "操作输出超过 2 MiB，请缩小查询范围",
                            ));
                        }
                        stdout.extend_from_slice(&data);
                    }
                    russh::ChannelMsg::ExtendedData { data, .. } => {
                        if stderr.len() + data.len() > 16384 {
                            return Err(error("OPS_OUTPUT_LIMIT", "错误输出超过 16 KiB 安全上限"));
                        }
                        stderr.extend_from_slice(&data);
                    }
                    russh::ChannelMsg::ExitStatus { exit_status } => status = Some(exit_status),
                    russh::ChannelMsg::ExitSignal { .. } => {
                        return Err(error("OPS_SIGNAL", "远端操作被信号终止，请刷新核对状态"));
                    }
                    russh::ChannelMsg::Close => break,
                    _ => (),
                }
            }
            if !accepted {
                return Err(error("OPS_EXEC_DENIED", "exec 请求没有成功确认"));
            }
            Ok(ExecOutput {
                stdout,
                stderr,
                status,
            })
        };
        let result = tokio::select! {r=tokio::time::timeout(Duration::from_secs(30),collecting)=>r.unwrap_or_else(|_|Err(error("OPS_TIMEOUT","操作超时，结果可能未确认；请刷新目标状态，勿盲目重复操作"))),_=self.stop.cancelled()=>Err(Error::ShuttingDown),_=opened.session_closed.cancelled()=>Err(error("OPS_DISCONNECTED","运维连接已关闭，操作结果可能未确认")),_=opened.transport_closed.cancelled()=>Err(error("OPS_DISCONNECTED","SSH 连接中断，请重新连接后核对状态"))};
        if result.is_err() {
            let _ = tokio::time::timeout(
                Duration::from_millis(250),
                opened.channel.signal(russh::Sig::TERM),
            )
            .await;
        }
        let _ = tokio::time::timeout(Duration::from_millis(500), opened.channel.close()).await;
        result
    }
    pub async fn close(&self, id: &str) -> Result<(), Error> {
        self.close_logs(id).await?;
        self.engine.close(id).await
    }
    pub async fn shutdown(&self) {
        self.stop.cancel();
        let ids = self
            .logs
            .lock()
            .map(|logs| logs.keys().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        for id in ids {
            let _ = self.log_close(&id).await;
        }
        if tokio::time::timeout(Duration::from_secs(6), self.slots.acquire_many(8))
            .await
            .is_err()
        {
            tracing::warn!(
                operation = "ops_shutdown",
                "operations did not drain before SSH shutdown"
            );
        }
    }
}
struct ExecOutput {
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    status: Option<u32>,
}
fn clean_message(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes)
        .chars()
        .filter(|c| !c.is_control() || *c == '\n' || *c == '\t')
        .take(2048)
        .collect()
}
pub(crate) fn network(e: russh::Error) -> Error {
    Error::Connection {
        code: "OPS_NETWORK",
        message: "运维 SSH Channel 失败",
        source: Some(Box::new(e)),
    }
}
fn error_code(e: &Error) -> Error {
    match e {
        Error::Connection { code, message, .. } => error(code, message),
        _ => error("OPS_FAILED", "操作未完成"),
    }
}
