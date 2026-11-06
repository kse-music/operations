use super::*;
use serverdeck_core::{AppConfig, Theme, openssh};

fn input() -> HostInput {
    HostInput {
        ssh: Default::default(),
        name: "测试服务器".into(),
        hostname: "EXAMPLE.com".into(),
        port: 2222,
        username: "ops".into(),
        auth_type: AuthType::Agent,
        credential_id: None,
        group_id: None,
        tags: vec!["生产".into(), "linux".into(), "linux".into()],
        description: "测试备注".into(),
        favorite: true,
        connect_timeout_secs: 30,
    }
}

#[test]
fn hosts_with_unbound_proxy_passwords_remain_editable_until_credentials_are_restored() {
    use serverdeck_core::connection::{ProxyKind, ProxySettings};

    let dir = tempfile::tempdir().expect("dir");
    let db = Database::open(dir.path().join("hosts.sqlite3")).expect("db");
    let mut config = input();
    config.ssh.proxy = Some(ProxySettings {
        kind: ProxyKind::Socks5,
        hostname: "proxy.example".into(),
        port: 1080,
        username: Some("proxy-user".into()),
        credential_id: None,
    });
    let host = db.host_create(config).expect("legacy host");
    let mut saved = db.host(&host.id).expect("read host").config;
    assert!(saved.ssh.require_proxy_credentials().is_err());
    saved.name = "待补绑凭据".into();
    db.host_update(&host.id, saved).expect("edit host");
    let updated = db.host(&host.id).expect("read updated host");
    assert_eq!(updated.config.name, "待补绑凭据");
    assert!(updated.config.ssh.require_proxy_credentials().is_err());
}

#[test]
fn unnamed_hosts_can_be_created_updated_copied_and_reopened() {
    let dir = tempfile::tempdir().expect("dir");
    let path = dir.path().join("hosts.sqlite3");
    let db = Database::open(&path).expect("db");
    let mut config = input();
    config.name = "   ".into();
    let created = db.host_create(config).expect("create unnamed");
    assert!(created.config.name.is_empty());
    assert_eq!(created.config.display_name(), "example.com:2222");
    let copied = db.host_copy(&created.id).expect("copy unnamed");
    assert_eq!(copied.config.name, "example.com:2222 副本");
    let mut updated = copied.config.clone();
    updated.name.clear();
    updated.port = 22;
    db.host_update(&copied.id, updated).expect("clear name");
    let reopened = Database::open(path).expect("reopen");
    let saved = reopened.host(&copied.id).expect("saved");
    assert!(saved.config.name.is_empty());
    assert_eq!(saved.config.display_name(), "example.com");
    assert_eq!(reopened.catalog().expect("catalog").hosts.len(), 2);
}

