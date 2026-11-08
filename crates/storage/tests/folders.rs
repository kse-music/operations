use rusqlite::Connection;
use serverdeck_core::hosts::*;
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
        description: "保留".into(),
        favorite: true,
        connect_timeout_secs: 15,
        ssh: Default::default(),
    })
    .unwrap()
}

#[test]
fn current_schema_keeps_host_membership_and_credential_links_after_reopen() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db");
    Database::open(&path).unwrap();
    let c = Connection::open(&path).unwrap();
    c.execute(
        "INSERT INTO host_groups(id,name,sort_order) VALUES('legacy','上海',3)",
        [],
    )
    .unwrap();
    c.execute("INSERT INTO credentials(id,name,kind,key_path,secret_ref,revision) VALUES('credential','Legacy key','private_key','~/.ssh/legacy-test-key','legacy-ref',3)", []).unwrap();
    c.execute("INSERT INTO hosts(id,name,hostname,port,username,auth_type,credential_id,group_id,connect_timeout_secs) VALUES('host','','192.0.2.1',22,'ops','private_key','credential','legacy',15)", []).unwrap();
    drop(c);
    let db = Database::open(&path).unwrap();
    assert_eq!(db.version().unwrap(), serverdeck_core::DATABASE_VERSION);
    let data = db.catalog().unwrap();
    assert_eq!(data.groups.len(), 1);
    assert_eq!(data.groups[0].name, "上海");
    assert_eq!(data.groups[0].parent_id, None);
    assert_eq!(data.hosts[0].config.group_id.as_deref(), Some("legacy"));
    assert_eq!(
        data.hosts[0].config.credential_id.as_deref(),
        Some("credential")
    );
    let credential = db.credential_record("credential").unwrap();
    assert_eq!(
        credential.public.key_path.as_deref(),
        Some("~/.ssh/legacy-test-key")
    );
    assert_eq!(credential.secret_ref.as_deref(), Some("legacy-ref"));
    assert_eq!(credential.public.revision, 3);
    assert_eq!(credential.public.host_count, 1);
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
