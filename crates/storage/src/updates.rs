use super::*;
use serverdeck_core::updates::UpdatePreferences;

impl Database {
    pub fn update_preferences(&self) -> Result<UpdatePreferences, Error> {
        let json = self
            .connect()?
            .query_row(
                "SELECT value FROM application_settings WHERE key='software_updates'",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(storage_error)?;
        let preferences: UpdatePreferences = json
            .map(|json| serde_json::from_str(&json).map_err(storage_error))
            .transpose()?
            .unwrap_or_default();
        preferences.validate()?;
        Ok(preferences)
    }

    pub fn save_update_preferences(&self, preferences: &UpdatePreferences) -> Result<(), Error> {
        preferences.validate()?;
        self.connect()?
            .execute(
                "INSERT INTO application_settings(key,value) VALUES('software_updates',?1)
             ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                [serde_json::to_string(preferences).map_err(storage_error)?],
            )
            .map_err(storage_error)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn update_preferences_preserve_config_and_survive_reopen() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("app.sqlite3");
        let db = Database::open(&path).unwrap();
        let config = db.load_config().unwrap();
        assert!(db.update_preferences().unwrap().should_check(100_000));
        let preferences = UpdatePreferences {
            auto_check: false,
            last_attempt_at: Some(100),
            last_checked_at: Some(90),
            ..Default::default()
        };
        db.save_update_preferences(&preferences).unwrap();
        let reopened = Database::open(path).unwrap();
        assert_eq!(reopened.update_preferences().unwrap(), preferences);
        assert_eq!(reopened.load_config().unwrap(), config);
        assert_eq!(
            reopened.version().unwrap(),
            serverdeck_core::DATABASE_VERSION
        );
    }

    #[test]
    fn invalid_update_preferences_are_not_reset_or_loaded_at_startup() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("app.sqlite3");
        let db = Database::open(&path).unwrap();
        let json = r#"{"version":99,"autoCheck":true,"lastAttemptAt":null,"lastCheckedAt":null}"#;
        db.connect()
            .unwrap()
            .execute(
                "INSERT INTO application_settings(key,value) VALUES('software_updates',?1)",
                [json],
            )
            .unwrap();
        let reopened = Database::open(&path).unwrap();
        assert!(reopened.update_preferences().is_err());
        assert_eq!(
            reopened
                .connect()
                .unwrap()
                .query_row(
                    "SELECT value FROM application_settings WHERE key='software_updates'",
                    [],
                    |row| row.get::<_, String>(0)
                )
                .unwrap(),
            json
        );
    }
}