#[test]
fn migrates_v5_hosts_without_changing_configuration_or_links() {
    let dir = tempfile::tempdir().expect("dir");
    let path = dir.path().join("v5.sqlite3");
    let connection = Connection::open(&path).expect("open");
    for sql in [
        include_str!("../../migrations/001_settings.sql"),
        include_str!("../../migrations/002_hosts.sql"),
        include_str!("../../migrations/003_known_hosts.sql"),
        include_str!("../../migrations/004_terminal_workspace.sql"),
    ] {
        connection.execute_batch(sql).expect("v5 schema");
    }
    connection
        .pragma_update(None, "user_version", 5)
        .expect("v5");
    let legacy = Database { path: path.clone() };
    let group_id = uuid::Uuid::new_v4().to_string();
    connection
        .execute(
            "INSERT INTO host_groups(id,name,sort_order) VALUES(?1,'生产',2)",
            [&group_id],
        )
        .expect("legacy group");
    let credential = legacy
        .credential_save(
            "private-key",
            None,
            "key",
            AuthType::PrivateKey,
            Some("C:/keys/test"),
            None,
        )
        .expect("credential");
    let jump = legacy.host_create(input()).expect("jump");
    let mut config = input();
    config.name = "应用".into();
    config.group_id = Some(group_id.clone());
    config.auth_type = AuthType::PrivateKey;
    config.credential_id = Some(credential.id.clone());
    config.ssh.jump_host_id = Some(jump.id.clone());
    legacy.host_create(config).expect("child");
    let settings = AppConfig {
        theme: Theme::Light,
        ..Default::default()
    };
    legacy.save_config(&settings).expect("settings");
    let old_hosts = connection
        .prepare(&format!(
            "SELECT {HOST_COLUMNS} FROM hosts ORDER BY name COLLATE NOCASE,id"
        ))
        .expect("old hosts")
        .query_map([], host_row)
        .expect("query")
        .collect::<rusqlite::Result<Vec<_>>>()
        .expect("hosts");
    let old_groups = connection
        .prepare(
            "SELECT id,name,sort_order FROM host_groups ORDER BY sort_order,name COLLATE NOCASE,id",
        )
        .expect("old groups")
        .query_map([], |row| {
            Ok(HostGroup {
                id: row.get(0)?,
                name: row.get(1)?,
                sort_order: row.get(2)?,
                parent_id: None,
            })
        })
        .expect("query")
        .collect::<rusqlite::Result<Vec<_>>>()
        .expect("groups");
    let before = serde_json::to_value(Catalog {
        hosts: old_hosts,
        groups: old_groups,
        credentials: vec![
            legacy
                .credential_record(&credential.id)
                .expect("credential metadata")
                .public,
        ],
        pending_secret_deletions: connection
            .query_row("SELECT count(*) FROM secret_gc", [], |r| r.get(0))
            .expect("pending deletions"),
    })
    .expect("old catalog");
    drop(connection);
    let migrated = Database::open(&path).expect("migrate");
    assert_eq!(
        migrated.version().expect("version"),
        serverdeck_core::DATABASE_VERSION
    );
    assert_eq!(
        serde_json::to_value(migrated.catalog().expect("after")).expect("json"),
        before
    );
    let groups = migrated.catalog().expect("catalog").groups;
    assert_eq!(groups[0].id, group_id);
    assert_eq!(groups[0].name, "生产");
    assert_eq!(groups[0].parent_id, None);
    assert_eq!(migrated.load_config().expect("settings"), settings);
    let mut unnamed = input();
    unnamed.name.clear();
    let saved = migrated
        .host_create(unnamed)
        .expect("unnamed after migration");
    let connection = migrated.connect().expect("connect");
    assert!(
        connection
            .execute("UPDATE hosts SET port=0 WHERE id=?1", [&saved.id])
            .is_err()
    );
    assert!(
        connection
            .execute(
                "UPDATE hosts SET group_id='missing' WHERE id=?1",
                [&saved.id]
            )
            .is_err()
    );
}

#[test]
fn host_crud_copy_groups_and_restart_preserve_real_data() {
    let dir = tempfile::tempdir().expect("dir");
    let path = dir.path().join("hosts.sqlite3");
    let db = Database::open(&path).expect("db");
    let group = db
        .group_save(
            None,
            GroupInput {
                parent_id: None,
                name: "生产".into(),
                sort_order: 4,
            },
        )
        .expect("group");
    let mut config = input();
    config.group_id = Some(group.id.clone());
    let created = db.host_create(config).expect("create");
    assert_eq!(created.config.hostname, "example.com");
    assert_eq!(created.config.tags.len(), 2);
    let mut changed = created.config.clone();
    changed.name = "修改后的主机".into();
    changed.port = 22;
    changed.description = "新备注".into();
    let updated = db.host_update(&created.id, changed).expect("update");
    assert_eq!(updated.id, created.id);
    let copy = db.host_copy(&created.id).expect("copy");
    assert_ne!(copy.id, created.id);
    assert!(copy.config.name.ends_with("副本"));
    db.group_save(
        Some(&group.id),
        GroupInput {
            parent_id: None,
            name: "正式环境".into(),
            sort_order: 1,
        },
    )
    .expect("rename");
    assert!(matches!(
        db.group_save(
            None,
            GroupInput {
                parent_id: None,
                name: "正式环境".into(),
                sort_order: 0
            }
        ),
        Err(Error::Conflict)
    ));
    drop(db);
    let db = Database::open(path).expect("restart");
    let catalog = db.catalog().expect("catalog");
    assert_eq!(catalog.hosts.len(), 2);
    assert_eq!(catalog.groups[0].name, "正式环境");
    assert_eq!(
        catalog
            .hosts
            .iter()
            .find(|h| h.id == created.id)
            .expect("host")
            .config
            .description,
        "新备注"
    );
    db.group_delete(&group.id).expect("delete group");
    assert!(
        db.catalog()
            .expect("catalog")
            .hosts
            .iter()
            .all(|h| h.config.group_id.is_none())
    );
    db.host_delete(&copy.id).expect("delete copy");
    assert_eq!(db.catalog().expect("catalog").hosts.len(), 1);
    db.host_delete(&created.id).expect("delete host");
    assert!(db.catalog().expect("catalog").hosts.is_empty());
    assert!(matches!(db.host_delete(&created.id), Err(Error::NotFound)));
}

