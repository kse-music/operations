use super::*;
use serde::{Deserialize, Serialize};
use serverdeck_core::batch::{BatchCommand, BatchCommandInput, validate_command};
use std::collections::HashSet;
use uuid::Uuid;

const KEY: &str = "batch_commands";
const VERSION: u32 = 1;
const LIMIT: usize = 128;

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Library {
    version: u32,
    commands: Vec<BatchCommand>,
}

fn load(connection: &Connection) -> Result<Library, Error> {
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
    let library: Library = serde_json::from_str(&json).map_err(storage_error)?;
    if library.version != VERSION {
        return Err(Error::UnsupportedConfig(library.version));
    }
    if library.commands.len() > LIMIT {
        return Err(Error::Validation("最多保存 128 条批量命令"));
    }
    let mut ids = HashSet::new();
    for entry in &library.commands {
        validate_command(&entry.name, &entry.command)?;
        if Uuid::parse_str(&entry.id).is_err() || entry.revision == 0 || !ids.insert(&entry.id) {
            return Err(Error::Validation("批量命令记录无效"));
        }
    }
    Ok(library)
}

impl Database {
    pub fn batch_commands(&self) -> Result<Vec<BatchCommand>, Error> {
        Ok(load(&self.connect()?)?.commands)
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
        self.change_batch_commands(|commands| {
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
            };
            commands.push(entry.clone());
            Ok(entry)
        })
    }

    pub fn delete_batch_command(&self, id: &str, revision: u32) -> Result<(), Error> {
        self.change_batch_commands(|commands| {
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
        change: impl FnOnce(&mut Vec<BatchCommand>) -> Result<T, Error>,
    ) -> Result<T, Error> {
        let mut connection = self.connect()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_error)?;
        let mut library = load(&transaction)?;
        let result = change(&mut library.commands)?;
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

    #[test]
    fn batch_library_reopens_multiline_commands_and_rejects_stale_or_future_writes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("serverdeck.sqlite3");
        let db = Database::open(&path).unwrap();
        assert!(db.batch_commands().unwrap().is_empty());
        let input = || BatchCommandInput {
            name: "  运行信息  ".to_owned(),
            command: "hostname\n\nuptime\n".to_owned(),
        };
        let entry = db.save_batch_command(None, None, input()).unwrap();
        drop(db);
        let db = Database::open(path).unwrap();
        let saved = db.batch_command(&entry.id, 1).unwrap();
        assert_eq!(saved.name, "运行信息");
        assert_eq!(saved.command, input().command);
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
            .execute(
                "UPDATE application_settings SET value=?1 WHERE key=?2",
                params![r#"{"version":2,"commands":[]}"#, KEY],
            )
            .unwrap();
        assert!(matches!(
            db.save_batch_command(None, None, input()),
            Err(Error::UnsupportedConfig(2))
        ));
        assert!(matches!(
            db.batch_commands(),
            Err(Error::UnsupportedConfig(2))
        ));
        assert_eq!(db.version().unwrap(), serverdeck_core::DATABASE_VERSION);
    }
}
