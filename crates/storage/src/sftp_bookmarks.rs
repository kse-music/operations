use super::*;
use serde::{Deserialize, Serialize};
use serverdeck_core::files::{DirectoryBookmark, remote_absolute};
use std::collections::HashSet;

const VERSION: u32 = 1;
const LIMIT: usize = 64;

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct SavedBookmarks {
    version: u32,
    bookmarks: Vec<DirectoryBookmark>,
}

pub(super) fn key(host_id: &str) -> String {
    format!("sftp_bookmarks:{host_id}")
}

fn load(connection: &Connection, key: &str) -> Result<Vec<DirectoryBookmark>, Error> {
    let json: Option<String> = connection
        .query_row(
            "SELECT value FROM application_settings WHERE key=?1",
            [key],
            |row| row.get(0),
        )
        .optional()
        .map_err(storage_error)?;
    let Some(json) = json else {
        return Ok(Vec::new());
    };
    let saved: SavedBookmarks = serde_json::from_str(&json).map_err(storage_error)?;
    if saved.version != VERSION {
        return Err(Error::UnsupportedConfig(saved.version));
    }
    if saved.bookmarks.len() > LIMIT {
        return Err(Error::Validation("每台主机最多保存 64 个目录书签"));
    }
    let mut paths = HashSet::new();
    for bookmark in &saved.bookmarks {
        bookmark.validate()?;
        if !paths.insert(bookmark.path.as_str()) {
            return Err(Error::Validation("此目录已收藏"));
        }
    }
    Ok(saved.bookmarks)
}

impl Database {
    pub fn sftp_bookmarks(&self, host_id: &str) -> Result<Vec<DirectoryBookmark>, Error> {
        load(&self.connect()?, &key(host_id))
    }

    pub fn add_sftp_bookmark(
        &self,
        host_id: &str,
        mut bookmark: DirectoryBookmark,
    ) -> Result<Vec<DirectoryBookmark>, Error> {
        bookmark.name = bookmark.name.trim().to_owned();
        bookmark.validate()?;
        self.change_sftp_bookmarks(host_id, |bookmarks| {
            if bookmarks.iter().any(|saved| saved.path == bookmark.path) {
                return Err(Error::Validation("此目录已收藏"));
            }
            if bookmarks.len() >= LIMIT {
                return Err(Error::Validation("每台主机最多保存 64 个目录书签"));
            }
            bookmarks.push(bookmark);
            Ok(())
        })
    }

    pub fn remove_sftp_bookmark(
        &self,
        host_id: &str,
        path: &str,
    ) -> Result<Vec<DirectoryBookmark>, Error> {
        remote_absolute(path)?;
        self.change_sftp_bookmarks(host_id, |bookmarks| {
            bookmarks.retain(|bookmark| bookmark.path != path);
            Ok(())
        })
    }

    fn change_sftp_bookmarks(
        &self,
        host_id: &str,
        change: impl FnOnce(&mut Vec<DirectoryBookmark>) -> Result<(), Error>,
    ) -> Result<Vec<DirectoryBookmark>, Error> {
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
        if !exists {
            return Err(Error::NotFound);
        }
        let key = key(host_id);
        let mut saved = SavedBookmarks {
            version: VERSION,
            bookmarks: load(&tx, &key)?,
        };
        change(&mut saved.bookmarks)?;
        if saved.bookmarks.is_empty() {
            tx.execute("DELETE FROM application_settings WHERE key=?1", [&key])
                .map_err(storage_error)?;
        } else {
            let json = serde_json::to_string(&saved).map_err(storage_error)?;
            tx.execute(
                "INSERT INTO application_settings(key,value) VALUES(?1,?2)
                 ON CONFLICT(key) DO UPDATE SET value=excluded.value,
                   updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')",
                params![key, json],
            )
            .map_err(storage_error)?;
        }
        tx.commit().map_err(storage_error)?;
        Ok(saved.bookmarks)
    }
}
