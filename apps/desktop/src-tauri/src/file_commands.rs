use serverdeck_application::Application;
use serverdeck_core::{
    Error, IpcError,
    files::*,
    terminal::{TerminalEvent, TerminalSession, TerminalSize},
};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::DialogExt;
pub struct ExitApproval(pub AtomicBool);
#[tauri::command]
pub async fn files_open(
    application: tauri::State<'_, Application>,
    host_id: String,
    events: tauri::ipc::Channel<TerminalEvent>,
) -> Result<TerminalSession, IpcError> {
    application
        .files_open(
            host_id,
            std::sync::Arc::new(move |event| events.send(event).is_ok()),
        )
        .await
        .map_err(Into::into)
}
#[tauri::command]
pub async fn files_switch_user(
    application: tauri::State<'_, Application>,
    id: String,
    user: Option<SftpUser>,
) -> Result<FileUserSession, IpcError> {
    application
        .files_switch_user(id, user)
        .await
        .map_err(Into::into)
}
#[tauri::command]
pub async fn file_terminal(
    application: tauri::State<'_, Application>,
    host_id: String,
    action: FileTerminalAction,
    size: TerminalSize,
    events: tauri::ipc::Channel<TerminalEvent>,
) -> Result<TerminalSession, IpcError> {
    application
        .file_terminal(
            host_id,
            action,
            size,
            std::sync::Arc::new(move |event| events.send(event).is_ok()),
        )
        .await
        .map_err(Into::into)
}
#[tauri::command]
pub async fn files_list(
    application: tauri::State<'_, Application>,
    id: String,
    path: String,
) -> Result<DirectoryListing, IpcError> {
    application.files_list(&id, &path).await.map_err(Into::into)
}
#[tauri::command]
pub async fn files_local(
    application: tauri::State<'_, Application>,
    path: Option<String>,
) -> Result<DirectoryListing, IpcError> {
    application.files_local(path).await.map_err(Into::into)
}
#[tauri::command]
pub async fn files_local_drives() -> Result<Vec<LocalDrive>, IpcError> {
    #[cfg(windows)]
    {
        tauri::async_runtime::spawn_blocking(serverdeck_windows_file_drag::local_drives)
            .await
            .map_err(|error| IpcError::from(Error::Worker(Box::new(error))))?
            .map_err(Into::into)
    }
    #[cfg(not(windows))]
    {
        Ok(vec![LocalDrive {
            path: "/".into(),
            name: "/ 文件系统".into(),
        }])
    }
}
#[tauri::command]
pub async fn files_properties(
    application: tauri::State<'_, Application>,
    id: String,
    path: String,
) -> Result<FileEntry, IpcError> {
    application
        .files_properties(&id, &path)
        .await
        .map_err(Into::into)
}
#[tauri::command]
pub async fn files_action(
    application: tauri::State<'_, Application>,
    id: String,
    action: RemoteAction,
) -> Result<(), IpcError> {
    application
        .files_action(&id, action)
        .await
        .map_err(Into::into)
}
#[tauri::command]
pub async fn files_close<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    application: tauri::State<'_, Application>,
    id: String,
    cancel: bool,
) -> Result<(), IpcError> {
    if let Some(editors) = tauri::Manager::try_state::<crate::editor_commands::EditorWindows>(&app)
    {
        editors.check_session_close(&id)?;
    }
    application
        .files_close(&id, cancel)
        .await
        .map_err(Into::into)
}
#[tauri::command]
pub fn transfer_clear_host(
    application: tauri::State<'_, Application>,
    host_id: String,
) -> Result<(), IpcError> {
    application
        .transfer_clear_host(&host_id)
        .map_err(Into::into)
}
#[tauri::command]
pub async fn files_pick<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    kind: String,
) -> Result<Vec<String>, IpcError> {
    if !["files", "folder"].contains(&kind.as_str()) {
        return Err(Error::Validation("选择器类型无效").into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let picker = app
            .dialog()
            .file()
            .set_title("ServerDeck：选择本地传输路径");
        let selected = if kind == "folder" {
            picker.blocking_pick_folder().map(|p| vec![p])
        } else {
            picker.blocking_pick_files()
        };
        selected
            .unwrap_or_default()
            .into_iter()
            .map(|p| {
                p.into_path()
                    .map_err(|_| Error::Validation("不支持此文件 URI"))?
                    .into_os_string()
                    .into_string()
                    .map_err(|_| Error::Validation("本地路径不是 Unicode"))
            })
            .collect::<Result<Vec<_>, Error>>()
    })
    .await
    .map_err(|e| IpcError::from(Error::Worker(Box::new(e))))?
    .map_err(Into::into)
}
#[tauri::command]
pub async fn files_drag_download<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    application: tauri::State<'_, Application>,
    session_id: String,
    sources: Vec<String>,
) -> Result<(), IpcError> {
    #[cfg(windows)]
    {
        let names = application.drag_download_names(&session_id, sources.clone())?;
        let application = application.inner().clone();
        serverdeck_windows_file_drag::start(
            names,
            move |directory| {
                tauri::async_runtime::block_on(
                    application.stage_drag_download(session_id, sources, directory),
                )
            },
            |run| {
                app.run_on_main_thread(run)
                    .map_err(|error| Error::Worker(Box::new(error)).into())
            },
        )
        .await
    }
    #[cfg(not(windows))]
    {
        let _ = (app, application, session_id, sources);
        Err(Error::Validation("拖到系统文件夹仅在 Windows 上可用").into())
    }
}
#[tauri::command]
pub async fn transfer_start(
    application: tauri::State<'_, Application>,
    input: TransferInput,
) -> Result<TransferInfo, IpcError> {
    application.transfer_start(input).map_err(Into::into)
}
#[tauri::command]
pub fn transfer_list(
    application: tauri::State<'_, Application>,
) -> Result<Vec<TransferInfo>, IpcError> {
    application.transfer_list().map_err(Into::into)
}
#[tauri::command]
pub fn transfer_cancel(
    application: tauri::State<'_, Application>,
    id: String,
) -> Result<(), IpcError> {
    application.transfer_cancel(&id).map_err(Into::into)
}
#[tauri::command]
pub async fn transfer_retry(
    application: tauri::State<'_, Application>,
    id: String,
    session_id: String,
    conflict: ConflictPolicy,
    confirmed: bool,
) -> Result<TransferInfo, IpcError> {
    application
        .transfer_retry(&id, &session_id, conflict, confirmed)
        .map_err(Into::into)
}
#[tauri::command]
pub async fn text_read(
    application: tauri::State<'_, Application>,
    id: String,
    path: String,
) -> Result<TextDocument, IpcError> {
    application.text_read(&id, &path).await.map_err(Into::into)
}
#[tauri::command]
pub async fn external_prepare(
    application: tauri::State<'_, Application>,
    id: String,
    path: String,
) -> Result<ExternalDocument, IpcError> {
    application
        .external_prepare(&id, &path)
        .await
        .map_err(Into::into)
}
#[tauri::command]
pub async fn external_ready(
    application: tauri::State<'_, Application>,
    token: String,
) -> Result<ExternalDocument, IpcError> {
    application.external_ready(&token).await.map_err(Into::into)
}
#[tauri::command]
pub async fn external_save(
    application: tauri::State<'_, Application>,
    token: String,
    confirmed: bool,
) -> Result<SaveResult, IpcError> {
    application
        .external_save(token, confirmed)
        .await
        .map_err(Into::into)
}
#[tauri::command]
pub async fn files_open_local<R: tauri::Runtime>(
    window: tauri::WebviewWindow<R>,
    path: String,
) -> Result<bool, IpcError> {
    #[cfg(windows)]
    {
        let parent = window
            .hwnd()
            .map_err(|error| IpcError::from(Error::Worker(Box::new(error))))?
            .0 as isize;
        tauri::async_runtime::spawn_blocking(move || {
            serverdeck_windows_file_drag::open_with(&path, Some(parent))
        })
        .await
        .map_err(|error| IpcError::from(Error::Worker(Box::new(error))))?
        .map_err(Into::into)
    }
    #[cfg(not(windows))]
    {
        let _ = (window, path);
        Err(Error::Validation("系统打开方式当前仅支持 Windows，请下载后使用本地应用打开").into())
    }
}
#[tauri::command]
pub fn external_cancel(
    application: tauri::State<'_, Application>,
    token: String,
) -> Result<(), IpcError> {
    application.external_cancel(&token).map_err(Into::into)
}
#[tauri::command]
pub async fn text_save(
    application: tauri::State<'_, Application>,
    input: SaveText,
) -> Result<SaveResult, IpcError> {
    application.text_save(input).await.map_err(Into::into)
}
#[tauri::command]
pub fn text_dirty(
    application: tauri::State<'_, Application>,
    token: String,
    dirty: bool,
) -> Result<(), IpcError> {
    application.text_dirty(&token, dirty).map_err(Into::into)
}
#[tauri::command]
pub fn text_close(
    application: tauri::State<'_, Application>,
    token: String,
    discard: bool,
) -> Result<(), IpcError> {
    application.text_close(&token, discard).map_err(Into::into)
}
#[tauri::command]
pub fn app_exit_confirm<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    approval: tauri::State<'_, ExitApproval>,
    application: tauri::State<'_, Application>,
    confirmed: bool,
) -> Result<(), IpcError> {
    let pending = application.exit_pending();
    let editors = app.try_state::<crate::editor_commands::EditorWindows>();
    if let Some(editors) = &editors {
        editors.check_exit()?;
    }
    if !confirmed
        && (pending.0 > 0 || pending.1 > 0 || editors.is_some_and(|editors| editors.is_open()))
    {
        app.emit_to("main", "app-exit-review", pending)
            .map_err(|_| IpcError::from(Error::Validation("无法请求退出确认，请重试")))?;
        return Ok(());
    }
    approval.0.store(true, Ordering::Release);
    app.exit(0);
    Ok(())
}

#[tauri::command]
pub fn files_connections(
    application: tauri::State<'_, Application>,
) -> Result<Vec<TerminalSession>, IpcError> {
    application.file_connections().map_err(Into::into)
}
