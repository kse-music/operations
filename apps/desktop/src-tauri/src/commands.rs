use serverdeck_application::Application;
use serverdeck_core::{
    connection::{ForwardInfo, ForwardInput},
    workspace::WorkspaceLayout,
};
#[tauri::command]
pub async fn workspace_load(
    application: tauri::State<'_, Application>,
) -> Result<Option<WorkspaceLayout>, IpcError> {
    application.workspace_load().await.map_err(Into::into)
}
#[tauri::command]
pub async fn workspace_save(
    application: tauri::State<'_, Application>,
    layout: WorkspaceLayout,
) -> Result<(), IpcError> {
    application.workspace_save(layout).await.map_err(Into::into)
}
#[tauri::command]
pub async fn forward_start(
    application: tauri::State<'_, Application>,
    id: String,
    input: ForwardInput,
) -> Result<ForwardInfo, IpcError> {
    application
        .forward_start(&id, input)
        .await
        .map_err(Into::into)
}
#[tauri::command]
pub fn forward_list(
    application: tauri::State<'_, Application>,
    id: String,
) -> Result<Vec<ForwardInfo>, IpcError> {
    application.forward_list(&id).map_err(Into::into)
}
#[tauri::command]
pub async fn forward_stop(
    application: tauri::State<'_, Application>,
    id: String,
) -> Result<(), IpcError> {
    application.forward_stop(&id).await.map_err(Into::into)
}
use serverdeck_core::terminal::{TerminalEvent, TerminalSession, TerminalSize};

