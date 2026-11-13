use super::*;
use serde::{Deserialize, Serialize};
use serverdeck_core::terminal::SavedLocalTerminal;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct LocalSessions {
    version: u32,
    sessions: Vec<SavedLocalTerminal>,
}
fn decode(json: Option<&str>) -> Result<Vec<SavedLocalTerminal>, Error> {
    let Some(json) = json else {
        return Ok(Vec::new());
    };
    let stored: LocalSessions = serde_json::from_str(json).map_err(storage_error)?;
    if stored.version != 1 || stored.sessions.len() > 32 {
        return Err(Error::Validation("保存的本地会话格式或版本无效"));
    }
    let mut ids = std::collections::HashSet::new();
    for session in &stored.sessions {
        session.validate()?;
        if !ids.insert(&session.id) {
            return Err(Error::Validation("保存的本地会话标识重复"));
        }
    }
    Ok(stored.sessions)
}
fn read(connection: &Connection) -> Result<Vec<SavedLocalTerminal>, Error> {
    let json = connection
        .query_row(
            "SELECT value FROM application_settings WHERE key='local_terminal_sessions'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(storage_error)?;
    decode(json.as_deref())
}
impl Database {
    pub fn local_terminal_sessions(&self) -> Result<Vec<SavedLocalTerminal>, Error> {
        read(&self.connect()?)
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
    pub fn remove_local_terminal_session(&self, id: &str) -> Result<(), Error> {
        self.edit_local_terminal_sessions(|sessions| {
            sessions.retain(|session| session.id != id);
            Ok(())
        })
    }
    fn edit_local_terminal_sessions(
        &self,
        edit: impl FnOnce(&mut Vec<SavedLocalTerminal>) -> Result<(), Error>,
    ) -> Result<(), Error> {
        let mut connection = self.connect()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_error)?;
        let mut sessions = read(&transaction)?;
        edit(&mut sessions)?;
        transaction.execute(
            "INSERT INTO application_settings(key,value) VALUES('local_terminal_sessions',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            [serde_json::to_string(&LocalSessions { version: 1, sessions }).map_err(storage_error)?],
        ).map_err(storage_error)?;
        transaction.commit().map_err(storage_error)
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
