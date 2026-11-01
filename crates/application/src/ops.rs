use super::*;
use serverdeck_core::{
    ops::*,
    terminal::{TerminalSession, TerminalSize},
};
use serverdeck_ssh::Sink;
impl Application {
    pub fn ops_connections(&self) -> Result<Vec<TerminalSession>, Error> {
        self.terminals.ops_connections()
    }

    pub async fn ops_open(&self, host_id: String, sink: Sink) -> Result<TerminalSession, Error> {
        let secrets = self.secrets.clone();
        let (host, plan) = self
            .blocking(move |db| super::terminal::connection_plan(&db, secrets.as_ref(), &host_id))
            .await?;
        if self.shutting_down.load(Ordering::Acquire) {
            return Err(Error::ShuttingDown);
        }
        self.terminals.open_ops_plan(host, plan, sink)
    }
    pub async fn ops_query(&self, id: &str, request: Request) -> Result<Response, Error> {
        self.operations_host.query(id, request).await
    }
    pub async fn ops_close(&self, id: &str) -> Result<(), Error> {
        self.operations_host.close(id).await
    }
    pub fn ops_feedback(&self) -> Result<Vec<Feedback>, Error> {
        self.operations_host.feedback()
    }
    pub fn ops_log_open(
        &self,
        id: &str,
        input: LogInput,
        sink: serverdeck_ops::LogSink,
    ) -> Result<LogSession, Error> {
        self.operations_host.log_open(id, input, sink)
    }
    pub fn ops_log_pause(&self, id: &str, paused: bool) -> Result<(), Error> {
        self.operations_host.log_pause(id, paused)
    }
    pub fn ops_log_ack(&self, id: &str, sequence: u64) -> Result<(), Error> {
        self.operations_host.log_ack(id, sequence)
    }
    pub async fn ops_log_close(&self, id: &str) -> Result<(), Error> {
        self.operations_host.log_close(id).await
    }
    pub async fn ops_container_shell(
        &self,
        host_id: String,
        shell: ContainerShell,
        size: TerminalSize,
        sink: Sink,
    ) -> Result<TerminalSession, Error> {
        shell.command()?;
        let secrets = self.secrets.clone();
        let (host, plan) = self
            .blocking(move |db| super::terminal::connection_plan(&db, secrets.as_ref(), &host_id))
            .await?;
        if self.shutting_down.load(Ordering::Acquire) {
            return Err(Error::ShuttingDown);
        }
        self.terminals
            .open_container_terminal_plan(host, plan, size, sink, shell)
    }
}
