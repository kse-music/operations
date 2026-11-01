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
fn host_crud_copy_groups_and_restart_preserve_real_data() {
    let dir = tempfile::tempdir().expect("dir");
    let path = dir.path().join("hosts.sqlite3");
    let db = Database::open(&path).expect("db");
    let group = db
        .group_save(
            None,
            GroupInput {
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
            name: "正式环境".into(),
            sort_order: 1,
        },
    )
    .expect("rename");
    assert!(matches!(
        db.group_save(
            None,
            GroupInput {
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