#[test]
fn proxyjump_import_is_topological_persistent_and_cycles_are_rejected() {
    let dir = tempfile::tempdir().expect("dir");
    let db = Database::open(dir.path().join("db")).expect("database");
    let parsed=openssh::preview("Host app\n HostName app.example.com\n ProxyJump jump\nHost jump\n HostName jump.example.com", "ops",15).expect("parse");
    let result = db
        .import_hosts(parsed.candidates, &["app".into(), "jump".into()], None)
        .expect("import");
    assert_eq!(result.value.len(), 2);
    let catalog = db.catalog().expect("catalog");
    let app = catalog
        .hosts
        .iter()
        .find(|h| h.config.name == "app")
        .expect("app");
    let jump = catalog
        .hosts
        .iter()
        .find(|h| h.config.name == "jump")
        .expect("jump");
    assert_eq!(
        app.config.ssh.jump_host_id.as_deref(),
        Some(jump.id.as_str())
    );
    let mut cycle = jump.config.clone();
    cycle.ssh.jump_host_id = Some(app.id.clone());
    assert!(db.host_update(&jump.id, cycle).is_err());
    assert!(db.host_delete(&jump.id).is_err());
    let reopened = Database::open(dir.path().join("db")).expect("reopen");
    assert_eq!(
        reopened.host(&app.id).expect("app").config.ssh.jump_host_id,
        Some(jump.id.clone())
    );
    let missing =
        openssh::preview("Host other\n ProxyJump not-selected", "ops", 15).expect("parse");
    assert!(
        db.import_hosts(missing.candidates, &["other".into()], None)
            .is_err()
    );
}

#[test]
fn migrates_existing_v1_without_losing_settings() {
    let dir = tempfile::tempdir().expect("dir");
    let path = dir.path().join("v1.sqlite3");
    let connection = Connection::open(&path).expect("open");
    connection
        .execute_batch(include_str!("../../migrations/001_settings.sql"))
        .expect("v1");
    let config = AppConfig {
        theme: Theme::Light,
        ..Default::default()
    };
    connection
        .execute(
            "INSERT INTO application_settings(key,value) VALUES('app_config',?1)",
            [serde_json::to_string(&config).expect("json")],
        )
        .expect("settings");
    connection
        .pragma_update(None, "user_version", 1)
        .expect("version");
    drop(connection);
    let db = Database::open(&path).expect("migrate");
    assert_eq!(
        db.version().expect("version"),
        serverdeck_core::DATABASE_VERSION
    );
    assert_eq!(db.load_config().expect("settings"), config);
    db.host_create(input()).expect("create after migration");
    drop(db);
    assert_eq!(
        Database::open(path)
            .expect("reopen")
            .catalog()
            .expect("catalog")
            .hosts
            .len(),
        1
    );
}

