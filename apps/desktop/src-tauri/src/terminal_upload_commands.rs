use serverdeck_application::Application;
use serverdeck_core::{Error, IpcError, terminal::TerminalUploadSelection};
use tauri_plugin_dialog::DialogExt;

#[tauri::command]
pub async fn terminal_upload_pick<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    application: tauri::State<'_, Application>,
    id: String,
) -> Result<TerminalUploadSelection, IpcError> {
    let target = application.terminal_upload_target(&id)?;
    let token = application.terminal_upload_begin(&id)?;
    let result = async {
        let paths = tauri::async_runtime::spawn_blocking(move || {
            app.dialog()
                .file()
                .set_title(format!("ServerDeck：ZMODEM 上传（SSH {target}）"))
                .blocking_pick_files()
                .unwrap_or_default()
                .into_iter()
                .map(|p| {
                    p.into_path()
                        .map_err(|_| Error::Validation("不支持此文件 URI"))
                })
                .collect::<Result<Vec<_>, Error>>()
        })
        .await
        .map_err(|e| Error::Worker(Box::new(e)))??;
        application
            .terminal_upload_select(id.clone(), token.clone(), paths)
            .await
    }
    .await;
    if result.is_err()
        && let Err(error) = application.terminal_upload_release(&id, &token)
    {
        tracing::error!(operation = "terminal_upload_release", error = %error);
    }
    result.map_err(Into::into)
}

#[tauri::command]
pub async fn terminal_upload_read(
    application: tauri::State<'_, Application>,
    id: String,
    token: String,
    index: usize,
    offset: u64,
) -> Result<Vec<u8>, IpcError> {
    application
        .terminal_upload_read(id, token, index, offset)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub fn terminal_upload_release(
    application: tauri::State<'_, Application>,
    id: String,
    token: String,
) -> Result<(), IpcError> {
    application
        .terminal_upload_release(&id, &token)
        .map_err(Into::into)
}
