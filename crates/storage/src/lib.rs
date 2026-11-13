use std::{
    path::{Path, PathBuf},
    time::Duration,
};

use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
pub mod ai;
mod config_migrations;
pub mod hosts;
mod local_terminal;
mod migrations;
pub mod plugins;
pub mod trust;
pub mod updates;
use serverdeck_core::{AppConfig, Error, product::WindowGeometry};

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
    /// Check a closed migration copy without creating, migrating or rewriting it.
    pub fn verify_file(path: &Path) -> Result<(), Error> {
        let connection =
            Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
                .map_err(storage_error)?;
        migrations::verify(&connection)
    }

    pub fn open(path: impl AsRef<Path>) -> Result<Self, Error> {
        let database = Self {
            path: if path.as_ref().is_absolute() {
                path.as_ref().to_owned()
            } else {
                std::env::current_dir().map_err(storage_error)?.join(path)
            },
        };
        migrations::check_path(&database.path)?;
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
        migrations::upgrade(&database, &mut connection)?;
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

    pub fn window_geometry(&self) -> Result<Option<WindowGeometry>, Error> {
        let json = self
            .connect()?
            .query_row(
                "SELECT value FROM application_settings WHERE key='window_geometry'",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(storage_error)?;
        json.map(|json| {
            let geometry: WindowGeometry = serde_json::from_str(&json).map_err(storage_error)?;
            geometry.validate()?;
            Ok(geometry)
        })
        .transpose()
    }

    pub fn save_window_geometry(&self, geometry: WindowGeometry) -> Result<(), Error> {
        geometry.validate()?;
        self.connect()?
            .execute(
                "INSERT INTO application_settings(key,value) VALUES('window_geometry',?1)
                 ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                [serde_json::to_string(&geometry).map_err(storage_error)?],
            )
            .map_err(storage_error)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serverdeck_core::DATABASE_VERSION;

    #[test]
    fn current_schema_initializes_once_and_settings_survive_reopen() {
        let directory = tempfile::tempdir().expect("tempdir");
        let path = directory.path().join("nested/serverdeck.sqlite3");
        let database = Database::open(&path).expect("open");
        assert_eq!(database.version().expect("version"), DATABASE_VERSION);
        let config = AppConfig {
            theme: serverdeck_core::Theme::Light,
            interface_font_size: serverdeck_core::InterfaceFontSize::UltraLarge,
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
    fn unrelated_or_unversioned_databases_are_rejected_without_changes() {
        for version in 0..DATABASE_VERSION {
            let directory = tempfile::tempdir().unwrap();
            let path = directory.path().join("unsupported.sqlite3");
            let connection = Connection::open(&path).unwrap();
            connection
                .execute_batch(
                    "CREATE TABLE retained(value TEXT); INSERT INTO retained VALUES('keep');",
                )
                .unwrap();
            connection
                .pragma_update(None, "user_version", version)
                .unwrap();
            assert!(Database::open(&path).is_err());
            assert_eq!(
                connection
                    .query_row("SELECT value FROM retained", [], |row| row
                        .get::<_, String>(0))
                    .unwrap(),
                "keep"
            );
            assert_eq!(
                connection
                    .pragma_query_value(None, "user_version", |row| row.get::<_, u32>(0))
                    .unwrap(),
                version
            );
            assert_eq!(
                connection
                    .query_row(
                        "SELECT count(*) FROM sqlite_master WHERE type='table'",
                        [],
                        |row| row.get::<_, u32>(0)
                    )
                    .unwrap(),
                1
            );
        }
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
        assert!(matches!(Database::open(path), Err(Error::Migration { .. })));
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
