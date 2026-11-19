use super::*;
use serverdeck_core::openssh;

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
        description: "测试备注".into(),
        favorite: true,
        connect_timeout_secs: 30,
    }
}

#[test]
fn favorite_updates_only_the_requested_host_flag_and_survives_reopen() {
    let dir = tempfile::tempdir().expect("dir");
    let path = dir.path().join("hosts.sqlite3");
    let db = Database::open(&path).expect("db");
    let mut config = input();
    config.favorite = false;
    let host = db.host_create(config.clone()).expect("first host");
    let other = db.host_create(config.clone()).expect("other host");
    db.host_set_favorite(&host.id, true).expect("favorite");
    drop(db);

    let db = Database::open(&path).expect("reopen");
    let mut expected = host.config.clone();
    expected.favorite = true;
    let saved = db.host(&host.id).expect("saved host");
    assert!(saved.config.favorite);
    assert_eq!(saved.config, expected);
    assert!(!db.host(&other.id).expect("other host").config.favorite);
    db.host_set_favorite(&host.id, false).expect("unfavorite");
    assert!(!db.host(&host.id).expect("saved host").config.favorite);
    assert!(matches!(
        db.host_set_favorite("missing", true),
        Err(Error::NotFound)
    ));
}

#[test]
fn last_sftp_directory_is_host_scoped_persistent_and_removed_with_host() {
    let dir = tempfile::tempdir().expect("dir");
    let path = dir.path().join("hosts.sqlite3");
    let db = Database::open(&path).expect("db");
    let host = db.host_create(input()).expect("first host");
    let other = db.host_create(input()).expect("other host");
    assert_eq!(db.sftp_last_directory(&host.id).unwrap(), None);
    db.save_sftp_last_directory(&host.id, "/var/log/nginx".into())
        .unwrap();
    db.save_sftp_last_directory(&other.id, "/srv/app".into())
        .unwrap();
    assert!(
        db.save_sftp_last_directory(&host.id, "../bad".into())
            .is_err()
    );
    drop(db);

    let db = Database::open(path).expect("reopen");
    assert_eq!(
        db.sftp_last_directory(&host.id).unwrap().as_deref(),
        Some("/var/log/nginx")
    );
    assert_eq!(
        db.sftp_last_directory(&other.id).unwrap().as_deref(),
        Some("/srv/app")
    );
    db.host_delete(&host.id).unwrap();
    db.save_sftp_last_directory(&host.id, "/late".into())
        .unwrap();
    assert_eq!(db.sftp_last_directory(&host.id).unwrap(), None);
    assert_eq!(
        db.sftp_last_directory(&other.id).unwrap().as_deref(),
        Some("/srv/app")
    );
}

#[test]
fn directory_bookmarks_persist_by_host_and_are_removed_with_the_host() {
    use serverdeck_core::files::DirectoryBookmark;

    let dir = tempfile::tempdir().expect("dir");
    let path = dir.path().join("hosts.sqlite3");
    let db = Database::open(&path).expect("db");
    let host = db.host_create(input()).unwrap();
    let other = db.host_create(input()).unwrap();
    let bookmark = DirectoryBookmark {
        name: "发布目录".into(),
        path: "/srv/app/releases".into(),
    };
    let logs = DirectoryBookmark {
        name: "Logs".into(),
        path: "/var/log".into(),
    };
    db.add_sftp_bookmark(&host.id, bookmark.clone()).unwrap();
    assert_eq!(
        db.add_sftp_bookmark(&host.id, logs.clone()).unwrap(),
        vec![bookmark.clone(), logs.clone()]
    );
    assert!(db.add_sftp_bookmark(&host.id, bookmark.clone()).is_err());
    assert!(
        db.add_sftp_bookmark(
            &host.id,
            DirectoryBookmark {
                path: "../bad".into(),
                ..bookmark.clone()
            },
        )
        .is_err()
    );
    assert!(db.sftp_bookmarks(&other.id).unwrap().is_empty());
    db.add_sftp_bookmark(&other.id, bookmark.clone()).unwrap();
    let copy = db.host_copy(&host.id).unwrap();
    drop(db);

    let db = Database::open(path).unwrap();
    assert_eq!(
        db.sftp_bookmarks(&host.id).unwrap(),
        [bookmark.clone(), logs.clone()]
    );
    assert!(db.sftp_bookmarks(&copy.id).unwrap().is_empty());
    assert_eq!(
        db.remove_sftp_bookmark(&host.id, &bookmark.path).unwrap(),
        [logs]
    );
    db.host_delete(&host.id).unwrap();
    assert!(db.sftp_bookmarks(&host.id).unwrap().is_empty());
    assert!(matches!(
        db.add_sftp_bookmark(&host.id, bookmark.clone()),
        Err(Error::NotFound)
    ));
    assert_eq!(db.sftp_bookmarks(&other.id).unwrap(), [bookmark]);
}

