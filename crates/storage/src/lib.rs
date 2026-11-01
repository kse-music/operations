use std::{
    path::{Path, PathBuf},
    time::Duration,
};

use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
pub mod automation;
pub mod backup;
pub mod hosts;
pub mod trust;
pub mod workspace;
use serverdeck_core::{AppConfig, DATABASE_VERSION, Error};

#[derive(Clone)]
pub struct Database {
    path: PathBuf,
}

pub(crate) fn storage_error<E: std::error::Error + Send + Sync + 'static>(error: E) -> Error {
    // Keep the source chain in Rust, logging only metadata without SQL values or paths.
    let source: &(dyn std::error::Error + 'static) = &error;
    if let Some(rusqlite::Error::SqliteFailure(code, _)) = source.downcast_ref::<rusqlite::Error>()
    {
        tracing::error!(
            operation = "storage",
            category = "sqlite",
            code = code.extended_code,
            "local storage operation failed"
        );
    } else if let Some(error) = source.downcast_ref::<std::io::Error>() {
        tracing::error!(operation = "storage", category = "io", kind = ?error.kind(), "local storage operation failed");
    } else if let Some(error) = source.downcast_ref::<serde_json::Error>() {
        tracing::error!(operation = "storage", category = "config_json", kind = ?error.classify(), line = error.line(), column = error.column(), "local storage operation failed");
    } else {
        tracing::error!(
            operation = "storage",
            category = "database_contract",
            "local storage operation failed"
        );
    }
    Error::Storage(Box::new(error))
}

impl Database {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, Error> {
        let database = Self {
            path: path.as_ref().to_owned(),
        };
        if let Some(parent) = database.path.parent() {
            std::fs::create_dir_all(parent).map_err(storage_error)?;
        }
        let mut connection = database.connect()?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&database.path, std::fs::Permissions::from_mode(0o600))
                .map_err(storage_error)?;
        }
        // A write transaction serializes concurrent application startups/migrations.
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_error)?;
        let version: u32 = transaction
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .map_err(storage_error)?;
        if version > DATABASE_VERSION {
            return Err(Error::UnsupportedDatabase(version));
        }
        if version == 0 {
            transaction
                .execute_batch(include_str!("../migrations/001_settings.sql"))
                .map_err(storage_error)?;
        }
        if version < 2 {
            transaction
                .execute_batch(include_str!("../migrations/002_hosts.sql"))
                .map_err(storage_error)?;
        }
        if version < 3 {
            transaction
                .execute_batch(include_str!("../migrations/003_known_hosts.sql"))
                .map_err(storage_error)?;
        }
        if version < 4 {
            transaction
                .execute_batch(include_str!("../migrations/004_terminal_workspace.sql"))
                .map_err(storage_error)?;
        }
        if version < 5 {
            transaction
                .execute_batch(include_str!("../migrations/005_automation.sql"))
                .map_err(storage_error)?;
        }
        transaction
            .pragma_update(None, "user_version", DATABASE_VERSION)
            .map_err(storage_error)?;
        transaction.commit().map_err(storage_error)?;
        database.load_config()?;
        Ok(database)
    }

    pub(crate) fn connect(&self) -> Result<Connection, Error> {
        let connection = Connection::open(&self.path).map_err(storage_error)?;
        connection
            .busy_timeout(Duration::from_secs(5))
            .map_err(storage_error)?;
        connection
            .pragma_update(None, "foreign_keys", true)
            .map_err(storage_error)?;
        // A single small settings store does not need WAL or a connection pool yet.
        Ok(connection)
    }

    pub fn version(&self) -> Result<u32, Error> {
        self.connect()?
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .map_err(storage_error)
    }

    pub fn load_config(&self) -> Result<AppConfig, Error> {
        let connection = self.connect()?;
        let json: Option<String> = connection
            .query_row(
                "SELECT value FROM application_settings WHERE key = 'app_config'",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(storage_error)?;
        let config = match json {
            Some(json) => serde_json::from_str::<AppConfig>(&json).map_err(storage_error)?,
            None => {
                let config = AppConfig::default();
                let json = serde_json::to_string(&config).map_err(storage_error)?;
                connection.execute(
                    "INSERT OR IGNORE INTO application_settings (key, value) VALUES ('app_config', ?1)",
                    [json],
                ).map_err(storage_error)?;
                return self.load_config();
            }
        };
        config.validate()?;
        Ok(config)
    }

    pub fn save_config(&self, config: &AppConfig) -> Result<(), Error> {
        config.validate()?;
        if let Some(id) = config
            .product
            .ssh_defaults
            .proxy
            .as_ref()
            .and_then(|p| p.credential_id.as_ref())
        {
            match self.credential_record(id) {
                Ok(r) if r.public.kind == serverdeck_core::hosts::AuthType::Password => (),
                Ok(_) | Err(Error::NotFound) => {
                    return Err(Error::Validation("全局默认代理必须关联现有安全密码凭据"));
                }
                Err(error) => return Err(error),
            }
        }
        let json = serde_json::to_string(config).map_err(storage_error)?;
        self.connect()?
            .execute(
                "INSERT INTO application_settings (key, value) VALUES ('app_config', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value,
               updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
                params![json],
            )
            .map_err(storage_error)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migration_is_idempotent_and_settings_survive_reopen() {
        let directory = tempfile::tempdir().expect("tempdir");
        let path = directory.path().join("nested/serverdeck.sqlite3");
        let database = Database::open(&path).expect("open");
        assert_eq!(database.version().expect("version"), DATABASE_VERSION);
        let config = AppConfig {
            theme: serverdeck_core::Theme::Light,
            ..Default::default()
        };
        database.save_config(&config).expect("save");
        let reopened = Database::open(&path).expect("reopen");
        assert_eq!(reopened.load_config().expect("load"), config);
        let invalid = AppConfig {
            sidebar_width: 0,
            ..config.clone()
        };
        assert!(reopened.save_config(&invalid).is_err());
        assert_eq!(reopened.load_config().expect("unchanged"), config);
    }

    #[test]
    fn newer_database_is_not_downgraded() {
        let directory = tempfile::tempdir().expect("tempdir");
        let path = directory.path().join("future.sqlite3");
        let connection = Connection::open(&path).expect("open");
        connection
            .pragma_update(None, "user_version", 99)
            .expect("set version");
        assert!(matches!(
            Database::open(&path),
            Err(Error::UnsupportedDatabase(99))
        ));
        let count: u32 = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table'",
                [],
                |row| row.get(0),
            )
            .expect("tables");
        assert_eq!(count, 0);
    }

    #[test]
    fn corrupt_settings_are_not_silently_reset() {
        let directory = tempfile::tempdir().expect("tempdir");
        let path = directory.path().join("corrupt.sqlite3");
        Database::open(&path).expect("open");
        let connection = Connection::open(&path).expect("connection");
        connection
            .execute("UPDATE application_settings SET value = 'broken'", [])
            .expect("corrupt");
        assert!(matches!(Database::open(path), Err(Error::Storage(_))));
    }
}

#[cfg(all(test, unix))]
mod private_database_tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    #[test]
    fn existing_database_is_tightened_before_writes() {
        let directory = tempfile::tempdir().expect("directory");
        let path = directory.path().join("legacy.sqlite3");
        let database = Database::open(&path).expect("create");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644))
            .expect("legacy permission");
        drop(database);
        Database::open(&path).expect("reopen");
        assert_eq!(
            std::fs::metadata(&path)
                .expect("metadata")
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
}
