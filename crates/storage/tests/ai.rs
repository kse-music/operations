use serverdeck_core::{Error, ai::Config};
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
fn legacy_configuration_is_converted_once_without_changing_key_reference() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db");
    let db = Database::open(&path).unwrap();
    let config = Config {
        model: "existing-user-model".into(),
        base_url: "http://127.0.0.1:8080/v1".into(),
        allow_insecure_http: true,
        ..Default::default()
    };
    let mut legacy = serde_json::json!({"config":config,"secretRef":"existing-os-ref","revision":"old-revision"});
    let legacy_config = legacy["config"].as_object_mut().unwrap();
    legacy_config.remove("contextWindowTokens");
    legacy_config.insert("inputPricePerMillion".into(), serde_json::json!(1.0));
    legacy_config.insert("outputPricePerMillion".into(), serde_json::json!(2.0));
    let connection = rusqlite::Connection::open(&path).unwrap();
    connection
        .execute(
            "INSERT INTO application_settings(key,value) VALUES('ai_config',?1)",
            [legacy.to_string()],
        )
        .unwrap();
    let models = db.ai_models().unwrap();
    assert_eq!(models.len(), 1);
    assert_eq!(models[0].config, config);
    assert_eq!(models[0].name, "默认模型");
    assert_eq!(models[0].secret_ref.as_deref(), Some("existing-os-ref"));
    assert_eq!(models[0].revision, "old-revision");
    let reopened = Database::open(&path).unwrap();
    assert_eq!(reopened.ai_models().unwrap()[0].id, models[0].id);
    assert!(reopened.pending_secret_gc().unwrap().is_empty());
    assert_eq!(
        connection
            .query_row(
                "SELECT COUNT(*) FROM application_settings WHERE key='ai_config'",
                [],
                |r| r.get::<_, u32>(0)
            )
            .unwrap(),
        0
    );
}

#[test]
fn saved_model_windows_round_trip_and_legacy_prices_are_discarded_on_save() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db");
    let db = Database::open(&path).unwrap();
    let connection = rusqlite::Connection::open(&path).unwrap();
    let mut legacy = serde_json::to_value(record("old", "Old model")).unwrap();
    let config = legacy["config"].as_object_mut().unwrap();
    config.remove("contextWindowTokens");
    config.insert("inputPricePerMillion".into(), serde_json::json!(1.0));
    config.insert("outputPricePerMillion".into(), serde_json::json!(2.0));
    let registry = serde_json::json!({"version":1,"models":[legacy]});
    connection
        .execute(
            "INSERT INTO application_settings(key,value) VALUES('ai_models',?1)",
            [registry.to_string()],
        )
        .unwrap();
    let mut model = db.ai_model("old").unwrap();
    assert_eq!(
        model.config.context_window_tokens,
        Config::default().context_window_tokens
    );
    model.config.context_window_tokens = 8192;
    db.ai_model_save(model, Some("r-old")).unwrap();
    let saved = Database::open(&path).unwrap().ai_model("old").unwrap();
    assert_eq!(saved.config.context_window_tokens, 8192);
    assert_eq!(saved.secret_ref.as_deref(), Some("ref-old"));
    let raw: String = connection
        .query_row(
            "SELECT value FROM application_settings WHERE key='ai_models'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(!raw.contains("PricePerMillion"));
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
fn corrupt_legacy_and_future_registry_preserve_data_and_do_not_block_other_modules() {
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
