use serverdeck_core::{backup::*, hosts::*, product::WindowGeometry};
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
        tags: vec!["中文".into()],
        description: "backup test".into(),
        favorite: true,
        connect_timeout_secs: 15,
        ssh: Default::default(),
    })
    .unwrap()
}
fn restore(text: String, selected: Vec<String>, conflict: ConflictPolicy) -> RestoreInput {
    RestoreInput {
        text,
        selected,
        conflict,
        restore_preferences: false,
        confirmed: true,
    }
}
#[test]
fn unnamed_hosts_roundtrip_without_false_name_conflicts() {
    let source = tempfile::tempdir().unwrap();
    let db = Database::open(source.path().join("db")).unwrap();
    let first = host(&db, "");
    let second = host(&db, "");
    let mut config = second.config;
    config.port = 2222;
    db.host_update(&second.id, config).unwrap();
    let text = db.backup_export().unwrap();
    let target = tempfile::tempdir().unwrap();
    let path = target.path().join("db");
    let out = Database::open(&path).unwrap();
    let existing = host(&out, "");
    let mut config = existing.config;
    config.hostname = "127.0.0.2".into();
    out.host_update(&existing.id, config).unwrap();
    let preview = out.backup_preview(&text).unwrap();
    assert!(preview.items.iter().all(|i| !i.duplicate));
    let mut names = preview
        .items
        .iter()
        .map(|i| i.name.as_str())
        .collect::<Vec<_>>();
    names.sort();
    assert_eq!(names, vec!["127.0.0.1", "127.0.0.1:2222"]);
    let result = out
        .backup_restore(restore(
            text.clone(),
            vec![first.id.clone(), second.id],
            ConflictPolicy::Skip,
        ))
        .unwrap();
    assert_eq!((result.hosts, result.skipped), (2, 0));
    assert!(
        out.backup_preview(&text)
            .unwrap()
            .items
            .iter()
            .all(|i| i.duplicate)
    );
    let result = out
        .backup_restore(restore(text, vec![first.id], ConflictPolicy::Copy))
        .unwrap();
    assert_eq!(result.hosts, 1);
    let reopened = Database::open(path).unwrap();
    let hosts = reopened.catalog().unwrap().hosts;
    assert_eq!(hosts.len(), 4);
    assert!(hosts.iter().all(|h| h.config.name.is_empty()));
}

