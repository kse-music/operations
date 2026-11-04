use super::*;
impl Database {
    pub fn bundled_plugin_provisioned(&self, id: &str) -> Result<bool, Error> {
        let value: Option<String> = self
            .connect()?
            .query_row(
                "SELECT value FROM application_settings WHERE key=?1",
                [format!("bundled_plugin:{id}")],
                |row| row.get(0),
            )
            .optional()
            .map_err(storage_error)?;
        value
            .map(|value| serde_json::from_str(&value).map_err(storage_error))
            .transpose()
            .map(|value| value.unwrap_or(false))
    }
    pub fn mark_bundled_plugin_provisioned(&self, id: &str) -> Result<(), Error> {
        self.connect()?.execute("INSERT INTO application_settings(key,value) VALUES (?1,'true') ON CONFLICT(key) DO UPDATE SET value='true'", [format!("bundled_plugin:{id}")]).map_err(storage_error)?;
        Ok(())
    }
}
