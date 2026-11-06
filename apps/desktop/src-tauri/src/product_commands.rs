use serverdeck_application::Application;
use serverdeck_core::{IpcError, product::BackgroundSnapshot};
#[tauri::command]
pub fn background_tasks(
    application: tauri::State<'_, Application>,
) -> Result<BackgroundSnapshot, IpcError> {
    application.background_tasks().map_err(Into::into)
}
