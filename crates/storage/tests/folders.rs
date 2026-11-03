use rusqlite::Connection;
use serverdeck_core::{backup::*, hosts::*};
use serverdeck_storage::Database;

fn folder(db: &Database, name: &str, parent: Option<&str>) -> HostGroup {
    db.group_save(
        None,
        GroupInput {
            name: name.into(),
            sort_order: 0,
            parent_id: parent.map(str::to_owned),
        },
    )
    .unwrap()
}
fn host(db: &Database, group: Option<&str>) -> Host {
    db.host_create(HostInput {
        name: "主机".into(),
        hostname: "example.com".into(),
        port: 22,
        username: "ops".into(),
        auth_type: AuthType::Agent,
        credential_id: None,
        group_id: group.map(str::to_owned),
        tags: vec!["历史".into()],
        description: "保留".into(),
        favorite: true,
        connect_timeout_secs: 15,
        ssh: Default::default(),
    })
    .unwrap()
}

#[test]
fn v6_migration_keeps_host_membership_and_creates_no_synthetic_database_root() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db");
    let c = Connection::open(&path).unwrap();
    for sql in [
        include_str!("../migrations/001_settings.sql"),
        include_str!("../migrations/002_hosts.sql"),
        include_str!("../migrations/003_known_hosts.sql"),
        include_str!("../migrations/004_terminal_workspace.sql"),
        include_str!("../migrations/005_automation.sql"),
        include_str!("../migrations/006_optional_host_name.sql"),
    ] {
        c.execute_batch(sql).unwrap();
    }
    c.execute(
        "INSERT INTO host_groups(id,name,sort_order) VALUES('legacy','上海',3)",
        [],
    )
    .unwrap();
    c.execute("INSERT INTO hosts(id,name,hostname,port,username,auth_type,group_id,connect_timeout_secs) VALUES('host','','192.0.2.1',22,'ops','agent','legacy',15)", []).unwrap();
    c.pragma_update(None, "user_version", 6).unwrap();
    drop(c);
    let db = Database::open(&path).unwrap();
    assert_eq!(db.version().unwrap(), 7);
    let data = db.catalog().unwrap();
    assert_eq!(data.groups.len(), 1);
    assert_eq!(data.groups[0].name, "上海");
    assert_eq!(data.groups[0].parent_id, None);
    assert_eq!(data.hosts[0].config.group_id.as_deref(), Some("legacy"));
    assert!(data.hosts[0].config.name.is_empty());
    assert_eq!(
        Database::open(&path)
            .unwrap()
            .catalog()
            .unwrap()
            .groups
            .len(),
        1
    );
}

#[test]
fn hierarchy_copy_delete_and_restart_preserve_contents_and_reject_invalid_parents() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db");
    let db = Database::open(&path).unwrap();
    let a = folder(&db, "生产", None);
    let b = folder(&db, "上海", Some(&a.id));
    let c = folder(&db, "应用", Some(&b.id));
    let h = host(&db, Some(&b.id));
    let credential_id = uuid::Uuid::new_v4().to_string();
    db.credential_save(
        &credential_id,
        None,
        "共享私钥引用",
        AuthType::PrivateKey,
        Some("C:/keys/test"),
        None,
    )
    .unwrap();
    let mut config = h.config.clone();
    config.auth_type = AuthType::PrivateKey;
    config.credential_id = Some(credential_id.clone());
    let h = db.host_update(&h.id, config).unwrap();
    let deep = host(&db, Some(&c.id));
    let copied = db.host_copy(&h.id).unwrap();
    assert_ne!(copied.id, h.id);
    assert_eq!(copied.config.group_id, h.config.group_id);
    assert_eq!(copied.config.tags, h.config.tags);
    assert_eq!(copied.config.ssh, h.config.ssh);
    let mut expected = h.config.clone();
    expected.name = copied.config.name.clone();
    assert_eq!(copied.config, expected);
    for parent in [&a.id, &b.id, &c.id] {
        assert!(
            db.group_save(
                Some(&a.id),
                GroupInput {
                    name: a.name.clone(),
                    sort_order: 0,
                    parent_id: Some(parent.clone())
                }
            )
            .is_err()
        );
    }
    assert!(
        db.group_save(
            None,
            GroupInput {
                name: "missing".into(),
                sort_order: 0,
                parent_id: Some("missing".into())
            }
        )
        .is_err()
    );
    let raw = Connection::open(&path).unwrap();
    raw.pragma_update(None, "foreign_keys", true).unwrap();
    assert!(
        raw.execute("UPDATE host_groups SET parent_id=?1 WHERE id=?1", [&a.id])
            .is_err()
    );
    assert!(
        raw.execute(
            "UPDATE host_groups SET parent_id='missing' WHERE id=?1",
            [&a.id]
        )
        .is_err()
    );
    db.group_delete(&b.id).unwrap();
    let data = Database::open(&path).unwrap().catalog().unwrap();
    assert_eq!(
        data.groups
            .iter()
            .find(|g| g.id == c.id)
            .unwrap()
            .parent_id
            .as_deref(),
        Some(a.id.as_str())
    );
    assert_eq!(data.hosts.len(), 3);
    assert_eq!(data.credentials[0].id, credential_id);
    assert_eq!(data.credentials[0].host_count, 2);
    assert_eq!(
        db.host(&h.id).unwrap().config.group_id.as_deref(),
        Some(a.id.as_str())
    );
    assert_eq!(
        db.host(&deep.id).unwrap().config.group_id.as_deref(),
        Some(c.id.as_str())
    );
    db.group_delete(&a.id).unwrap();
    assert!(db.host(&h.id).unwrap().config.group_id.is_none());
    assert!(
        db.catalog()
            .unwrap()
            .groups
            .iter()
            .find(|g| g.id == c.id)
            .unwrap()
            .parent_id
            .is_none()
    );
    assert!(db.group_delete("").is_err());
}

