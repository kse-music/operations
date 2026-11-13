use serverdeck_core::{
    Error,
    ai::{Config, Provider},
};
use serverdeck_storage::{Database, ai::ModelRecord};
fn record(id: &str, name: &str) -> ModelRecord {
    ModelRecord {
        created_at: None,
        id: id.into(),
        name: name.into(),
        config: Config {
            model: format!("fixture-{id}"),
            ..Default::default()
        },
        secret_ref: Some(format!("ref-{id}")),
        revision: format!("r-{id}"),
    }
}

fn historical_record(id: &str, name: &str) -> serde_json::Value {
    serde_json::json!({
        "id": id, "name": name, "revision": format!("r-{id}"),
        "secretRef": format!("ref-{id}"),
        "config": { "provider": "openai_compatible", "baseUrl": "https://api.openai.com/v1",
            "model": format!("fixture-{id}"), "allowInsecureHttp": false,
            "maxOutputTokens": 2048, "contextWindowTokens": 131072 }
    })
}

#[test]
fn local_codex_consent_is_opt_in_persistent_and_revocable() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db");
    let db = Database::open(&path).unwrap();
    assert!(!db.ai_local_codex_consent().unwrap().authorized);
    db.ai_model_save(record("existing", "Existing"), None)
        .unwrap();
    db.ai_local_codex_authorize(true).unwrap();
    let approved = Database::open(&path)
        .unwrap()
        .ai_local_codex_consent()
        .unwrap();
    assert!(approved.authorized);
    db.ai_local_codex_authorize(false).unwrap();
    let revoked = db.ai_local_codex_consent().unwrap();
    assert!(!revoked.authorized);
    assert_ne!(approved.revision, revoked.revision);
    assert_eq!(db.ai_models().unwrap()[0].id, "existing");
}

#[test]
fn local_provider_consents_are_independent_and_keep_registered_models() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db");
    let db = Database::open(&path).unwrap();
    assert!(
        !db.ai_local_consent(Provider::LocalClaudeCode)
            .unwrap()
            .authorized
    );
    db.ai_model_save(record("existing", "Existing"), None)
        .unwrap();
    db.ai_local_codex_authorize(true).unwrap();
    let codex = db.ai_local_codex_consent().unwrap();
    db.ai_local_authorize(Provider::LocalClaudeCode, true)
        .unwrap();
    let reopened = Database::open(&path).unwrap();
    let claude = reopened
        .ai_local_consent(Provider::LocalClaudeCode)
        .unwrap();
    assert!(claude.authorized);
    db.ai_local_authorize(Provider::LocalClaudeCode, false)
        .unwrap();
    let revoked = db.ai_local_consent(Provider::LocalClaudeCode).unwrap();
    assert!(!revoked.authorized);
    assert_ne!(claude.revision, revoked.revision);
    assert_eq!(
        db.ai_local_codex_consent().unwrap().revision,
        codex.revision
    );
    assert!(db.ai_local_codex_consent().unwrap().authorized);
    assert_eq!(db.ai_models().unwrap()[0].id, "existing");
}