#[test]
fn unsupported_directory_bookmarks_survive_attempted_edits() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(dir.path().join("hosts.sqlite3")).unwrap();
    let host = db.host_create(input()).unwrap();
    let key = crate::sftp_bookmarks::key(&host.id);
    let json = r#"{"version":2,"bookmarks":[{"name":"Logs","path":"/var/log"}]}"#;
    let connection = db.connect().unwrap();
    connection
        .execute(
            "INSERT INTO application_settings(key,value) VALUES(?1,?2)",
            params![key, json],
        )
        .unwrap();
    assert!(matches!(
        db.sftp_bookmarks(&host.id),
        Err(Error::UnsupportedConfig(2))
    ));
    assert!(matches!(
        db.remove_sftp_bookmark(&host.id, "/var/log"),
        Err(Error::UnsupportedConfig(2))
    ));
    let raw: String = connection
        .query_row(
            "SELECT value FROM application_settings WHERE key=?1",
            [&key],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(raw, json);
    assert_eq!(db.catalog().unwrap().hosts.len(), 1);
}

#[test]
fn forward_rules_persist_by_host_and_are_removed_with_the_host() {
    use serverdeck_core::connection::LocalForwardInput;

    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("hosts.sqlite3");
    let db = Database::open(&path).unwrap();
    let host = db.host_create(input()).unwrap();
    let other = db.host_create(input()).unwrap();
    let rule = LocalForwardInput {
        listen_port: 12345,
        target_host: "example.com".into(),
        target_port: 9005,
    };
    let console = LocalForwardInput {
        listen_port: 9001,
        target_host: "127.0.0.1".into(),
        target_port: 9001,
    };
    assert!(db.forward_rules(&host.id).unwrap().is_empty());
    let written = db
        .add_forward_rule(
            &host.id,
            LocalForwardInput {
                target_host: " EXAMPLE.com. ".into(),
                ..rule.clone()
            },
        )
        .unwrap();
    assert_eq!(written, rule);
    assert!(db.add_forward_rule(&host.id, rule.clone()).is_err());
    assert!(
        db.add_forward_rule(
            &host.id,
            LocalForwardInput {
                target_port: 0,
                ..console.clone()
            }
        )
        .is_err()
    );
    assert!(db.forward_rules(&other.id).unwrap().is_empty());
    db.add_forward_rule(&other.id, rule.clone()).unwrap();
    db.add_forward_rule(&host.id, console.clone()).unwrap();
    drop(db);

    let db = Database::open(&path).unwrap();
    assert_eq!(
        db.forward_rules(&host.id).unwrap(),
        [rule.clone(), console.clone()]
    );
    db.remove_forward_rule(&host.id, rule.listen_port).unwrap();
    db.remove_forward_rule(&host.id, rule.listen_port).unwrap();
    drop(db);

    let db = Database::open(&path).unwrap();
    assert_eq!(
        db.forward_rules(&host.id).unwrap().as_slice(),
        std::slice::from_ref(&console)
    );
    db.host_delete(&host.id).unwrap();
    assert!(db.forward_rules(&host.id).unwrap().is_empty());
    assert!(matches!(
        db.add_forward_rule(&host.id, console),
        Err(Error::NotFound)
    ));
    assert_eq!(db.forward_rules(&other.id).unwrap(), [rule]);
}

