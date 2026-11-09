use rusqlite::{Connection, params};
use serde_json::json;
use serverdeck_application::Application;
use serverdeck_core::{AppConfig, CONFIG_VERSION, DATABASE_VERSION, Error, Theme};

#[tokio::test]
async fn startup_upgrades_an_existing_profile_before_bootstrap_and_keeps_user_records() {
    let root = tempfile::tempdir().unwrap();
    let data = root.path().join("data");
    std::fs::create_dir(&data).unwrap();
    let path = data.join("serverdeck.sqlite3");
    let connection = Connection::open(&path).unwrap();
    connection
        .execute_batch(include_str!("../../storage/tests/fixtures/schema-9.sql"))
        .unwrap();
    connection.pragma_update(None, "user_version", 9).unwrap();
    let mut config = serde_json::to_value(AppConfig {
        theme: Theme::Light,
        sidebar_width: 301,
        ..Default::default()
    })
    .unwrap();
    config["version"] = json!(1);
    config.as_object_mut().unwrap().remove("interfaceFontSize");
    let original = config.to_string();
    connection.execute("INSERT INTO application_settings(key,value) VALUES('app_config',?1),('plugin:kept',?2)",params![original,r#"{"enabled":false,"custom":"kept"}"#]).unwrap();
    connection.execute_batch("INSERT INTO credentials(id,name,kind,secret_ref) VALUES('fixture-credential','Kept credential','password','opaque-kept-reference'); INSERT INTO hosts(id,name,hostname,port,username,auth_type,credential_id,description,connect_timeout_secs) VALUES('fixture-host','Kept host','192.0.2.1',22,'ops','password','fixture-credential','Kept description',15);").unwrap();
    drop(connection);
    let app = Application::initialize(data.clone(), data.join("logs")).unwrap();
    let bootstrap = app.bootstrap().await.unwrap();
    assert_eq!(bootstrap.database_version, DATABASE_VERSION);
    assert_eq!(bootstrap.config.version, CONFIG_VERSION);
    assert_eq!(bootstrap.config.theme, Theme::Light);
    assert_eq!(bootstrap.config.sidebar_width, 301);
    let connection = Connection::open(&path).unwrap();
    assert_eq!(
        connection
            .query_row(
                "SELECT credential_id,description FROM hosts WHERE id='fixture-host'",
                [],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            )
            .unwrap(),
        ("fixture-credential".into(), "Kept description".into())
    );
    assert_eq!(
        connection
            .query_row(
                "SELECT secret_ref FROM credentials WHERE id='fixture-credential'",
                [],
                |row| row.get::<_, String>(0)
            )
            .unwrap(),
        "opaque-kept-reference"
    );
    let backups = std::fs::read_dir(data.join("migration-backups"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .collect::<Vec<_>>();
    assert_eq!(backups.len(), 1);
    let backup = Connection::open(&backups[0]).unwrap();
    assert_eq!(
        backup
            .query_row(
                "SELECT value FROM application_settings WHERE key='app_config'",
                [],
                |row| row.get::<_, String>(0)
            )
            .unwrap(),
        original
    );
    assert_eq!(
        backup
            .pragma_query_value(None, "user_version", |row| row.get::<_, u32>(0))
            .unwrap(),
        9
    );
    app.shutdown().await;
    let reopened = Application::initialize(data.clone(), data.join("logs")).unwrap();
    assert_eq!(reopened.bootstrap().await.unwrap().config, bootstrap.config);
    assert_eq!(
        std::fs::read_dir(data.join("migration-backups"))
            .unwrap()
            .count(),
        1
    );
    reopened.shutdown().await;
}

#[test]
fn invalid_old_config_stops_startup_without_committing_schema_or_replacing_preferences() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("serverdeck.sqlite3");
    let connection = Connection::open(&path).unwrap();
    connection
        .execute_batch(include_str!("../../storage/tests/fixtures/schema-9.sql"))
        .unwrap();
    connection.pragma_update(None, "user_version", 9).unwrap();
    let original = r#"{"version":1,"theme":"light","sidebarWidth":0}"#;
    connection
        .execute(
            "INSERT INTO application_settings(key,value) VALUES('app_config',?1)",
            [original],
        )
        .unwrap();
    assert!(matches!(
        Application::initialize(root.path().into(), root.path().join("logs")),
        Err(Error::Migration { .. })
    ));
    assert_eq!(
        connection
            .pragma_query_value(None, "user_version", |row| row.get::<_, u32>(0))
            .unwrap(),
        9
    );
    assert_eq!(
        connection
            .query_row(
                "SELECT value FROM application_settings WHERE key='app_config'",
                [],
                |row| row.get::<_, String>(0)
            )
            .unwrap(),
        original
    );
}
