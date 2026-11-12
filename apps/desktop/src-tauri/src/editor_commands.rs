use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};

use serverdeck_application::Application;
use serverdeck_core::{
    Error, IpcError,
    files::{SaveResult, SaveText, TextDocument},
};
use tauri::{Emitter, Manager, Runtime};

const PREFIX: &str = "remote-editor-";

#[derive(Default)]
pub struct EditorWindows {
    opening: tokio::sync::Mutex<()>,
    current: Mutex<Option<Arc<EditorSession>>>,
    webview_directory: Option<std::path::PathBuf>,
}

struct EditorSession {
    label: String,
    document: Mutex<TextDocument>,
    operation: tokio::sync::Mutex<()>,
    loaded: AtomicBool,
    dirty: AtomicBool,
    closing: AtomicBool,
}

impl EditorWindows {
    pub fn new(webview_directory: std::path::PathBuf) -> Self {
        Self {
            webview_directory: Some(webview_directory),
            ..Self::default()
        }
    }

    fn session(&self) -> Result<Option<Arc<EditorSession>>, Error> {
        Ok(self.current.lock().map_err(|_| Error::Busy)?.clone())
    }

    pub fn is_open(&self) -> bool {
        self.opening.try_lock().is_err() || self.session().map_or(true, |v| v.is_some())
    }

    pub fn check_session_close(&self, id: &str) -> Result<(), Error> {
        if let Some(session) = self.session()?
            && session.document()?.session_id == id
        {
            return Err(Error::Validation(
                "请先关闭此连接的独立编辑器，再断开文件连接",
            ));
        }
        if self.opening.try_lock().is_err() {
            return Err(Error::Busy);
        }
        Ok(())
    }

    pub fn check_exit(&self) -> Result<(), Error> {
        if self.opening.try_lock().is_err()
            || self
                .session()?
                .is_some_and(|session| session.operation.try_lock().is_err())
        {
            return Err(Error::Validation(
                "编辑器正在读取或保存文件，请完成后再退出",
            ));
        }
        Ok(())
    }

    fn for_window(&self, label: &str) -> Result<Arc<EditorSession>, Error> {
        self.session()?
            .filter(|session| session.label == label && !session.closing.load(Ordering::Acquire))
            .ok_or(Error::Validation("此窗口没有可访问的编辑文档"))
    }

    fn status(&self) -> Result<serde_json::Value, Error> {
        Ok(match self.session()? {
            Some(session) => {
                let document = session.document()?;
                serde_json::json!({"document": summary(&document), "dirty": session.dirty.load(Ordering::Acquire)})
            }
            None => serde_json::json!({"document": null, "dirty": false}),
        })
    }
}

impl EditorSession {
    fn document(&self) -> Result<TextDocument, Error> {
        Ok(self.document.lock().map_err(|_| Error::Busy)?.clone())
    }
}

fn summary(document: &TextDocument) -> serde_json::Value {
    serde_json::json!({"token": document.token, "sessionId": document.session_id, "path": document.path})
}

fn notify<R: Runtime>(app: &tauri::AppHandle<R>) {
    match app.state::<EditorWindows>().status() {
        Ok(status) => {
            if let Err(error) = app.emit_to("main", "remote-editor-state", status) {
                tracing::warn!(operation = "editor_state_event", error = %error);
            }
        }
        Err(error) => tracing::warn!(operation = "editor_state", error = %error),
    }
}

fn window_title(path: &str, connection_caption: Option<&str>, language: &str) -> String {
    let editor = if language == "en-US" {
        "Editor"
    } else {
        "编辑器"
    };
    match connection_caption {
        Some(connection) => format!("{path} — {connection} — {editor} — ServerDeck"),
        None => format!("{path} — {editor} — ServerDeck"),
    }
    .replace(char::is_control, " ")
}

#[test]
fn localized_window_title_preserves_user_paths_and_captions() {
    assert_eq!(
        window_title("/配置/server.conf", Some("中文主机"), "en-US"),
        "/配置/server.conf — 中文主机 — Editor — ServerDeck"
    );
    assert_eq!(
        window_title("/配置/server.conf", None, "zh-CN"),
        "/配置/server.conf — 编辑器 — ServerDeck"
    );
    assert_eq!(
        window_title("/config\nfile", Some("ops\r@server"), "en-US"),
        "/config file — ops @server — Editor — ServerDeck"
    );
}

