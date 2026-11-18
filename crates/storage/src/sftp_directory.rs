use super::*;
use serde::{Deserialize, Serialize};
use serverdeck_core::files::remote_absolute;

const VERSION: u32 = 1;

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct SavedDirectory {
    version: u32,
    path: String,
}

pub(super) fn key(host_id: &str) -> String {
    format!("sftp_last_directory:{host_id}")
}

fn load(connection: &Connection, key: &str) -> Result<Option<String>, Error> {
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
    remote_absolute(&directory.path)?;
    Ok(Some(directory.path))
}

impl Database {
    pub fn sftp_last_directory(&self, host_id: &str) -> Result<Option<String>, Error> {
        load(&self.connect()?, &key(host_id))
    }

    pub fn save_sftp_last_directory(&self, host_id: &str, path: String) -> Result<(), Error> {
        remote_absolute(&path)?;
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
        // An open SFTP session can outlive its saved host.
        if !exists {
            return Ok(());
        }
        let key = key(host_id);
        if load(&tx, &key)?.as_deref() == Some(path.as_str()) {
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
