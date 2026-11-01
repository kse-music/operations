mod batch;
mod exec;
mod network;
pub use exec::Outcome as ExecutionOutcome;
use serverdeck_core::{Error, tasks::*};
use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio_util::sync::CancellationToken;
pub(crate) fn lock<T>(m: &Mutex<T>) -> Result<std::sync::MutexGuard<'_, T>, Error> {
    m.lock().map_err(|_| Error::Validation("任务状态不可用"))
}
pub(crate) fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
pub(crate) fn append(s: &mut String, value: &str, limit: usize) -> u64 {
    s.push_str(value);
    if s.len() <= limit {
        return 0;
    }
    let mut n = s.len() - limit;
    while !s.is_char_boundary(n) {
        n += 1;
    }
    s.drain(..n);
    n as u64
}
struct DiagnosticControl {
    info: Mutex<Diagnostic>,
    cancel: CancellationToken,
    join: Mutex<Option<tokio::task::JoinHandle<()>>>,
}
struct BatchControl {
    info: Mutex<Batch>,
    queued: CancellationToken,
    running: CancellationToken,
    join: Mutex<Option<tokio::task::JoinHandle<()>>>,
}
#[derive(Clone)]
pub struct Tasks {
    engine: serverdeck_ssh::Engine,
    files: serverdeck_sftp::Files,
    slots: Arc<tokio::sync::Semaphore>,
    diagnostics: Arc<Mutex<VecDeque<Arc<DiagnosticControl>>>>,
    batches: Arc<Mutex<VecDeque<Arc<BatchControl>>>>,
    stop: CancellationToken,
}
impl Tasks {
    pub fn summary(&self) -> Result<Vec<serverdeck_core::product::BackgroundTask>, Error> {
        use serverdeck_core::product::BackgroundTask;
        let mut items = Vec::new();
        for c in lock(&self.diagnostics)?.iter() {
            let i = lock(&c.info)?;
            items.push(BackgroundTask {
                id: i.id.clone(),
                kind: "diagnostic",
                host_ids: match &i.input.origin {
                    Origin::Local => vec![],
                    Origin::Remote { host_id, .. } => vec![host_id.clone()],
                },
                state: i.state.clone(),
                label: format!("{:?} · {}", i.input.tool, i.input.target),
                active: active(&i.state),
            });
        }
        for c in lock(&self.batches)?.iter() {
            let i = lock(&c.info)?;
            items.push(BackgroundTask {
                id: i.id.clone(),
                kind: "batch",
                host_ids: i.rows.iter().map(|r| r.host_id.clone()).collect(),
                state: if !i.finished {
                    "running"
                } else if i.rows.iter().any(|r| r.state == "uncertain") {
                    "uncertain"
                } else if i.rows.iter().any(|r| r.state == "failed") {
                    "failed"
                } else if i.rows.iter().any(|r| r.state == "cancelled") {
                    "cancelled"
                } else {
                    "completed"
                }
                .into(),
                label: match i.input.operation {
                    BatchOperation::Command { .. } => "批量命令",
                    BatchOperation::File { .. } => "批量文件分发",
                }
                .into(),
                active: !i.finished,
            });
        }
        Ok(items)
    }
    pub async fn script_slot(
        &self,
        cancel: &CancellationToken,
    ) -> Result<tokio::sync::OwnedSemaphorePermit, Error> {
        tokio::select! {r=self.slots.clone().acquire_owned()=>r.map_err(|_|Error::ShuttingDown),_=cancel.cancelled()=>Err(Error::Validation("排队任务已取消，未执行")),_=self.stop.cancelled()=>Err(Error::ShuttingDown)}
    }
    pub async fn execute_script(
        &self,
        id: &str,
        payload: &[u8],
        seconds: u16,
        cancel: &CancellationToken,
        _slot: tokio::sync::OwnedSemaphorePermit,
        output: impl FnMut(&str, bool) + Send,
    ) -> ExecutionOutcome {
        if payload.len() > 262144 {
            return exec::Outcome::failed("脚本输入超过 256 KiB");
        }
        let command = match serverdeck_core::ops::quote(include_str!("automation_bootstrap.py")) {
            Ok(s) => format!("exec python3 -c {s}"),
            Err(_) => return exec::Outcome::failed("脚本启动协议不可用"),
        };
        exec::remote_input(
            &self.engine,
            id,
            &command,
            Some(payload),
            seconds,
            cancel,
            output,
        )
        .await
    }
    pub fn new(engine: serverdeck_ssh::Engine, files: serverdeck_sftp::Files) -> Self {
        Self {
            engine,
            files,
            slots: Arc::new(tokio::sync::Semaphore::new(8)),
            diagnostics: Arc::default(),
            batches: Arc::default(),
            stop: CancellationToken::new(),
        }
    }
    pub fn pending(&self) -> Result<usize, Error> {
        Ok(lock(&self.diagnostics)?
            .iter()
            .filter(|c| c.info.lock().is_ok_and(|i| active(&i.state)))
            .count()
            + lock(&self.batches)?
                .iter()
                .filter(|c| c.info.lock().is_ok_and(|i| !i.finished))
                .count())
    }
    pub async fn shutdown(&self) {
        self.stop.cancel();
        let ds = lock(&self.diagnostics)
            .map(|v| v.iter().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        let bs = lock(&self.batches)
            .map(|v| v.iter().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        let mut joins = Vec::new();
        for d in ds {
            d.cancel.cancel();
            if let Ok(mut j) = d.join.lock()
                && let Some(j) = j.take()
            {
                joins.push(j);
            }
        }
        for b in bs {
            b.queued.cancel();
            b.running.cancel();
            if let Ok(mut j) = b.join.lock()
                && let Some(j) = j.take()
            {
                joins.push(j);
            }
        }
        for j in joins {
            if tokio::time::timeout(Duration::from_secs(20), j)
                .await
                .is_err()
            {
                tracing::warn!(
                    operation = "tasks_shutdown",
                    "task cleanup exceeded deadline"
                );
            }
        }
    }
    fn check_origin(&self, host: &str, id: &str) -> Result<(), Error> {
        if self.engine.session_info(id)?.host_id != host || !self.engine.ops_ready(id)? {
            return Err(Error::Validation("主机与已认证运维连接不匹配"));
        }
        Ok(())
    }
}
