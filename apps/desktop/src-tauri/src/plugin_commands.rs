use serverdeck_application::Application;
use serverdeck_core::IpcError;
use serverdeck_plugin_core::{InstallInput, InstalledPlugin, Manifest, UninstallInput};
use std::path::PathBuf;
use tauri::State;
use tauri_plugin_dialog::DialogExt;
#[tauri::command]
pub async fn plugin_inventory(
    application: State<'_, Application>,
) -> Result<serverdeck_application::PluginInventory, IpcError> {
    application.plugin_inventory().await.map_err(Into::into)
}
#[tauri::command]
pub async fn plugin_reinstall_bundled(
    application: State<'_, Application>,
    id: String,
    expected_record_digest: Option<String>,
    confirmed: bool,
) -> Result<InstalledPlugin, IpcError> {
    application
        .plugin_reinstall_bundled(id, expected_record_digest, confirmed)
        .await
        .map_err(Into::into)
}
#[tauri::command]
pub async fn plugin_continue(
    application: State<'_, Application>,
    id: String,
    owner: String,
    continuation: String,
    cancelled: bool,
) -> Result<serverdeck_plugin_runtime::protocol::Reply, IpcError> {
    application
        .plugin_continue(&id, &owner, &continuation, cancelled)
        .await
        .map_err(Into::into)
}
#[tauri::command]
pub fn plugin_cancel_scope(
    application: State<'_, Application>,
    id: String,
    owner: String,
) -> Result<(), IpcError> {
    application
        .plugin_cancel_scope(&id, &owner)
        .map_err(Into::into)
}
#[tauri::command]
pub async fn plugin_close_scope(
    application: State<'_, Application>,
    id: String,
    owner: String,
) -> Result<(), IpcError> {
    application
        .plugin_close_scope(&id, &owner)
        .await
        .map_err(Into::into)
}
#[tauri::command]
pub async fn plugin_scope_visibility(
    application: State<'_, Application>,
    id: String,
    owner: String,
    visible: bool,
    retain: Option<bool>,
) -> Result<(), IpcError> {
    application
        .plugin_scope_visibility(&id, &owner, visible, retain.unwrap_or(false))
        .await
        .map_err(Into::into)
}
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn plugin_platform_terminal_open(
    application: State<'_, Application>,
    id: String,
    owner: String,
    ticket: String,
    expected_host: String,
    size: serverdeck_core::terminal::TerminalSize,
    events: tauri::ipc::Channel<serverdeck_core::terminal::TerminalEvent>,
) -> Result<serverdeck_core::terminal::TerminalSession, IpcError> {
    application
        .plugin_platform_terminal_open(
            &id,
            &owner,
            &ticket,
            &expected_host,
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
    owner: String,
    payload: serde_json::Value,
) -> Result<serverdeck_plugin_runtime::protocol::Reply, IpcError> {
    application
        .plugin_call_scoped(&id, &owner, payload)
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
pub async fn plugin_reset(application: State<'_, Application>, id: String) -> Result<(), IpcError> {
    application.plugin_reset(id).await.map_err(Into::into)
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
    owner: String,
    request: serverdeck_plugin_sdk::Request,
) -> Result<serverdeck_plugin_sdk::Response, IpcError> {
    application
        .plugin_capability_scoped(&id, &owner, request)
        .await
        .map_err(Into::into)
}