/// Creates an ordinary top-level window: no native parent/owner, so it can move
/// across monitors and remains usable while the main window is minimized.
pub fn create_window<R: Runtime>(
    app: &tauri::AppHandle<R>,
    document: TextDocument,
    connection_caption: Option<&str>,
    language: &str,
) -> Result<(), Error> {
    let state = app.state::<EditorWindows>();
    let label = format!("{PREFIX}{}", document.token);
    let title = window_title(&document.path, connection_caption, language);
    let session = Arc::new(EditorSession {
        label: label.clone(),
        document: Mutex::new(document),
        operation: tokio::sync::Mutex::new(()),
        loaded: AtomicBool::new(false),
        dirty: AtomicBool::new(false),
        closing: AtomicBool::new(false),
    });
    {
        let mut current = state.current.lock().map_err(|_| Error::Busy)?;
        if current.is_some() {
            return Err(Error::Busy);
        }
        *current = Some(session.clone());
    }
    let mut builder = tauri::WebviewWindowBuilder::new(
        app,
        &label,
        tauri::WebviewUrl::App("index.html?remote-editor".into()),
    )
    .initialization_script_for_all_frames(crate::PREVENT_NATIVE_CONTEXT_MENU)
    .title(title)
    .inner_size(1000.0, 740.0)
    .min_inner_size(560.0, 380.0)
    .resizable(true)
    .disable_drag_drop_handler()
    .on_navigation(move |_| !session.loaded.load(Ordering::Acquire));
    if let Some(directory) = &state.webview_directory {
        builder = builder.data_directory(directory.clone());
    }
    if let Err(error) = builder.build() {
        *state.current.lock().map_err(|_| Error::Busy)? = None;
        return Err(Error::Worker(Box::new(error)));
    }
    notify(app);
    Ok(())
}

#[tauri::command]
pub async fn editor_open<R: Runtime>(
    app: tauri::AppHandle<R>,
    application: tauri::State<'_, Application>,
    id: String,
    path: String,
    connection_caption: Option<String>,
) -> Result<serde_json::Value, IpcError> {
    if app
        .state::<crate::file_commands::ExitApproval>()
        .0
        .load(Ordering::Acquire)
    {
        return Err(Error::ShuttingDown.into());
    }
    let state = app.state::<EditorWindows>();
    let _opening = state.opening.try_lock().map_err(|_| Error::Busy)?;
    if let Some(session) = state.session()? {
        if let Some(window) = app.get_webview_window(&session.label) {
            window
                .unminimize()
                .and_then(|()| window.show())
                .and_then(|()| window.set_focus())
                .map_err(|error| Error::Worker(Box::new(error)))?;
        }
        return Err(Error::Validation("请先关闭当前编辑文档，再打开其他文件").into());
    }
    if application.has_external_editors()? {
        return Err(Error::Validation("请先结束外部编辑，再打开内置编辑器").into());
    }
    let language = application.bootstrap().await?.config.product.language;
    let document = application.text_read(&id, &path).await?;
    if let Err(error) = create_window(
        &app,
        document.clone(),
        connection_caption.as_deref(),
        &language,
    ) {
        application.text_close(&document.token, false)?;
        return Err(error.into());
    }
    Ok(summary(&document))
}

#[tauri::command]
pub fn editor_status(
    state: tauri::State<'_, EditorWindows>,
) -> Result<serde_json::Value, IpcError> {
    state.status().map_err(Into::into)
}

#[tauri::command]
pub async fn editor_load<R: Runtime>(
    window: tauri::WebviewWindow<R>,
    application: tauri::State<'_, Application>,
) -> Result<serde_json::Value, IpcError> {
    let session = window.state::<EditorWindows>().for_window(window.label())?;
    let _operation = session.operation.try_lock().map_err(|_| Error::Busy)?;
    let config = application.bootstrap().await?.config;
    let document = session.document()?;
    // The frontend installs its close listener before requesting the document.
    session.loaded.store(true, Ordering::Release);
    Ok(
        serde_json::json!({"document": document, "theme": config.theme, "interfaceFontSize": config.interface_font_size, "language": config.product.language}),
    )
}

#[tauri::command]
pub fn editor_dirty<R: Runtime>(
    window: tauri::WebviewWindow<R>,
    dirty: bool,
) -> Result<(), IpcError> {
    let session = window.state::<EditorWindows>().for_window(window.label())?;
    window
        .state::<Application>()
        .text_dirty(&session.document()?.token, dirty)?;
    session.dirty.store(dirty, Ordering::Release);
    notify(window.app_handle());
    Ok(())
}