#[test]
fn backup_roundtrip_preserves_definitions_groups_tags_and_omits_credentials_and_history() {
    let source = tempfile::tempdir().unwrap();
    let db = Database::open(source.path().join("db")).unwrap();
    let group = db
        .group_save(
            None,
            GroupInput {
                parent_id: None,
                name: "Production".into(),
                sort_order: 2,
            },
        )
        .unwrap();
    let h = host(&db, "primary");
    let mut input = h.config;
    input.group_id = Some(group.id);
    let h = db.host_update(&h.id, input).unwrap();
    let credential_id = uuid::Uuid::new_v4().to_string();
    db.credential_save(
        &credential_id,
        None,
        "not exported",
        AuthType::PrivateKey,
        Some("C:/private/key"),
        None,
    )
    .unwrap();
    let text = db.backup_export().unwrap();
    assert!(!text.contains(&credential_id));
    assert!(!text.contains("C:/private/key"));
    assert!(!text.contains("secretRef"));
    assert!(!text.contains("schedules"));
    let target = tempfile::tempdir().unwrap();
    let out = Database::open(target.path().join("db")).unwrap();
    let before = out.backup_preview(&text).unwrap();
    assert!(before.items.iter().all(|i| !i.duplicate));
    let r = out
        .backup_restore(restore(text, vec![h.id], ConflictPolicy::Skip))
        .unwrap();
    assert_eq!(r.hosts, 1);
    let catalog = out.catalog().unwrap();
    assert_eq!(catalog.hosts[0].config.tags, vec!["中文"]);
    assert!(catalog.hosts[0].config.credential_id.is_none());
    assert!(catalog.credentials.is_empty());
    assert_eq!(catalog.groups[0].name, "Production");
}
#[test]
fn duplicate_skip_copy_and_reopen_do_not_overwrite_original() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db");
    let db = Database::open(&path).unwrap();
    let h = host(&db, "primary");
    let text = db.backup_export().unwrap();
    assert!(db.backup_preview(&text).unwrap().items[0].duplicate);
    let r = db
        .backup_restore(restore(
            text.clone(),
            vec![h.id.clone()],
            ConflictPolicy::Skip,
        ))
        .unwrap();
    assert_eq!((r.hosts, r.skipped), (0, 1));
    let r = db
        .backup_restore(restore(text, vec![h.id.clone()], ConflictPolicy::Copy))
        .unwrap();
    assert_eq!(r.hosts, 1);
    let reopened = Database::open(&path).unwrap();
    assert_eq!(reopened.host(&h.id).unwrap().config.name, "primary");
    assert_eq!(reopened.catalog().unwrap().hosts.len(), 2);
}
#[test]
fn invalid_version_unknown_fields_credentials_and_unconfirmed_restore_reject_atomically() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(dir.path().join("db")).unwrap();
    host(&db, "primary");
    let text = db.backup_export().unwrap();
    let original: serde_json::Value = serde_json::from_str(&text).unwrap();
    for (pointer, value) in [
        ("/version", serde_json::json!(99)),
        (
            "/hosts/0/config/credentialId",
            serde_json::json!(uuid::Uuid::new_v4().to_string()),
        ),
        ("/hosts/0/config/port", serde_json::json!(0)),
    ] {
        let mut b = original.clone();
        *b.pointer_mut(pointer).unwrap() = value;
        assert!(db.backup_preview(&b.to_string()).is_err());
    }
    let mut b = original.clone();
    b["credentials"] = serde_json::json!([]);
    assert!(db.backup_preview(&b.to_string()).is_err());
    let mut request = restore(text, vec![], ConflictPolicy::Skip);
    request.confirmed = false;
    assert!(db.backup_restore(request).is_err());
    assert_eq!(db.catalog().unwrap().hosts.len(), 1);
}
#[test]
fn missing_jump_rolls_back_new_groups_hosts_and_preferences() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(dir.path().join("db")).unwrap();
    let jump = host(&db, "jump");
    let child = host(&db, "child");
    let mut config = child.config;
    config.hostname = "127.0.0.2".into();
    config.ssh.jump_host_id = Some(jump.id.clone());
    let child = db.host_update(&child.id, config).unwrap();
    let group = db
        .group_save(
            None,
            GroupInput {
                parent_id: None,
                name: "new group".into(),
                sort_order: 0,
            },
        )
        .unwrap();
    let mut config = child.config;
    config.group_id = Some(group.id);
    db.host_update(&child.id, config).unwrap();
    let text = db.backup_export().unwrap();
    let target = tempfile::tempdir().unwrap();
    let out = Database::open(target.path().join("db")).unwrap();
    let mut request = restore(text.clone(), vec![child.id.clone()], ConflictPolicy::Copy);
    request.restore_preferences = true;
    assert!(out.backup_restore(request).is_err());
    assert!(out.catalog().unwrap().groups.is_empty());
    assert!(out.catalog().unwrap().hosts.is_empty());
    let r = out
        .backup_restore(restore(text, vec![child.id, jump.id], ConflictPolicy::Copy))
        .unwrap();
    assert_eq!(r.hosts, 2);
    let c = out.catalog().unwrap();
    let imported = c.hosts.iter().find(|h| h.config.name == "child").unwrap();
    assert!(
        c.hosts
            .iter()
            .any(|h| Some(&h.id) == imported.config.ssh.jump_host_id.as_ref())
    );
}
#[test]
fn authenticated_proxy_is_blocked_and_secret_defaults_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(dir.path().join("db")).unwrap();
    let h = host(&db, "primary");
    let id = uuid::Uuid::new_v4().to_string();
    db.credential_save(
        &id,
        None,
        "proxy",
        AuthType::Password,
        None,
        Some("opaque-reference"),
    )
    .unwrap();
    let mut c = h.config;
    c.ssh.proxy = Some(serverdeck_core::connection::ProxySettings {
        kind: serverdeck_core::connection::ProxyKind::Socks5,
        hostname: "127.0.0.1".into(),
        port: 1080,
        username: Some("proxy-user".into()),
        credential_id: Some(id.clone()),
    });
    db.host_update(&h.id, c).unwrap();
    let text = db.backup_export().unwrap();
    assert!(!text.contains(&id));
    let p = db.backup_preview(&text).unwrap();
    assert!(p.items[0].blocked);
    assert!(
        db.backup_restore(restore(text, vec![h.id], ConflictPolicy::Copy))
            .is_err()
    );
}
#[test]
fn additive_preferences_and_logical_window_size_survive_reopen() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db");
    let db = Database::open(&path).unwrap();
    let mut config = db.load_config().unwrap();
    config.product.download_directory = Some(dir.path().to_string_lossy().into_owned());
    config.product.ssh_defaults.keepalive_interval_secs = 42;
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
    let mut old = serde_json::to_value(config).unwrap();
    old.as_object_mut().unwrap().remove("product");
    let migrated: serverdeck_core::AppConfig = serde_json::from_value(old).unwrap();
    assert_eq!(migrated.product.language, "zh-CN");
    migrated.validate().unwrap();
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
fn retired_data_stays_intact_and_legacy_backup_only_restores_hosts_and_preferences() {
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
    let mut backup: serde_json::Value = serde_json::from_str(&db.backup_export().unwrap()).unwrap();
    assert_eq!(backup["version"], 3);
    assert!(backup.get("entries").is_none());
    assert!(backup.get("commandGroups").is_none());
    backup["version"] = serde_json::json!(2);
    backup["entries"] = serde_json::json!([{"old":"ignored, never executed"}]);
    backup["commandGroups"] = serde_json::json!([]);
    let old = serde_json::to_string(&backup).unwrap();
    let other = tempfile::tempdir().unwrap();
    let target = Database::open(other.path().join("db")).unwrap();
    let preview = target.backup_preview(&old).unwrap();
    assert_eq!(preview.items.len(), 1);
    assert!(preview.warnings.iter().any(|w| w.contains("旧版命令库")));
    let result = target
        .backup_restore(restore(old, vec![saved.id], ConflictPolicy::Skip))
        .unwrap();
    assert_eq!(result.hosts, 1);
    assert!(result.warnings.iter().any(|w| w.contains("旧版命令库")));
    assert_eq!(
        target.catalog().unwrap().hosts[0].config.name,
        "retained host"
    );
}
