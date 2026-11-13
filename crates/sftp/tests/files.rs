mod external;
mod support;
mod throughput;
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
async fn uploads_preserve_source_modified_time_for_new_empty_nested_and_replaced_files() {
    let server = Server::start(true, Duration::ZERO).await;
    let session = server.open().await;
    let files = Files::new(server.engine.clone(), 1);
    let local = tempfile::tempdir().unwrap();
    let modified = std::time::SystemTime::UNIX_EPOCH + Duration::from_secs(1_645_594_860);
    for name in ["new.bin", "empty.bin", "folder/nested.bin", "replaced.bin"] {
        let source = local.path().join(name);
        std::fs::create_dir_all(source.parent().unwrap()).unwrap();
        std::fs::write(
            &source,
            if name == "empty.bin" {
                &b""[..]
            } else {
                &b"source"[..]
            },
        )
        .unwrap();
        std::fs::OpenOptions::new()
            .write(true)
            .open(&source)
            .unwrap()
            .set_modified(modified)
            .unwrap();
    }
    std::fs::write(server.root.path().join("replaced.bin"), b"old").unwrap();
    for source in ["new.bin", "empty.bin", "folder", "replaced.bin"] {
        let task = files
            .transfers
            .start(input(
                &session.id,
                Direction::Upload,
                vec![path(&local.path().join(source))],
                "/".into(),
                ConflictPolicy::Overwrite,
            ))
            .unwrap();
        assert_completed(&files, &task.id).await;
    }
    for name in ["new.bin", "empty.bin", "folder/nested.bin", "replaced.bin"] {
        assert_eq!(
            std::fs::metadata(server.root.path().join(name))
                .unwrap()
                .modified()
                .unwrap(),
            modified,
            "{name}"
        );
    }
    server.engine.shutdown().await;
}

#[tokio::test]
async fn ignored_modified_time_fails_without_replacing_target_or_leaking_staging_file() {
    let server = Server::start(true, Duration::ZERO).await;
    let session = server.open().await;
    let files = Files::new(server.engine.clone(), 1);
    let local = tempfile::tempdir().unwrap();
    let source = local.path().join("file.bin");
    std::fs::write(&source, b"new").unwrap();
    std::fs::OpenOptions::new()
        .write(true)
        .open(&source)
        .unwrap()
        .set_modified(std::time::SystemTime::UNIX_EPOCH + Duration::from_secs(1_645_594_860))
        .unwrap();
    let target = server.root.path().join("file.bin");
    std::fs::write(&target, b"old").unwrap();
    let before = std::fs::metadata(&target).unwrap().modified().unwrap();
    server
        .faults
        .ignore_times
        .store(true, std::sync::atomic::Ordering::SeqCst);
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
    let result = finished(&files, &task.id).await;
    assert_eq!(result.state, "failed");
    assert!(result.message.as_deref().unwrap().contains("修改时间"));
    assert_eq!(std::fs::read(&target).unwrap(), b"old");
    assert_eq!(
        std::fs::metadata(&target).unwrap().modified().unwrap(),
        before
    );
    assert_eq!(std::fs::read_dir(server.root.path()).unwrap().count(), 1);
    server.engine.shutdown().await;
}

