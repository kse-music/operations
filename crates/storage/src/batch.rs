use super::*;
use serde::{Deserialize, Serialize};
use serverdeck_core::{
    DATABASE_VERSION,
    batch::{BatchCommand, BatchCommandInput, validate_command, validate_targets},
};
use std::collections::HashSet;
use uuid::Uuid;

const KEY: &str = "batch_commands";
const VERSION: u32 = 2;
const LIMIT: usize = 128;

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Library {
    version: u32,
    commands: Vec<BatchCommand>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct LibraryV1 {
    #[serde(rename = "version")]
    _version: u32,
    commands: Vec<CommandV1>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CommandV1 {
    id: String,
    revision: u32,
    name: String,
    command: String,
}

fn read(db: &Database, connection: &rusqlite::Transaction<'_>) -> Result<Library, Error> {
    let json: Option<String> = connection
        .query_row(
            "SELECT value FROM application_settings WHERE key=?1",
            [KEY],
            |row| row.get(0),
        )
        .optional()
        .map_err(storage_error)?;
    let Some(json) = json else {
        return Ok(Library {
            version: VERSION,
            commands: Vec::new(),
        });
    };
    let json = super::config_migrations::json(&json)?;
    let version = json["version"]
        .as_u64()
        .and_then(|n| u32::try_from(n).ok())
        .ok_or(Error::Validation("批量命令记录无效"))?;
    let library = match version {
        1 => {
            let old: LibraryV1 = serde_json::from_value(json).map_err(storage_error)?;
            Library {
                version: 2,
                commands: old
                    .commands
                    .into_iter()
                    .map(|entry| BatchCommand {
                        id: entry.id,
                        revision: entry.revision,
                        name: entry.name,
                        command: entry.command,
                        // V1 target selection existed only in memory.
                        host_ids: Vec::new(),
                        concurrency: 3,
                    })
                    .collect(),
            }
        }
        VERSION => serde_json::from_value(json).map_err(storage_error)?,
        _ => return Err(Error::UnsupportedConfig(version)),
    };
    if library.commands.len() > LIMIT {
        return Err(Error::Validation("最多保存 128 条批量命令"));
    }
    let mut ids = HashSet::new();
    for entry in &library.commands {
        validate_command(&entry.name, &entry.command)?;
        validate_targets(&entry.host_ids, entry.concurrency)?;
        if Uuid::parse_str(&entry.id).is_err() || entry.revision == 0 || !ids.insert(&entry.id) {
            return Err(Error::Validation("批量命令记录无效"));
        }
    }
    if version == 1 {
        super::migrations::backup(db, DATABASE_VERSION)
            .map_err(|error| super::migrations::failure("批量命令备份", error))?;
        connection
            .execute(
                "UPDATE application_settings SET value=?1 WHERE key=?2",
                params![serde_json::to_string(&library).map_err(storage_error)?, KEY],
            )
            .map_err(storage_error)?;
        super::migrations::integrity(connection)?;
    }
    Ok(library)
}

impl Database {
    pub fn batch_commands(&self) -> Result<Vec<BatchCommand>, Error> {
        let mut connection = self.connect()?;
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_error)?;
        let library = read(self, &tx)?;
        tx.commit().map_err(storage_error)?;
        Ok(library.commands)
    }

    pub fn batch_command(&self, id: &str, revision: u32) -> Result<BatchCommand, Error> {
        let command = self
            .batch_commands()?
            .into_iter()
            .find(|entry| entry.id == id)
            .ok_or(Error::NotFound)?;
        if command.revision != revision {
            return Err(Error::Conflict);
        }
        Ok(command)
    }

    pub fn save_batch_command(
        &self,
        id: Option<&str>,
        revision: Option<u32>,
        input: BatchCommandInput,
    ) -> Result<BatchCommand, Error> {
        let name = input.name.trim().to_owned();
        validate_command(&name, &input.command)?;
        validate_targets(&input.host_ids, input.concurrency)?;
        self.change_batch_commands(|tx, commands| {
            let mut exists = tx
                .prepare("SELECT EXISTS(SELECT 1 FROM hosts WHERE id=?1)")
                .map_err(storage_error)?;
            for id in &input.host_ids {
                if !exists
                    .query_row([id], |row| row.get::<_, bool>(0))
                    .map_err(storage_error)?
                {
                    return Err(Error::Validation(
                        "部分目标主机已删除，请修改命令的目标主机",
                    ));
                }
            }
            let (id, revision) = match (id, revision) {
                (None, None) => {
                    if commands.len() >= LIMIT {
                        return Err(Error::Validation("最多保存 128 条批量命令"));
                    }
                    (Uuid::new_v4().to_string(), 1)
                }
                (Some(id), Some(revision)) => {
                    let entry = commands
                        .iter_mut()
                        .find(|entry| entry.id == id)
                        .ok_or(Error::NotFound)?;
                    if entry.revision != revision {
                        return Err(Error::Conflict);
                    }
                    let next = revision.checked_add(1).ok_or(Error::Conflict)?;
                    *entry = BatchCommand {
                        id: id.to_owned(),
                        revision: next,
                        name,
                        command: input.command,
                        host_ids: input.host_ids,
                        concurrency: input.concurrency,
                    };
                    return Ok(entry.clone());
                }
                _ => return Err(Error::Validation("批量命令标识与版本无效")),
            };
            let entry = BatchCommand {
                id,
                revision,
                name,
                command: input.command,
                host_ids: input.host_ids,
                concurrency: input.concurrency,
            };
            commands.push(entry.clone());
            Ok(entry)
        })
    }

    pub fn delete_batch_command(&self, id: &str, revision: u32) -> Result<(), Error> {
        self.change_batch_commands(|_, commands| {
            let index = commands
                .iter()
                .position(|entry| entry.id == id)
                .ok_or(Error::NotFound)?;
            if commands[index].revision != revision {
                return Err(Error::Conflict);
            }
            commands.remove(index);
            Ok(())
        })
    }

    fn change_batch_commands<T>(
        &self,
        change: impl FnOnce(&Connection, &mut Vec<BatchCommand>) -> Result<T, Error>,
    ) -> Result<T, Error> {
        let mut connection = self.connect()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_error)?;
        let mut library = read(self, &transaction)?;
        let result = change(&transaction, &mut library.commands)?;
        transaction
            .execute(
                "INSERT INTO application_settings(key,value) VALUES(?1,?2)
             ON CONFLICT(key) DO UPDATE SET value=excluded.value,
                 updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')",
                params![KEY, serde_json::to_string(&library).map_err(storage_error)?],
            )
            .map_err(storage_error)?;
        transaction.commit().map_err(storage_error)?;
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serverdeck_core::hosts::{AuthType, Host, HostInput};

    fn add_host(db: &Database) -> Host {
        db.host_create(HostInput {
            name: "主机".into(),
            hostname: "fixture.invalid".into(),
            port: 22,
            username: "ops".into(),
            auth_type: AuthType::Agent,
            credential_id: None,
            group_id: None,
            description: String::new(),
            favorite: false,
            connect_timeout_secs: 10,
            ssh: Default::default(),
        })
        .unwrap()
    }

    #[test]
    fn batch_library_reopens_multiline_commands_and_rejects_stale_or_future_writes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("serverdeck.sqlite3");
        let db = Database::open(&path).unwrap();
        assert!(db.batch_commands().unwrap().is_empty());
        let host = add_host(&db);
        let input = || BatchCommandInput {
            name: "  运行信息  ".to_owned(),
            command: "hostname\n\nuptime\n".to_owned(),
            host_ids: vec![host.id.clone()],
            concurrency: 5,
        };
        let entry = db.save_batch_command(None, None, input()).unwrap();
        drop(db);
        let db = Database::open(path).unwrap();
        let saved = db.batch_command(&entry.id, 1).unwrap();
        assert_eq!(saved.name, "运行信息");
        assert_eq!(saved.command, input().command);
        assert_eq!(saved.host_ids, [host.id.clone()]);
        assert_eq!(saved.concurrency, 5);
        let updated = db
            .save_batch_command(Some(&entry.id), Some(1), input())
            .unwrap();
        assert_eq!(updated.revision, 2);
        assert!(matches!(
            db.delete_batch_command(&entry.id, 1),
            Err(Error::Conflict)
        ));
        db.connect()
            .unwrap()
            .execute("DELETE FROM hosts WHERE id=?1", [&host.id])
            .unwrap();
        assert_eq!(
            db.batch_command(&entry.id, 2).unwrap().host_ids,
            [host.id.clone()]
        );
        assert!(matches!(
            db.save_batch_command(Some(&entry.id), Some(2), input()),
            Err(Error::Validation(_))
        ));
        db.connect()
            .unwrap()
            .execute(
                "UPDATE application_settings SET value=?1 WHERE key=?2",
                params![r#"{"version":3,"commands":[]}"#, KEY],
            )
            .unwrap();
        assert!(matches!(
            db.save_batch_command(None, None, input()),
            Err(Error::UnsupportedConfig(3))
        ));
        assert!(matches!(
            db.batch_commands(),
            Err(Error::UnsupportedConfig(3))
        ));
        assert_eq!(db.version().unwrap(), serverdeck_core::DATABASE_VERSION);
    }

    #[test]
    fn batch_library_upgrades_v1_with_one_backup_and_retries_after_backup_failure() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(dir.path().join("serverdeck.sqlite3")).unwrap();
        let host = add_host(&db);
        let id = Uuid::new_v4().to_string();
        let old = serde_json::json!({"version":1,"commands":[{"id":id,"revision":9,"name":"旧命令","command":"hostname\nuptime\n"}]}).to_string();
        let conn = db.connect().unwrap();
        conn.pragma_update(None, "journal_mode", "WAL").unwrap();
        conn.execute(
            "INSERT INTO application_settings(key,value) VALUES(?1,?2)",
            params![KEY, old],
        )
        .unwrap();
        let backups = dir.path().join("migration-backups");
        std::fs::write(&backups, b"block backup creation").unwrap();
        assert!(matches!(db.batch_commands(), Err(Error::Migration { .. })));
        let raw = |conn: &Connection| -> String {
            conn.query_row(
                "SELECT value FROM application_settings WHERE key=?1",
                [KEY],
                |row| row.get(0),
            )
            .unwrap()
        };
        assert_eq!(raw(&conn), old);
        std::fs::remove_file(&backups).unwrap();

        std::thread::scope(|scope| {
            let first = scope.spawn(|| db.batch_commands().unwrap());
            let second = scope.spawn(|| db.batch_commands().unwrap());
            for list in [first.join().unwrap(), second.join().unwrap()] {
                assert_eq!(list.len(), 1);
                let migrated = &list[0];
                assert_eq!(migrated.id, id);
                assert_eq!(migrated.revision, 9);
                assert_eq!(migrated.name, "旧命令");
                assert_eq!(migrated.command, "hostname\nuptime\n");
                assert!(migrated.host_ids.is_empty());
                assert_eq!(migrated.concurrency, 3);
            }
        });
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&raw(&conn)).unwrap()["version"],
            2
        );
        assert!(db.host(&host.id).is_ok());
        assert_eq!(db.batch_commands().unwrap().len(), 1);
        let files = std::fs::read_dir(backups)
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(raw(&Connection::open(files[0].path()).unwrap()), old);
    }
}
