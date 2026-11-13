use serde::Serialize;
use serverdeck_application::Application;
use serverdeck_core::{Error, IpcError, updates::UpdatePreferences};
use std::{
    sync::{
        Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{Manager, Runtime};
use tauri_plugin_updater::{Update, UpdaterExt};
use tokio::sync::{Mutex as AsyncMutex, watch};

const RELEASE_ROOT: &str = "https://github.com/kse-music/operations/releases/download/";

fn supported() -> bool {
    cfg!(all(target_os = "windows", target_arch = "x86_64"))
        && matches!(
            tauri::utils::platform::bundle_type(),
            Some(tauri::utils::config::BundleType::Nsis)
        )
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    #[default]
    Idle,
    Checking,
    UpToDate,
    Available,
    Downloading,
    Ready,
    Installing,
    Error,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Release {
    version: String,
    notes: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    supported: bool,
    phase: Phase,
    release: Option<Release>,
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
    error: Option<String>,
    preferences: UpdatePreferences,
}

#[derive(Default)]
struct Inner {
    phase: Phase,
    update: Option<Update>,
    bytes: Option<Vec<u8>>,
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
    error: Option<String>,
    cancel: Option<watch::Sender<bool>>,
}

#[derive(Default)]
pub struct Updates {
    inner: Mutex<Inner>,
    operation: AsyncMutex<()>,
    closing: AtomicBool,
}

fn failure(
    code: &'static str,
    message: &'static str,
    source: impl std::error::Error + Send + Sync + 'static,
) -> Error {
    tracing::warn!(
        operation = "software_update",
        code,
        "software update failed"
    );
    Error::Connection {
        code,
        message,
        source: Some(Box::new(source)),
    }
}

fn now() -> Result<u64, Error> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|at| at.as_secs())
        .map_err(|error| Error::Worker(Box::new(error)))
}

fn cancelled(message: &'static str) -> Error {
    Error::Connection {
        code: "UPDATE_CANCELLED",
        message,
        source: None,
    }
}

pub fn validate_download(url: &tauri::Url, version: &str) -> Result<(), Error> {
    let expected = format!("{RELEASE_ROOT}v{version}/ServerDeck_{version}_x64-setup.exe");
    if url.as_str() != expected {
        return Err(Error::Validation(
            "更新包地址不属于当前版本的官方 GitHub Release",
        ));
    }
    Ok(())
}

impl Updates {
    fn ensure_open(&self) -> Result<(), Error> {
        if self.closing.load(Ordering::Acquire) {
            return Err(Error::ShuttingDown);
        }
        Ok(())
    }
    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Inner>, Error> {
        self.inner.lock().map_err(|_| Error::Busy)
    }

    fn status(&self, preferences: UpdatePreferences) -> Result<Status, Error> {
        let inner = self.lock()?;
        Ok(Status {
            supported: supported(),
            phase: inner.phase,
            release: inner.update.as_ref().map(|update| Release {
                version: update.version.clone(),
                notes: update.body.clone().unwrap_or_default(),
            }),
            downloaded_bytes: inner.downloaded_bytes,
            total_bytes: inner.total_bytes,
            error: inner.error.clone(),
            preferences,
        })
    }

    fn finish_error(&self, error: &Error) -> Result<(), Error> {
        let mut inner = self.lock()?;
        inner.cancel = None;
        if matches!(
            error,
            Error::Connection {
                code: "UPDATE_CANCELLED",
                ..
            }
        ) {
            inner.phase = if inner.update.is_some() {
                Phase::Available
            } else {
                Phase::Idle
            };
            inner.error = None;
        } else {
            inner.phase = Phase::Error;
            inner.error = Some(error.to_string());
        }
        Ok(())
    }

    pub fn cancel(&self) -> Result<(), Error> {
        if let Some(cancel) = &self.lock()?.cancel {
            let _ = cancel.send(true); // No receiver means the operation already completed.
        }
        Ok(())
    }

    pub async fn shutdown(&self) {
        self.closing.store(true, Ordering::Release);
        if let Err(error) = self.cancel() {
            tracing::error!(operation = "update_shutdown", error = %error);
        }
        let _operation = self.operation.lock().await;
    }

    pub fn installing(&self) -> bool {
        self.inner
            .lock()
            .is_ok_and(|inner| inner.phase == Phase::Installing)
    }

    pub fn take_installation(&self) -> Result<(Update, Vec<u8>), Error> {
        let mut inner = self.lock()?;
        if inner.phase != Phase::Installing {
            return Err(Error::Validation("更新尚未准备好安装"));
        }
        let update = inner.update.take().ok_or(Error::NotFound)?;
        let bytes = inner.bytes.take().ok_or(Error::NotFound)?;
        Ok((update, bytes))
    }
}

#[tauri::command]
pub async fn app_update_status<R: Runtime>(app: tauri::AppHandle<R>) -> Result<Status, IpcError> {
    let preferences = app.state::<Application>().update_preferences().await?;
    app.state::<Updates>()
        .status(preferences)
        .map_err(Into::into)
}

#[tauri::command]
pub async fn app_update_auto_check<R: Runtime>(
    app: tauri::AppHandle<R>,
    enabled: bool,
) -> Result<Status, IpcError> {
    let preferences = app
        .state::<Application>()
        .update_auto_check(enabled)
        .await?;
    app.state::<Updates>()
        .status(preferences)
        .map_err(Into::into)
}

#[tauri::command]
pub async fn app_update_check<R: Runtime>(
    app: tauri::AppHandle<R>,
    automatic: bool,
) -> Result<Status, IpcError> {
    let updates = app.state::<Updates>();
    let _operation = updates.operation.try_lock().map_err(|_| Error::Busy)?;
    updates.ensure_open()?;
    let application = app.state::<Application>();
    let preferences = application.update_preferences().await?;
    let at = now()?;
    let downloaded = updates.lock()?.bytes.is_some();
    if !supported() || (automatic && !preferences.should_check(at)) || downloaded {
        return updates.status(preferences).map_err(Into::into);
    }
    application.record_update_check(at, false).await?;
    let (cancel, mut cancelled) = watch::channel(false);
    {
        let mut inner = updates.lock()?;
        updates.ensure_open()?;
        inner.phase = Phase::Checking;
        inner.error = None;
        inner.cancel = Some(cancel);
    }
    let result = async {
        let logger = app.clone();
        let updater = app.updater_builder()
            .timeout(Duration::from_secs(20))
            .configure_client(|client| client.https_only(true))
            .version_comparator(|current, release| release.version > current && release.version.pre.is_empty())
            .on_before_exit(move || logger.state::<serverdeck_application::logging::Logger>().flush())
            .build().map_err(|error| failure("UPDATE_CONFIG", "更新器配置无效，请联系发布者", error))?;
        let update = tokio::select! {
            biased;
            _ = cancelled.changed() => return Err(crate::update_commands::cancelled("更新检查已取消")),
            result = updater.check() => result.map_err(|error| failure("UPDATE_CHECK", "无法检查更新，请检查网络或稍后重试", error))?,
        };
        if let Some(update) = &update {
            validate_download(&update.download_url, &update.version)?;
            if update.body.as_ref().is_some_and(|notes| notes.len() > 64 * 1024) {
                return Err(Error::Validation("更新说明超出大小限制"));
            }
        }
        application.record_update_check(now()?, true).await?;
        let mut inner = updates.lock()?;
        inner.phase = if update.is_some() { Phase::Available } else { Phase::UpToDate };
        inner.update = update;
        inner.cancel = None;
        Ok::<_, Error>(())
    }.await;
    if let Err(error) = result {
        updates.finish_error(&error)?;
        return Err(error.into());
    }
    updates
        .status(application.update_preferences().await?)
        .map_err(Into::into)
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
}

#[tauri::command]
pub async fn app_update_download<R: Runtime>(
    app: tauri::AppHandle<R>,
    events: tauri::ipc::Channel<Progress>,
) -> Result<Status, IpcError> {
    let updates = app.state::<Updates>();
    let _operation = updates.operation.try_lock().map_err(|_| Error::Busy)?;
    updates.ensure_open()?;
    if !supported() {
        return Err(Error::Validation("当前平台暂不支持应用内更新").into());
    }
    let (cancel, mut cancelled) = watch::channel(false);
    let mut update = {
        let mut inner = updates.lock()?;
        updates.ensure_open()?;
        if inner.bytes.is_some() || inner.phase == Phase::Installing {
            return Err(Error::Busy.into());
        }
        let update = inner
            .update
            .clone()
            .ok_or(Error::Validation("请先检查可用更新"))?;
        inner.phase = Phase::Downloading;
        inner.downloaded_bytes = 0;
        inner.total_bytes = None;
        inner.error = None;
        inner.cancel = Some(cancel.clone());
        update
    };
    update.timeout = Some(Duration::from_secs(600));
    let mut last_progress = Instant::now()
        .checked_sub(Duration::from_millis(100))
        .unwrap_or_else(Instant::now);
    let result = tokio::select! {
        biased;
        _ = cancelled.changed() => {
            if updates.lock()?.error.is_some() { Err(Error::Validation("更新包超出大小限制，已停止下载")) }
            else { Err(crate::update_commands::cancelled("更新下载已取消")) }
        },
        result = update.download(|chunk, total| {
            match updates.lock() {
                Ok(mut inner) => {
                    inner.downloaded_bytes += chunk as u64;
                    inner.total_bytes = total;
                    // Bound the in-memory package; never retain an unbounded response.
                    if inner.downloaded_bytes > 512 * 1024 * 1024 || total.is_some_and(|bytes| bytes > 512 * 1024 * 1024) {
                        inner.error = Some("更新包超出大小限制".into());
                        let _ = cancel.send(true);
                    }
                    if last_progress.elapsed() >= Duration::from_millis(100) || total == Some(inner.downloaded_bytes) {
                        last_progress = Instant::now();
                        if events.send(Progress { downloaded_bytes: inner.downloaded_bytes, total_bytes: total }).is_err() {
                            let _ = cancel.send(true);
                        }
                    }
                }
                Err(_) => { let _ = cancel.send(true); }
            }
        }, || {}) => result.map_err(|error| failure("UPDATE_DOWNLOAD", "更新包下载或签名验证失败，未安装更新；请重试", error)),
    };
    match result {
        Ok(bytes) if bytes.len() > 512 * 1024 * 1024 => {
            let error = Error::Validation("更新包超出大小限制，已停止下载");
            updates.finish_error(&error)?;
            return Err(error.into());
        }
        Ok(bytes) => {
            let mut inner = updates.lock()?;
            inner.bytes = Some(bytes);
            inner.phase = Phase::Ready;
            inner.cancel = None;
        }
        Err(error) => {
            updates.finish_error(&error)?;
            return Err(error.into());
        }
    }
    let preferences = app.state::<Application>().update_preferences().await?;
    updates.status(preferences).map_err(Into::into)
}

#[tauri::command]
pub fn app_update_cancel(updates: tauri::State<'_, Updates>) -> Result<(), IpcError> {
    updates.cancel().map_err(Into::into)
}

#[tauri::command]
pub fn app_update_install<R: Runtime>(
    app: tauri::AppHandle<R>,
    confirmed: bool,
) -> Result<(), IpcError> {
    if !supported() || !confirmed {
        return Err(Error::Validation("安装更新并重启需要明确确认").into());
    }
    let updates = app.state::<Updates>();
    let _operation = updates.operation.try_lock().map_err(|_| Error::Busy)?;
    updates.ensure_open()?;
    let mut inner = updates.lock()?;
    updates.ensure_open()?;
    if inner.phase != Phase::Ready || inner.bytes.is_none() {
        return Err(Error::Validation("请先完成更新包下载和验证").into());
    }
    if let Some(editors) = app.try_state::<crate::editor_commands::EditorWindows>() {
        editors.check_exit()?;
    }
    if app
        .state::<crate::storage_commands::StorageState>()
        .preparing
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return Err(Error::Busy.into());
    }
    inner.phase = Phase::Installing;
    drop(inner);
    app.state::<crate::file_commands::ExitApproval>()
        .0
        .store(true, std::sync::atomic::Ordering::Release);
    // The normal exit handler drains application resources before invoking the installer.
    app.exit(0);
    Ok(())
}
