use super::*;
use serverdeck_core::product::*;
impl Application {
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