#[tauri::command]
pub async fn terminal_local_open(
    application: tauri::State<'_, Application>,
    size: TerminalSize,
    events: tauri::ipc::Channel<TerminalEvent>,
) -> Result<serverdeck_core::terminal::LocalTerminalSession, IpcError> {
    application
        .terminal_local_open(
            size,
            std::sync::Arc::new(move |event| events.send(event).is_ok()),
        )
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn terminal_open(
    application: tauri::State<'_, Application>,
    host_id: String,
    size: TerminalSize,
    events: tauri::ipc::Channel<TerminalEvent>,
) -> Result<TerminalSession, IpcError> {
    application
        .terminal_open(
            host_id,
            size,
            std::sync::Arc::new(move |event| events.send(event).is_ok()),
        )
        .await
        .map_err(Into::into)
}
#[tauri::command]
pub fn terminal_input(
    application: tauri::State<'_, Application>,
    id: String,
    data: Vec<u8>,
) -> Result<(), IpcError> {
    application.terminal_input(&id, data).map_err(Into::into)
}
#[tauri::command]
pub fn terminal_resize(
    application: tauri::State<'_, Application>,
    id: String,
    size: TerminalSize,
) -> Result<(), IpcError> {
    application.terminal_resize(&id, size).map_err(Into::into)
}
#[tauri::command]
pub fn terminal_ack(
    application: tauri::State<'_, Application>,
    id: String,
    sequence: u64,
) -> Result<(), IpcError> {
    application.terminal_ack(&id, sequence).map_err(Into::into)
}
#[tauri::command]
pub fn terminal_trust(
    application: tauri::State<'_, Application>,
    id: String,
    accept: bool,
) -> Result<(), IpcError> {
    application.terminal_trust(&id, accept).map_err(Into::into)
}
#[tauri::command]
pub async fn terminal_close(
    application: tauri::State<'_, Application>,
    id: String,
) -> Result<(), IpcError> {
    application.terminal_close(&id).await.map_err(Into::into)
}
#[tauri::command]
pub async fn terminal_close_host(
    application: tauri::State<'_, Application>,
    host_id: String,
) -> Result<(), IpcError> {
    application
        .terminal_close_host(&host_id)
        .await
        .map_err(Into::into)
}
use serverdeck_application::SecureStatus;
use serverdeck_core::{AppConfig, Bootstrap, IpcError};
use serverdeck_core::{hosts::*, openssh::ImportPreview};

#[tauri::command]
pub async fn app_bootstrap(
    application: tauri::State<'_, Application>,
) -> Result<Bootstrap, IpcError> {
    let result = application.bootstrap().await.map_err(IpcError::from)?;
    tracing::info!(operation = "ipc_bootstrap", "frontend bootstrap completed");
    Ok(result)
}

#[tauri::command]
pub async fn config_save(
    application: tauri::State<'_, Application>,
    config: AppConfig,
) -> Result<AppConfig, IpcError> {
    application.save_config(config).await.map_err(Into::into)
}

#[tauri::command]
pub async fn host_list(application: tauri::State<'_, Application>) -> Result<Catalog, IpcError> {
    application.catalog().await.map_err(Into::into)
}
#[tauri::command]
pub async fn host_create(
    application: tauri::State<'_, Application>,
    input: HostInput,
) -> Result<Host, IpcError> {
    application.host_create(input).await.map_err(Into::into)
}
#[tauri::command]
pub async fn host_update(
    application: tauri::State<'_, Application>,
    id: String,
    input: HostInput,
) -> Result<Host, IpcError> {
    application.host_update(id, input).await.map_err(Into::into)
}
#[tauri::command]
pub async fn host_delete(
    application: tauri::State<'_, Application>,
    id: String,
) -> Result<(), IpcError> {
    application.host_delete(id).await.map_err(Into::into)
}
#[tauri::command]
pub async fn host_copy(
    application: tauri::State<'_, Application>,
    id: String,
) -> Result<Host, IpcError> {
    application.host_copy(id).await.map_err(Into::into)
}
#[tauri::command]
pub async fn group_save(
    application: tauri::State<'_, Application>,
    id: Option<String>,
    input: GroupInput,
) -> Result<HostGroup, IpcError> {
    application.group_save(id, input).await.map_err(Into::into)
}
#[tauri::command]
pub async fn group_delete(
    application: tauri::State<'_, Application>,
    id: String,
) -> Result<(), IpcError> {
    application.group_delete(id).await.map_err(Into::into)
}
#[tauri::command]
pub async fn credential_save(
    application: tauri::State<'_, Application>,
    id: Option<String>,
    expected_revision: Option<u32>,
    input: CredentialInput,
) -> Result<Mutation<Credential>, IpcError> {
    application
        .credential_save(id, expected_revision, input)
        .await
        .map_err(Into::into)
}
#[tauri::command]
pub async fn credential_delete(
    application: tauri::State<'_, Application>,
    id: String,
    detach_hosts: bool,
) -> Result<Mutation<()>, IpcError> {
    application
        .credential_delete(id, detach_hosts)
        .await
        .map_err(Into::into)
}
#[tauri::command]
pub async fn credential_cleanup(
    application: tauri::State<'_, Application>,
) -> Result<Mutation<()>, IpcError> {
    application.cleanup_secrets().await.map_err(Into::into)
}
#[tauri::command]
pub async fn credential_status(
    application: tauri::State<'_, Application>,
) -> Result<SecureStatus, IpcError> {
    application.secure_status().await.map_err(Into::into)
}
#[tauri::command]
pub async fn hosts_import_preview(
    application: tauri::State<'_, Application>,
    text: String,
) -> Result<ImportPreview, IpcError> {
    application.import_preview(text).await.map_err(Into::into)
}
#[tauri::command]
pub async fn hosts_import(
    application: tauri::State<'_, Application>,
    text: String,
    selected: Vec<String>,
    group_id: Option<String>,
) -> Result<Mutation<Vec<Host>>, IpcError> {
    application
        .import_hosts(text, selected, group_id)
        .await
        .map_err(Into::into)
}
#[tauri::command]
pub async fn hosts_export(application: tauri::State<'_, Application>) -> Result<String, IpcError> {
    application.export_hosts().await.map_err(Into::into)
}
