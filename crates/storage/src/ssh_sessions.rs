use super::*;
use serde::{Deserialize, Serialize};
use serverdeck_core::terminal::{SavedSshTerminal, validate_terminal_title};
use uuid::Uuid;

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SshSessionRecord {
    pub session: SavedSshTerminal,
    blob_id: Uuid,
    blob_size: usize,
}
impl SshSessionRecord {
    pub fn new(session: SavedSshTerminal, size: usize) -> Self {
        Self {
            session,
            blob_id: Uuid::new_v4(),
            blob_size: size,
        }
    }
    pub fn reference(&self) -> String {
        format!("ssh-session:{}:{}", self.blob_id, self.blob_size)
    }
    fn validate(&self) -> Result<(), Error> {
        validate_terminal_title(&self.session.title)?;
        self.session.layout.validate(self.session.pane_count)?;
        if self.session.layout_only_panes > self.session.pane_count
            || !(1..=1024 * 1024).contains(&self.blob_size)
        {
            return Err(Error::Validation("SSH 会话快照大小无效"));
        }
        Ok(())
    }
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Sessions {
    version: u32,
    sessions: Vec<SshSessionRecord>,
}
fn key(host: &str) -> String {
    format!("ssh_terminal_sessions:{host}")
}
fn read(conn: &Connection, host: &str) -> Result<Vec<SshSessionRecord>, Error> {
    let raw: Option<String> = conn
        .query_row(
            "SELECT value FROM application_settings WHERE key=?1",
            [key(host)],
            |row| row.get(0),
        )
        .optional()
        .map_err(storage_error)?;
    let Some(raw) = raw else {
        return Ok(vec![]);
    };
    let data: Sessions = serde_json::from_str(&raw).map_err(storage_error)?;
    if data.version != 1 {
        return Err(Error::UnsupportedConfig(data.version));
    }
    let mut ids = std::collections::HashSet::new();
    if data.sessions.len() > 32 {
        return Err(Error::Validation("每台主机最多保存 32 个会话"));
    }
    for record in &data.sessions {
        record.validate()?;
        if !ids.insert(record.session.id) {
            return Err(Error::Validation("SSH 会话标识重复"));
        }
    }
    Ok(data.sessions)
}
fn retire(tx: &Connection, record: &SshSessionRecord) -> Result<(), Error> {
    tx.execute(
        "INSERT OR IGNORE INTO secret_gc(reference) VALUES(?1)",
        [record.reference()],
    )
    .map_err(storage_error)?;
    Ok(())
}
pub(crate) fn remove_host(tx: &Connection, host: &str) -> Result<(), Error> {
    for record in read(tx, host)? {
        retire(tx, &record)?;
    }
    tx.execute("DELETE FROM application_settings WHERE key=?1", [key(host)])
        .map_err(storage_error)?;
    Ok(())
}
impl Database {
    pub fn ssh_terminal_sessions(&self, host: &str) -> Result<Vec<SshSessionRecord>, Error> {
        read(&self.connect()?, host)
    }
    fn edit_ssh_sessions<T>(
        &self,
        host: &str,
        edit: impl FnOnce(&Connection, &mut Vec<SshSessionRecord>) -> Result<T, Error>,
    ) -> Result<T, Error> {
        let mut conn = self.connect()?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_error)?;
        let exists: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM hosts WHERE id=?1)",
                [host],
                |row| row.get(0),
            )
            .map_err(storage_error)?;
        if !exists {
            return Err(Error::NotFound);
        }
        let mut sessions = read(&tx, host)?;
        let result = edit(&tx, &mut sessions)?;
        let raw = serde_json::to_string(&Sessions {
            version: 1,
            sessions,
        })
        .map_err(storage_error)?;
        tx.execute("INSERT INTO application_settings(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", params![key(host), raw]).map_err(storage_error)?;
        tx.commit().map_err(storage_error)?;
        Ok(result)
    }
    pub fn save_ssh_session(
        &self,
        host: &str,
        record: SshSessionRecord,
        updating: bool,
        write_secret: impl FnOnce(&str) -> Result<(), Error>,
    ) -> Result<(), Error> {
        record.validate()?;
        let reference = record.reference();
        self.queue_secret_gc(&reference)?;
        self.edit_ssh_sessions(host, |tx, entries| {
            if let Some(old) = entries
                .iter_mut()
                .find(|r| r.session.id == record.session.id)
            {
                if !updating {
                    return Err(Error::Validation("SSH 会话标识重复"));
                }
                if record.session.layout_only_panes > 0 && old.session.layout_only_panes == 0 {
                    return Err(Error::Validation(
                        "当前远端 Shell 只能保存布局，原有目录和命令快照已保留",
                    ));
                }
                retire(tx, old)?;
                *old = record;
            } else {
                if updating {
                    return Err(Error::NotFound);
                }
                if entries.len() >= 32 {
                    return Err(Error::Validation("每台主机最多保存 32 个会话"));
                }
                entries.push(record);
            }
            // A concurrent GC may already have collected our reservation. Never
            // write an untracked secret. A rollback restores the cleanup intent.
            if tx
                .execute("DELETE FROM secret_gc WHERE reference=?1", [&reference])
                .map_err(storage_error)?
                != 1
            {
                return Err(Error::Validation("SSH 会话正在清理，请重试保存"));
            }
            write_secret(&reference)
        })
    }
    pub fn rename_ssh_session(
        &self,
        host: &str,
        id: Uuid,
        title: String,
    ) -> Result<SavedSshTerminal, Error> {
        validate_terminal_title(&title)?;
        self.edit_ssh_sessions(host, |_, entries| {
            let entry = entries
                .iter_mut()
                .find(|r| r.session.id == id)
                .ok_or(Error::NotFound)?;
            entry.session.title = title;
            Ok(entry.session.clone())
        })
    }
    pub fn remove_ssh_session(&self, host: &str, id: Uuid) -> Result<(), Error> {
        self.edit_ssh_sessions(host, |tx, entries| {
            if let Some(index) = entries.iter().position(|r| r.session.id == id) {
                retire(tx, &entries.remove(index))?;
            }
            Ok(())
        })
    }
}
