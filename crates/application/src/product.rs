use super::*;
use serverdeck_core::product::*;
impl Application {
    pub async fn update_preferences(
        &self,
    ) -> Result<serverdeck_core::updates::UpdatePreferences, Error> {
        self.blocking(|db| db.update_preferences()).await
    }

    pub async fn update_auto_check(
        &self,
        enabled: bool,
    ) -> Result<serverdeck_core::updates::UpdatePreferences, Error> {
        self.blocking(move |db| {
            let mut preferences = db.update_preferences()?;
            preferences.auto_check = enabled;
            db.save_update_preferences(&preferences)?;
            Ok(preferences)
        })
        .await
    }

    pub async fn record_update_check(&self, at: u64, completed: bool) -> Result<(), Error> {
        self.blocking(move |db| {
            let mut preferences = db.update_preferences()?;
            if completed {
                preferences.last_checked_at = Some(at);
            } else {
                preferences.last_attempt_at = Some(at);
            }
            db.save_update_preferences(&preferences)
        })
        .await
    }
    pub fn background_tasks(&self) -> Result<BackgroundSnapshot, Error> {
        Ok(BackgroundSnapshot {
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
