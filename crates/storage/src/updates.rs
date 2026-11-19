use super::*;
use serverdeck_core::updates::UpdatePreferences;

#[derive(serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UpdateNotice {
    version: u32,
    ignored_release: String,
}

impl UpdateNotice {
    fn validate(&self) -> Result<(), Error> {
        if self.version != 1 {
            return Err(Error::UnsupportedConfig(self.version));
        }
        if self.ignored_release.is_empty()
            || self.ignored_release.len() > 128
            || !self
                .ignored_release
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'+' | b'-'))
        {
            return Err(Error::Validation("忽略的更新版本无效"));
        }
        Ok(())
    }

    fn load(connection: &Connection) -> Result<Option<Self>, Error> {
        let raw = connection
            .query_row(
                "SELECT value FROM application_settings WHERE key='software_update_notice'",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(storage_error)?;
        raw.map(|raw| {
            let notice: Self = serde_json::from_str(&raw).map_err(storage_error)?;
            notice.validate()?;
            Ok(notice)
        })
        .transpose()
    }
}

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

    pub fn ignored_update_version(&self) -> Result<Option<String>, Error> {
        Ok(UpdateNotice::load(&self.connect()?)?.map(|notice| notice.ignored_release))
    }

    pub fn ignore_update_version(&self, version: String) -> Result<(), Error> {
        let notice = UpdateNotice {
            version: 1,
            ignored_release: version,
        };
        notice.validate()?;
        let mut connection = self.connect()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_error)?;
        UpdateNotice::load(&transaction)?;
        transaction
            .execute(
                "INSERT INTO application_settings(key,value) VALUES('software_update_notice',?1)
                 ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                [serde_json::to_string(&notice).map_err(storage_error)?],
            )
            .map_err(storage_error)?;
        transaction.commit().map_err(storage_error)
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
        assert!(db.update_preferences().unwrap().allows_check(true));
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
    fn ignored_releases_are_saved_independently_and_survive_reopen() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("app.sqlite3");
        let db = Database::open(&path).unwrap();
        let preferences = UpdatePreferences {
            last_attempt_at: Some(100),
            last_checked_at: Some(101),
            ..Default::default()
        };
        db.save_update_preferences(&preferences).unwrap();
        assert_eq!(db.ignored_update_version().unwrap(), None);
        db.ignore_update_version("1.2.3".into()).unwrap();
        let reopened = Database::open(path).unwrap();
        assert_eq!(
            reopened.ignored_update_version().unwrap().as_deref(),
            Some("1.2.3")
        );
        assert_eq!(reopened.update_preferences().unwrap(), preferences);
        reopened.ignore_update_version("1.2.4".into()).unwrap();
        assert_eq!(
            reopened.ignored_update_version().unwrap().as_deref(),
            Some("1.2.4")
        );
    }

    #[test]
    fn unsupported_notice_preferences_are_kept_without_blocking_update_preferences() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("app.sqlite3");
        let db = Database::open(&path).unwrap();
        let future = r#"{"version":2,"ignoredRelease":"1.2.3"}"#;
        db.connect()
            .unwrap()
            .execute(
                "INSERT INTO application_settings(key,value) VALUES('software_update_notice',?1)",
                [future],
            )
            .unwrap();
        let reopened = Database::open(path).unwrap();
        assert!(reopened.update_preferences().unwrap().auto_check);
        assert!(reopened.ignored_update_version().is_err());
        assert!(reopened.ignore_update_version("1.2.4".into()).is_err());
        let raw: String = reopened
            .connect()
            .unwrap()
            .query_row(
                "SELECT value FROM application_settings WHERE key='software_update_notice'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(raw, future);
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