#[tokio::test]
async fn data_time_and_speed_freeze_before_close_and_verification_for_each_file() {
    use std::sync::atomic::Ordering;
    for direction in [Direction::Upload, Direction::Download] {
        let server = Server::start(true, Duration::from_millis(40)).await;
        // Keep file close and readback visibly separate from the data stage.
        server.faults.close_delay_ms.store(1500, Ordering::SeqCst);
        let session = server.open().await;
        let files = Files::new(server.engine.clone(), 1);
        let local = tempfile::tempdir().expect("local files");
        let payload = vec![
            42;
            if direction == Direction::Upload {
                1024 * 1024
            } else {
                128 * 1024 + 17
            }
        ];
        let sources: Vec<_> = ["first.bin", "second.bin"]
            .into_iter()
            .map(|name| {
                if direction == Direction::Upload {
                    let source = local.path().join(name);
                    std::fs::write(&source, &payload).expect("upload source");
                    path(&source)
                } else {
                    std::fs::write(server.root.path().join(name), &payload)
                        .expect("download source");
                    format!("/{name}")
                }
            })
            .collect();
        let task = files
            .transfers
            .start(input(
                &session.id,
                direction,
                sources,
                if direction == Direction::Upload {
                    "/".into()
                } else {
                    path(local.path())
                },
                ConflictPolicy::Fail,
            ))
            .expect("start transfer");
        let snapshot = || files.transfers.list().expect("tasks").pop().expect("task");
        let mut final_metrics = (0, 0);
        for index in 0..2 {
            let target_directory = if direction == Direction::Upload {
                server.root.path()
            } else {
                local.path()
            };
            tokio::time::timeout(Duration::from_secs(15), async {
                loop {
                    let info = snapshot();
                    assert!(info.unfinished(), "missed data phase: {info:?}");
                    if info.transferred_bytes == payload.len() as u64 * (index as u64 + 1) {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
            })
            .await
            .expect("data deadline");
            tokio::time::sleep(Duration::from_millis(20)).await;
            let verifying = snapshot();
            assert_eq!(verifying.state, "verifying", "{direction:?}: {verifying:?}");
            assert_eq!(verifying.files_done, index);
            assert_eq!(
                ["first.bin", "second.bin"]
                    .iter()
                    .filter(|name| target_directory.join(name).exists())
                    .count(),
                index,
                "full byte progress must not commit an unverified file"
            );
            assert!(verifying.bytes_per_second > 0);
            if direction == Direction::Upload {
                assert!(
                    verifying.elapsed_seconds > index as u64,
                    "data time must accumulate across files: {verifying:?}"
                );
            }
            final_metrics = (verifying.elapsed_seconds, verifying.bytes_per_second);
            tokio::time::sleep(Duration::from_millis(1100)).await;
            let later = snapshot();
            assert_eq!(later.state, "verifying", "{later:?}");
            assert_eq!(later.files_done, index);
            assert_eq!(
                (later.elapsed_seconds, later.bytes_per_second),
                final_metrics,
                "verification must not change transfer metrics: {direction:?}"
            );
        }
        let done = finished(&files, &task.id).await;
        assert_eq!(done.state, "completed", "{done:?}");
        assert_eq!(done.files_done, 2);
        assert_eq!(done.remaining_bytes, 0);
        assert_eq!((done.elapsed_seconds, done.bytes_per_second), final_metrics);
        for name in ["first.bin", "second.bin"] {
            let target = if direction == Direction::Upload {
                server.root.path().join(name)
            } else {
                local.path().join(name)
            };
            assert_eq!(std::fs::read(target).expect("committed file"), payload);
        }
        assert_eq!(server.faults.open_handles.load(Ordering::SeqCst), 0);
        files.shutdown().await;
        server.engine.shutdown().await;
    }
}

#[tokio::test]
async fn elapsed_time_excludes_queueing_and_freezes_after_completion() {
    let server = Server::start(true, Duration::from_millis(50)).await;
    let session = server.open().await;
    let files = Files::new(server.engine.clone(), 1);
    let source = tempfile::tempdir().expect("source");
    let large = source.path().join("large.bin");
    let empty = source.path().join("empty.bin");
    std::fs::write(&large, vec![42; 1024 * 1024]).expect("large file");
    std::fs::write(&empty, []).expect("empty file");
    let start = |source: &Path| {
        files
            .transfers
            .start(input(
                &session.id,
                Direction::Upload,
                vec![path(source)],
                "/".into(),
                ConflictPolicy::Fail,
            ))
            .expect("enqueue")
    };
    let active = start(&large);
    let queued = start(&empty);
    assert_eq!(queued.state, "queued");
    assert_eq!(queued.elapsed_seconds, 0);
    tokio::time::sleep(Duration::from_millis(1100)).await;
    let snapshots = files.transfers.list().expect("tasks");
    let running = snapshots
        .iter()
        .find(|t| t.id == active.id)
        .expect("active task");
    assert!(running.elapsed_seconds >= 1, "{running:?}");
    let waiting = snapshots
        .iter()
        .find(|t| t.id == queued.id)
        .expect("queued task");
    assert_eq!(waiting.state, "queued");
    assert_eq!(waiting.elapsed_seconds, 0);
    let ended = finished(&files, &active.id).await;
    let second = finished(&files, &queued.id).await;
    assert_eq!(ended.state, "completed", "{ended:?}");
    assert!(ended.elapsed_seconds >= 1);
    assert_eq!(second.state, "completed", "{second:?}");
    assert!(
        second.elapsed_seconds < ended.elapsed_seconds,
        "queue time must not be included"
    );
    assert_eq!(
        serde_json::to_value(&ended).expect("IPC snapshot")["elapsedSeconds"],
        ended.elapsed_seconds
    );
    tokio::time::sleep(Duration::from_millis(1100)).await;
    assert_eq!(
        finished(&files, &active.id).await.elapsed_seconds,
        ended.elapsed_seconds
    );
    assert_eq!(
        finished(&files, &queued.id).await.elapsed_seconds,
        second.elapsed_seconds
    );
    files.shutdown().await;
    server.engine.shutdown().await;
}

#[tokio::test]
async fn sudo_file_channels_authenticate_each_transfer_and_keep_login_leases_separate() {
    use zeroize::Zeroizing;
    let server = Server::start(true, Duration::ZERO).await;
    *server.faults.sudo_password.lock().unwrap() = Some("sudo-secret".into());
    let login = server.open().await;
    let elevated = server
        .open_as(Some(SftpUser {
            username: "root".into(),
            server_path: String::new(),
            password: Some(Zeroizing::new("sudo-secret".into())),
        }))
        .await;
    assert_ne!(login.id, elevated.id);
    assert_eq!(login.transport_id, elevated.transport_id);
    assert!(server.engine.file_is_elevated(&elevated.id).unwrap());
    assert!(!server.engine.file_is_elevated(&login.id).unwrap());
    let files = Files::new(server.engine.clone(), 3);
    files
        .list(&elevated.id, ".")
        .await
        .expect("sudo browser handshake");
    let local = tempfile::tempdir().unwrap();
    tokio::fs::write(local.path().join("sudo.txt"), b"sudo transfer content")
        .await
        .unwrap();
    let upload = files
        .transfers
        .start(input(
            &elevated.id,
            Direction::Upload,
            vec![path(&local.path().join("sudo.txt"))],
            "/".into(),
            ConflictPolicy::Fail,
        ))
        .unwrap();
    assert_completed(&files, &upload.id).await;
    assert_eq!(
        tokio::fs::read(server.root.path().join("sudo.txt"))
            .await
            .unwrap(),
        b"sudo transfer content"
    );
    let doc = files.read_text(&elevated.id, "/sudo.txt").await.unwrap();
    assert!(files.check_user_switch(&elevated.id).is_err());
    files.close_editor(&doc.token, false).unwrap();
    files.check_user_switch(&elevated.id).unwrap();
    let commands = server.faults.sudo_commands.lock().unwrap().clone();
    assert!(
        commands.len() >= 2,
        "browser and transfer use separate sudo channels"
    );
    assert!(
        commands
            .iter()
            .all(|command| !command.contains("sudo-secret"))
    );
    let ordinary = server.open().await;
    assert_eq!(
        ordinary.id, login.id,
        "normal opens must not reuse sudo leases"
    );
    let dedicated_login = server.open_as(None).await;
    assert_ne!(
        dedicated_login.id, login.id,
        "switch candidates must own a new lease"
    );
    files.close(&elevated.id, false).await.unwrap();
    files
        .list(&login.id, ".")
        .await
        .expect("other lease survives");
    files.shutdown().await;
    server.engine.shutdown().await;
}

#[tokio::test]
async fn sudo_rejection_and_bad_password_leave_the_original_sftp_usable() {
    use zeroize::Zeroizing;
    let server = Server::start(true, Duration::ZERO).await;
    *server.faults.sudo_password.lock().unwrap() = Some("correct-password".into());
    let login = server.open().await;
    let files = Files::new(server.engine.clone(), 3);
    for password in [None, Some(Zeroizing::new("incorrect-password".into()))] {
        let candidate = server
            .open_as(Some(SftpUser {
                username: "root".into(),
                server_path: String::new(),
                password,
            }))
            .await;
        let error = match files.list(&candidate.id, ".").await {
            Ok(_) => panic!("sudo must reject"),
            Err(error) => error,
        };
        assert!(matches!(
            serverdeck_core::IpcError::from(error).code,
            "SFTP_SUDO_DENIED" | "SFTP_SUDO_AUTH"
        ));
        files.close(&candidate.id, false).await.unwrap();
        files
            .list(&login.id, ".")
            .await
            .expect("old browser retained");
    }
    *server.faults.sudo_password.lock().unwrap() = None;
    let no_password = server
        .open_as(Some(SftpUser {
            username: "root".into(),
            server_path: String::new(),
            password: None,
        }))
        .await;
    files
        .list(&no_password.id, ".")
        .await
        .expect("passwordless sudo");
    let extra_password = server
        .open_as(Some(SftpUser {
            username: "root".into(),
            server_path: String::new(),
            password: Some(Zeroizing::new("unused-password".into())),
        }))
        .await;
    files
        .list(&extra_password.id, ".")
        .await
        .expect("unused password must not corrupt SFTP packets");
    files.shutdown().await;
    server.engine.shutdown().await;
}

#[tokio::test]
async fn downloads_selected_file_links_under_the_link_name_without_following_tree_links() {
    let server = Server::start(true, Duration::ZERO).await;
    let session = server.open().await;
    let files = Files::new(server.engine.clone(), 3);
    let destination = tempfile::tempdir().expect("destination");
    tokio::fs::write(server.root.path().join("image.bin"), b"image contents")
        .await
        .expect("target file");
    let directory = server.root.path().join("directory");
    tokio::fs::create_dir(&directory).await.expect("directory");
    // The placeholder supplies the directory entry; LSTAT identifies it as a fixture link.
    tokio::fs::write(directory.join("nested"), b"")
        .await
        .expect("nested entry");
    server.faults.links.lock().expect("links").extend([
        ("/image".into(), "/image.bin".into()),
        ("/folder-link".into(), "/directory".into()),
        ("/broken".into(), "/missing".into()),
        ("/directory/nested".into(), "/image.bin".into()),
    ]);
    let download = |source: &str| {
        files
            .transfers
            .start(input(
                &session.id,
                Direction::Download,
                vec![source.into()],
                path(destination.path()),
                ConflictPolicy::Fail,
            ))
            .expect("queue download")
    };
    assert_completed(&files, &download("/image").id).await;
    assert_eq!(
        tokio::fs::read(destination.path().join("image"))
            .await
            .expect("downloaded file"),
        b"image contents"
    );
    assert!(!destination.path().join("image.bin").exists());
    for source in ["/folder-link", "/broken", "/directory"] {
        let info = finished(&files, &download(source).id).await;
        assert_eq!(info.state, "failed", "{source}");
        assert!(!destination.path().join(&source[1..]).exists());
    }
}

#[tokio::test]
async fn stages_windows_drag_files_and_selected_file_links() {
    let server = Server::start(true, Duration::ZERO).await;
    let session = server.open().await;
    let files = Files::new(server.engine.clone(), 3);
    let destination = tempfile::tempdir().expect("drop staging directory");
    tokio::fs::write(server.root.path().join("actual.txt"), b"verified bytes")
        .await
        .expect("remote file");
    tokio::fs::create_dir(server.root.path().join("folder"))
        .await
        .expect("remote directory");
    server.faults.links.lock().expect("links").extend([
        ("/shortcut.txt".into(), "/actual.txt".into()),
        ("/folder-link".into(), "/folder".into()),
    ]);

    let sources = vec!["/actual.txt".into(), "/shortcut.txt".into()];
    assert_eq!(
        serverdeck_sftp::Transfers::drag_download_names(&session.id, sources.clone())
            .expect("export names"),
        ["actual.txt", "shortcut.txt"]
    );
    assert!(
        serverdeck_sftp::Transfers::drag_download_names(
            &session.id,
            vec!["/first/readme.txt".into(), "/second/README.txt".into()],
        )
        .is_err()
    );
    files
        .transfers
        .stage_drag_download(session.id.clone(), sources, destination.path())
        .await
        .expect("successful export");
    for name in ["actual.txt", "shortcut.txt"] {
        assert_eq!(
            tokio::fs::read(destination.path().join(name))
                .await
                .unwrap(),
            b"verified bytes"
        );
    }
    for remote_path in ["/folder", "/folder-link"] {
        let error = files
            .transfers
            .stage_drag_download(
                session.id.clone(),
                vec![remote_path.into()],
                destination.path(),
            )
            .await
            .expect_err("directory export is unsupported");
        assert_eq!(error.code, "DRAG_DOWNLOAD_FAILED");
        assert!(!destination.path().join(&remote_path[1..]).exists());
    }
    assert!(files.transfers.list().expect("transfer history").is_empty());
}

#[tokio::test]
async fn windows_drag_progress_is_marked_without_bypassing_active_transfer_guards() {
    let server = Server::start(true, Duration::ZERO).await;
    server
        .faults
        .wire_delay_ms
        .store(20, std::sync::atomic::Ordering::SeqCst);
    let session = server.open().await;
    let files = Files::new(server.engine.clone(), 1);
    let destination = tempfile::tempdir().expect("staging directory");
    std::fs::write(
        server.root.path().join("large.bin"),
        vec![42; 4 * 1024 * 1024],
    )
    .expect("source");
    let transfers = files.transfers.clone();
    let session_id = session.id.clone();
    let directory = destination.path().to_owned();
    let staging = tokio::spawn(async move {
        transfers
            .stage_drag_download(session_id, vec!["/large.bin".into()], &directory)
            .await
    });
    let snapshot = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Some(info) = files.transfers.list().expect("tasks").into_iter().next() {
                break info;
            }
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    })
    .await
    .expect("drag task started");
    assert!(snapshot.drag_export);
    assert_eq!(
        serde_json::to_value(&snapshot).expect("IPC snapshot")["dragExport"],
        true
    );
    assert_eq!(files.transfers.unfinished().expect("active count"), 1);
    assert_eq!(
        files
            .transfers
            .session_unfinished(&session.id)
            .expect("session count"),
        1
    );
    assert_eq!(
        IpcError::from(
            files
                .close(&session.id, false)
                .await
                .expect_err("confirmation required")
        )
        .code,
        "TRANSFERS_ACTIVE"
    );
    files
        .transfers
        .cancel(&snapshot.id)
        .expect("cancel drag staging");
    assert_eq!(
        staging
            .await
            .expect("staging task")
            .expect_err("cancelled export")
            .code,
        "DRAG_DOWNLOAD_FAILED"
    );
    assert_eq!(files.transfers.unfinished().expect("drained count"), 0);
    assert!(files.transfers.list().expect("history").is_empty());
    assert!(!destination.path().join("large.bin").exists());
    files.shutdown().await;
    server.engine.shutdown().await;
}

