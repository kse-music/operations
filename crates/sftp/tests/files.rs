mod support;
use serverdeck_core::{IpcError, files::*};
use serverdeck_sftp::Files;
use sha2::{Digest, Sha256};
use std::{path::Path, time::Duration};
use support::Server;
fn input(
    session: &str,
    direction: Direction,
    sources: Vec<String>,
    destination: String,
    conflict: ConflictPolicy,
) -> TransferInput {
    TransferInput {
        session_id: session.into(),
        direction,
        sources,
        destination,
        conflict,
        confirm_overwrite: conflict == ConflictPolicy::Overwrite,
    }
}
fn path(path: &Path) -> String {
    path.to_str().expect("Unicode").to_owned()
}
async fn finished(files: &Files, id: &str) -> TransferInfo {
    tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            let info = files
                .transfers
                .list()
                .expect("list")
                .into_iter()
                .find(|t| t.id == id)
                .expect("task");
            if !info.unfinished() {
                return info;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("task deadline")
}
async fn assert_completed(files: &Files, id: &str) {
    let info = finished(files, id).await;
    assert_eq!(info.state, "completed", "{:?}", info.message);
    assert_eq!(info.remaining_bytes, 0);
}

#[tokio::test]
async fn closing_host_cancels_before_clearing_records_and_preserves_other_hosts_and_files() {
    let mut server = Server::start(true, Duration::from_millis(8)).await;
    let first = server.open().await;
    let files = Files::new(server.engine.clone(), 2);
    let source = tempfile::tempdir().expect("source");
    let saved = source.path().join("saved.txt");
    tokio::fs::write(&saved, b"completed file survives record cleanup")
        .await
        .expect("source");
    let completed = files
        .transfers
        .start(input(
            &first.id,
            Direction::Upload,
            vec![path(&saved)],
            "/".into(),
            ConflictPolicy::Skip,
        ))
        .expect("first upload");
    assert_completed(&files, &completed.id).await;
    files.close(&first.id, false).await.expect("first close");

    // A second configured host alias uses the same owned protocol server.
    server.host.id = uuid::Uuid::new_v4().to_string();
    let second = server.open().await;
    let large = source.path().join("active.bin");
    tokio::fs::write(&large, vec![42u8; 8 * 1024 * 1024])
        .await
        .expect("large source");
    let active = files
        .transfers
        .start(input(
            &second.id,
            Direction::Upload,
            vec![path(&large)],
            "/".into(),
            ConflictPolicy::Skip,
        ))
        .expect("second upload");
    assert_ne!(first.host_id, second.host_id);
    files
        .transfers
        .clear_host(&first.host_id)
        .expect("clear first host");
    let records = files.transfers.list().expect("records");
    assert_eq!(records.len(), 1);
    assert_eq!(records[0].id, active.id);
    assert!(records[0].unfinished());
    assert_eq!(
        IpcError::from(
            files
                .transfers
                .clear_host(&second.host_id)
                .expect_err("active guard")
        )
        .code,
        "TRANSFERS_ACTIVE"
    );
    assert_eq!(
        IpcError::from(
            files
                .close(&second.id, false)
                .await
                .expect_err("confirmation required")
        )
        .code,
        "TRANSFERS_ACTIVE"
    );
    files
        .close(&second.id, true)
        .await
        .expect("cancel and drain");
    let cancelled = files.transfers.list().expect("ended records");
    assert_eq!(cancelled[0].state, "cancelled");
    assert!(
        cancelled[0].recovery_paths.is_empty(),
        "{:?}",
        cancelled[0].recovery_paths
    );
    files
        .transfers
        .clear_host(&second.host_id)
        .expect("clear second host");
    files
        .transfers
        .clear_host(&second.host_id)
        .expect("idempotent clear");
    assert!(files.transfers.list().expect("empty").is_empty());
    assert_eq!(
        tokio::fs::read(server.root.path().join("saved.txt"))
            .await
            .expect("preserved remote file"),
        b"completed file survives record cleanup"
    );
    assert!(saved.is_file());
    assert!(large.is_file());
    server
        .engine
        .close_all()
        .await
        .expect("close server leases");
}

#[tokio::test]
async fn real_protocol_crud_unicode_properties_and_terminal_lease_independence() {
    let server = Server::start(true, Duration::ZERO).await;
    let info = server.open().await;
    let files = Files::new(server.engine.clone(), 3);
    let terminal = server.terminal().expect("terminal");
    assert_eq!(terminal.transport_id, info.transport_id);
    let name = "中文 空格 ;$'目录";
    let root = format!("/{name}");
    files
        .action(&info.id, RemoteAction::Mkdir { path: root.clone() })
        .await
        .expect("mkdir");
    tokio::fs::write(
        server.root.path().join(name).join("data file.txt"),
        b"actual bytes",
    )
    .await
    .expect("file");
    let listing = files.list(&info.id, &root).await.expect("list");
    assert_eq!(listing.entries[0].name, "data file.txt");
    assert_eq!(listing.entries[0].size, Some(12));
    assert_eq!(listing.parent, Some("/".into()));
    assert_eq!(listing.entries[0].permissions, Some(0o600));
    assert_eq!(listing.entries[0].uid, Some(1000));
    assert_eq!(listing.entries[0].owner.as_deref(), Some("sftp-owner"));
    files
        .action(
            &info.id,
            RemoteAction::Rename {
                path: format!("{root}/data file.txt"),
                destination: format!("{root}/renamed.txt"),
            },
        )
        .await
        .expect("rename");
    assert!(
        files
            .action(
                &info.id,
                RemoteAction::Remove {
                    paths: vec![root.clone()],
                    recursive: true,
                    confirmed: false
                }
            )
            .await
            .is_err()
    );
    server
        .engine
        .close(&terminal.id)
        .await
        .expect("close terminal");
    assert_eq!(
        files
            .list(&info.id, &root)
            .await
            .expect("SFTP still alive")
            .entries
            .len(),
        1
    );
    files
        .action(
            &info.id,
            RemoteAction::Remove {
                paths: vec![root],
                recursive: true,
                confirmed: true,
            },
        )
        .await
        .expect("recursive delete");
    assert!(
        std::fs::read_dir(server.root.path())
            .expect("root")
            .next()
            .is_none()
    );
    assert!(
        files
            .action(
                &info.id,
                RemoteAction::Remove {
                    paths: vec!["/".into()],
                    recursive: true,
                    confirmed: true
                }
            )
            .await
            .is_err()
    );
    files.close(&info.id, false).await.expect("close files");
    assert_eq!(server.engine.counts().expect("counts"), (0, 0));
}
#[tokio::test]
async fn recursive_large_multifile_roundtrip_conflicts_and_hashes() {
    let server = Server::start(true, Duration::ZERO).await;
    let session = server.open().await;
    let files = Files::new(server.engine.clone(), 3);
    let source = tempfile::tempdir().expect("source");
    let destination = tempfile::tempdir().expect("destination");
    let tree = source.path().join("中文 tree ;$'");
    tokio::fs::create_dir(&tree).await.expect("mkdir");
    tokio::fs::create_dir(tree.join("nested"))
        .await
        .expect("nested");
    let bytes: Vec<u8> = (0..8 * 1024 * 1024).map(|n| (n % 251) as u8).collect();
    tokio::fs::write(tree.join("large.bin"), &bytes)
        .await
        .expect("large");
    for n in 0..12 {
        tokio::fs::write(
            tree.join("nested").join(format!("file {n}.txt")),
            format!("真实数据 {n}"),
        )
        .await
        .expect("small");
    }
    let upload = files
        .transfers
        .start(input(
            &session.id,
            Direction::Upload,
            vec![path(&tree)],
            "/".into(),
            ConflictPolicy::Fail,
        ))
        .expect("start");
    assert_completed(&files, &upload.id).await;
    let speed = finished(&files, &upload.id).await.bytes_per_second;
    tokio::time::sleep(Duration::from_millis(25)).await;
    assert_eq!(
        finished(&files, &upload.id).await.bytes_per_second,
        speed,
        "completed transfer speed must not decay over time"
    );
    let remote = "/中文 tree ;$'".to_owned();
    let download = files
        .transfers
        .start(input(
            &session.id,
            Direction::Download,
            vec![remote.clone()],
            path(destination.path()),
            ConflictPolicy::Fail,
        ))
        .expect("download");
    assert_completed(&files, &download.id).await;
    assert_eq!(
        Sha256::digest(
            tokio::fs::read(destination.path().join("中文 tree ;$'").join("large.bin"))
                .await
                .expect("read")
        ),
        Sha256::digest(&bytes)
    );
    assert_eq!(
        tokio::fs::read_to_string(
            destination
                .path()
                .join("中文 tree ;$'")
                .join("nested")
                .join("file 11.txt")
        )
        .await
        .expect("read"),
        "真实数据 11"
    );
    let failed = files
        .transfers
        .start(input(
            &session.id,
            Direction::Upload,
            vec![path(&tree.join("large.bin"))],
            remote.clone(),
            ConflictPolicy::Fail,
        ))
        .expect("conflict task");
    assert_eq!(finished(&files, &failed.id).await.state, "failed");
    let skipped = files
        .transfers
        .retry(&failed.id, &session.id, ConflictPolicy::Skip, false)
        .expect("retry skip");
    assert_completed(&files, &skipped.id).await;
    assert_eq!(finished(&files, &skipped.id).await.skipped, 1);
    let renamed = files
        .transfers
        .start(input(
            &session.id,
            Direction::Upload,
            vec![path(&tree.join("large.bin"))],
            remote.clone(),
            ConflictPolicy::Rename,
        ))
        .expect("rename policy");
    assert_completed(&files, &renamed.id).await;
    assert!(
        server
            .root
            .path()
            .join("中文 tree ;$'")
            .join("large.bin (1)")
            .exists()
    );
    tokio::fs::write(tree.join("large.bin"), b"replacement")
        .await
        .expect("replace source");
    let overwritten = files
        .transfers
        .start(input(
            &session.id,
            Direction::Upload,
            vec![path(&tree.join("large.bin"))],
            remote,
            ConflictPolicy::Overwrite,
        ))
        .expect("overwrite");
    assert_completed(&files, &overwritten.id).await;
    assert_eq!(
        tokio::fs::read(server.root.path().join("中文 tree ;$'").join("large.bin"))
            .await
            .expect("target"),
        b"replacement"
    );
    files.shutdown().await;
    server.engine.shutdown().await;
    assert_eq!(server.engine.counts().expect("counts"), (0, 0));
}
#[tokio::test]
async fn bounded_host_queue_cancel_cleanup_disconnect_and_retry() {
    let server = Server::start(true, Duration::from_millis(4)).await;
    let session = server.open().await;
    let files = Files::new(server.engine.clone(), 3);
    let source = tempfile::tempdir().expect("source");
    let mut tasks = vec![];
    for n in 0..7 {
        let file = source.path().join(format!("large-{n}.bin"));
        tokio::fs::write(&file, vec![n; 4 * 1024 * 1024])
            .await
            .expect("file");
        tasks.push(
            files
                .transfers
                .start(input(
                    &session.id,
                    Direction::Upload,
                    vec![path(&file)],
                    "/".into(),
                    ConflictPolicy::Fail,
                ))
                .expect("enqueue"),
        );
    }
    tokio::time::sleep(Duration::from_millis(80)).await;
    let states = files.transfers.list().expect("states");
    assert!(
        states
            .iter()
            .filter(|i| i.unfinished() && i.state != "queued")
            .count()
            <= 3
    );
    assert!(states.iter().any(|i| i.state == "queued"));
    files.transfers.cancel(&tasks[6].id).expect("cancel queued");
    assert_eq!(finished(&files, &tasks[6].id).await.state, "cancelled");
    files.transfers.cancel(&tasks[0].id).expect("cancel active");
    let cancelled = finished(&files, &tasks[0].id).await;
    assert_eq!(cancelled.state, "cancelled");
    assert!(cancelled.recovery_paths.is_empty());
    assert!(!server.root.path().join("large-0.bin").exists());
    server.cut_network();
    for task in &tasks[1..6] {
        assert_eq!(finished(&files, &task.id).await.state, "failed");
    }
    let fresh = server.open().await;
    let retried = files
        .transfers
        .retry(&tasks[1].id, &fresh.id, ConflictPolicy::Fail, false)
        .expect("retry");
    assert_completed(&files, &retried.id).await;
    // Explicitly closing a connection with active work is refused unless cancellation is confirmed.
    let closing = files
        .transfers
        .start(input(
            &fresh.id,
            Direction::Upload,
            vec![path(&source.path().join("large-6.bin"))],
            "/".into(),
            ConflictPolicy::Fail,
        ))
        .expect("work");
    assert!(files.close(&fresh.id, false).await.is_err());
    files
        .close(&fresh.id, true)
        .await
        .expect("cancel and close");
    assert_eq!(finished(&files, &closing.id).await.state, "cancelled");
    files.shutdown().await;
    server.engine.shutdown().await;
    assert_eq!(server.engine.counts().expect("counts"), (0, 0));
}
#[tokio::test]
async fn text_save_hash_conflict_permission_and_unsupported_atomic_never_truncate() {
    let server = Server::start(true, Duration::ZERO).await;
    let session = server.open().await;
    let files = Files::new(server.engine.clone(), 3);
    let path = server.root.path().join("配置文件.txt");
    tokio::fs::write(&path, "original").await.expect("file");
    let doc = files
        .read_text(&session.id, "/配置文件.txt")
        .await
        .expect("read");
    files.editor_dirty(&doc.token, true).expect("dirty");
    assert_eq!(files.dirty_count(), 1);
    assert!(files.close_editor(&doc.token, false).is_err());
    server
        .faults
        .reject_writes
        .store(true, std::sync::atomic::Ordering::SeqCst);
    let error = files
        .save_text(SaveText {
            token: doc.token.clone(),
            content: "write must fail".into(),
            confirm_replace: true,
        })
        .await
        .expect_err("write denied");
    assert_eq!(IpcError::from(error).code, "SFTP_PERMISSION");
    assert_eq!(
        server
            .faults
            .open_handles
            .load(std::sync::atomic::Ordering::SeqCst),
        0,
        "failed saves must close their remote handle"
    );
    assert_eq!(
        tokio::fs::read_to_string(&path)
            .await
            .expect("preserved original"),
        "original"
    );
    assert_eq!(
        std::fs::read_dir(server.root.path()).expect("root").count(),
        1,
        "staging file removed"
    );
    server
        .faults
        .reject_writes
        .store(false, std::sync::atomic::Ordering::SeqCst);
    let saved = files
        .save_text(SaveText {
            token: doc.token.clone(),
            content: "中文已保存".into(),
            confirm_replace: true,
        })
        .await
        .expect("save")
        .document
        .expect("document");
    assert_eq!(
        tokio::fs::read_to_string(&path).await.expect("content"),
        "中文已保存"
    );
    assert_eq!(saved.permissions, Some(0o600));
    assert_eq!(saved.uid, Some(1000));
    let original_modified = std::fs::metadata(&path)
        .expect("metadata")
        .modified()
        .expect("mtime");
    tokio::fs::write(&path, "external change")
        .await
        .expect("external");
    std::fs::OpenOptions::new()
        .write(true)
        .open(&path)
        .expect("open timestamps")
        .set_times(std::fs::FileTimes::new().set_modified(original_modified))
        .expect("restore mtime");
    let error = files
        .save_text(SaveText {
            token: doc.token.clone(),
            content: "must not win".into(),
            confirm_replace: true,
        })
        .await
        .expect_err("conflict");
    assert_eq!(IpcError::from(error).code, "EDITOR_CONFLICT");
    assert_eq!(
        tokio::fs::read_to_string(&path).await.expect("content"),
        "external change"
    );
    files.close_editor(&doc.token, true).expect("close");
    let permissions = std::fs::metadata(&path).expect("meta").permissions();
    let mut readonly = permissions.clone();
    readonly.set_readonly(true);
    std::fs::set_permissions(&path, readonly).expect("readonly");
    let doc = files
        .read_text(&session.id, "/配置文件.txt")
        .await
        .expect("read readonly");
    let error = files
        .save_text(SaveText {
            token: doc.token,
            content: "denied".into(),
            confirm_replace: true,
        })
        .await
        .expect_err("permission");
    assert_eq!(IpcError::from(error).code, "SFTP_PERMISSION");
    std::fs::set_permissions(&path, permissions).expect("restore");
    tokio::fs::write(server.root.path().join("binary"), b"\0\xff")
        .await
        .expect("binary");
    assert!(files.read_text(&session.id, "/binary").await.is_err());
    files.shutdown().await;
    server.engine.shutdown().await;
    let server = Server::start(false, Duration::ZERO).await;
    let session = server.open().await;
    let files = Files::new(server.engine.clone(), 3);
    tokio::fs::write(server.root.path().join("text"), b"keep")
        .await
        .expect("file");
    let doc = files.read_text(&session.id, "/text").await.expect("read");
    assert!(!doc.atomic_save);
    assert!(
        files
            .save_text(SaveText {
                token: doc.token,
                content: "wrong".into(),
                confirm_replace: true
            })
            .await
            .is_err()
    );
    assert_eq!(
        tokio::fs::read(server.root.path().join("text"))
            .await
            .expect("file"),
        b"keep"
    );
    files.shutdown().await;
    server.engine.shutdown().await;
}

#[tokio::test]
async fn shutdown_drains_editor_commit_cancels_transfers_and_rejects_new_work() {
    let server = Server::start(true, Duration::from_millis(3)).await;
    let session = server.open().await;
    let files = Files::new(server.engine.clone(), 3);
    tokio::fs::write(server.root.path().join("edit.txt"), b"original")
        .await
        .expect("file");
    let doc = files
        .read_text(&session.id, "/edit.txt")
        .await
        .expect("document");
    let writing = {
        let files = files.clone();
        tokio::spawn(async move {
            files
                .save_text(SaveText {
                    token: doc.token,
                    content: "z".repeat(1024 * 1024),
                    confirm_replace: true,
                })
                .await
        })
    };
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if std::fs::read_dir(server.root.path())
                .expect("directory")
                .any(|e| {
                    e.expect("entry")
                        .file_name()
                        .to_string_lossy()
                        .starts_with(".serverdeck-editor-")
                })
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("save began");
    let source = tempfile::tempdir().expect("source");
    let large = source.path().join("large");
    tokio::fs::write(&large, vec![42; 8 * 1024 * 1024])
        .await
        .expect("large");
    let transfer = files
        .transfers
        .start(input(
            &session.id,
            Direction::Upload,
            vec![path(&large)],
            "/".into(),
            ConflictPolicy::Fail,
        ))
        .expect("task");
    files.shutdown().await;
    assert!(
        writing
            .await
            .expect("writer join")
            .expect("writer")
            .document
            .is_some()
    );
    assert_eq!(
        tokio::fs::metadata(server.root.path().join("edit.txt"))
            .await
            .expect("saved")
            .len(),
        1024 * 1024
    );
    assert_eq!(finished(&files, &transfer.id).await.state, "cancelled");
    assert!(files.list(&session.id, "/").await.is_err());
    server.engine.shutdown().await;
    assert_eq!(server.engine.counts().expect("released"), (0, 0));
}
