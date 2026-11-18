use super::*;
use std::sync::atomic::Ordering;

async fn wait_for(
    files: &Files,
    id: &str,
    condition: impl Fn(&TransferInfo) -> bool,
) -> TransferInfo {
    tokio::time::timeout(Duration::from_secs(12), async {
        loop {
            let info = files
                .transfers
                .list()
                .unwrap()
                .into_iter()
                .find(|t| t.id == id)
                .unwrap();
            if condition(&info) {
                return info;
            }
            assert!(info.unfinished(), "unexpected terminal state: {info:?}");
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
    })
    .await
    .expect("transfer progress")
}

async fn reopen_and_upload(disconnect: bool, change_source: bool, damage_partial: bool) {
    let server = Server::start(true, Duration::ZERO).await;
    server.faults.wire_delay_ms.store(12, Ordering::Relaxed);
    let session = server.open().await;
    let local = tempfile::tempdir().unwrap();
    let records = local.path().join("records");
    let source = local.path().join("中文.iso");
    let target = server.root.path().join("中文.iso");
    let unrelated = server.root.path().join("中文.iso.filepart");
    std::fs::write(&unrelated, b"other client").unwrap();
    std::fs::write(&target, b"old target").unwrap();
    let mut data: Vec<u8> = (0..8 * 1024 * 1024 + 17).map(|i| (i % 251) as u8).collect();
    std::fs::write(&source, &data).unwrap();
    let new_manager = || Files::new(server.engine.clone(), 2).with_upload_recovery(records.clone());
    let request = |id: &str| {
        input(
            id,
            Direction::Upload,
            vec![path(&source)],
            "/".into(),
            ConflictPolicy::Overwrite,
        )
    };
    if damage_partial {
        // The upload process exits before this process creates its recovery manager.
        let setup = serde_json::to_vec(&(
            server.db_path(),
            &server.host.id,
            &server.password,
            &source,
            &records,
        ))
        .unwrap();
        tokio::task::spawn_blocking(move || {
            use std::{
                io::Write,
                process::{Command, Stdio},
            };
            let mut child = Command::new(std::env::current_exe().unwrap())
                .args([
                    "--ignored",
                    "--exact",
                    "resume::upload_until_shutdown_child",
                ])
                .env("SERVERDECK_UPLOAD_TEST_CHILD", "1")
                .stdin(Stdio::piped())
                .spawn()
                .unwrap();
            child.stdin.take().unwrap().write_all(&setup).unwrap();
            assert!(child.wait().unwrap().success());
        })
        .await
        .unwrap();
    } else {
        let files = new_manager();
        let first = files.transfers.start(request(&session.id)).unwrap();
        wait_for(&files, &first.id, |i| i.transferred_bytes >= 32768 * 4).await;
        if disconnect {
            server.cut_network();
            assert_eq!(finished(&files, &first.id).await.state, "failed");
        }
        files.shutdown().await;
    }
    assert_eq!(std::fs::read(&target).unwrap(), b"old target");
    let dir = std::fs::read_dir(server.root.path())
        .unwrap()
        .flatten()
        .find(|p| p.path().is_dir())
        .unwrap()
        .path();
    let partial = std::fs::read_dir(&dir)
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    let size = std::fs::metadata(&partial).unwrap().len();
    assert!(size >= 32768 * 4 && size < data.len() as u64);
    if change_source {
        data.push(17);
        std::fs::write(&source, &data).unwrap();
    }
    if damage_partial {
        use std::io::{Seek, Write};
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .open(&partial)
            .unwrap();
        file.seek(std::io::SeekFrom::Start(65536)).unwrap();
        file.write_all(&[255; 24]).unwrap();
    }
    let files = new_manager();
    let fresh = server.open().await;
    let before = server.faults.written_bytes.load(Ordering::Relaxed);
    let task = files.transfers.start(request(&fresh.id)).unwrap();
    if change_source {
        let prompt = wait_for(&files, &task.id, |i| i.restart_prompt.is_some())
            .await
            .restart_prompt
            .unwrap();
        assert_eq!(prompt.partial_bytes, size);
        assert_eq!(server.faults.written_bytes.load(Ordering::Relaxed), before);
        assert!(
            files
                .transfers
                .confirm_upload_restart(&task.id, "stale")
                .is_err()
        );
        let competing = files.transfers.start(request(&fresh.id)).unwrap();
        assert_eq!(finished(&files, &competing.id).await.state, "failed");
        files
            .transfers
            .confirm_upload_restart(&task.id, &prompt.token)
            .unwrap();
    }
    let result = finished(&files, &task.id).await;
    assert_eq!(result.state, "completed", "{result:?}");
    let reused = if change_source {
        0
    } else if damage_partial {
        65536
    } else {
        size
    };
    assert_eq!(result.resumed_bytes, reused);
    assert_eq!(result.remaining_bytes, 0);
    assert_eq!(
        server.faults.written_bytes.load(Ordering::Relaxed) - before,
        data.len() as u64 - reused
    );
    assert_eq!(std::fs::read(target).unwrap(), data);
    assert_eq!(std::fs::read(unrelated).unwrap(), b"other client");
    assert!(!dir.exists());
    assert_eq!(std::fs::read_dir(records).unwrap().count(), 0);
    files.shutdown().await;
    server.engine.shutdown().await;
}

#[tokio::test]
async fn disconnect_reopen_resends_only_the_suffix() {
    reopen_and_upload(true, false, false).await;
}
#[tokio::test]
async fn shutdown_reopen_repairs_a_gap_from_the_first_bad_block() {
    reopen_and_upload(false, false, true).await;
}
#[tokio::test]
async fn shutdown_reopen_resumes_without_a_prompt() {
    reopen_and_upload(false, false, false).await;
}
#[tokio::test]
async fn changed_source_requires_restart() {
    reopen_and_upload(false, true, false).await;
}

#[tokio::test]
#[ignore = "launched by the recovery test with a live loopback SFTP fixture"]
async fn upload_until_shutdown_child() {
    use serverdeck_ssh::{Authentication, Engine};
    use std::path::PathBuf;
    if std::env::var_os("SERVERDECK_UPLOAD_TEST_CHILD").is_none() {
        return;
    }
    let (db, id, password, source, records): (PathBuf, String, String, PathBuf, PathBuf) =
        serde_json::from_reader(std::io::stdin().lock()).unwrap();
    let db = serverdeck_storage::Database::open(db).unwrap();
    let host = db.host(&id).unwrap();
    assert_eq!(host.config.hostname, "127.0.0.1");
    let engine = Engine::new(db);
    let (events, mut rx) = tokio::sync::mpsc::channel(32);
    let session = engine
        .open_file_plan(
            host.clone(),
            serverdeck_ssh::ConnectionPlan {
                hops: vec![serverdeck_ssh::Hop {
                    host,
                    revision: 1,
                    auth: Authentication::Password(password.into()),
                }],
                proxy: None,
            },
            std::sync::Arc::new(move |e| events.try_send(e).is_ok()),
        )
        .unwrap();
    tokio::time::timeout(Duration::from_secs(10), async {
        while let Some(event) = rx.recv().await {
            if let serverdeck_core::terminal::TerminalEvent::State { state, .. } = event {
                assert_ne!(state, "failed");
                if state == "connected" {
                    return;
                }
            }
        }
        panic!("fixture closed");
    })
    .await
    .unwrap();
    let files = Files::new(engine.clone(), 1).with_upload_recovery(records);
    let task = files
        .transfers
        .start(input(
            &session.id,
            Direction::Upload,
            vec![path(&source)],
            "/".into(),
            ConflictPolicy::Overwrite,
        ))
        .unwrap();
    wait_for(&files, &task.id, |i| i.transferred_bytes >= 32768 * 4).await;
    files.shutdown().await;
    engine.shutdown().await;
}

#[tokio::test]
async fn replaced_partial_is_rejected_and_another_sftp_identity_cannot_claim_it() {
    let server = Server::start(true, Duration::ZERO).await;
    server.faults.wire_delay_ms.store(12, Ordering::Relaxed);
    let local = tempfile::tempdir().unwrap();
    let files =
        Files::new(server.engine.clone(), 2).with_upload_recovery(local.path().join("records"));
    let source = local.path().join("shared.iso");
    std::fs::write(&source, vec![37; 4 * 1024 * 1024]).unwrap();
    let login = server.open().await;
    let request = |session: &str| {
        input(
            session,
            Direction::Upload,
            vec![path(&source)],
            "/".into(),
            ConflictPolicy::Fail,
        )
    };
    let first = files.transfers.start(request(&login.id)).unwrap();
    wait_for(&files, &first.id, |i| i.transferred_bytes > 0).await;
    files.transfers.cancel(&first.id).unwrap();
    assert_eq!(finished(&files, &first.id).await.state, "cancelled");
    // The changed source requires confirmation before discarding the old partial.
    std::fs::write(&source, vec![38; 4 * 1024 * 1024 + 1]).unwrap();
    let retry = files
        .transfers
        .retry(&first.id, &login.id, ConflictPolicy::Fail, false)
        .unwrap();
    let prompt = wait_for(&files, &retry.id, |i| i.restart_prompt.is_some())
        .await
        .restart_prompt
        .unwrap();
    let dir = std::fs::read_dir(server.root.path())
        .unwrap()
        .next()
        .unwrap()
        .unwrap();
    let partial = std::fs::read_dir(dir.path())
        .unwrap()
        .next()
        .unwrap()
        .unwrap();
    let name = format!(
        "/{}/{}",
        dir.file_name().to_str().unwrap(),
        partial.file_name().to_str().unwrap()
    );
    let before = std::fs::read(partial.path()).unwrap();
    server
        .faults
        .links
        .lock()
        .unwrap()
        .insert(name.clone(), "/unrelated".into());
    files
        .transfers
        .confirm_upload_restart(&retry.id, &prompt.token)
        .unwrap();
    assert_eq!(finished(&files, &retry.id).await.state, "failed");
    assert_eq!(std::fs::read(partial.path()).unwrap(), before);
    server.faults.links.lock().unwrap().remove(&name);
    let pending = files.transfers.start(request(&login.id)).unwrap();
    let prompt = wait_for(&files, &pending.id, |i| i.restart_prompt.is_some())
        .await
        .restart_prompt
        .unwrap();
    let target = server.root.path().join("shared.iso");
    std::fs::write(&target, b"created while waiting").unwrap();
    files
        .transfers
        .confirm_upload_restart(&pending.id, &prompt.token)
        .unwrap();
    assert_eq!(finished(&files, &pending.id).await.state, "failed");
    assert_eq!(std::fs::read(&target).unwrap(), b"created while waiting");
    std::fs::remove_file(&target).unwrap();
    let retained = std::fs::read(partial.path()).unwrap();
    let elevated = server
        .open_as(Some(SftpUser {
            username: "root".into(),
            server_path: String::new(),
            password: None,
        }))
        .await;
    let other = files.transfers.start(request(&elevated.id)).unwrap();
    let result = wait_for(&files, &other.id, |i| {
        i.restart_prompt.is_some() || i.state == "completed"
    })
    .await;
    assert_eq!(result.state, "completed");
    assert_eq!(result.resumed_bytes, 0);
    assert_eq!(std::fs::read(partial.path()).unwrap(), retained);
    files.shutdown().await;
    server.engine.shutdown().await;
}

#[tokio::test]
async fn file_only_write_permission_still_allows_verified_upload() {
    let server = Server::start(true, Duration::ZERO).await;
    server
        .faults
        .reject_private_mkdir
        .store(true, Ordering::Relaxed);
    let session = server.open().await;
    let local = tempfile::tempdir().unwrap();
    let files =
        Files::new(server.engine.clone(), 1).with_upload_recovery(local.path().join("records"));
    let source = local.path().join("data.bin");
    std::fs::write(&source, b"payload").unwrap();
    let task = files
        .transfers
        .start(input(
            &session.id,
            Direction::Upload,
            vec![path(&source)],
            "/".into(),
            ConflictPolicy::Fail,
        ))
        .unwrap();
    assert_completed(&files, &task.id).await;
    assert_eq!(
        std::fs::read(server.root.path().join("data.bin")).unwrap(),
        b"payload"
    );
    assert_eq!(std::fs::read_dir(server.root.path()).unwrap().count(), 1);
    files.shutdown().await;
    server.engine.shutdown().await;
}
