use super::*;
use serde::{Deserialize, Serialize};
use serverdeck_core::files::{FileSide, remote_absolute, valid_path};
use std::path::Path;

const VERSION: u32 = 1;

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct SavedDirectory {
    version: u32,
    path: String,
}

pub(super) fn key(host_id: &str, side: FileSide) -> String {
    let prefix = match side {
        FileSide::Local => "local_file_last_directory",
        FileSide::Remote => "sftp_last_directory",
    };
    format!("{prefix}:{host_id}")
}

fn validate_path(path: &str, side: FileSide) -> Result<(), Error> {
    match side {
        FileSide::Remote => remote_absolute(path),
        FileSide::Local => {
            valid_path(path)?;
            if !Path::new(path).is_absolute() {
                return Err(Error::Validation("本地目录必须是绝对路径"));
            }
            Ok(())
        }
    }
}

fn load(connection: &Connection, key: &str, side: FileSide) -> Result<Option<String>, Error> {
    let json: Option<String> = connection
        .query_row(
            "SELECT value FROM application_settings WHERE key=?1",
            [key],
            |row| row.get(0),
        )
        .optional()
        .map_err(storage_error)?;
    let Some(json) = json else { return Ok(None) };
    let directory: SavedDirectory = serde_json::from_str(&json).map_err(storage_error)?;
    if directory.version != VERSION {
        return Err(Error::UnsupportedConfig(directory.version));
    }
    validate_path(&directory.path, side)?;
    Ok(Some(directory.path))
}

impl Database {
    pub fn file_last_directory(
        &self,
        host_id: &str,
        side: FileSide,
    ) -> Result<Option<String>, Error> {
        load(&self.connect()?, &key(host_id, side), side)
    }

    pub fn save_file_last_directory(
        &self,
        host_id: &str,
        side: FileSide,
        path: String,
    ) -> Result<(), Error> {
        validate_path(&path, side)?;
        let mut connection = self.connect()?;
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_error)?;
        let exists: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM hosts WHERE id=?1)",
                [host_id],
                |row| row.get(0),
            )
            .map_err(storage_error)?;
        // A directory read can complete after its host has been removed.
        if !exists {
            return Ok(());
        }
        let key = key(host_id, side);
        if load(&tx, &key, side)?.as_deref() == Some(path.as_str()) {
            return Ok(());
        }
        let json = serde_json::to_string(&SavedDirectory {
            version: VERSION,
            path,
        })
        .map_err(storage_error)?;
        tx.execute(
            "INSERT INTO application_settings(key,value) VALUES(?1,?2)
             ON CONFLICT(key) DO UPDATE SET value=excluded.value,
               updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')",
            params![key, json],
        )
        .map_err(storage_error)?;
        tx.commit().map_err(storage_error)
    }
}
