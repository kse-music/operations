use serverdeck_core::{hosts::*, product::WindowGeometry};
use serverdeck_storage::Database;
fn host(db: &Database, name: &str) -> Host {
    db.host_create(HostInput {
        name: name.into(),
        hostname: "127.0.0.1".into(),
        port: 22,
        username: "test".into(),
        auth_type: AuthType::Password,
        credential_id: None,
        group_id: None,
        description: String::new(),
        favorite: true,
        connect_timeout_secs: 15,
        ssh: Default::default(),
    })
    .unwrap()
}
#[test]
fn unnamed_hosts_keep_distinct_endpoints_after_reopen() {
    let source = tempfile::tempdir().unwrap();
    let path = source.path().join("db");
    let db = Database::open(&path).unwrap();
    let first = host(&db, "");
    let second = host(&db, "");
    let mut config = second.config;
    config.port = 2222;
    db.host_update(&second.id, config).unwrap();
    drop(db);

    let reopened = Database::open(path).unwrap();
    let hosts = reopened.catalog().unwrap().hosts;
    assert_eq!(hosts.len(), 2);
    assert!(hosts.iter().all(|host| host.config.name.is_empty()));
    assert_eq!(reopened.host(&first.id).unwrap().config.port, 22);
    assert_eq!(reopened.host(&second.id).unwrap().config.port, 2222);
}

#[test]
fn additive_preferences_and_logical_window_size_survive_reopen() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db");
    let db = Database::open(&path).unwrap();
    let mut config = db.load_config().unwrap();
    config.product.download_directory = Some(dir.path().to_string_lossy().into_owned());
    config.product.ssh_defaults.keepalive_interval_secs = 42;
    config.product.language = "en-US".into();
    db.save_config(&config).unwrap();
    db.save_window_geometry(WindowGeometry {
        width: 1100.0,
        height: 720.0,
        maximized: false,
    })
    .unwrap();
    let out = Database::open(path).unwrap();
    assert_eq!(out.load_config().unwrap().product, config.product);
    assert_eq!(out.window_geometry().unwrap().unwrap().width, 1100.0);
    assert!(
        db.save_window_geometry(WindowGeometry {
            width: f64::NAN,
            height: 720.0,
            maximized: false
        })
        .is_err()
    );
    let mut old = serde_json::to_value(&config).unwrap();
    old.as_object_mut().unwrap().remove("product");
    assert!(serde_json::from_value::<serverdeck_core::AppConfig>(old).is_err());
    let mut invalid = config.product.clone();
    invalid.shortcuts.insert("tasks".into(), "Ctrl+J".into());
    assert!(invalid.validate().is_err());
}

#[test]
fn saved_width_below_the_current_window_minimum_remains_readable() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db");
    let db = Database::open(&path).unwrap();
    db.save_window_geometry(WindowGeometry {
        width: 900.0,
        height: 600.0,
        maximized: false,
    })
    .unwrap();
    drop(db);

    let geometry = Database::open(path)
        .unwrap()
        .window_geometry()
        .unwrap()
        .unwrap();
    assert_eq!(geometry.width, 900.0);
    assert_eq!(geometry.height, 600.0);
    assert!(!geometry.maximized);
}

#[test]
fn proxy_default_requires_a_live_credential_and_blocks_deletion_until_unlinked() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(dir.path().join("db")).unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    let mut config = db.load_config().unwrap();
    config.product.ssh_defaults.proxy = Some(serverdeck_core::connection::ProxySettings {
        kind: serverdeck_core::connection::ProxyKind::Socks5,
        hostname: "127.0.0.1".into(),
        port: 1080,
        username: Some("proxy-user".into()),
        credential_id: Some(id.clone()),
    });
    assert!(db.save_config(&config).is_err());
    db.credential_save(
        &id,
        None,
        "proxy",
        AuthType::Password,
        None,
        Some("opaque-reference"),
    )
    .unwrap();
    db.save_config(&config).unwrap();
    assert!(db.credential_delete(&id, true).is_err());
    assert!(db.credential_record(&id).is_ok());
    config.product.ssh_defaults.proxy = None;
    db.save_config(&config).unwrap();
    db.credential_delete(&id, false).unwrap();
    assert!(db.credential_record(&id).is_err());
}

#[test]
fn retired_data_stays_intact_after_reopen() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db");
    let db = Database::open(&path).unwrap();
    let connection = rusqlite::Connection::open(&path).unwrap();
    assert_eq!(connection.query_row("SELECT count(*) FROM sqlite_master WHERE type='table' AND name LIKE 'automation_%'", [], |row| row.get::<_, u32>(0)).unwrap(), 0);
    connection.execute_batch("CREATE TABLE automation_entries(id TEXT PRIMARY KEY,document TEXT); INSERT INTO automation_entries VALUES('legacy','retained');").unwrap();
    drop(connection);
    let saved = host(&db, "retained host");
    drop(db);
    let db = Database::open(&path).unwrap();
    assert_eq!(
        rusqlite::Connection::open(&path)
            .unwrap()
            .query_row(
                "SELECT document FROM automation_entries WHERE id='legacy'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
        "retained"
    );
    assert_eq!(db.host(&saved.id).unwrap().config.name, "retained host");
}