#[test]
fn damage_or_unknown_versions_in_forward_rules_are_preserved() {
    use serverdeck_core::connection::LocalForwardInput;

    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(dir.path().join("hosts.sqlite3")).unwrap();
    let host = db.host_create(input()).unwrap();
    let key = crate::forward_rules::key(&host.id);
    let connection = db.connect().unwrap();
    let rule = LocalForwardInput {
        listen_port: 12345,
        target_host: "127.0.0.1".into(),
        target_port: 9005,
    };
    for raw in [
        r#"{"version":2,"rules":[]}"#,
        r#"{"version":1,"rules":[{"listenPort":9001,"targetHost":"127.0.0.1","targetPort":9001,"autoStart":true}]}"#,
        r#"{"version":1,"rules":[{"listenPort":0,"targetHost":"127.0.0.1","targetPort":9001}]}"#,
    ] {
        connection
            .execute(
                "INSERT OR REPLACE INTO application_settings(key,value) VALUES(?1,?2)",
                params![key, raw],
            )
            .unwrap();
        assert!(db.forward_rules(&host.id).is_err());
        assert!(db.add_forward_rule(&host.id, rule.clone()).is_err());
        assert!(db.remove_forward_rule(&host.id, 9001).is_err());
        let saved: String = connection
            .query_row(
                "SELECT value FROM application_settings WHERE key=?1",
                [&key],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(saved, raw);
        assert_eq!(db.host(&host.id).unwrap().config, host.config);
    }
}

#[test]
fn unknown_sftp_directory_format_is_preserved_and_does_not_block_catalog() {
    let dir = tempfile::tempdir().expect("dir");
    let path = dir.path().join("hosts.sqlite3");
    let db = Database::open(&path).expect("db");
    let host = db.host_create(input()).expect("host");
    let key = crate::sftp_directory::key(&host.id);
    let json = r#"{"version":2,"path":"/srv"}"#;
    db.connect()
        .unwrap()
        .execute(
            "INSERT INTO application_settings(key,value) VALUES(?1,?2)",
            params![key, json],
        )
        .unwrap();

    let db = Database::open(&path).expect("reopen");
    assert_eq!(db.catalog().unwrap().hosts.len(), 1);
    assert!(matches!(
        db.sftp_last_directory(&host.id),
        Err(Error::UnsupportedConfig(2))
    ));
    assert!(matches!(
        db.save_sftp_last_directory(&host.id, "/tmp".into()),
        Err(Error::UnsupportedConfig(2))
    ));
    let raw: String = db
        .connect()
        .unwrap()
        .query_row(
            "SELECT value FROM application_settings WHERE key=?1",
            [key],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(raw, json);
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

#[test]
fn ssh_session_snapshots_survive_reopen_failed_replacement_and_host_scoped_rename() {
    use crate::ssh_sessions::SshSessionRecord;
    use serverdeck_core::terminal::{LocalTerminalLayout, SavedSshTerminal};
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("sessions.db");
    let db = Database::open(&path).unwrap();
    let host = db.host_create(input()).unwrap().id;
    let other = db.host_create(input()).unwrap().id;
    let session = SavedSshTerminal {
        id: uuid::Uuid::new_v4(),
        title: "first".into(),
        pane_count: 1,
        layout_only_panes: 0,
        layout: LocalTerminalLayout::Leaf { pane: 0 },
    };
    let original = SshSessionRecord::new(session.clone(), 40);
    let reference = original.reference();
    db.save_ssh_session(&host, original, false, |_| Ok(()))
        .unwrap();
    let failed = SshSessionRecord::new(session.clone(), 50);
    let failed_reference = failed.reference();
    assert!(
        db.save_ssh_session(&host, failed, true, |_| Err(Error::Validation("injected")))
            .is_err()
    );
    let db = Database::open(&path).unwrap();
    assert_eq!(
        db.ssh_terminal_sessions(&host).unwrap()[0].reference(),
        reference
    );
    assert_eq!(db.pending_secret_gc().unwrap(), [failed_reference]);
    assert!(db.ssh_terminal_sessions(&other).unwrap().is_empty());
    assert!(
        db.rename_ssh_session(&other, session.id, "wrong".into())
            .is_err()
    );
    db.rename_ssh_session(&host, session.id, "renamed".into())
        .unwrap();
    let renamed = db.ssh_terminal_sessions(&host).unwrap().pop().unwrap();
    assert_eq!(renamed.session.title, "renamed");
    assert_eq!(renamed.reference(), reference);
    db.host_delete(&host).unwrap();
    assert!(db.ssh_terminal_sessions(&host).unwrap().is_empty());
    assert!(db.pending_secret_gc().unwrap().contains(&reference));
}

#[test]
fn unknown_ssh_snapshot_versions_are_never_overwritten() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(dir.path().join("sessions.db")).unwrap();
    let host = db.host_create(input()).unwrap().id;
    let key = format!("ssh_terminal_sessions:{host}");
    let conn = db.connect().unwrap();
    for raw in [
        r#"{"version":2,"sessions":[]}"#,
        r#"{"version":1,"sessions":[],"unknown":true}"#,
    ] {
        conn.execute(
            "INSERT OR REPLACE INTO application_settings(key,value) VALUES(?1,?2)",
            params![key, raw],
        )
        .unwrap();
        assert!(db.ssh_terminal_sessions(&host).is_err());
        assert!(db.remove_ssh_session(&host, uuid::Uuid::new_v4()).is_err());
        assert_eq!(
            conn.query_row(
                "SELECT value FROM application_settings WHERE key=?1",
                [&key],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            raw
        );
    }
}
