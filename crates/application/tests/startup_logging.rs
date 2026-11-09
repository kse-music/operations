use rusqlite::Connection;
use serverdeck_application::{Application, logging};
use serverdeck_core::{Error, LogLevel};

#[test]
fn early_upgrade_diagnostics_survive_failure_and_persisted_log_level_can_be_applied() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("serverdeck.sqlite3");
    let connection = Connection::open(&path).unwrap();
    connection
        .execute_batch(include_str!("../../storage/tests/fixtures/schema-9.sql"))
        .unwrap();
    connection.pragma_update(None, "user_version", 9).unwrap();
    connection
        .execute(
            "INSERT INTO application_settings(key,value) VALUES('app_config',?1)",
            ["fixture-private-configuration-payload"],
        )
        .unwrap();
    let logs = root.path().join("logs");
    let logger = logging::initialize(&logs, LogLevel::Info).unwrap();
    tracing::info!(target:"serverdeck_application", operation="fixture-shown-info", "startup diagnostics active");
    assert!(matches!(
        Application::initialize(root.path().into(), logs.clone()),
        Err(Error::Migration { .. })
    ));
    logger.set_level(LogLevel::Error).unwrap();
    tracing::info!(target:"serverdeck_application", operation="fixture-hidden-info", "filtered after config level applied");
    logger.flush();
    let output = std::fs::read_to_string(logs.join("serverdeck.log")).unwrap();
    assert!(output.contains("fixture-shown-info"));
    assert!(output.contains("data_upgrade"));
    assert!(output.contains("应用配置检查"));
    assert!(output.contains("config_json"));
    assert!(!output.contains("fixture-hidden-info"));
    assert!(!output.contains("fixture-private-configuration-payload"));
    assert_eq!(
        output
            .lines()
            .filter(|line| line.contains("local data upgrade failed"))
            .count(),
        1
    );
}
