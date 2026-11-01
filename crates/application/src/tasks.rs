use super::*;
use serverdeck_core::tasks::*;
impl Application {
    pub fn diagnostic_start(&self, input: DiagnosticInput) -> Result<Diagnostic, Error> {
        if self.shutting_down.load(Ordering::Acquire) {
            return Err(Error::ShuttingDown);
        }
        self.tasks.diagnostic_start(input)
    }
    pub fn diagnostic_list(&self) -> Result<Vec<Diagnostic>, Error> {
        self.tasks.diagnostic_list()
    }
    pub fn diagnostic_cancel(&self, id: &str) -> Result<(), Error> {
        self.tasks.diagnostic_cancel(id)
    }
    pub async fn batch_start(&self, input: BatchInput) -> Result<Batch, Error> {
        input.validate()?;
        if self.shutting_down.load(Ordering::Acquire) {
            return Err(Error::ShuttingDown);
        }
        let ids = input
            .targets
            .iter()
            .map(|t| t.host_id.clone())
            .collect::<Vec<_>>();
        self.blocking(move |db| {
            for id in ids {
                db.host(&id)?;
            }
            Ok(())
        })
        .await?;
        self.tasks.batch_start(input).await
    }
    pub fn batch_list(&self) -> Result<Vec<Batch>, Error> {
        self.tasks.batch_list()
    }
    pub fn batch_cancel(&self, id: &str, running: bool) -> Result<(), Error> {
        self.tasks.batch_cancel(id, running)
    }
    pub async fn batch_retry_file(
        &self,
        id: &str,
        host: &str,
        session: String,
        confirmed: bool,
    ) -> Result<Batch, Error> {
        if self.shutting_down.load(Ordering::Acquire) {
            return Err(Error::ShuttingDown);
        }
        self.tasks
            .batch_retry_file(id, host, session, confirmed)
            .await
    }
}