#[test]
fn old_model_format_upgrades_once_without_changing_identity_secret_reference_or_context() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db");
    let db = Database::open(&path).unwrap();
    let connection = rusqlite::Connection::open(&path).unwrap();
    let mut invalid = historical_record("a", "Model A");
    invalid["config"]["inputPricePerMillion"] = serde_json::json!(1.0);
    invalid["config"]
        .as_object_mut()
        .unwrap()
        .remove("contextWindowTokens");
    let raw = serde_json::json!({"version":1,"models":[invalid]}).to_string();
    connection
        .execute(
            "INSERT INTO application_settings(key,value) VALUES('ai_models',?1)",
            [&raw],
        )
        .unwrap();
    let models = db.ai_models().unwrap();
    assert_eq!(models[0].id, "a");
    assert_eq!(models[0].name, "Model A");
    assert_eq!(models[0].secret_ref.as_deref(), Some("ref-a"));
    assert_eq!(models[0].revision, "r-a");
    assert!(models[0].created_at.is_none());
    assert_eq!(models[0].config.context_window_tokens, 131_072);
    let saved: String = connection
        .query_row(
            "SELECT value FROM application_settings WHERE key='ai_models'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let value: serde_json::Value = serde_json::from_str(&saved).unwrap();
    assert_eq!(value["version"], 3);
    assert!(value["models"][0]["createdAt"].is_null());
    assert!(
        value["models"][0]["config"]
            .get("inputPricePerMillion")
            .is_none()
    );
    let backups = std::fs::read_dir(dir.path().join("migration-backups"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .collect::<Vec<_>>();
    assert_eq!(backups.len(), 1);
    let backup = rusqlite::Connection::open(&backups[0]).unwrap();
    assert_eq!(
        backup
            .query_row(
                "SELECT value FROM application_settings WHERE key='ai_models'",
                [],
                |row| row.get::<_, String>(0)
            )
            .unwrap(),
        raw
    );
    assert_eq!(db.ai_models().unwrap()[0].id, "a");
    assert_eq!(
        std::fs::read_dir(dir.path().join("migration-backups"))
            .unwrap()
            .count(),
        1
    );
}
#[test]
fn saved_model_context_windows_and_key_references_round_trip() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db");
    let db = Database::open(&path).unwrap();
    let mut model = record("a", "Model A");
    model.config.context_window_tokens = 8192;
    db.ai_model_save(model.clone(), None).unwrap();
    let saved = Database::open(&path).unwrap().ai_model("a").unwrap();
    assert_eq!(saved.config, model.config);
    assert_eq!(saved.secret_ref, model.secret_ref);
}

#[test]
fn registration_time_is_assigned_by_storage_and_preserved_on_edit_and_reopen() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db");
    let db = Database::open(&path).unwrap();
    let connection = rusqlite::Connection::open(&path).unwrap();
    let before: String = connection
        .query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now')", [], |r| {
            r.get(0)
        })
        .unwrap();
    let mut input = record("a", "Model A");
    input.created_at = Some("2000-01-01T00:00:00.000Z".into());
    let saved = db.ai_model_save(input, None).unwrap();
    let after: String = connection
        .query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now')", [], |r| {
            r.get(0)
        })
        .unwrap();
    let time = saved.created_at.as_deref().unwrap();
    assert!(time >= before.as_str() && time <= after.as_str());
    assert_eq!(saved.public().created_at, saved.created_at);
    // A fixed historical time makes an accidental reset detectable even in the same millisecond.
    connection.execute("UPDATE application_settings SET value=json_set(value,'$.models[0].createdAt','2020-01-02T03:04:05.000Z') WHERE key='ai_models'", []).unwrap();
    let mut changed = saved.clone();
    changed.name = "Renamed A".into();
    changed.revision = "r2".into();
    changed.created_at = None;
    let changed = db.ai_model_save(changed, Some(&saved.revision)).unwrap();
    assert_eq!(
        changed.created_at.as_deref(),
        Some("2020-01-02T03:04:05.000Z")
    );
    assert_eq!(
        Database::open(&path)
            .unwrap()
            .ai_model("a")
            .unwrap()
            .created_at,
        changed.created_at
    );
    assert!(!dir.path().join("migration-backups").exists());
}