#[tokio::test]
async fn a_link_retargeted_during_download_does_not_commit_local_bytes() {
    let server = Server::start(true, Duration::from_millis(20)).await;
    let session = server.open().await;
    let files = Files::new(server.engine.clone(), 3);
    let destination = tempfile::tempdir().expect("destination");
    let root = server.root.path();
    tokio::fs::write(root.join("first"), vec![1; 512 * 1024])
        .await
        .expect("first target");
    tokio::fs::write(root.join("second"), vec![2; 512 * 1024])
        .await
        .expect("second target");
    let retarget = |target: &str| {
        server
            .faults
            .links
            .lock()
            .expect("links")
            .insert("/image".into(), target.into());
    };
    retarget("/first");
    let task = files
        .transfers
        .start(input(
            &session.id,
            Direction::Download,
            vec!["/image".into()],
            path(destination.path()),
            ConflictPolicy::Fail,
        ))
        .expect("queue download");
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if files.transfers.list().expect("tasks")[0].transferred_bytes > 0 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("transfer started");
    retarget("/second");
    let result = finished(&files, &task.id).await;
    assert_eq!(result.state, "failed");
    assert!(
        result
            .message
            .expect("reason")
            .contains("远程链接目标已变化")
    );
    assert!(!destination.path().join("image").exists());
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
    assert_eq!(
        IpcError::from(
            files
                .check_user_switch(&session.id)
                .expect_err("unfinished transfers block identity changes")
        )
        .code,
        "TRANSFERS_ACTIVE"
    );
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
