use super::*;
use serde::{Deserialize, Serialize};
use serverdeck_core::terminal::SavedLocalTerminal;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct LocalSessions {
    version: u32,
    sessions: Vec<SavedLocalTerminal>,
}
fn decode(raw: &str) -> Result<LocalSessions, Error> {
    let json = super::config_migrations::json(raw)?;
    let invalid = || Error::Validation("保存的本地会话格式或版本无效");
    match json["version"].as_u64() {
        Some(1) => {
            // A v1 pane had exactly these two required fields. Reject new fields
            // even when null before interpreting the data as the current DTO.
            for session in json["sessions"].as_array().ok_or_else(invalid)? {
                for pane in session["panes"].as_array().ok_or_else(invalid)? {
                    let fields = pane.as_object().ok_or_else(invalid)?;
                    if fields.len() != 2
                        || !fields.contains_key("directory")
                        || !fields.contains_key("elevated")
                    {
                        return Err(invalid());
                    }
                }
            }
        }
        Some(2) => {}
        _ => return Err(invalid()),
    }
    let stored: LocalSessions = serde_json::from_value(json).map_err(storage_error)?;
    if stored.sessions.len() > 32 {
        return Err(invalid());
    }
    let mut ids = std::collections::HashSet::new();
    for session in &stored.sessions {
        session.validate()?;
        if !ids.insert(&session.id) {
            return Err(Error::Validation("保存的本地会话标识重复"));
        }
    }
    Ok(stored)
}
fn read(db: &Database, connection: &rusqlite::Transaction<'_>) -> Result<LocalSessions, Error> {
    let json = connection
        .query_row(
            "SELECT value FROM application_settings WHERE key='local_terminal_sessions'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(storage_error)?;
    let Some(json) = json else {
        return Ok(LocalSessions {
            version: 2,
            sessions: vec![],
        });
    };
    let mut stored = decode(&json)?;
    if stored.version == 1 {
        // v1 had no command. All pane and layout data has been strictly validated.
        super::migrations::backup(db, serverdeck_core::DATABASE_VERSION)
            .map_err(|error| super::migrations::failure("本地会话备份", error))?;
        stored.version = 2;
        write(connection, &stored)?;
        super::migrations::integrity(connection)?;
    }
    Ok(stored)
}
fn write(connection: &Connection, stored: &LocalSessions) -> Result<(), Error> {
    connection.execute(
        "INSERT INTO application_settings(key,value) VALUES('local_terminal_sessions',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        [serde_json::to_string(stored).map_err(storage_error)?],
    ).map_err(storage_error)?;
    Ok(())
}
impl Database {
    pub fn local_terminal_sessions(&self) -> Result<Vec<SavedLocalTerminal>, Error> {
        let mut connection = self.connect()?;
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_error)?;
        let stored = read(self, &tx)?;
        tx.commit().map_err(storage_error)?;
        Ok(stored.sessions)
    }
    pub fn save_local_terminal_session(&self, session: SavedLocalTerminal) -> Result<(), Error> {
        session.validate()?;
        self.edit_local_terminal_sessions(move |sessions| {
            if let Some(existing) = sessions.iter_mut().find(|saved| saved.id == session.id) {
                *existing = session;
            } else if sessions.len() < 32 {
                sessions.push(session);
            } else {
                return Err(Error::Validation("最多保存 32 个本地会话"));
            }
            Ok(())
        })
    }
    pub fn rename_local_terminal_session(
        &self,
        id: &str,
        title: String,
    ) -> Result<SavedLocalTerminal, Error> {
        serverdeck_core::terminal::validate_terminal_title(&title)?;
        self.edit_local_terminal_sessions(|sessions| {
            let saved = sessions
                .iter_mut()
                .find(|saved| saved.id == id)
                .ok_or(Error::NotFound)?;
            saved.title = title;
            Ok(saved.clone())
        })
    }
    pub fn remove_local_terminal_session(&self, id: &str) -> Result<(), Error> {
        self.edit_local_terminal_sessions(|sessions| {
            sessions.retain(|session| session.id != id);
            Ok(())
        })
    }
    fn edit_local_terminal_sessions<T>(
        &self,
        edit: impl FnOnce(&mut Vec<SavedLocalTerminal>) -> Result<T, Error>,
    ) -> Result<T, Error> {
        let mut connection = self.connect()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_error)?;
        let mut stored = read(self, &transaction)?;
        let result = edit(&mut stored.sessions)?;
        write(&transaction, &stored)?;
        transaction.commit().map_err(storage_error)?;
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serverdeck_core::terminal::{LocalTerminalLayout, SavedLocalPane};
    fn session(directory: &Path, title: &str) -> SavedLocalTerminal {
        SavedLocalTerminal {
            id: uuid::Uuid::new_v4().to_string(),
            title: title.into(),
            panes: vec![SavedLocalPane {
                directory: directory.to_str().unwrap().into(),
                elevated: false,
                protected_command: None,
            }],
            layout: LocalTerminalLayout::Leaf { pane: 0 },
        }
    }
    #[test]
    fn saves_multiple_independent_snapshots_and_preserves_legacy_data() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("app.sqlite3");
        let db = Database::open(&path).unwrap();
        let config = db.load_config().unwrap();
        db.save_local_terminal_directory(root.path().to_str().unwrap())
            .unwrap();
        assert!(
            db.local_terminal_sessions().unwrap().is_empty(),
            "automatic history must not become a manually saved session"
        );
        let mut first = session(&root.path().join("one"), "第一会话");
        let second = session(&root.path().join("two"), "第二会话");
        db.save_local_terminal_session(first.clone()).unwrap();
        db.save_local_terminal_session(second.clone()).unwrap();
        first.panes[0].directory = root.path().join("updated").to_str().unwrap().into();
        db.save_local_terminal_session(first.clone()).unwrap();
        let reopened = Database::open(&path).unwrap();
        assert_eq!(
            reopened.local_terminal_sessions().unwrap(),
            [first.clone(), second.clone()]
        );
        reopened.remove_local_terminal_session(&first.id).unwrap();
        assert_eq!(reopened.local_terminal_sessions().unwrap(), [second]);
        assert_eq!(
            reopened.local_terminal_directory().unwrap().as_deref(),
            root.path().to_str()
        );
        assert_eq!(reopened.load_config().unwrap(), config);
        assert_eq!(
            reopened.version().unwrap(),
            serverdeck_core::DATABASE_VERSION
        );
    }
    #[test]
    fn v1_upgrade_backs_up_wal_and_preserves_each_pane_once_across_concurrent_reads() {
        let root = tempfile::tempdir().unwrap();
        let db = Database::open(root.path().join("app.sqlite3")).unwrap();
        let connection = db.connect().unwrap();
        let mut saved = session(root.path(), "会话");
        saved.panes.push(SavedLocalPane {
            directory: root.path().join("second").to_str().unwrap().into(),
            elevated: true,
            protected_command: None,
        });
        saved.layout = LocalTerminalLayout::Split {
            axis: serverdeck_core::terminal::LocalSplitAxis::Rows,
            ratio: 43,
            first: Box::new(LocalTerminalLayout::Leaf { pane: 0 }),
            second: Box::new(LocalTerminalLayout::Leaf { pane: 1 }),
        };
        let legacy = serde_json::json!({"version": 1, "sessions": [{
            "id": saved.id, "title": saved.title,
            "layout": {"kind":"split", "axis":"rows", "ratio":43, "first":{"kind":"leaf","pane":0}, "second":{"kind":"leaf","pane":1}},
            "panes":[{"directory": saved.panes[0].directory, "elevated":false},
                     {"directory": saved.panes[1].directory, "elevated":true}]
        }]})
        .to_string();
        let select = "SELECT value FROM application_settings WHERE key='local_terminal_sessions'";
        connection
            .execute(
                "INSERT INTO application_settings(key,value) VALUES('local_terminal_sessions',?1)",
                [&legacy],
            )
            .unwrap();
        let backups = root.path().join("migration-backups");
        std::fs::write(&backups, "blocked backup directory").unwrap();
        assert!(db.local_terminal_sessions().is_err());
        assert_eq!(
            connection
                .query_row(select, [], |r| r.get::<_, String>(0))
                .unwrap(),
            legacy
        );
        std::fs::remove_file(&backups).unwrap();
        connection.execute_batch("CREATE TRIGGER block_upgrade BEFORE UPDATE ON application_settings BEGIN SELECT RAISE(ABORT,'upgrade failed'); END;").unwrap();
        assert!(db.local_terminal_sessions().is_err());
        assert_eq!(
            connection
                .query_row(select, [], |r| r.get::<_, String>(0))
                .unwrap(),
            legacy
        );
        connection
            .execute_batch("DROP TRIGGER block_upgrade")
            .unwrap();
        std::thread::scope(|scope| {
            let readers: Vec<_> = (0..3)
                .map(|_| scope.spawn(|| db.local_terminal_sessions().unwrap()))
                .collect();
            for reader in readers {
                assert_eq!(
                    reader.join().unwrap().as_slice(),
                    std::slice::from_ref(&saved)
                );
            }
        });
        let reopened = Database::open(&db.path).unwrap();
        assert_eq!(reopened.local_terminal_sessions().unwrap(), [saved]);
        let raw: String = connection.query_row(select, [], |r| r.get(0)).unwrap();
        assert_eq!(decode(&raw).unwrap().version, 2);
        let copies = std::fs::read_dir(backups)
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(
            copies.len(),
            2,
            "one failed write and one committed upgrade"
        );
        for copy in copies {
            let backup = Connection::open(copy.path()).unwrap();
            assert_eq!(
                backup
                    .query_row(select, [], |r| r.get::<_, String>(0))
                    .unwrap(),
                legacy
            );
        }
    }
    #[test]
    fn corrupt_future_and_invalid_layout_records_are_never_overwritten() {
        let root = tempfile::tempdir().unwrap();
        let db = Database::open(root.path().join("app.sqlite3")).unwrap();
        for json in [
            r#"{"version":99,"sessions":[]}"#,
            r#"{"version":1,"sessions":[],"extra":1}"#,
            "{broken",
        ] {
            db.connect().unwrap().execute("INSERT OR REPLACE INTO application_settings(key,value) VALUES('local_terminal_sessions',?1)", [json]).unwrap();
            assert!(db.local_terminal_sessions().is_err());
            assert!(
                db.save_local_terminal_session(session(root.path(), "new"))
                    .is_err()
            );
            assert!(db.remove_local_terminal_session("missing").is_err());
            let unchanged: String = db
                .connect()
                .unwrap()
                .query_row(
                    "SELECT value FROM application_settings WHERE key='local_terminal_sessions'",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(unchanged, json);
        }
        let mut invalid = session(root.path(), "invalid");
        invalid.panes[0].protected_command = Some("command\r".into());
        assert!(db.save_local_terminal_session(invalid.clone()).is_err());
        let mut future_pane = serde_json::json!({"version":1,"sessions":[invalid.clone()]});
        future_pane["sessions"][0]["panes"][0]["protectedCommand"] = serde_json::Value::Null;
        assert!(decode(&future_pane.to_string()).is_err());
        invalid.panes[0].protected_command = None;
        invalid.layout = LocalTerminalLayout::Leaf { pane: 1 };
        assert!(db.save_local_terminal_session(invalid).is_err());
    }
    #[test]
    fn failed_write_keeps_the_existing_snapshot_and_split_paths_are_validated() {
        use serverdeck_core::terminal::LocalSplitAxis;
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("app.sqlite3");
        let db = Database::open(&path).unwrap();
        let mut saved = session(&root.path().join("one"), "split");
        saved.panes.push(SavedLocalPane {
            directory: root.path().join("two").to_str().unwrap().into(),
            elevated: true,
            protected_command: Some("AQID".into()),
        });
        saved.layout = LocalTerminalLayout::Split {
            axis: LocalSplitAxis::Columns,
            ratio: 35,
            first: Box::new(LocalTerminalLayout::Leaf { pane: 0 }),
            second: Box::new(LocalTerminalLayout::Leaf { pane: 1 }),
        };
        db.save_local_terminal_session(saved.clone()).unwrap();
        assert_eq!(
            Database::open(&path)
                .unwrap()
                .local_terminal_sessions()
                .unwrap(),
            [saved.clone()]
        );
        let mut invalid = saved.clone();
        invalid.layout = LocalTerminalLayout::Split {
            axis: LocalSplitAxis::Rows,
            ratio: 50,
            first: Box::new(LocalTerminalLayout::Leaf { pane: 0 }),
            second: Box::new(LocalTerminalLayout::Leaf { pane: 0 }),
        };
        assert!(db.save_local_terminal_session(invalid).is_err());
        db.connect().unwrap().execute_batch("CREATE TRIGGER fail_saved_session_write BEFORE UPDATE ON application_settings WHEN NEW.key='local_terminal_sessions' BEGIN SELECT RAISE(ABORT, 'injected failure'); END;").unwrap();
        let mut changed = saved.clone();
        changed.title = "failed title".into();
        assert!(db.save_local_terminal_session(changed).is_err());
        assert!(db.remove_local_terminal_session(&saved.id).is_err());
        assert_eq!(db.local_terminal_sessions().unwrap(), [saved]);
    }
}
