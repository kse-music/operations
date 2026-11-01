use serverdeck_application::Application;
use serverdeck_core::{IpcError, backup::*, product::BackgroundSnapshot};
#[tauri::command]
pub async fn backup_export(application: tauri::State<'_, Application>) -> Result<String, IpcError> {
    application.backup_export().await.map_err(Into::into)
}
#[tauri::command]
pub async fn backup_preview(
    application: tauri::State<'_, Application>,
    text: String,
) -> Result<BackupPreview, IpcError> {
    application.backup_preview(text).await.map_err(Into::into)
}
#[tauri::command]
pub async fn backup_restore(
    application: tauri::State<'_, Application>,
    input: RestoreInput,
) -> Result<RestoreResult, IpcError> {
    application.backup_restore(input).await.map_err(Into::into)
}
#[tauri::command]
pub fn background_tasks(
    application: tauri::State<'_, Application>,
) -> Result<BackgroundSnapshot, IpcError> {
    application.background_tasks().map_err(Into::into)
}
