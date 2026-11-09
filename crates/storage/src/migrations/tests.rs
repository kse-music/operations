use super::*;
use rusqlite::params;
use serde_json::{Value, json};
use serverdeck_core::{CONFIG_VERSION, InterfaceFontSize, Theme};

fn old_config() -> String {
    let mut config = serde_json::to_value(AppConfig::default()).unwrap();
    config["version"] = json!(1);
    config["theme"] = json!("light");
    config["sidebarWidth"] = json!(312);
    config["terminalFontSize"] = json!(23);
    config["terminal"]["quickCopyPaste"] = json!(true);
    config["product"]["sshDefaults"]["keepaliveIntervalSecs"] = json!(42);
    config["product"]["shortcuts"]["tasks"] = json!("Ctrl+J");
    config.as_object_mut().unwrap().remove("interfaceFontSize");
    config["terminal"]
        .as_object_mut()
        .unwrap()
        .remove("cursorBlink");
    config.to_string()
}

fn fixture(path: &Path, version: u32) -> String {
    let connection = Connection::open(path).unwrap();
    for migration in MIGRATIONS
        .iter()
        .filter(|migration| migration.version <= version)
    {
        connection.execute_batch(migration.sql).unwrap();
    }
    connection
        .pragma_update(None, "user_version", version)
        .unwrap();
    let config = old_config();
    connection.execute("INSERT INTO application_settings(key,value,updated_at) VALUES('app_config',?1,'retained-time'),('plugin:fixture',?2,'retained-time')", params![config, r#"{"custom":"keep","enabled":false}"#]).unwrap();
    connection
        .execute_batch(
            "CREATE TABLE user_notes(value TEXT); INSERT INTO user_notes VALUES('must survive');",
        )
        .unwrap();
    if version >= 2 {
        connection.execute_batch("INSERT INTO host_groups(id,name) VALUES('group','kept group'); INSERT INTO credentials(id,name,kind,secret_ref,revision) VALUES('credential','kept credential','password','opaque-original-reference',7); INSERT INTO hosts(id,name,hostname,port,username,auth_type,credential_id,group_id,tags,description,favorite,connect_timeout_secs) VALUES('host','kept host','192.0.2.4',2222,'ops','password','credential','group','[\"original-tag\"]','kept description',1,19);").unwrap();
    }
    if version >= 3 {
        connection.execute("INSERT INTO ssh_known_hosts(hostname,port,public_key,fingerprint) VALUES('192.0.2.4',2222,'fixture-public-key','fixture-fingerprint')", []).unwrap();
    }
    if version >= 5 {
        connection
            .execute_batch(include_str!("../../tests/fixtures/005_automation.sql"))
            .unwrap();
        connection.execute_batch("INSERT INTO automation_groups(id,name) VALUES('old-group','Kept automation group'); INSERT INTO automation_entries(id,revision,group_id,document) VALUES('old-entry',4,'old-group','{\"retired\":\"kept\"}'); INSERT INTO automation_schedules(id,entry_id,revision,enabled,next_at,document) VALUES('old-schedule','old-entry',3,1,42,'{\"original\":true}');").unwrap();
    }
    config
}

fn backups(path: &Path) -> Vec<PathBuf> {
    let folder = path.parent().unwrap().join("migration-backups");
    if !folder.exists() {
        return vec![];
    }
    fs::read_dir(folder)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| {
            path.extension()
                .is_some_and(|extension| extension == "sqlite3")
        })
        .collect()
}
fn raw(connection: &Connection) -> String {
    config_raw(connection).unwrap().unwrap()
}

#[test]
fn all_recorded_schema_versions_upgrade_with_data_references_and_durable_original_backup() {
    for version in 1..=9 {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("serverdeck.sqlite3");
        let original = fixture(&path, version);
        let db = Database::open(&path).unwrap();
        assert_eq!(db.version().unwrap(), DATABASE_VERSION);
        let config = db.load_config().unwrap();
        assert_eq!(config.version, CONFIG_VERSION);
        assert_eq!(config.theme, Theme::Light);
        assert_eq!(config.sidebar_width, 312);
        assert_eq!(config.terminal_font_size, 23);
        assert_eq!(config.interface_font_size, InterfaceFontSize::Standard);
        assert!(config.terminal.quick_copy_paste);
        assert!(config.terminal.cursor_blink);
        assert_eq!(config.product.ssh_defaults.keepalive_interval_secs, 42);
        assert!(!config.product.shortcuts.contains_key("tasks"));
        let connection = db.connect().unwrap();
        assert!(
            connection
                .pragma_query_value(None, "foreign_keys", |row| row.get::<_, bool>(0))
                .unwrap()
        );
        integrity(&connection).unwrap();
        history(&connection, DATABASE_VERSION).unwrap();
        assert_eq!(
            connection
                .query_row("SELECT value FROM user_notes", [], |row| row
                    .get::<_, String>(0))
                .unwrap(),
            "must survive"
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT updated_at FROM application_settings WHERE key='app_config'",
                    [],
                    |row| row.get::<_, String>(0)
                )
                .unwrap(),
            "retained-time"
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT value FROM application_settings WHERE key='plugin:fixture'",
                    [],
                    |row| row.get::<_, String>(0)
                )
                .unwrap(),
            r#"{"custom":"keep","enabled":false}"#
        );
        if version >= 2 {
            let host = db.host("host").unwrap();
            assert_eq!(host.config.credential_id.as_deref(), Some("credential"));
            assert_eq!(host.config.group_id.as_deref(), Some("group"));
            assert_eq!(host.config.port, 2222);
            assert_eq!(
                connection
                    .query_row(
                        "SELECT secret_ref,revision FROM credentials WHERE id='credential'",
                        [],
                        |row| Ok((row.get::<_, String>(0)?, row.get::<_, u32>(1)?))
                    )
                    .unwrap(),
                ("opaque-original-reference".into(), 7)
            );
            assert_eq!(
                connection
                    .query_row("SELECT tags FROM hosts WHERE id='host'", [], |row| row
                        .get::<_, String>(
                        0
                    ))
                    .unwrap(),
                "[\"original-tag\"]"
            );
        }
        if version >= 3 {
            assert_eq!(
                connection
                    .query_row("SELECT fingerprint FROM ssh_known_hosts", [], |row| row
                        .get::<_, String>(
                        0
                    ))
                    .unwrap(),
                "fixture-fingerprint"
            );
        }
        if version >= 5 {
            assert_eq!(
                connection
                    .query_row(
                        "SELECT document FROM automation_entries WHERE id='old-entry'",
                        [],
                        |row| row.get::<_, String>(0)
                    )
                    .unwrap(),
                r#"{"retired":"kept"}"#
            );
            assert_eq!(connection.query_row("SELECT entry_id,revision,enabled,next_at FROM automation_schedules WHERE id='old-schedule'",[],|row|Ok((row.get::<_,String>(0)?,row.get::<_,u32>(1)?,row.get::<_,bool>(2)?,row.get::<_,i64>(3)?))).unwrap(),("old-entry".into(),3,true,42));
        }
        let saved = backups(&path);
        assert_eq!(saved.len(), 1);
        let backup =
            Connection::open_with_flags(&saved[0], OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        assert_eq!(raw(&backup), original);
        assert_eq!(
            backup
                .pragma_query_value(None, "user_version", |row| row.get::<_, u32>(0))
                .unwrap(),
            version
        );
        integrity(&backup).unwrap();
        let upgraded = raw(&connection);
        drop(connection);
        drop(db);
        Database::open(&path).unwrap();
        assert_eq!(backups(&path).len(), 1);
        assert_eq!(raw(&Connection::open(&path).unwrap()), upgraded);
    }
}

