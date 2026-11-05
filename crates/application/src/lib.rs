mod ai;
mod bundled_plugins;
mod files;
mod hosts;
pub mod identity;
mod local_terminal;
pub mod logging;
mod monitor;
mod ops;
mod plugins;
mod product;
mod tasks;
mod terminal;
mod terminal_upload;
pub use hosts::SecureStatus;
pub use plugins::{
    Approval as PluginApproval, ContextInput as PluginContextInput, Event as PluginEvent,
    ToolInput, ToolTicket,
};

use std::{
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

use serverdeck_core::{AppConfig, Bootstrap, Error};
use serverdeck_security::{NativeStore, SecretStore};
use serverdeck_storage::Database;
use tokio::sync::Semaphore;

#[derive(Clone)]
pub struct Application {
    plugins: serverdeck_plugin_core::Repository,
    plugin_runtime: serverdeck_plugin_runtime::Runtime,
    plugin_host: plugins::state::Host,
    assistant: serverdeck_ai::Assistant,
    terminal_uploads: terminal_upload::TerminalUploads,
    local_terminals: local_terminal::LocalTerminals,
    terminals: serverdeck_ssh::Engine,
    files: serverdeck_sftp::Files,
    monitors: serverdeck_monitor::Monitors,
    operations_host: serverdeck_ops::Operations,
    tasks: serverdeck_tasks::Tasks,
    database: Database,
    secrets: Arc<dyn SecretStore>,
    data_directory: PathBuf,
    log_directory: PathBuf,
    // Reject excess calls instead of accumulating an unbounded work queue.
    operations: Arc<Semaphore>,
    queued_operations: Arc<Semaphore>,
    shutting_down: Arc<AtomicBool>,
}

impl Application {
    pub fn initialize(data_directory: PathBuf, log_directory: PathBuf) -> Result<Self, Error> {
        // These are application-owned leaf directories, never an arbitrary parent such as HOME.
        private_directory(&data_directory)?;
        private_directory(&log_directory)?;
        let database = Database::open(data_directory.join("serverdeck.sqlite3"))?;
        let terminals = serverdeck_ssh::Engine::new(database.clone());
        let files = serverdeck_sftp::Files::new(
            terminals.clone(),
            database.load_config()?.transfer_concurrency,
        );
        let monitors = serverdeck_monitor::Monitors::new(terminals.clone());
        let operations_host = serverdeck_ops::Operations::new(terminals.clone());
        let tasks = serverdeck_tasks::Tasks::new(terminals.clone());
        let plugins = serverdeck_plugin_core::Repository::open(data_directory.join("plugins"))?;
        Ok(Self {
            plugin_runtime: serverdeck_plugin_runtime::Runtime::new(plugins.clone()),
            plugin_host: plugins::state::Host::default(),
            plugins,
            assistant: serverdeck_ai::Assistant::default(),
            terminal_uploads: terminal_upload::TerminalUploads::default(),
            local_terminals: local_terminal::LocalTerminals::new(),
            tasks,
            operations_host,
            monitors,
            terminals,
            files,
            database,
            secrets: Arc::new(NativeStore),
            data_directory,
            log_directory,
            operations: Arc::new(Semaphore::new(1)),
            queued_operations: Arc::new(Semaphore::new(16)),
            shutting_down: Arc::new(AtomicBool::new(false)),
        })
    }

    async fn blocking<T, F>(&self, operation: F) -> Result<T, Error>
    where
        T: Send + 'static,
        F: FnOnce(Database) -> Result<T, Error> + Send + 'static,
    {
        if self.shutting_down.load(Ordering::Acquire) {
            return Err(Error::ShuttingDown);
        }
        let slot = self
            .queued_operations
            .clone()
            .try_acquire_owned()
            .map_err(|_| Error::Busy)?;
        let permit = tokio::time::timeout(
            std::time::Duration::from_secs(3),
            self.operations.clone().acquire_owned(),
        )
        .await
        .map_err(|_| Error::Busy)?
        .map_err(|_| Error::ShuttingDown)?;
        if self.shutting_down.load(Ordering::Acquire) {
            return Err(Error::ShuttingDown);
        }
        let database = self.database.clone();
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            let _slot = slot;
            operation(database)
        })
        .await
        .map_err(|error| {
            tracing::error!(
                operation = "database_worker",
                panic = error.is_panic(),
                cancelled = error.is_cancelled(),
                "background database worker failed"
            );
            Error::Worker(Box::new(error))
        })?
    }

    pub async fn bootstrap(&self) -> Result<Bootstrap, Error> {
        let (config, database_version) = self
            .blocking(|database| Ok((database.load_config()?, database.version()?)))
            .await?;
        Ok(Bootstrap {
            app_version: env!("CARGO_PKG_VERSION").to_owned(),
            database_version,
            data_directory: self.data_directory.to_string_lossy().into_owned(),
            log_directory: self.log_directory.to_string_lossy().into_owned(),
            config,
        })
    }

    pub async fn save_config(&self, config: AppConfig) -> Result<AppConfig, Error> {
        config.validate()?;
        let concurrency = config.transfer_concurrency;
        let interval = config.monitor_interval_secs;
        let saved = self
            .blocking(move |database| {
                database.save_config(&config)?;
                tracing::info!(operation = "config_save", "preferences saved");
                Ok(config)
            })
            .await?;
        self.files.transfers.configure(concurrency);
        self.configure_monitors(interval)?;
        Ok(saved)
    }

    pub async fn shutdown(&self) {
        self.shutting_down.store(true, Ordering::Release);
        match self.plugin_host.ids() {
            Ok(ids) => {
                for id in ids {
                    if let Err(error) = self.plugin_stop_resources(&id).await {
                        tracing::error!(operation="plugin_capability_shutdown", error=%error);
                    }
                }
            }
            Err(error) => tracing::error!(operation="plugin_capability_shutdown", error=%error),
        }
        if let Err(error) = self.plugin_runtime.shutdown().await {
            tracing::error!(operation = "plugin_shutdown", error = %error);
        }
        self.assistant.shutdown().await;
        if let Err(error) = self.terminal_uploads.clear() {
            tracing::error!(operation = "terminal_upload_shutdown", error = %error);
        }
        if let Err(error) = self.local_terminals.close_all(true).await {
            tracing::error!(operation = "local_terminal_shutdown", error = %error);
        }
        self.tasks.shutdown().await;
        self.operations_host.shutdown().await;
        self.monitors.shutdown().await;
        self.files.shutdown().await;
        self.terminals.shutdown().await;
        // Drain an in-flight local metadata write after cancelling all SSH sessions.
        if let Ok(_permit) = self.operations.acquire().await {
            tracing::info!(operation = "shutdown", "application work drained");
        }
    }
}

