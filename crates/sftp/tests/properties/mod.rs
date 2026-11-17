use super::*;
use russh_sftp::protocol::FileAttributes;
use std::sync::atomic::Ordering;

fn request(path: &str, operation: PropertyOperation) -> PropertyRequest {
    PropertyRequest {
        request_id: uuid::Uuid::new_v4().to_string(),
        path: path.into(),
        operation,
    }
}
fn change(expected: FileEntry) -> PropertyChange {
    PropertyChange {
        expected,
        permissions: Some(0o644),
        uid: None,
        gid: None,
        recursive: false,
        directory_execute: false,
        confirmed: true,
    }
}

#[tokio::test]
async fn property_size_and_sha256_read_real_bytes_and_close_handles() {
    let server = Server::start(true, Duration::ZERO).await;
    let session = server.open().await;
    let files = Files::new(server.engine.clone(), 1);
    std::fs::create_dir_all(server.root.path().join("tree/empty")).unwrap();
    std::fs::write(server.root.path().join("tree/中文.txt"), b"hello").unwrap();
    std::fs::write(server.root.path().join("tree/link"), b"placeholder").unwrap();
    server
        .faults
        .links
        .lock()
        .unwrap()
        .insert("/tree/link".into(), "/outside".into());
    let size = files
        .property_operation(&session.id, request("/tree", PropertyOperation::Size))
        .await
        .unwrap();
    assert!(size.message.is_none(), "{:?}", size.message);
    assert_eq!(
        (size.bytes, size.files, size.directories, size.skipped_links),
        (5, 1, 2, 1)
    );
    let hash = files
        .property_operation(
            &session.id,
            request("/tree/中文.txt", PropertyOperation::Checksum),
        )
        .await
        .unwrap();
    assert_eq!(
        hash.checksum,
        Some(format!("{:x}", Sha256::digest(b"hello")))
    );
    assert!(hash.message.is_none());
    assert_eq!(server.faults.open_handles.load(Ordering::SeqCst), 0);
    let link = files
        .property_operation(
            &session.id,
            request("/tree/link", PropertyOperation::Checksum),
        )
        .await
        .unwrap();
    assert!(link.message.is_some());
    assert!(link.checksum.is_none());
    server.engine.shutdown().await;
}

#[tokio::test]
async fn property_recursive_apply_preserves_unspecified_ids_and_updates_children_before_directories()
 {
    let server = Server::start(true, Duration::ZERO).await;
    let session = server.open().await;
    let files = Files::new(server.engine.clone(), 1);
    std::fs::create_dir_all(server.root.path().join("tree/sub")).unwrap();
    std::fs::write(server.root.path().join("tree/sub/file"), b"keep content").unwrap();
    std::fs::write(server.root.path().join("tree/link"), b"link placeholder").unwrap();
    server
        .faults
        .links
        .lock()
        .unwrap()
        .insert("/tree/link".into(), "/outside".into());
    for (path, mode) in [
        ("/tree", 0o040700),
        ("/tree/sub", 0o040700),
        ("/tree/sub/file", 0o100600),
    ] {
        server.faults.property_attributes.lock().unwrap().insert(
            path.into(),
            FileAttributes {
                permissions: Some(mode),
                uid: Some(1000),
                gid: Some(1000),
                ..Default::default()
            },
        );
    }
    let expected = files.properties(&session.id, "/tree").await.unwrap();
    let result = files
        .property_operation(
            &session.id,
            request(
                "/tree",
                PropertyOperation::Apply {
                    change: PropertyChange {
                        uid: Some(42),
                        recursive: true,
                        directory_execute: true,
                        ..change(expected)
                    },
                },
            ),
        )
        .await
        .unwrap();
    assert!(result.message.is_none(), "{:?}", result.message);
    assert_eq!((result.changed, result.skipped_links), (3, 1));
    for (path, mode) in [
        ("/tree", 0o755),
        ("/tree/sub", 0o755),
        ("/tree/sub/file", 0o644),
    ] {
        let actual = files.properties(&session.id, path).await.unwrap();
        assert_eq!(
            (actual.permissions, actual.uid, actual.gid),
            (Some(mode), Some(42), Some(1000))
        );
    }
    let writes = server.faults.property_writes.lock().unwrap().clone();
    assert_eq!(writes.first().unwrap().0, "/tree/sub/file");
    assert_eq!(writes.last().unwrap().0, "/tree");
    assert!(writes.iter().all(|(path, attrs)| path != "/tree/link"
        && attrs.size.is_none()
        && attrs.mtime.is_none()));
    assert_eq!(
        std::fs::read(server.root.path().join("tree/sub/file")).unwrap(),
        b"keep content"
    );
    server.engine.shutdown().await;
}