#[test]
fn v2_upgrade_serializes_concurrent_reads_and_backs_up_committed_wal_without_changing_models() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db");
    let db = Database::open(&path).unwrap();
    let connection = rusqlite::Connection::open(&path).unwrap();
    connection
        .pragma_update(None, "journal_mode", "WAL")
        .unwrap();
    connection
        .pragma_update(None, "wal_autocheckpoint", 0)
        .unwrap();
    let mut a = historical_record("a", "Model A");
    a["config"]["contextWindowTokens"] = serde_json::json!(65536);
    let raw = serde_json::json!({"version":2,"models":[a, historical_record("b", "Model B")]})
        .to_string();
    connection
        .execute(
            "INSERT INTO application_settings(key,value) VALUES('ai_models',?1)",
            [&raw],
        )
        .unwrap();
    let config = db.load_config().unwrap();
    let barrier = std::sync::Barrier::new(2);
    std::thread::scope(|scope| {
        let readers = (0..2)
            .map(|_| {
                scope.spawn(|| {
                    barrier.wait();
                    Database::open(&path).unwrap().ai_models().unwrap()
                })
            })
            .collect::<Vec<_>>();
        for reader in readers {
            let models = reader.join().unwrap();
            assert_eq!(models.len(), 2);
            for model in &models {
                assert!(model.created_at.is_none());
            }
        }
    });
    let backups = std::fs::read_dir(dir.path().join("migration-backups"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .collect::<Vec<_>>();
    assert_eq!(backups.len(), 1);
    let backup = rusqlite::Connection::open(&backups[0]).unwrap();
    let original: String = backup
        .query_row(
            "SELECT value FROM application_settings WHERE key='ai_models'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(original, raw);
    drop(backup);
    let saved: String = connection
        .query_row(
            "SELECT value FROM application_settings WHERE key='ai_models'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let mut saved: serde_json::Value = serde_json::from_str(&saved).unwrap();
    assert_eq!(saved["version"], 3);
    for model in saved["models"].as_array_mut().unwrap() {
        assert_eq!(
            model.as_object_mut().unwrap().remove("createdAt"),
            Some(serde_json::Value::Null)
        );
    }
    saved["version"] = serde_json::json!(2);
    assert_eq!(
        saved,
        serde_json::from_str::<serde_json::Value>(&raw).unwrap()
    );
    let mut edited = db.ai_model("a").unwrap();
    edited.name = "Renamed A".into();
    edited.revision = "r2".into();
    assert!(
        db.ai_model_save(edited, Some("r-a"))
            .unwrap()
            .created_at
            .is_none()
    );
    assert_eq!(
        Database::open(&path).unwrap().load_config().unwrap(),
        config
    );
    assert!(db.ai_model("a").unwrap().created_at.is_none());
    assert_eq!(
        std::fs::read_dir(dir.path().join("migration-backups"))
            .unwrap()
            .count(),
        1
    );
}

#[test]
fn model_upgrades_roll_back_after_backup_or_write_failure_and_can_retry() {
    for version in [1, 2] {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("db");
        let db = Database::open(&path).unwrap();
        let connection = rusqlite::Connection::open(&path).unwrap();
        let raw = serde_json::json!({"version":version,"models":[historical_record("a", "A")]})
            .to_string();
        connection
            .execute(
                "INSERT INTO application_settings(key,value) VALUES('ai_models',?1)",
                [&raw],
            )
            .unwrap();
        let backup_directory = dir.path().join("migration-backups");
        std::fs::write(&backup_directory, b"occupied").unwrap();
        assert!(db.ai_models().is_err());
        let unchanged = || {
            let current: String = connection
                .query_row(
                    "SELECT value FROM application_settings WHERE key='ai_models'",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(current, raw);
            assert!(Database::open(&path).unwrap().load_config().is_ok());
        };
        unchanged();
        std::fs::remove_file(&backup_directory).unwrap();
        connection.execute_batch("CREATE TRIGGER reject_model_upgrade BEFORE UPDATE ON application_settings WHEN OLD.key='ai_models' BEGIN SELECT RAISE(ABORT,'injected model write failure'); END;").unwrap();
        assert!(db.ai_models().is_err());
        unchanged();
        assert_eq!(std::fs::read_dir(&backup_directory).unwrap().count(), 1);
        connection
            .execute_batch("DROP TRIGGER reject_model_upgrade;")
            .unwrap();
        let models = db.ai_models().unwrap();
        assert_eq!(models[0].id, "a");
        assert_eq!(models[0].secret_ref.as_deref(), Some("ref-a"));
        assert!(models[0].created_at.is_none());
        assert_eq!(std::fs::read_dir(&backup_directory).unwrap().count(), 2);
    }
}
#[test]
fn model_crud_reopens_rejects_conflicts_and_keeps_other_credentials() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db");
    let db = Database::open(&path).unwrap();
    db.queue_secret_gc("ref-a").unwrap();
    let a = db.ai_model_save(record("a", "Model A"), None).unwrap();
    let b = db.ai_model_save(record("b", "Model B"), None).unwrap();
    assert!(db.pending_secret_gc().unwrap().is_empty());
    let mut changed = a.clone();
    changed.name = "renamed".into();
    changed.revision = "r2".into();
    changed.secret_ref = Some("ref-a-new".into());
    assert!(matches!(
        db.ai_model_save(changed.clone(), Some("stale")),
        Err(Error::Conflict)
    ));
    db.ai_model_save(changed.clone(), Some(&a.revision))
        .unwrap();
    assert_eq!(db.pending_secret_gc().unwrap(), vec!["ref-a"]);
    let reopened = Database::open(&path).unwrap();
    assert_eq!(reopened.ai_model("a").unwrap().name, "renamed");
    assert_eq!(reopened.ai_model("b").unwrap().secret_ref, b.secret_ref);
    assert!(matches!(
        db.ai_model_delete("a", "stale"),
        Err(Error::Conflict)
    ));
    let mut duplicate = record("c", "MODEL B");
    assert!(reopened.ai_model_save(duplicate.clone(), None).is_err());
    duplicate.name = "unique".into();
    assert!(matches!(
        reopened.ai_model_save(duplicate, Some("deleted")),
        Err(Error::NotFound)
    ));
    reopened.ai_model_delete("a", "r2").unwrap();
    assert!(matches!(reopened.ai_model("a"), Err(Error::NotFound)));
    assert_eq!(reopened.ai_models().unwrap().len(), 1);
    assert!(
        reopened
            .pending_secret_gc()
            .unwrap()
            .contains(&"ref-a-new".into())
    );
    assert!(
        !reopened
            .pending_secret_gc()
            .unwrap()
            .contains(&"ref-b".into())
    );
}
#[test]
fn damaged_legacy_settings_and_unsupported_registry_are_not_rewritten_or_block_startup() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db");
    let db = Database::open(&path).unwrap();
    let connection = rusqlite::Connection::open(&path).unwrap();
    connection
        .execute(
            "INSERT INTO application_settings(key,value) VALUES('ai_config','broken')",
            [],
        )
        .unwrap();
    assert!(db.ai_models().is_err());
    assert_eq!(
        connection
            .query_row(
                "SELECT value FROM application_settings WHERE key='ai_config'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
        "broken"
    );
    connection.execute("INSERT INTO application_settings(key,value) VALUES('ai_models','{\"version\":99,\"models\":[]}')",[]).unwrap();
    assert!(db.ai_models().is_err());
    let reopened = Database::open(path).unwrap();
    assert_eq!(reopened.load_config().unwrap(), db.load_config().unwrap());
    assert!(reopened.catalog().unwrap().hosts.is_empty());
}

#[test]
fn legacy_single_model_migrates_lazily_and_keeps_the_original_row_and_secret_reference() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db");
    let db = Database::open(&path).unwrap();
    let connection = rusqlite::Connection::open(&path).unwrap();
    let legacy = serde_json::json!({"config":Config {model:"kept-model".into(),..Default::default()},"secretRef":"opaque-original-reference","revision":"original-revision"}).to_string();
    connection.execute("INSERT INTO application_settings(key,value,updated_at) VALUES('ai_config',?1,'original-time')", [&legacy]).unwrap();
    Database::open(&path).unwrap();
    assert!(!dir.path().join("migration-backups").exists());
    let models = db.ai_models().unwrap();
    assert_eq!(models.len(), 1);
    assert_eq!(models[0].name, "默认模型");
    assert_eq!(models[0].config.model, "kept-model");
    assert_eq!(
        models[0].secret_ref.as_deref(),
        Some("opaque-original-reference")
    );
    assert_eq!(models[0].revision, "original-revision");
    assert!(models[0].created_at.is_none());
    assert_eq!(
        connection
            .query_row(
                "SELECT value FROM application_settings WHERE key='ai_config'",
                [],
                |row| row.get::<_, String>(0)
            )
            .unwrap(),
        legacy
    );
    assert_eq!(db.ai_models().unwrap()[0].id, models[0].id);
    assert_eq!(
        std::fs::read_dir(dir.path().join("migration-backups"))
            .unwrap()
            .count(),
        1
    );
}

#[test]
fn model_upgrade_failures_preserve_raw_settings_and_do_not_block_application_config() {
    for value in [
        serde_json::json!({"version":1,"models":["invalid"]}),
        serde_json::json!({"version":1,"models":[{"config":null}]}),
        serde_json::json!({"version":99,"models":[]}),
        {
            let mut value = serde_json::json!({"version":2,"models":[historical_record("a","A")]});
            value["models"][0]["config"]
                .as_object_mut()
                .unwrap()
                .remove("contextWindowTokens");
            value
        },
        serde_json::json!({"version":2,"models":[record("a","A")]}),
        serde_json::json!({"version":3,"models":[historical_record("a","A")]}),
        {
            let mut value = serde_json::json!({"version":3,"models":[record("a","A")]});
            value["models"][0]["createdAt"] = serde_json::json!(123);
            value
        },
        {
            let mut value = serde_json::json!({"version":3,"models":[record("a","A")]});
            value["models"][0]["createdAt"] = serde_json::json!("invalid-time");
            value
        },
        {
            let mut value = serde_json::json!({"version":3,"models":[record("a","A")]});
            value["models"][0]["createdAt"] = serde_json::json!("");
            value
        },
    ] {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("db");
        let db = Database::open(&path).unwrap();
        let connection = rusqlite::Connection::open(&path).unwrap();
        let raw = value.to_string();
        connection
            .execute(
                "INSERT INTO application_settings(key,value) VALUES('ai_models',?1)",
                [&raw],
            )
            .unwrap();
        assert!(db.ai_models().is_err());
        assert_eq!(
            connection
                .query_row(
                    "SELECT value FROM application_settings WHERE key='ai_models'",
                    [],
                    |row| row.get::<_, String>(0)
                )
                .unwrap(),
            raw
        );
        assert!(!dir.path().join("migration-backups").exists());
        assert!(Database::open(&path).unwrap().load_config().is_ok());
    }
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db");
    let db = Database::open(&path).unwrap();
    let connection = rusqlite::Connection::open(&path).unwrap();
    let raw = serde_json::json!({"version":1,"models":[historical_record("a","A")]}).to_string();
    connection
        .execute(
            "INSERT INTO application_settings(key,value) VALUES('ai_models',?1)",
            [&raw],
        )
        .unwrap();
    std::fs::write(dir.path().join("migration-backups"), b"occupied").unwrap();
    assert!(matches!(db.ai_models(), Err(Error::Migration { .. })));
    assert_eq!(
        connection
            .query_row(
                "SELECT value FROM application_settings WHERE key='ai_models'",
                [],
                |row| row.get::<_, String>(0)
            )
            .unwrap(),
        raw
    );
}
