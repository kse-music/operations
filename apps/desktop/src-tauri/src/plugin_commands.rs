use serverdeck_application::Application;
use serverdeck_core::IpcError;
use serverdeck_plugin_core::{InstallInput, InstalledPlugin, Manifest, UninstallInput};
use std::path::PathBuf;
use tauri::State;
use tauri_plugin_dialog::DialogExt;
#[tauri::command]
pub fn plugin_tool_abort_input(
    application: State<'_, Application>,
    id: String,
    input_id: String,
) -> Result<(), IpcError> {
    application
        .plugin_tool_abort_input(&id, &input_id)
        .map_err(Into::into)
}
#[tauri::command]
pub async fn plugin_tool_stage(
    application: State<'_, Application>,
    id: String,
    input: serde_json::Value,
) -> Result<serverdeck_application::ToolTicket, IpcError> {
    application
        .plugin_tool_stage(id, input)
        .await
        .map_err(Into::into)
}
#[tauri::command]
pub fn plugin_tool_cancel_request(
    application: State<'_, Application>,
    id: String,
    request: String,
) -> Result<(), IpcError> {
    application
        .plugin_tool_cancel_request(&id, &request)
        .map_err(Into::into)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)] // Explicit IPC launch bindings are validated independently.
pub async fn plugin_terminal_open(
    application: State<'_, Application>,
    id: String,
    ticket: String,
    expected_host: String,
    expected: serverdeck_core::ops::ContainerShell,
    size: serverdeck_core::terminal::TerminalSize,
    events: tauri::ipc::Channel<serverdeck_core::terminal::TerminalEvent>,
) -> Result<serverdeck_core::terminal::TerminalSession, IpcError> {
    application
        .plugin_terminal_open(
            id,
            ticket,
            expected_host,
            expected,
            size,
            std::sync::Arc::new(move |event| events.send(event).is_ok()),
        )
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn plugin_preview_info(
    application: State<'_, Application>,
    path: PathBuf,
) -> Result<serverdeck_plugin_core::repository::PackagePreview, IpcError> {
    application
        .plugin_preview_info(path)
        .await
        .map_err(Into::into)
}
#[tauri::command]
pub async fn plugin_ui(
    application: State<'_, Application>,
    id: String,
    revision: String,
) -> Result<serverdeck_plugin_sdk::ui::Ui, IpcError> {
    application
        .plugin_ui(id, revision)
        .await
        .map_err(Into::into)
}
#[tauri::command]
pub async fn plugin_pick<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<Option<String>, IpcError> {
    tokio::task::spawn_blocking(move || {
        app.dialog()
            .file()
            .add_filter("ServerDeck plugin", &["sdplugin"])
            .blocking_pick_file()
            .map(|p| {
                p.into_path()
                    .map(|p| p.to_string_lossy().into_owned())
                    .map_err(|_| serverdeck_core::Error::Validation("需要本地插件包路径"))
            })
            .transpose()
    })
    .await
    .map_err(|e| serverdeck_core::Error::Worker(Box::new(e)))?
    .map_err(Into::into)
}

#[tauri::command]
pub async fn plugin_preview(
    application: State<'_, Application>,
    path: PathBuf,
) -> Result<Manifest, IpcError> {
    application.plugin_preview(path).await.map_err(Into::into)
}
#[tauri::command]
pub async fn plugin_install(
    application: State<'_, Application>,
    input: InstallInput,
) -> Result<InstalledPlugin, IpcError> {
    application.plugin_install(input).await.map_err(Into::into)
}
#[tauri::command]
pub async fn plugin_list(
    application: State<'_, Application>,
) -> Result<Vec<InstalledPlugin>, IpcError> {
    application.plugin_list().await.map_err(Into::into)
}
#[tauri::command]
pub async fn plugin_detail(
    application: State<'_, Application>,
    id: String,
) -> Result<InstalledPlugin, IpcError> {
    application.plugin_detail(id).await.map_err(Into::into)
}
#[tauri::command]
pub async fn plugin_set_enabled(
    application: State<'_, Application>,
    id: String,
    enabled: bool,
) -> Result<InstalledPlugin, IpcError> {
    application
        .plugin_set_enabled(id, enabled)
        .await
        .map_err(Into::into)
}
#[tauri::command]
pub async fn plugin_uninstall(
    application: State<'_, Application>,
    input: UninstallInput,
) -> Result<(), IpcError> {
    application
        .plugin_uninstall(input)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub fn plugin_statuses(
    application: State<'_, Application>,
) -> Result<Vec<serverdeck_plugin_runtime::protocol::Status>, IpcError> {
    application.plugin_statuses().map_err(Into::into)
}
#[tauri::command]
pub async fn plugin_activate(
    application: State<'_, Application>,
    id: String,
) -> Result<serverdeck_plugin_runtime::protocol::Status, IpcError> {
    application.plugin_activate(&id).await.map_err(Into::into)
}
#[tauri::command]
pub async fn plugin_call(
    application: State<'_, Application>,
    id: String,
    payload: serde_json::Value,
) -> Result<serverdeck_plugin_runtime::protocol::Reply, IpcError> {
    application
        .plugin_call(&id, payload)
        .await
        .map_err(Into::into)
}
#[tauri::command]
pub async fn plugin_health(
    application: State<'_, Application>,
    id: String,
) -> Result<serverdeck_plugin_runtime::protocol::Reply, IpcError> {
    application.plugin_health(&id).await.map_err(Into::into)
}
#[tauri::command]
pub fn plugin_cancel(application: State<'_, Application>, id: String) -> Result<(), IpcError> {
    application.plugin_cancel(&id).map_err(Into::into)
}

#[tauri::command]
pub async fn plugin_grant(
    application: State<'_, Application>,
    id: String,
    input: serverdeck_plugin_core::permissions::GrantInput,
) -> Result<serverdeck_plugin_core::permissions::Grant, IpcError> {
    application
        .plugin_grant(id, input)
        .await
        .map_err(Into::into)
}
#[tauri::command]
pub async fn plugin_permissions(
    application: State<'_, Application>,
    id: String,
) -> Result<Option<serverdeck_plugin_core::permissions::Grant>, IpcError> {
    application.plugin_permissions(id).await.map_err(Into::into)
}
#[tauri::command]
pub async fn plugin_revoke(
    application: State<'_, Application>,
    id: String,
) -> Result<(), IpcError> {
    application.plugin_revoke(id).await.map_err(Into::into)
}
#[tauri::command]
pub async fn plugin_context(
    application: State<'_, Application>,
    id: String,
    input: Option<serverdeck_application::PluginContextInput>,
) -> Result<(), IpcError> {
    match input {
        Some(input) => application.plugin_context(id, input).await,
        None => application.plugin_clear_context(id).await,
    }
    .map_err(Into::into)
}
#[tauri::command]
pub fn plugin_approve(
    application: State<'_, Application>,
    id: String,
    confirmed: bool,
) -> Result<(), IpcError> {
    application
        .plugin_approve(&id, confirmed)
        .map_err(Into::into)
}
#[tauri::command]
pub fn plugin_events(
    application: State<'_, Application>,
) -> Result<Vec<serverdeck_application::PluginEvent>, IpcError> {
    application.plugin_events().map_err(Into::into)
}
#[tauri::command]
pub async fn plugin_capability(
    application: State<'_, Application>,
    id: String,
    request: serverdeck_plugin_sdk::Request,
) -> Result<serverdeck_plugin_sdk::Response, IpcError> {
    application
        .plugin_capability(&id, request)
        .await
        .map_err(Into::into)
}
