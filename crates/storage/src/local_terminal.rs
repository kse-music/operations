use super::*;
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LocalTerminalDirectory {
    version: u32,
    directory: String,
}

fn decode(json: &str) -> Result<String, Error> {
    let stored: LocalTerminalDirectory = serde_json::from_str(json).map_err(storage_error)?;
    if stored.version != 1 {
        return Err(Error::Validation("不支持的本地终端目录记录版本"));
    }
    validate_directory(&stored.directory)?;
    Ok(stored.directory)
}

fn validate_directory(directory: &str) -> Result<(), Error> {
    if directory.len() > 32768
        || !Path::new(directory).is_absolute()
        || directory.chars().any(char::is_control)
    {
        return Err(Error::Validation("本地终端工作目录无效"));
    }
    Ok(())
}

impl Database {
    pub fn local_terminal_directory(&self) -> Result<Option<String>, Error> {
        self.connect()?
            .query_row(
                "SELECT value FROM application_settings WHERE key='local_terminal_directory'",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(storage_error)?
            .as_deref()
            .map(decode)
            .transpose()
    }

    pub fn save_local_terminal_directory(&self, directory: &str) -> Result<(), Error> {
        validate_directory(directory)?;
        let mut connection = self.connect()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_error)?;
        // Refuse to overwrite corrupt or future records, including a concurrent external edit.
        let previous = transaction
            .query_row(
                "SELECT value FROM application_settings WHERE key='local_terminal_directory'",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(storage_error)?;
        if let Some(json) = previous {
            decode(&json)?;
        }
        let stored = LocalTerminalDirectory {
            version: 1,
            directory: directory.to_owned(),
        };
        transaction
            .execute(
                "INSERT INTO application_settings(key,value) VALUES('local_terminal_directory',?1)
                 ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                [serde_json::to_string(&stored).map_err(storage_error)?],
            )
            .map_err(storage_error)?;
        transaction.commit().map_err(storage_error)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn directory_survives_reopen_without_changing_config_or_schema() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("app.sqlite3");
        let db = Database::open(&path).unwrap();
        let config = db.load_config().unwrap();
        assert_eq!(db.local_terminal_directory().unwrap(), None);
        let directory = root
            .path()
            .join("中文 space '&;$[]")
            .to_str()
            .unwrap()
            .to_owned();
        // A missing directory remains valid history; availability is checked at shell startup.
        db.save_local_terminal_directory(&directory).unwrap();
        let reopened = Database::open(&path).unwrap();
        assert_eq!(
            reopened.local_terminal_directory().unwrap(),
            Some(directory)
        );
        assert_eq!(reopened.load_config().unwrap(), config);
        assert_eq!(
            reopened.version().unwrap(),
            serverdeck_core::DATABASE_VERSION
        );
        assert!(
            reopened
                .save_local_terminal_directory("relative/path")
                .is_err()
        );
        assert!(reopened.save_local_terminal_directory("\0").is_err());
    }

    #[test]
    fn invalid_records_are_isolated_and_never_overwritten() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("app.sqlite3");
        let db = Database::open(&path).unwrap();
        let valid_directory = root.path().to_str().unwrap();
        for json in [
            r#"{"version":99,"directory":"/tmp"}"#,
            r#"{"version":1,"directory":"/tmp","unknown":true}"#,
            r#"{"version":1,"directory":"relative"}"#,
            r#"{"version":1,"directory":"/tmp\ncommand"}"#,
            r#"{"version":1,"version":1,"directory":"/tmp"}"#,
            "{broken",
        ] {
            db.connect().unwrap().execute(
                "INSERT OR REPLACE INTO application_settings(key,value) VALUES('local_terminal_directory',?1)",
                [json],
            ).unwrap();
            let reopened = Database::open(&path).unwrap();
            assert!(reopened.local_terminal_directory().is_err());
            assert!(
                reopened
                    .save_local_terminal_directory(valid_directory)
                    .is_err()
            );
            let unchanged: String = reopened
                .connect()
                .unwrap()
                .query_row(
                    "SELECT value FROM application_settings WHERE key='local_terminal_directory'",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(unchanged, json);
        }
    }
}
