use serverdeck_application::Application;
use serverdeck_core::{IpcError, ai::*, hosts::Mutation};
use tauri::State;

#[tauri::command]
pub async fn ai_local_tool_install(
    application: State<'_, Application>,
    model_id: String,
    request_id: String,
) -> Result<(), IpcError> {
    application
        .ai_local_tool_install(model_id, request_id)
        .await
        .map_err(Into::into)
}
#[tauri::command]
pub fn ai_local_tool_install_cancel(
    application: State<'_, Application>,
    request_id: String,
) -> Result<(), IpcError> {
    application
        .ai_local_tool_install_cancel(&request_id)
        .map_err(Into::into)
}

#[tauri::command]
pub async fn ai_local_claude_code_status(
    application: State<'_, Application>,
) -> Result<LocalClaudeCodeStatus, IpcError> {
    application
        .ai_local_claude_code_status()
        .await
        .map_err(Into::into)
}
#[tauri::command]
pub async fn ai_local_claude_code_authorize(
    application: State<'_, Application>,
    authorized: bool,
) -> Result<(), IpcError> {
    application
        .ai_local_claude_code_authorize(authorized)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn ai_local_codex_status(
    application: State<'_, Application>,
) -> Result<LocalCodexStatus, IpcError> {
    application
        .ai_local_codex_status()
        .await
        .map_err(Into::into)
}
#[tauri::command]
pub async fn ai_local_codex_authorize(
    application: State<'_, Application>,
    authorized: bool,
) -> Result<(), IpcError> {
    application
        .ai_local_codex_authorize(authorized)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn ai_models(application: State<'_, Application>) -> Result<Vec<Model>, IpcError> {
    application.ai_models().await.map_err(Into::into)
}
#[tauri::command]
pub async fn ai_model_test(
    application: State<'_, Application>,
    input: ModelInput,
) -> Result<ModelTest, IpcError> {
    application.ai_model_test(input).await.map_err(Into::into)
}
#[tauri::command]
pub async fn ai_model_save(
    application: State<'_, Application>,
    input: ModelInput,
) -> Result<Mutation<Model>, IpcError> {
    application.ai_model_save(input).await.map_err(Into::into)
}
#[tauri::command]
pub async fn ai_model_delete(
    application: State<'_, Application>,
    input: ModelDeleteInput,
) -> Result<Mutation<()>, IpcError> {
    application.ai_model_delete(input).await.map_err(Into::into)
}
#[tauri::command]
pub async fn ai_resolve_hosts(
    application: State<'_, Application>,
    input: ResolveHostsInput,
) -> Result<HostRoute, IpcError> {
    application
        .ai_resolve_hosts(input)
        .await
        .map_err(Into::into)
}
#[tauri::command]
pub async fn ai_prepare(
    application: State<'_, Application>,
    input: PrepareInput,
) -> Result<Preview, IpcError> {
    application.ai_prepare(input).await.map_err(Into::into)
}
#[tauri::command]
pub async fn ai_send(
    application: State<'_, Application>,
    id: String,
    confirmed: bool,
) -> Result<Answer, IpcError> {
    application.ai_send(id, confirmed).await.map_err(Into::into)
}
#[tauri::command]
pub async fn ai_execute(
    application: State<'_, Application>,
    input: ExecuteInput,
) -> Result<Execution, IpcError> {
    application.ai_execute(input).await.map_err(Into::into)
}
#[tauri::command]
pub fn ai_cancel(application: State<'_, Application>, id: String) -> Result<(), IpcError> {
    application.ai_cancel(&id).map_err(Into::into)
}