fn private_directory(path: &std::path::Path) -> Result<(), Error> {
    std::fs::create_dir_all(path).map_err(|error| Error::Storage(Box::new(error)))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let metadata =
            std::fs::symlink_metadata(path).map_err(|error| Error::Storage(Box::new(error)))?;
        if metadata.file_type().is_symlink() {
            return Err(Error::Validation("应用数据及日志目录不能是符号链接"));
        }
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
            .map_err(|error| Error::Storage(Box::new(error)))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serverdeck_core::Theme;
    #[tokio::test(flavor = "multi_thread")]
    async fn foreground_metadata_waits_for_layout_save_without_spurious_busy() {
        let dir = tempfile::tempdir().expect("dir");
        let app = Application::initialize(dir.path().join("data"), dir.path().join("logs"))
            .expect("application");
        let (started, ready) = tokio::sync::oneshot::channel();
        let (release, waiting) = std::sync::mpsc::channel();
        let writer = app.clone();
        let first = tokio::spawn(async move {
            writer
                .blocking(move |db| {
                    let _ = started.send(());
                    waiting
                        .recv_timeout(std::time::Duration::from_secs(3))
                        .expect("release");
                    db.load_config()
                })
                .await
        });
        ready.await.expect("started");
        let reader = app.clone();
        let second = tokio::spawn(async move { reader.bootstrap().await });
        tokio::task::yield_now().await;
        assert!(
            !second.is_finished(),
            "read should wait instead of returning BUSY"
        );
        release.send(()).expect("release");
        first.await.expect("writer").expect("saved");
        second
            .await
            .expect("reader")
            .expect("foreground read succeeds");
    }

    #[tokio::test]
    async fn bootstrap_roundtrip_and_shutdown_rejection() {
        let directory = tempfile::tempdir().expect("tempdir");
        let app =
            Application::initialize(directory.path().join("data"), directory.path().join("logs"))
                .expect("initialize");
        let bootstrap = app.bootstrap().await.expect("bootstrap");
        assert_eq!(
            bootstrap.database_version,
            serverdeck_core::DATABASE_VERSION
        );
        let config = AppConfig {
            theme: Theme::System,
            ..bootstrap.config
        };
        assert_eq!(app.save_config(config.clone()).await.expect("save"), config);
        assert_eq!(app.bootstrap().await.expect("reload").config, config);
        app.shutdown().await;
        assert!(matches!(app.bootstrap().await, Err(Error::ShuttingDown)));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn shutdown_drains_an_inflight_write_and_rejects_new_work() {
        let directory = tempfile::tempdir().expect("tempdir");
        let app =
            Application::initialize(directory.path().join("data"), directory.path().join("logs"))
                .expect("initialize");
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let config = AppConfig {
            theme: Theme::Light,
            ..Default::default()
        };
        let expected = config.clone();
        let writer = {
            let app = app.clone();
            tokio::spawn(async move {
                app.blocking(move |database| {
                    started_tx.send(()).expect("started");
                    release_rx
                        .recv_timeout(std::time::Duration::from_secs(5))
                        .expect("release");
                    database.save_config(&config)
                })
                .await
            })
        };
        started_rx.await.expect("writer started");
        let shutdown = {
            let app = app.clone();
            tokio::spawn(async move { app.shutdown().await })
        };
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            while !app.shutting_down.load(Ordering::Acquire) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("shutdown started");
        assert!(!shutdown.is_finished());
        assert!(matches!(app.bootstrap().await, Err(Error::ShuttingDown)));
        release_tx.send(()).expect("release");
        writer.await.expect("join writer").expect("saved");
        shutdown.await.expect("join shutdown");
        assert_eq!(app.database.load_config().expect("persisted"), expected);
    }
}

#[cfg(all(test, unix))]
mod private_directory_tests {
    use super::*;
    use std::os::unix::fs::{PermissionsExt, symlink};
    #[test]
    fn tightens_only_owned_leaf_and_rejects_symlink() {
        let root = tempfile::tempdir().expect("temp");
        let leaf = root.path().join("data");
        std::fs::create_dir(&leaf).expect("dir");
        std::fs::set_permissions(&leaf, std::fs::Permissions::from_mode(0o755))
            .expect("legacy mode");
        private_directory(&leaf).expect("private directory");
        assert_eq!(
            std::fs::metadata(&leaf)
                .expect("metadata")
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        let link = root.path().join("link");
        symlink(&leaf, &link).expect("link");
        assert!(private_directory(&link).is_err());
    }
}