#[tauri::command]
pub async fn editor_save<R: Runtime>(
    window: tauri::WebviewWindow<R>,
    content: String,
) -> Result<SaveResult, IpcError> {
    if window
        .state::<crate::file_commands::ExitApproval>()
        .0
        .load(Ordering::Acquire)
    {
        return Err(Error::ShuttingDown.into());
    }
    let session = window.state::<EditorWindows>().for_window(window.label())?;
    let _operation = session.operation.try_lock().map_err(|_| Error::Busy)?;
    let result = window
        .state::<Application>()
        .text_save(SaveText {
            token: session.document()?.token,
            content,
            confirm_replace: true,
        })
        .await?;
    if let Some(document) = &result.document {
        *session.document.lock().map_err(|_| Error::Busy)? = document.clone();
        session.dirty.store(false, Ordering::Release);
        notify(window.app_handle());
        if let Err(error) = window
            .app_handle()
            .emit_to("main", "remote-editor-saved", ())
        {
            tracing::warn!(operation = "editor_saved_event", error = %error);
        }
    }
    Ok(result)
}

#[tauri::command]
pub async fn editor_reload<R: Runtime>(
    window: tauri::WebviewWindow<R>,
    discard: bool,
) -> Result<TextDocument, IpcError> {
    if window
        .state::<crate::file_commands::ExitApproval>()
        .0
        .load(Ordering::Acquire)
    {
        return Err(Error::ShuttingDown.into());
    }
    let session = window.state::<EditorWindows>().for_window(window.label())?;
    let _operation = session.operation.try_lock().map_err(|_| Error::Busy)?;
    if session.dirty.load(Ordering::Acquire) && !discard {
        return Err(Error::Validation("重新加载前请确认放弃未保存内容").into());
    }
    let old = session.document()?;
    let application = window.state::<Application>();
    let document = application.text_read(&old.session_id, &old.path).await?;
    application.text_close(&old.token, true)?;
    *session.document.lock().map_err(|_| Error::Busy)? = document.clone();
    session.dirty.store(false, Ordering::Release);
    notify(window.app_handle());
    Ok(document)
}

#[tauri::command]
pub async fn editor_close<R: Runtime>(
    window: tauri::WebviewWindow<R>,
    discard: bool,
) -> Result<(), IpcError> {
    close(window.app_handle(), window.label(), discard)
        .await
        .map_err(Into::into)
}

async fn close<R: Runtime>(
    app: &tauri::AppHandle<R>,
    label: &str,
    discard: bool,
) -> Result<(), Error> {
    let state = app.state::<EditorWindows>();
    let session = state.for_window(label)?;
    let _operation = session.operation.try_lock().map_err(|_| Error::Busy)?;
    if session.dirty.load(Ordering::Acquire) && !discard {
        return Err(Error::Validation("文档有未保存内容，请先保存或确认放弃"));
    }
    // Destroy only after the backend accepted the explicit close. Destroyed
    // performs token cleanup, including windows closed during module loading.
    if let Some(window) = app.get_webview_window(label) {
        session.closing.store(true, Ordering::Release);
        if let Err(error) = window.destroy() {
            session.closing.store(false, Ordering::Release);
            return Err(Error::Worker(Box::new(error)));
        }
    }
    Ok(())
}

pub fn window_event<R: Runtime>(window: &tauri::Window<R>, event: &tauri::WindowEvent) -> bool {
    if !window.label().starts_with(PREFIX) {
        return false;
    }
    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
        api.prevent_close();
        let state = window.state::<EditorWindows>();
        match state.for_window(window.label()) {
            Ok(session) if session.loaded.load(Ordering::Acquire) => {
                if let Err(error) = window.emit("remote-editor-close-requested", ()) {
                    tracing::warn!(operation = "editor_close_review", error = %error);
                }
            }
            Ok(_) => {
                let app = window.app_handle().clone();
                let label = window.label().to_owned();
                tauri::async_runtime::spawn(async move {
                    if let Err(error) = close(&app, &label, false).await {
                        tracing::warn!(operation = "editor_loading_close", error = %error);
                    }
                });
            }
            Err(error) => tracing::warn!(operation = "editor_close", error = %error),
        }
    }
    if matches!(event, tauri::WindowEvent::Destroyed) {
        let result = (|| -> Result<(), Error> {
            let state = window.state::<EditorWindows>();
            let mut current = state.current.lock().map_err(|_| Error::Busy)?;
            if current
                .as_ref()
                .is_some_and(|session| session.label == window.label())
            {
                if let Some(session) = current.as_ref() {
                    if session.dirty.load(Ordering::Acquire)
                        && !session.closing.load(Ordering::Acquire)
                        && !window
                            .state::<crate::file_commands::ExitApproval>()
                            .0
                            .load(Ordering::Acquire)
                    {
                        tracing::warn!(
                            operation = "editor_unexpected_destroy",
                            "independent editor closed with unsaved content"
                        );
                    }
                    window
                        .state::<Application>()
                        .text_close(&session.document()?.token, true)?;
                }
                *current = None;
            }
            Ok(())
        })();
        if let Err(error) = result {
            tracing::warn!(operation = "editor_destroy_cleanup", error = %error);
        }
        notify(window.app_handle());
    }
    true
}