#[test]
fn rejects_invalid_authentication_references_and_preserves_shared_credentials() {
    let dir = tempfile::tempdir().expect("dir");
    let db = Database::open(dir.path().join("db")).expect("db");
    let password = db
        .credential_save(
            "credential-1",
            None,
            "共享密码",
            AuthType::Password,
            None,
            Some("opaque-os-secret-reference"),
        )
        .expect("credential");
    let mut config = input();
    config.auth_type = AuthType::PrivateKey;
    config.credential_id = Some(password.id.clone());
    assert!(db.host_create(config.clone()).is_err());
    config.auth_type = AuthType::Password;
    let host = db.host_create(config).expect("host");
    let copy = db.host_copy(&host.id).expect("copy");
    assert_eq!(copy.config.credential_id, Some(password.id.clone()));
    assert!(matches!(
        db.credential_delete(&password.id, false),
        Err(Error::Conflict)
    ));
    db.host_delete(&host.id).expect("remove host");
    assert_eq!(db.catalog().expect("catalog").credentials[0].host_count, 1);
    db.credential_delete(&password.id, true)
        .expect("detach delete");
    let catalog = db.catalog().expect("catalog");
    assert!(catalog.hosts[0].config.credential_id.is_none());
    assert_eq!(catalog.pending_secret_deletions, 1);
    let mut invalid = input();
    invalid.port = 0;
    assert!(db.host_create(invalid).is_err());
    let mut invalid = input();
    invalid.group_id = Some("missing".into());
    assert!(db.host_create(invalid).is_err());
}

#[test]
fn selective_import_skips_duplicates_blocks_unsafe_options_and_rolls_back() {
    let dir = tempfile::tempdir().expect("dir");
    let db = Database::open(dir.path().join("db")).expect("db");
    db.host_create(input()).expect("existing");
    let text = "Host existing\n HostName = EXAMPLE.com\n Port 2222\n User ops\nHost new\n HostName new.example.com\n IdentityFile \"~/.ssh/key with space\"\n User root";
    let mut preview = openssh::preview(text, "ops", 15).expect("preview");
    db.annotate_duplicates(&mut preview).expect("duplicates");
    assert!(preview.candidates[0].duplicate);
    assert!(!preview.candidates[1].duplicate);
    let result = db
        .import_hosts(preview.candidates, &["existing".into(), "new".into()], None)
        .expect("import");
    assert_eq!(result.value.len(), 1);
    assert_eq!(result.warnings.len(), 1);
    let catalog = db.catalog().expect("catalog");
    assert_eq!(catalog.hosts.len(), 2);
    assert_eq!(
        catalog.credentials[0].key_path.as_deref(),
        Some("~/.ssh/key with space")
    );
    assert!(!catalog.credentials[0].has_secret);
    let unsafe_preview =
        openssh::preview("Host bad\nProxyCommand attacker-command", "ops", 15).expect("preview");
    assert!(
        db.import_hosts(unsafe_preview.candidates, &["bad".into()], None)
            .is_err()
    );
    let preview =
        openssh::preview("Host rollback\nIdentityFile key\nUser ops", "ops", 15).expect("preview");
    assert!(
        db.import_hosts(
            preview.candidates,
            &["rollback".into()],
            Some("missing".into())
        )
        .is_err()
    );
    assert_eq!(db.catalog().expect("catalog").credentials.len(), 1);
}

#[test]
fn conflicting_existing_jump_alias_never_silently_changes_import_route() {
    let dir = tempfile::tempdir().expect("dir");
    let db = Database::open(dir.path().join("db")).expect("database");
    let mut jump = input();
    jump.name = "gateway".into();
    db.host_create(jump).expect("existing gateway");
    let text = "Host gateway\n HostName other.example.com\n User ops\nHost destination\n HostName target.example.com\n ProxyJump gateway\n User ops";
    let mut preview = openssh::preview(text, "ops", 15).expect("preview");
    db.annotate_duplicates(&mut preview).expect("annotate");
    assert!(preview.candidates[1].blocked);
    // Commit repeats the protection under the transaction even without preview annotations.
    let raw = openssh::preview(text, "ops", 15).expect("parse");
    assert!(
        db.import_hosts(raw.candidates, &["destination".into()], None)
            .is_err()
    );
    assert_eq!(db.catalog().expect("catalog").hosts.len(), 1);
}