#[test]
fn independent_schema_nine_snapshot_and_fresh_database_reach_the_same_active_structure() {
    let dir = tempfile::tempdir().unwrap();
    let old = dir.path().join("old.sqlite3");
    let connection = Connection::open(&old).unwrap();
    connection
        .execute_batch(include_str!("../../tests/fixtures/schema-9.sql"))
        .unwrap();
    connection.pragma_update(None, "user_version", 9).unwrap();
    connection
        .execute(
            "INSERT INTO application_settings(key,value) VALUES('app_config',?1)",
            [old_config()],
        )
        .unwrap();
    drop(connection);
    let upgraded = Database::open(&old).unwrap();
    let fresh_path = dir.path().join("fresh.sqlite3");
    let fresh = Database::open(&fresh_path).unwrap();
    let structure = |db: &Database| {
        db.connect().unwrap().prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").unwrap()
            .query_map([], |row| Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,String>(2)?))).unwrap()
            .collect::<Result<Vec<_>,_>>().unwrap()
            .into_iter().map(|(kind,name,sql)| (kind,name,sql.chars().filter(|ch| !ch.is_whitespace() && *ch != '"').collect::<String>())).collect::<Vec<_>>()
    };
    assert_eq!(structure(&upgraded), structure(&fresh));
    assert_eq!(fresh.load_config().unwrap(), AppConfig::default());
    assert_eq!(backups(&old).len(), 1);
}

