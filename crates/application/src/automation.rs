use super::*;
use serverdeck_core::automation::*;
impl Application {
    pub async fn automation_prepare(
        &self,
        entry_id: String,
        revision: u32,
        host_ids: Vec<String>,
    ) -> Result<(Entry, Vec<Target>), Error> {
        self.automation.prepare(entry_id, revision, host_ids).await
    }

    pub fn start_automation_scheduler(&self) -> Result<(), Error> {
        self.automation.start_scheduler()
    }
    pub async fn automation_catalog(&self) -> Result<Catalog, Error> {
        self.automation.catalog().await
    }
    pub async fn automation_entry_save(
        &self,
        id: Option<String>,
        revision: Option<u32>,
        input: EntryInput,
    ) -> Result<Entry, Error> {
        self.automation.entry_save(id, revision, input).await
    }
    pub async fn automation_entry_delete(&self, id: String, confirmed: bool) -> Result<(), Error> {
        self.automation.entry_delete(id, confirmed).await
    }
    pub async fn automation_group_save(
        &self,
        id: Option<String>,
        name: String,
    ) -> Result<Group, Error> {
        self.automation.group_save(id, name).await
    }
    pub async fn automation_group_delete(&self, id: String, confirmed: bool) -> Result<(), Error> {
        self.automation.group_delete(id, confirmed).await
    }
    pub async fn automation_start(&self, input: RunInput) -> Result<Run, Error> {
        self.automation.start(input).await
    }
    pub async fn automation_run(&self, id: String) -> Result<Run, Error> {
        self.automation.run(id).await
    }
    pub async fn automation_history(&self, query: HistoryQuery) -> Result<Vec<RunSummary>, Error> {
        self.automation.history(query).await
    }
    pub async fn automation_cancel(&self, id: String, running: bool) -> Result<(), Error> {
        self.automation.cancel(id, running).await
    }
    pub async fn automation_approve(
        &self,
        id: String,
        confirmed: bool,
        danger_confirmed: bool,
    ) -> Result<Run, Error> {
        self.automation
            .approve(id, confirmed, danger_confirmed)
            .await
    }
    pub async fn automation_schedule_save(
        &self,
        id: Option<String>,
        revision: Option<u32>,
        input: ScheduleInput,
    ) -> Result<Schedule, Error> {
        self.automation.schedule_save(id, revision, input).await
    }
    pub async fn automation_schedule_disable(&self, id: String) -> Result<(), Error> {
        self.automation.schedule_disable(id).await
    }
    pub async fn automation_schedule_delete(
        &self,
        id: String,
        confirmed: bool,
    ) -> Result<(), Error> {
        self.automation.schedule_delete(id, confirmed).await
    }
    pub async fn automation_status(&self) -> Result<Status, Error> {
        self.automation.status().await
    }
    pub async fn automation_run_delete(&self, id: String, confirmed: bool) -> Result<(), Error> {
        self.automation.run_delete(id, confirmed).await
    }
}
