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
fn removed_model_fields_are_rejected_without_rewriting_the_registry() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db");
    let db = Database::open(&path).unwrap();
    let connection = rusqlite::Connection::open(&path).unwrap();
    let mut invalid = serde_json::to_value(record("a", "Model A")).unwrap();
    invalid["config"]["inputPricePerMillion"] = serde_json::json!(1.0);
    let raw = serde_json::json!({"version":1,"models":[invalid]}).to_string();
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
fn unused_old_settings_and_unsupported_registry_are_not_rewritten() {
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
    assert!(db.ai_models().unwrap().is_empty());
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
