use serverdeck_application::{Application, storage_location::Profile};
use serverdeck_core::{AppConfig, Error, IpcError, StorageInfo, StoragePreview};
use std::{
    path::PathBuf,
    sync::{
        Mutex,
        atomic::{AtomicBool, Ordering},
    },
};
use tauri::{Manager, Runtime};

pub struct StorageState {
    pub profile: Mutex<Profile>,
    pub restart: AtomicBool,
    pub preparing: AtomicBool,
}

impl StorageState {
    pub fn new(profile: Profile) -> Self {
        Self {
            profile: Mutex::new(profile),
            restart: AtomicBool::new(false),
            preparing: AtomicBool::new(false),
        }
    }
    pub fn info(&self) -> Result<StorageInfo, Error> {
        Ok(self.profile.lock().map_err(|_| Error::Busy)?.info())
    }
}

#[tauri::command]
pub async fn app_storage_preview<R: Runtime>(
    app: tauri::AppHandle<R>,
    application: tauri::State<'_, Application>,
    target_directory: String,
) -> Result<StoragePreview, IpcError> {
    let pending = application.exit_pending();
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<StorageState>();
        let profile = state.profile.lock().map_err(|_| Error::Busy)?;
        let mut preview = profile.preview(&PathBuf::from(target_directory))?;
        preview.unfinished_tasks = pending.0;
        preview.dirty_documents = pending.1;
        Ok::<_, Error>(preview)
    })
    .await
    .map_err(|e| IpcError::from(Error::Worker(Box::new(e))))?
    .map_err(Into::into)
}

#[tauri::command]
pub async fn app_storage_migrate<R: Runtime>(
    app: tauri::AppHandle<R>,
    application: tauri::State<'_, Application>,
    config: AppConfig,
    target_directory: String,
    confirmed: bool,
    discard_documents: bool,
) -> Result<bool, IpcError> {
    if !confirmed {
        return Err(Error::Validation("迁移数据并重启需要明确确认").into());
    }
    if application.has_external_editors()? {
        return Err(Error::Validation("请先结束外部编辑并关闭外部应用，再迁移数据目录").into());
    }
    if application.exit_pending().1 > 0 && !discard_documents {
        return Err(Error::Validation("请先保存文档，或明确确认放弃未保存修改").into());
    }
    config.validate()?;
    let state = app.state::<StorageState>();
    if state.preparing.swap(true, Ordering::AcqRel) {
        return Err(Error::Busy.into());
    }
    let result = async {
        // Validate before saving preferences. Prepare revalidates after the write.
        let handle = app.clone();
        let target = target_directory.clone();
        tauri::async_runtime::spawn_blocking(move || {
            handle
                .state::<StorageState>()
                .profile
                .lock()
                .map_err(|_| Error::Busy)?
                .preview(&PathBuf::from(target))
        })
        .await
        .map_err(|e| Error::Worker(Box::new(e)))??;
        application.save_config(config).await?;
        let handle = app.clone();
        let changed = tauri::async_runtime::spawn_blocking(move || {
            handle
                .state::<StorageState>()
                .profile
                .lock()
                .map_err(|_| Error::Busy)?
                .prepare(&PathBuf::from(target_directory))
        })
        .await
        .map_err(|e| Error::Worker(Box::new(e)))?
        .map_err(|error| Error::Connection {
            code: "STORAGE_MIGRATION_PREPARE",
            message: "设置已保存，但无法登记目录迁移；当前目录继续使用，请重试",
            source: Some(Box::new(error)),
        })?;
        if changed {
            state.restart.store(true, Ordering::Release);
            app.state::<crate::file_commands::ExitApproval>()
                .0
                .store(true, Ordering::Release);
            // Ordinary exit first: Tauri restart requests cannot be deferred for draining.
            app.exit(0);
        }
        Ok::<_, Error>(changed)
    }
    .await;
    if !matches!(result, Ok(true)) {
        state.preparing.store(false, Ordering::Release);
    }
    result.map_err(Into::into)
}

#[tauri::command]
pub async fn app_storage_ready<R: Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<StorageInfo, IpcError> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<StorageState>()
            .profile
            .lock()
            .map_err(|_| Error::Busy)?
            .ready()
    })
    .await
    .map_err(|e| IpcError::from(Error::Worker(Box::new(e))))?
    .map_err(Into::into)
}
