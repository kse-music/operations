use serverdeck_application::Application;
use serverdeck_core::{
    IpcError,
    monitor::MonitorSnapshot,
    terminal::{TerminalEvent, TerminalSession},
};
use tauri::{State, ipc::Channel};
#[tauri::command]
pub async fn monitor_open(
    application: State<'_, Application>,
    host_id: String,
    events: Channel<TerminalEvent>,
) -> Result<TerminalSession, IpcError> {
    application
        .monitor_open(
            host_id,
            std::sync::Arc::new(move |event| events.send(event).is_ok()),
        )
        .await
        .map_err(Into::into)
}
#[tauri::command]
pub fn monitor_snapshot(
    application: State<'_, Application>,
    host_id: String,
    after: Option<u64>,
) -> Result<Option<MonitorSnapshot>, IpcError> {
    application
        .monitor_snapshot(&host_id, after)
        .map_err(Into::into)
}
#[tauri::command]
pub fn monitor_visible(
    application: State<'_, Application>,
    host_id: String,
    visible: bool,
) -> Result<(), IpcError> {
    application
        .monitor_visible(&host_id, visible)
        .map_err(Into::into)
}
#[tauri::command]
pub async fn monitor_stop(
    application: State<'_, Application>,
    host_id: String,
) -> Result<(), IpcError> {
    application.monitor_stop(&host_id).await.map_err(Into::into)
}