#[test]
fn backup_failure_and_late_sql_failure_leave_schema_config_and_user_rows_unchanged() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db");
    let original = fixture(&path, 9);
    fs::write(dir.path().join("migration-backups"), b"occupied").unwrap();
    assert!(matches!(
        Database::open(&path),
        Err(Error::Migration {
            stage: "升级前备份",
            ..
        })
    ));
    let connection = Connection::open(&path).unwrap();
    assert_eq!(raw(&connection), original);
    assert_eq!(
        connection
            .pragma_query_value(None, "user_version", |row| row.get::<_, u32>(0))
            .unwrap(),
        9
    );
    fs::remove_file(dir.path().join("migration-backups")).unwrap();
    let db = Database { path: path.clone() };
    let mut connection = db.connect().unwrap();
    let broken = [Migration {
        version: 10,
        name: "broken",
        sql: "CREATE TABLE half_done(value TEXT); UPDATE user_notes SET value='changed'; invalid SQL;",
    }];
    assert!(upgrade_with(&db, &mut connection, &broken).is_err());
    assert_eq!(raw(&connection), original);
    assert_eq!(
        connection
            .query_row("SELECT value FROM user_notes", [], |row| row
                .get::<_, String>(0))
            .unwrap(),
        "must survive"
    );
    assert_eq!(
        connection
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE name='half_done'",
                [],
                |row| row.get::<_, u32>(0)
            )
            .unwrap(),
        0
    );
    assert_eq!(
        connection
            .pragma_query_value(None, "user_version", |row| row.get::<_, u32>(0))
            .unwrap(),
        9
    );
    drop(connection);
    Database::open(&path).unwrap();
    assert_eq!(backups(&path).len(), 2);
}

#[test]
fn config_upgrades_independently_and_current_corruption_is_never_filled_or_reset() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db");
    Database::open(&path).unwrap();
    let connection = Connection::open(&path).unwrap();
    let mut legacy: Value = serde_json::from_str(&old_config()).unwrap();
    legacy["interfaceFontSize"] = json!("extraSmall");
    connection
        .execute(
            "UPDATE application_settings SET value=?1 WHERE key='app_config'",
            [legacy.to_string()],
        )
        .unwrap();
    let db = Database::open(&path).unwrap();
    assert_eq!(
        db.load_config().unwrap().interface_font_size,
        InterfaceFontSize::Small
    );
    assert_eq!(backups(&path).len(), 1);
    for value in [
        {
            let mut value = serde_json::to_value(db.load_config().unwrap()).unwrap();
            value.as_object_mut().unwrap().remove("interfaceFontSize");
            value
        },
        {
            let mut value = legacy.clone();
            value["sidebarWidth"] = json!(0);
            value
        },
        {
            let mut value = legacy.clone();
            value["version"] = json!(99);
            value
        },
        {
            let mut value = legacy.clone();
            value["unknownPreference"] = json!(true);
            value
        },
    ] {
        let raw = value.to_string();
        connection
            .execute(
                "UPDATE application_settings SET value=?1 WHERE key='app_config'",
                [&raw],
            )
            .unwrap();
        assert!(Database::open(&path).is_err());
        assert_eq!(super::tests::raw(&connection), raw);
        assert_eq!(backups(&path).len(), 1);
    }
}

#[test]
fn concurrent_startups_create_one_backup_and_one_committed_upgrade() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db");
    fixture(&path, 8);
    let threads = (0..4)
        .map(|_| {
            let path = path.clone();
            std::thread::spawn(move || Database::open(path).unwrap().load_config().unwrap())
        })
        .collect::<Vec<_>>();
    for thread in threads {
        assert_eq!(thread.join().unwrap().version, CONFIG_VERSION);
    }
    assert_eq!(backups(&path).len(), 1);
    assert_eq!(
        Connection::open(&path)
            .unwrap()
            .query_row(
                "SELECT count(*) FROM schema_migrations WHERE version=10",
                [],
                |row| row.get::<_, u32>(0)
            )
            .unwrap(),
        1
    );
}

