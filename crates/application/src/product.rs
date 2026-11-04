use super::*;
use serverdeck_core::{backup::*, product::*};
impl Application {
    pub async fn backup_export(&self) -> Result<String, Error> {
        self.blocking(|db| db.backup_export()).await
    }
    pub async fn backup_preview(&self, text: String) -> Result<BackupPreview, Error> {
        self.blocking(move |db| db.backup_preview(&text)).await
    }
    pub async fn backup_restore(&self, input: RestoreInput) -> Result<RestoreResult, Error> {
        let restore = input.restore_preferences;
        let result = self.blocking(move |db| db.backup_restore(input)).await?;
        if restore {
            let config = self.blocking(|db| db.load_config()).await?;
            self.files.transfers.configure(config.transfer_concurrency);
            self.configure_monitors(config.monitor_interval_secs)?;
        }
        Ok(result)
    }
    pub fn background_tasks(&self) -> Result<BackgroundSnapshot, Error> {
        Ok(BackgroundSnapshot {
            tasks: self.tasks.summary()?,
            connections: self.terminals.connection_status()?,
        })
    }
    pub async fn window_geometry(&self) -> Result<Option<WindowGeometry>, Error> {
        self.blocking(|db| db.window_geometry()).await
    }
    pub async fn save_window_geometry(&self, g: WindowGeometry) -> Result<(), Error> {
        self.blocking(move |db| db.save_window_geometry(g)).await
    }
}
