mod exec;
pub use exec::Outcome as ExecutionOutcome;
use serverdeck_core::Error;
use std::sync::Arc;
use std::time::Duration;
use tokio_util::sync::CancellationToken;

#[derive(Clone)]
pub struct Tasks {
    engine: serverdeck_ssh::Engine,
    slots: Arc<tokio::sync::Semaphore>,
    stop: CancellationToken,
}
impl Tasks {
    pub async fn command_slot(
        &self,
        cancel: &CancellationToken,
    ) -> Result<tokio::sync::OwnedSemaphorePermit, Error> {
        tokio::select! {r=self.slots.clone().acquire_owned()=>r.map_err(|_|Error::ShuttingDown),_=cancel.cancelled()=>Err(Error::Validation("排队任务已取消，未执行")),_=self.stop.cancelled()=>Err(Error::ShuttingDown)}
    }
    /// Host-authorized callers only. Reuses the same bounded SSH exec, cancellation and slot pool.
    pub async fn execute_command(
        &self,
        id: &str,
        command: &str,
        seconds: u16,
        cancel: &CancellationToken,
        _slot: tokio::sync::OwnedSemaphorePermit,
        output: impl FnMut(&str, bool) + Send,
    ) -> ExecutionOutcome {
        if command.is_empty()
            || command.len() > 8192
            || command.contains('\0')
            || !(1..=30).contains(&seconds)
        {
            return exec::Outcome::failed("插件命令或 1–30 秒超时参数无效");
        }
        exec::remote(&self.engine, id, command, seconds, cancel, output).await
    }
    pub fn new(engine: serverdeck_ssh::Engine) -> Self {
        Self {
            engine,
            slots: Arc::new(tokio::sync::Semaphore::new(8)),
            stop: CancellationToken::new(),
        }
    }
    pub async fn shutdown(&self) {
        self.stop.cancel();
        self.slots.close();
    }
}
