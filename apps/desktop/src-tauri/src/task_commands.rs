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
