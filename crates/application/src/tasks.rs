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
}
