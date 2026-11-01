use super::*;
use serverdeck_core::{monitor::MonitorSnapshot, terminal::TerminalSession};
use serverdeck_ssh::Sink;
impl Application {
    pub async fn monitor_open(
        &self,
        host_id: String,
        sink: Sink,
    ) -> Result<TerminalSession, Error> {
        let secrets = self.secrets.clone();
        let (host, plan) = self
            .blocking(move |db| super::terminal::connection_plan(&db, secrets.as_ref(), &host_id))
            .await?;
        if self.shutting_down.load(Ordering::Acquire) {
            return Err(Error::ShuttingDown);
        }
        let interval = self
            .blocking(|db| Ok(db.load_config()?.monitor_interval_secs))
            .await?;
        self.monitors.open(host, plan, interval, sink)
    }
    pub fn monitor_snapshot(
        &self,
        host: &str,
        after: Option<u64>,
    ) -> Result<Option<MonitorSnapshot>, Error> {
        self.monitors.snapshot(host, after)
    }
    pub fn monitor_visible(&self, host: &str, visible: bool) -> Result<(), Error> {
        self.monitors.visible(host, visible)
    }
    pub async fn monitor_stop(&self, host: &str) -> Result<(), Error> {
        self.monitors.stop(host).await
    }
}