#[test]
fn backup_restores_folder_ancestry_in_any_order_and_rejects_cycles_atomically() {
    let dir = tempfile::tempdir().unwrap();
    let source = Database::open(dir.path().join("source")).unwrap();
    let a = folder(&source, "生产", None);
    let b = folder(&source, "上海", Some(&a.id));
    let h = host(&source, Some(&b.id));
    let mut json: serde_json::Value =
        serde_json::from_str(&source.backup_export().unwrap()).unwrap();
    assert_eq!(json["version"], 2);
    json["groups"].as_array_mut().unwrap().reverse();
    let target = Database::open(dir.path().join("target")).unwrap();
    target
        .backup_restore(RestoreInput {
            text: json.to_string(),
            selected: vec![h.id.clone()],
            conflict: ConflictPolicy::Copy,
            restore_preferences: false,
            confirmed: true,
        })
        .unwrap();
    let data = target.catalog().unwrap();
    let restored_a = data.groups.iter().find(|g| g.name == "生产").unwrap();
    let restored_b = data.groups.iter().find(|g| g.name == "上海").unwrap();
    assert_eq!(
        restored_b.parent_id.as_deref(),
        Some(restored_a.id.as_str())
    );
    assert_ne!(restored_b.id, b.id);
    assert_eq!(
        data.hosts[0].config.group_id.as_deref(),
        Some(restored_b.id.as_str())
    );
    let index = json["groups"]
        .as_array()
        .unwrap()
        .iter()
        .position(|g| g["id"] == a.id)
        .unwrap();
    json["groups"][index]["parentId"] = serde_json::json!(b.id);
    assert!(target.backup_preview(&json.to_string()).is_err());
    assert!(
        target
            .backup_restore(RestoreInput {
                text: json.to_string(),
                selected: vec![h.id],
                conflict: ConflictPolicy::Copy,
                restore_preferences: false,
                confirmed: true
            })
            .is_err()
    );
    assert_eq!(target.catalog().unwrap().hosts.len(), 1);
    // Old flat v1 backups remain readable without a parentId field.
    let mut old: serde_json::Value =
        serde_json::from_str(&source.backup_export().unwrap()).unwrap();
    old["version"] = serde_json::json!(1);
    for group in old["groups"].as_array_mut().unwrap() {
        group.as_object_mut().unwrap().remove("parentId");
    }
    assert!(target.backup_preview(&old.to_string()).is_ok());
    // A same-name folder in a different local parent must never silently flatten a restore.
    let conflicting = Database::open(dir.path().join("conflict")).unwrap();
    folder(&conflicting, "上海", None);
    assert!(
        conflicting
            .backup_restore(RestoreInput {
                text: source.backup_export().unwrap(),
                selected: vec![],
                conflict: ConflictPolicy::Copy,
                restore_preferences: false,
                confirmed: true
            })
            .is_err()
    );
    assert_eq!(conflicting.catalog().unwrap().groups.len(), 1);
    assert!(conflicting.catalog().unwrap().hosts.is_empty());
}
