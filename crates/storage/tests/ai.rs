use serverdeck_core::{
    Error,
    ai::{Config, Provider},
};
use serverdeck_storage::{Database, ai::ModelRecord};
fn record(id: &str, name: &str) -> ModelRecord {
    ModelRecord {
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
    let mut invalid = serde_json::to_value(record("a", "Model A")).unwrap();
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
    assert_eq!(models[0].config.context_window_tokens, 131_072);
    let saved: String = connection
        .query_row(
            "SELECT value FROM application_settings WHERE key='ai_models'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let value: serde_json::Value = serde_json::from_str(&saved).unwrap();
    assert_eq!(value["version"], 2);
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
            let mut value = serde_json::json!({"version":2,"models":[record("a","A")]});
            value["models"][0]["config"]
                .as_object_mut()
                .unwrap()
                .remove("contextWindowTokens");
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
    let raw = serde_json::json!({"version":1,"models":[record("a","A")]}).to_string();
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