#[test]
fn wal_backup_includes_committed_rows_and_future_versions_or_changed_history_are_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db");
    fixture(&path, 9);
    let connection = Connection::open(&path).unwrap();
    connection
        .pragma_update(None, "journal_mode", "WAL")
        .unwrap();
    connection
        .execute("INSERT INTO user_notes VALUES('committed in WAL')", [])
        .unwrap();
    Database::open(&path).unwrap();
    let backup = Connection::open(&backups(&path)[0]).unwrap();
    assert_eq!(
        backup
            .query_row("SELECT count(*) FROM user_notes", [], |row| row
                .get::<_, u32>(0))
            .unwrap(),
        2
    );
    connection
        .execute(
            "UPDATE schema_migrations SET checksum='tampered' WHERE version=10",
            [],
        )
        .unwrap();
    assert!(Database::open(&path).is_err());
    connection
        .pragma_update(None, "user_version", DATABASE_VERSION + 1)
        .unwrap();
    assert!(matches!(
        Database::open(&path),
        Err(Error::UnsupportedDatabase(_))
    ));
    assert_eq!(backups(&path).len(), 1);
}

#[test]
fn custom_rebuild_columns_triggers_and_invalid_foreign_keys_stop_without_data_loss() {
    for sql in [
        "ALTER TABLE credentials ADD COLUMN custom TEXT DEFAULT 'keep';",
        "CREATE TRIGGER custom AFTER UPDATE ON credentials BEGIN INSERT INTO user_notes VALUES('changed'); END;",
        "UPDATE hosts SET credential_id='missing';",
    ] {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("db");
        let original = fixture(&path, 7);
        let connection = Connection::open(&path).unwrap();
        connection
            .pragma_update(None, "foreign_keys", false)
            .unwrap();
        connection.execute_batch(sql).unwrap();
        assert!(Database::open(&path).is_err());
        assert_eq!(raw(&connection), original);
        assert_eq!(
            connection
                .pragma_query_value(None, "user_version", |row| row.get::<_, u32>(0))
                .unwrap(),
            7
        );
        assert!(backups(&path).is_empty());
    }
}

#[test]
fn read_only_verification_does_not_upgrade_and_registry_versions_are_contiguous() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db");
    let original = fixture(&path, 9);
    Database::verify_file(&path).unwrap();
    assert_eq!(raw(&Connection::open(&path).unwrap()), original);
    assert!(backups(&path).is_empty());
    assert_eq!(
        MIGRATIONS
            .iter()
            .map(|migration| migration.version)
            .collect::<Vec<_>>(),
        (1..=DATABASE_VERSION).collect::<Vec<_>>()
    );
}

#[test]
fn duplicate_config_fields_are_rejected_and_migration_checksums_ignore_checkout_line_endings() {
    assert!(
        config_migrations::app_config(&old_config().replacen(
            "\"version\":1",
            "\"version\":1,\"version\":1",
            1
        ))
        .is_err()
    );
    assert!(config_migrations::json(r#"{"nested":{"kept":1,"kept":2}}"#).is_err());
    let first = Migration {
        version: 1,
        name: "test",
        sql: "CREATE TABLE kept(value TEXT);\n",
    };
    let second = Migration {
        version: 1,
        name: "test",
        sql: "CREATE TABLE kept(value TEXT);\r\n",
    };
    assert_eq!(checksum(&first), checksum(&second));
}

#[test]
fn a_real_config_write_failure_rolls_back_structure_history_and_version_together() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db");
    let original = fixture(&path, 9);
    let connection = Connection::open(&path).unwrap();
    connection.execute_batch("CREATE TRIGGER block_config BEFORE UPDATE ON application_settings BEGIN SELECT RAISE(ABORT,'fixture upgrade blocked'); END;").unwrap();
    assert!(matches!(
        Database::open(&path),
        Err(Error::Migration {
            stage: "应用配置",
            ..
        })
    ));
    assert_eq!(raw(&connection), original);
    assert_eq!(
        connection
            .pragma_query_value(None, "user_version", |row| row.get::<_, u32>(0))
            .unwrap(),
        9
    );
    assert_eq!(
        connection
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE name='schema_migrations'",
                [],
                |row| row.get::<_, u32>(0)
            )
            .unwrap(),
        0
    );
    assert_eq!(backups(&path).len(), 1);
    connection
        .execute_batch("DROP TRIGGER block_config;")
        .unwrap();
    Database::open(&path).unwrap();
    assert_eq!(backups(&path).len(), 2);
}

