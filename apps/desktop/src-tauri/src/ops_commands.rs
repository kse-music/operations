use serverdeck_application::Application;
use serverdeck_core::{
    IpcError,
    ops::*,
    terminal::{TerminalEvent, TerminalSession, TerminalSize},
};
use tauri::{State, ipc::Channel};
#[tauri::command]
pub async fn ops_open(
    application: State<'_, Application>,
    host_id: String,
    events: Channel<TerminalEvent>,
) -> Result<TerminalSession, IpcError> {
    application
        .ops_open(
            host_id,
            std::sync::Arc::new(move |event| events.send(event).is_ok()),
        )
        .await
        .map_err(Into::into)
}
#[tauri::command]
pub async fn ops_query(
    application: State<'_, Application>,
    id: String,
    request: Request,
) -> Result<Response, IpcError> {
    application
        .ops_query(&id, request)
        .await
        .map_err(Into::into)
}
#[tauri::command]
pub async fn ops_close(application: State<'_, Application>, id: String) -> Result<(), IpcError> {
    application.ops_close(&id).await.map_err(Into::into)
}
#[tauri::command]
pub fn ops_feedback(application: State<'_, Application>) -> Result<Vec<Feedback>, IpcError> {
    application.ops_feedback().map_err(Into::into)
}
#[tauri::command]
pub async fn ops_log_open(
    application: State<'_, Application>,
    id: String,
    input: LogInput,
    events: Channel<LogEvent>,
) -> Result<LogSession, IpcError> {
    application
        .ops_log_open(
            &id,
            input,
            std::sync::Arc::new(move |event| events.send(event).is_ok()),
        )
        .map_err(Into::into)
}
#[tauri::command]
pub fn ops_log_pause(
    application: State<'_, Application>,
    id: String,
    paused: bool,
) -> Result<(), IpcError> {
    application.ops_log_pause(&id, paused).map_err(Into::into)
}
#[tauri::command]
pub fn ops_log_ack(
    application: State<'_, Application>,
    id: String,
    sequence: u64,
) -> Result<(), IpcError> {
    application.ops_log_ack(&id, sequence).map_err(Into::into)
}
#[tauri::command]
pub async fn ops_log_close(
    application: State<'_, Application>,
    id: String,
) -> Result<(), IpcError> {
    application.ops_log_close(&id).await.map_err(Into::into)
}
#[tauri::command]
pub async fn ops_container_shell(
    application: State<'_, Application>,
    host_id: String,
    shell: ContainerShell,
    size: TerminalSize,
    events: Channel<TerminalEvent>,
) -> Result<TerminalSession, IpcError> {
    application
        .ops_container_shell(
            host_id,
            shell,
            size,
            std::sync::Arc::new(move |event| events.send(event).is_ok()),
        )
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub fn ops_connections(
    application: State<'_, Application>,
) -> Result<Vec<TerminalSession>, IpcError> {
    application.ops_connections().map_err(Into::into)
}
