use serverdeck_application::Application;
use serverdeck_core::{IpcError, automation::*};
use tauri::State;
#[tauri::command]
pub async fn automation_catalog(application: State<'_, Application>) -> Result<Catalog, IpcError> {
    application.automation_catalog().await.map_err(Into::into)
}
#[tauri::command]
pub async fn automation_entry_save(
    application: State<'_, Application>,
    id: Option<String>,
    revision: Option<u32>,
    input: EntryInput,
) -> Result<Entry, IpcError> {
    application
        .automation_entry_save(id, revision, input)
        .await
        .map_err(Into::into)
}
#[tauri::command]
pub async fn automation_entry_delete(
    application: State<'_, Application>,
    id: String,
    confirmed: bool,
) -> Result<(), IpcError> {
    application
        .automation_entry_delete(id, confirmed)
        .await
        .map_err(Into::into)
}
#[tauri::command]
pub async fn automation_group_save(
    application: State<'_, Application>,
    id: Option<String>,
    name: String,
) -> Result<Group, IpcError> {
    application
        .automation_group_save(id, name)
        .await
        .map_err(Into::into)
}
#[tauri::command]
pub async fn automation_group_delete(
    application: State<'_, Application>,
    id: String,
    confirmed: bool,
) -> Result<(), IpcError> {
    application
        .automation_group_delete(id, confirmed)
        .await
        .map_err(Into::into)
}
#[tauri::command]
pub async fn automation_start(
    application: State<'_, Application>,
    input: RunInput,
) -> Result<Run, IpcError> {
    application
        .automation_start(input)
        .await
        .map_err(Into::into)
}
#[tauri::command]
pub async fn automation_run(
    application: State<'_, Application>,
    id: String,
) -> Result<Run, IpcError> {
    application.automation_run(id).await.map_err(Into::into)
}
#[tauri::command]
pub async fn automation_history(
    application: State<'_, Application>,
    query: HistoryQuery,
) -> Result<Vec<RunSummary>, IpcError> {
    application
        .automation_history(query)
        .await
        .map_err(Into::into)
}
#[tauri::command]
pub async fn automation_cancel(
    application: State<'_, Application>,
    id: String,
    running: bool,
) -> Result<(), IpcError> {
    application
        .automation_cancel(id, running)
        .await
        .map_err(Into::into)
}
#[tauri::command]
pub async fn automation_approve(
    application: State<'_, Application>,
    id: String,
    confirmed: bool,
    danger_confirmed: bool,
) -> Result<Run, IpcError> {
    application
        .automation_approve(id, confirmed, danger_confirmed)
        .await
        .map_err(Into::into)
}
#[tauri::command]
pub async fn automation_schedule_save(
    application: State<'_, Application>,
    id: Option<String>,
    revision: Option<u32>,
    input: ScheduleInput,
) -> Result<Schedule, IpcError> {
    application
        .automation_schedule_save(id, revision, input)
        .await
        .map_err(Into::into)
}
#[tauri::command]
pub async fn automation_schedule_disable(
    application: State<'_, Application>,
    id: String,
) -> Result<(), IpcError> {
    application
        .automation_schedule_disable(id)
        .await
        .map_err(Into::into)
}
#[tauri::command]
pub async fn automation_schedule_delete(
    application: State<'_, Application>,
    id: String,
    confirmed: bool,
) -> Result<(), IpcError> {
    application
        .automation_schedule_delete(id, confirmed)
        .await
        .map_err(Into::into)
}
#[tauri::command]
pub async fn automation_status(application: State<'_, Application>) -> Result<Status, IpcError> {
    application.automation_status().await.map_err(Into::into)
}
#[tauri::command]
pub async fn automation_run_delete(
    application: State<'_, Application>,
    id: String,
    confirmed: bool,
) -> Result<(), IpcError> {
    application
        .automation_run_delete(id, confirmed)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn automation_prepare(
    application: State<'_, Application>,
    entry_id: String,
    revision: u32,
    host_ids: Vec<String>,
) -> Result<(Entry, Vec<Target>), IpcError> {
    application
        .automation_prepare(entry_id, revision, host_ids)
        .await
        .map_err(Into::into)
}
