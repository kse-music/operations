use serverdeck_application::Application;
use serverdeck_core::{IpcError, tasks::*};
use tauri::State;
#[tauri::command]
pub async fn diagnostic_start(
    application: State<'_, Application>,
    input: DiagnosticInput,
) -> Result<Diagnostic, IpcError> {
    application.diagnostic_start(input).map_err(Into::into)
}
#[tauri::command]
pub async fn diagnostic_list(
    application: State<'_, Application>,
    versions: Option<std::collections::HashMap<String, u64>>,
) -> Result<Vec<Diagnostic>, IpcError> {
    let versions = versions.unwrap_or_default();
    application
        .diagnostic_list()
        .map(|v| {
            v.into_iter()
                .filter(|i| versions.get(&i.id) != Some(&i.revision))
                .collect()
        })
        .map_err(Into::into)
}
#[tauri::command]
pub fn diagnostic_cancel(application: State<'_, Application>, id: String) -> Result<(), IpcError> {
    application.diagnostic_cancel(&id).map_err(Into::into)
}
#[tauri::command]
pub async fn batch_start(
    application: State<'_, Application>,
    input: BatchInput,
) -> Result<Batch, IpcError> {
    application.batch_start(input).await.map_err(Into::into)
}
#[tauri::command]
pub async fn batch_list(
    application: State<'_, Application>,
    versions: Option<std::collections::HashMap<String, u64>>,
) -> Result<Vec<Batch>, IpcError> {
    let versions = versions.unwrap_or_default();
    application
        .batch_list()
        .map(|v| {
            v.into_iter()
                .filter(|i| versions.get(&i.id) != Some(&i.revision))
                .collect()
        })
        .map_err(Into::into)
}
#[tauri::command]
pub fn batch_cancel(
    application: State<'_, Application>,
    id: String,
    running: bool,
) -> Result<(), IpcError> {
    application.batch_cancel(&id, running).map_err(Into::into)
}
#[tauri::command]
pub async fn batch_retry_file(
    application: State<'_, Application>,
    id: String,
    host_id: String,
    session_id: String,
    confirmed: bool,
) -> Result<Batch, IpcError> {
    application
        .batch_retry_file(&id, &host_id, session_id, confirmed)
        .await
        .map_err(Into::into)
}