#[test]
fn old_optional_groups_get_defaults_while_required_fields_and_explicit_values_stay_strict() {
    let mut value: Value = serde_json::from_str(&old_config()).unwrap();
    value.as_object_mut().unwrap().remove("terminal");
    value.as_object_mut().unwrap().remove("product");
    value.as_object_mut().unwrap().remove("transferConcurrency");
    let config = config_migrations::app_config(&value.to_string()).unwrap();
    assert_eq!(
        config.terminal.font_family,
        "Cascadia Mono, Consolas, monospace"
    );
    assert_eq!(config.terminal.scrollback, 5000);
    assert_eq!(config.terminal.paste_confirm_chars, 4096);
    assert_eq!(config.product.language, "zh-CN");
    assert_eq!(config.product.shortcuts["search"], "Ctrl+K");
    assert_eq!(config.transfer_concurrency, 3);
    assert_eq!(config.sidebar_width, 312);
    value["terminal"] = json!({"cursorBlink":false,"quickCopyPaste":false});
    let config = config_migrations::app_config(&value.to_string()).unwrap();
    assert!(!config.terminal.cursor_blink);
    assert!(!config.terminal.quick_copy_paste);
    value["product"] = json!({"sshDefaults":{"keepaliveIntervalSecs":47}});
    let config = config_migrations::app_config(&value.to_string()).unwrap();
    assert_eq!(config.product.ssh_defaults.keepalive_interval_secs, 47);
    assert_eq!(config.product.ssh_defaults.auth_timeout_secs, 15);
    value.as_object_mut().unwrap().remove("theme");
    assert!(config_migrations::app_config(&value.to_string()).is_err());
}

#[cfg(any(windows, unix))]
#[test]
fn linked_backup_directory_is_rejected_without_writing_the_target() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db");
    let original = fixture(&path, 9);
    let target = dir.path().join("outside");
    fs::create_dir(&target).unwrap();
    fs::write(target.join("keep.txt"), b"unrelated data").unwrap();
    let link = dir.path().join("migration-backups");
    #[cfg(unix)]
    std::os::unix::fs::symlink(&target, &link).unwrap();
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let status=std::process::Command::new("powershell.exe")
            .args(["-NoProfile","-NonInteractive","-Command","$ErrorActionPreference='Stop'; New-Item -ItemType Junction -Path $env:STORAGE_UPGRADE_TEST_LINK -Target $env:STORAGE_UPGRADE_TEST_TARGET | Out-Null"])
            .env("STORAGE_UPGRADE_TEST_LINK",&link).env("STORAGE_UPGRADE_TEST_TARGET",&target)
            .creation_flags(0x08000000).status().unwrap();
        assert!(status.success());
    }
    assert!(matches!(
        Database::open(&path),
        Err(Error::Migration {
            stage: "升级前备份",
            ..
        })
    ));
    assert_eq!(raw(&Connection::open(&path).unwrap()), original);
    assert_eq!(
        fs::read(target.join("keep.txt")).unwrap(),
        b"unrelated data"
    );
    assert_eq!(fs::read_dir(&target).unwrap().count(), 1);
    #[cfg(unix)]
    fs::remove_file(&link).unwrap();
    #[cfg(windows)]
    fs::remove_dir(&link).unwrap();
}

#[test]
fn publishing_a_backup_never_overwrites_an_existing_file_and_keeps_failure_evidence() {
    let dir = tempfile::tempdir().unwrap();
    let partial = dir.path().join("new.sqlite3.partial");
    let existing = dir.path().join("existing.sqlite3");
    fs::write(&partial, b"new snapshot").unwrap();
    fs::write(&existing, b"original backup").unwrap();
    assert!(publish_backup(&partial, &existing).is_err());
    assert_eq!(fs::read(&existing).unwrap(), b"original backup");
    assert_eq!(fs::read(&partial).unwrap(), b"new snapshot");
}