#[tokio::test]
async fn property_mutation_rejects_stale_snapshot_invalid_modes_and_unconfirmed_changes() {
    let server = Server::start(true, Duration::ZERO).await;
    let session = server.open().await;
    let files = Files::new(server.engine.clone(), 1);
    std::fs::write(server.root.path().join("file"), b"original").unwrap();
    let expected = files.properties(&session.id, "/file").await.unwrap();
    for (mode, confirmed) in [(0o10000, true), (0o644, false)] {
        assert!(
            files
                .property_operation(
                    &session.id,
                    request(
                        "/file",
                        PropertyOperation::Apply {
                            change: PropertyChange {
                                permissions: Some(mode),
                                confirmed,
                                ..change(expected.clone())
                            }
                        }
                    )
                )
                .await
                .is_err()
        );
    }
    std::fs::write(server.root.path().join("file"), b"changed size").unwrap();
    let stale = files
        .property_operation(
            &session.id,
            request(
                "/file",
                PropertyOperation::Apply {
                    change: change(expected),
                },
            ),
        )
        .await
        .unwrap();
    assert!(stale.message.is_some());
    assert_eq!(stale.changed, 0);
    assert!(server.faults.property_writes.lock().unwrap().is_empty());
    server.engine.shutdown().await;
}

#[tokio::test]
async fn property_failure_reports_partial_changes_and_server_ignored_permissions() {
    let server = Server::start(true, Duration::ZERO).await;
    let session = server.open().await;
    let files = Files::new(server.engine.clone(), 1);
    std::fs::create_dir(server.root.path().join("tree")).unwrap();
    std::fs::write(server.root.path().join("tree/file"), b"data").unwrap();
    let expected = files.properties(&session.id, "/tree").await.unwrap();
    *server.faults.reject_property_path.lock().unwrap() = Some("/tree".into());
    let partial = files
        .property_operation(
            &session.id,
            request(
                "/tree",
                PropertyOperation::Apply {
                    change: PropertyChange {
                        permissions: Some(0o600),
                        recursive: true,
                        ..change(expected)
                    },
                },
            ),
        )
        .await
        .unwrap();
    assert!(partial.message.is_some());
    assert_eq!(partial.changed, 1);
    assert!(!partial.cancelled);
    let expected = files.properties(&session.id, "/tree/file").await.unwrap();
    // Without an attribute override this fixture can only apply the write bit.
    let ignored = files
        .property_operation(
            &session.id,
            request(
                "/tree/file",
                PropertyOperation::Apply {
                    change: change(expected),
                },
            ),
        )
        .await
        .unwrap();
    assert!(ignored.message.unwrap().contains("未应用"));
    server.engine.shutdown().await;
}

#[tokio::test]
async fn property_cancellation_is_scoped_and_drains_checksum_handles() {
    let server = Server::start(true, Duration::from_millis(20)).await;
    let session = server.open().await;
    let files = Files::new(server.engine.clone(), 1);
    std::fs::write(server.root.path().join("large"), vec![8; 8 * 1024 * 1024]).unwrap();
    let input = request("/large", PropertyOperation::Checksum);
    let request_id = input.request_id.clone();
    let worker_files = files.clone();
    let id = session.id.clone();
    let worker =
        tokio::spawn(async move { worker_files.property_operation(&id, input).await.unwrap() });
    tokio::time::timeout(Duration::from_secs(5), async {
        while server.faults.open_handles.load(Ordering::SeqCst) == 0 {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    files
        .cancel_property_operation(&session.id, "another-request")
        .await
        .unwrap();
    assert!(!worker.is_finished());
    assert!(
        files
            .property_operation(&session.id, request("/large", PropertyOperation::Checksum))
            .await
            .is_err()
    );
    files
        .cancel_property_operation(&session.id, &request_id)
        .await
        .unwrap();
    let result = worker.await.unwrap();
    assert!(result.cancelled);
    assert!(result.checksum.is_none());
    assert_eq!(server.faults.open_handles.load(Ordering::SeqCst), 0);
    server.engine.shutdown().await;
}
