use serverdeck_core::automation::*;
use serverdeck_storage::Database;
fn entry(db: &Database) -> Entry {
    db.automation_entry_save(None, None, templates()[0].clone(), 1)
        .unwrap()
}
fn run(e: Entry, stamp: u64) -> Run {
    let target = Target {
        host_id: uuid::Uuid::new_v4().to_string(),
        name: "Test endpoint".into(),
        hostname: "localhost".into(),
        port: 22,
        username: "test".into(),
        route_signature: "fixture metadata".into(),
    };
    Run::new(
        RunSpec {
            entry: e,
            targets: vec![target],
            parameters: Default::default(),
            has_secrets: false,
            concurrency: 1,
            timeout_secs: 3,
        },
        stamp,
    )
}
fn plan(e: Entry) -> Schedule {
    Schedule {
        id: uuid::Uuid::new_v4().to_string(),
        revision: 0,
        name: "Daily test".into(),
        spec: run(e, 0).spec,
        timing: Timing::Daily { hour: 0, minute: 0 },
        offset_minutes: 0,
        missed_policy: MissedPolicy::Ask,
        enabled: true,
        next_at: 60000,
        last_message: None,
    }
}
#[test]
fn v4_migration_preserves_hosts_and_settings_and_is_idempotent() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db");
    let c = rusqlite::Connection::open(&path).unwrap();
    for sql in [
        include_str!("../migrations/001_settings.sql"),
        include_str!("../migrations/002_hosts.sql"),
        include_str!("../migrations/003_known_hosts.sql"),
        include_str!("../migrations/004_terminal_workspace.sql"),
    ] {
        c.execute_batch(sql).unwrap();
    }
    let id = uuid::Uuid::new_v4().to_string();
    c.execute("INSERT INTO hosts(id,name,hostname,port,username,auth_type,connect_timeout_secs) VALUES(?1,'existing','localhost',22,'existing-user','agent',30)",[&id]).unwrap();
    let old_config = serverdeck_core::AppConfig {
        theme: serverdeck_core::Theme::Light,
        ..Default::default()
    };
    c.execute(
        "INSERT INTO application_settings(key,value) VALUES('app_config',?1)",
        [serde_json::to_string(&old_config).unwrap()],
    )
    .unwrap();
    c.pragma_update(None, "user_version", 4).unwrap();
    drop(c);
    let db = Database::open(&path).unwrap();
    assert_eq!(db.version().unwrap(), serverdeck_core::DATABASE_VERSION);
    assert_eq!(db.host(&id).unwrap().config.name, "existing");
    let config = db.load_config().unwrap();
    assert_eq!(config, old_config);
    let again = Database::open(&path).unwrap();
    assert_eq!(again.load_config().unwrap(), config);
    assert!(again.automation_entries().unwrap().is_empty());
}
#[test]
fn library_groups_revisions_and_execution_change_invalidate_plan() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(dir.path().join("db")).unwrap();
    let g = db.automation_group_save(None, "Routine").unwrap();
    let mut input = templates()[0].clone();
    input.group_id = Some(g.id.clone());
    let e = db.automation_entry_save(None, None, input, 1).unwrap();
    let p = db.automation_schedule_save(plan(e.clone()), None).unwrap();
    let mut edited = e.input.clone();
    edited.favorite = true;
    let e2 = db
        .automation_entry_save(Some(&e.id), Some(e.revision), edited, 2)
        .unwrap();
    assert!(
        db.automation_schedules().unwrap()[0].enabled,
        "favorite must not revoke authorization"
    );
    assert!(
        db.automation_entry_save(Some(&e.id), Some(e.revision), e.input.clone(), 3)
            .is_err()
    );
    let mut edited = e2.input;
    edited.body = "uname -a".into();
    db.automation_entry_save(Some(&e.id), Some(e2.revision), edited, 4)
        .unwrap();
    assert!(!db.automation_schedules().unwrap()[0].enabled);
    assert!(
        db.automation_schedule_save(p.clone(), Some(p.revision))
            .is_err()
    );
    db.automation_group_delete(&g.id).unwrap();
    assert!(db.automation_entry(&e.id).unwrap().input.group_id.is_none());
    db.automation_entry_delete(&e.id).unwrap();
    assert!(db.automation_schedules().unwrap().is_empty());
}
#[test]
fn secret_parameter_and_output_never_reach_sqlite_even_with_forged_flags() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db");
    let db = Database::open(&path).unwrap();
    let mut input = templates()[0].clone();
    input.kind = EntryKind::Script;
    input.body = "printf '%s' \"$1\"".into();
    input.parameters = vec![Parameter {
        name: "secret".into(),
        label: "Secret".into(),
        kind: ParameterKind::Text,
        required: true,
        secret: true,
        default: None,
    }];
    input.retain_output = true;
    let e = db.automation_entry_save(None, None, input, 1).unwrap();
    let secret = uuid::Uuid::new_v4().to_string();
    let mut r = run(e, 2);
    r.spec.parameters.insert("secret".into(), secret.clone());
    r.spec.has_secrets = false;
    r.rows[0].stdout = secret.clone();
    r.rows[0].stderr = secret.clone();
    db.automation_run_insert(&r).unwrap();
    let saved = db.automation_run(&r.id).unwrap();
    assert!(saved.spec.has_secrets);
    assert!(saved.spec.parameters.is_empty());
    assert!(saved.rows[0].stdout.is_empty() && saved.rows[0].stderr.is_empty());
    assert!(
        !std::fs::read(path)
            .unwrap()
            .windows(secret.len())
            .any(|s| s == secret.as_bytes())
    );
}
#[test]
fn retained_utf8_output_survives_reopen_and_unsaved_output_does_not() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db");
    let db = Database::open(&path).unwrap();
    let e = entry(&db);
    let mut r = run(e.clone(), 2);
    r.rows[0].stdout = "private output not opted in".into();
    db.automation_run_insert(&r).unwrap();
    assert!(db.automation_run(&r.id).unwrap().rows[0].stdout.is_empty());
    let mut input = e.input;
    input.retain_output = true;
    let e = db
        .automation_entry_save(Some(&e.id), Some(e.revision), input, 3)
        .unwrap();
    let mut r = run(e, 4);
    r.rows[0].state = State::Success;
    r.state = State::Success;
    r.rows[0].stdout = "中😀".repeat(10000);
    db.automation_run_insert(&r).unwrap();
    let saved = Database::open(path).unwrap().automation_run(&r.id).unwrap();
    assert!(saved.rows[0].stdout.len() <= OUTPUT_LIMIT);
    assert!(!saved.rows[0].stdout.contains('\u{fffd}'));
    assert!(!saved.rows[0].stdout.is_empty());
}
#[test]
fn recovery_and_monotonic_checkpoint_never_replay_or_claim_stopped() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(dir.path().join("db")).unwrap();
    let e = entry(&db);
    let mut running = run(e.clone(), 1);
    db.automation_run_insert(&running).unwrap();
    let old = running.clone();
    running.rows[0].state = State::Running;
    running.state = State::Running;
    running.revision = 3;
    db.automation_run_save(&running).unwrap();
    db.automation_run_save(&old).unwrap();
    assert_eq!(
        db.automation_run(&running.id).unwrap().state,
        State::Running
    );
    let pending = run(e.clone(), 2);
    db.automation_run_insert(&pending).unwrap();
    let mut approval = run(e, 3);
    approval.approval_required = true;
    db.automation_run_insert(&approval).unwrap();
    db.automation_recover(4).unwrap();
    assert_eq!(
        db.automation_run(&running.id).unwrap().state,
        State::Unknown
    );
    assert_eq!(
        db.automation_run(&pending.id).unwrap().state,
        State::Cancelled
    );
    assert!(db.automation_run(&approval.id).unwrap().approval_required);
}
#[test]
fn due_claim_is_atomic_and_history_pagination_has_no_same_timestamp_gaps() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(dir.path().join("db")).unwrap();
    let e = entry(&db);
    let p = db.automation_schedule_save(plan(e.clone()), None).unwrap();
    let mut next = p.clone();
    next.next_at = 120000;
    let mut r = run(e.clone(), 60000);
    r.schedule_id = Some(p.id.clone());
    r.scheduled_for = Some(60000);
    r.approval_required = true;
    assert!(db.automation_claim(&next, 60000, &r).unwrap());
    assert!(!db.automation_claim(&next, 60000, &r).unwrap());
    assert_eq!(
        db.automation_history(HistoryQuery {
            schedule_id: Some(p.id.clone()),
            ..Default::default()
        })
        .unwrap()
        .len(),
        1
    );
    assert!(
        db.automation_history(HistoryQuery {
            schedule_id: Some(uuid::Uuid::new_v4().to_string()),
            ..Default::default()
        })
        .unwrap()
        .is_empty()
    );
    for _ in 0..204 {
        let mut r = run(e.clone(), 90000);
        r.state = State::Success;
        r.rows[0].state = State::Success;
        db.automation_run_insert(&r).unwrap();
    }
    let mut query = HistoryQuery::default();
    let mut ids = std::collections::HashSet::new();
    let mut pages = Vec::new();
    loop {
        let page = db.automation_history(query).unwrap();
        let Some(last) = page.last() else { break };
        query = HistoryQuery {
            before: Some(last.created_at),
            before_id: Some(last.id.clone()),
            ..Default::default()
        };
        pages.push(page.len());
        for item in page {
            assert!(ids.insert(item.id), "duplicate history row across pages");
        }
    }
    assert_eq!(pages, [50, 50, 50, 50, 5]);
    assert_eq!(ids.len(), 205);
    assert!(
        ids.contains(&r.id),
        "old history must not be silently pruned"
    );
}
