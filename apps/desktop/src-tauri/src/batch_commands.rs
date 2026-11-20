use serverdeck_application::Application;
use serverdeck_core::{
    IpcError,
    batch::{BatchCommand, BatchCommandInput, BatchPreview, BatchRequest, BatchRun},
};
use tauri::State;

#[tauri::command]
pub async fn batch_list(
    application: State<'_, Application>,
) -> Result<Vec<BatchCommand>, IpcError> {
    application.batch_commands().await.map_err(Into::into)
}

#[tauri::command]
pub async fn batch_save(
    application: State<'_, Application>,
    id: Option<String>,
    revision: Option<u32>,
    input: BatchCommandInput,
) -> Result<BatchCommand, IpcError> {
    application
        .batch_save(id, revision, input)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn batch_delete(
    application: State<'_, Application>,
    id: String,
    revision: u32,
) -> Result<(), IpcError> {
    application
        .batch_delete(id, revision)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn batch_prepare(
    application: State<'_, Application>,
    input: BatchRequest,
) -> Result<BatchPreview, IpcError> {
    application.batch_prepare(input).await.map_err(Into::into)
}

#[tauri::command]
pub async fn batch_start(
    application: State<'_, Application>,
    token: String,
    production_confirmed: bool,
) -> Result<BatchRun, IpcError> {
    application
        .batch_start(token, production_confirmed)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub fn batch_status(
    application: State<'_, Application>,
    id: Option<String>,
    known_revision: Option<u64>,
) -> Result<Option<BatchRun>, IpcError> {
    application
        .batch_status(id.as_deref(), known_revision)
        .map_err(Into::into)
}

#[tauri::command]
pub fn batch_cancel(application: State<'_, Application>, id: String) -> Result<(), IpcError> {
    application.batch_cancel(&id).map_err(Into::into)
}
