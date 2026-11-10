use serverdeck_application::Application;
use serverdeck_core::{
    Error, IpcError,
    terminal::{TerminalDropPrepared, TerminalDropSelection, TerminalUploadSelection},
};
use tauri_plugin_dialog::DialogExt;

pub fn drag_event<R: tauri::Runtime>(window: &tauri::Window<R>, event: &tauri::WindowEvent) {
    use tauri::{Emitter, Manager};
    if window.label() != "main" {
        return;
    }
    let tauri::WindowEvent::DragDrop(event) = event else {
        return;
    };
    let payload = match event {
        tauri::DragDropEvent::Enter { position, .. } | tauri::DragDropEvent::Over { position } => {
            serde_json::json!({"type":"over", "x":position.x, "y":position.y})
        }
        tauri::DragDropEvent::Leave => serde_json::json!({"type":"leave"}),
        tauri::DragDropEvent::Drop { paths, position } => {
            match window
                .state::<Application>()
                .terminal_upload_register_drop(paths.clone())
            {
                Ok(grant) => {
                    serde_json::json!({"type":"drop", "x":position.x, "y":position.y, "grant":grant.grant, "names":grant.names})
                }
                Err(error) => {
                    tracing::warn!(operation="terminal_native_drop", error=%error);
                    serde_json::json!({"type":"error","x":position.x,"y":position.y,"message":IpcError::from(error).message})
                }
            }
        }
        _ => return,
    };
    if let Err(error) = window.emit("terminal-file-drag", payload) {
        tracing::warn!(operation="terminal_native_drop_event", error=%error);
    }
}

#[tauri::command]
pub async fn terminal_upload_claim_drop(
    application: tauri::State<'_, Application>,
    id: String,
    grant: String,
) -> Result<TerminalDropSelection, IpcError> {
    application
        .terminal_upload_claim_drop(&id, &grant)
        .map_err(Into::into)
}

#[tauri::command]
pub async fn terminal_upload_prepare_drop(
    application: tauri::State<'_, Application>,
    id: String,
    token: String,
    confirmed: bool,
) -> Result<TerminalDropPrepared, IpcError> {
    application
        .terminal_upload_prepare_drop(id, token, confirmed)
        .await
        .map_err(Into::into)
}

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
