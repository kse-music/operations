use super::*;
use std::sync::atomic::Ordering;

fn remote_input(session: &str, sources: &[&str], destination: &str) -> RemoteCopyInput {
    RemoteCopyInput {
        session_id: session.into(),
        target_session_id: None,
        sources: sources.iter().map(|path| (*path).into()).collect(),
        destination: destination.into(),
        name: None,
        conflict: ConflictPolicy::Fail,
        confirmed: true,
        confirm_overwrite: false,
    }
}

#[test]
fn remote_copy_rejects_unsafe_targets_and_missing_confirmation() {
    let session = uuid::Uuid::new_v4().to_string();
    for (sources, destination, name) in [
        (vec!["/"], "/dest", None),
        (vec!["/a"], "/", None),
        (vec!["/a"], "/a/sub", None),
        (vec!["/a/b"], "/", Some("a")),
        (vec!["/a", "/a/b"], "/dest", None),
        (vec!["/a", "/a"], "/dest", None),
        (vec!["/a/file", "/b/file"], "/dest", None),
        (vec!["/a", "/b"], "/dest", Some("same")),
        (vec!["/a"], "/dest/../a", None),
        (vec!["/a"], "/dest", Some("../escape")),
    ] {
        let mut input = remote_input(&session, &sources, destination);
        input.name = name.map(str::to_owned);
        assert!(input.validate().is_err(), "{input:?}");
    }
    let mut input = remote_input(&session, &["/a"], "/dest");
    input.confirmed = false;
    assert!(input.validate().is_err());
    input.confirmed = true;
    input.conflict = ConflictPolicy::Overwrite;
    assert!(input.validate().is_err());
    input.confirm_overwrite = true;
    assert!(input.validate().is_ok());
}

#[test]
fn remote_copy_contract_rejects_removed_operation_selector() {
    let mut input = serde_json::json!({
        "sessionId": uuid::Uuid::new_v4().to_string(),
        "targetSessionId": uuid::Uuid::new_v4().to_string(),
        "sources": ["/source"], "destination": "/dest", "name": null,
        "conflict": "fail", "confirmed": true, "confirmOverwrite": false
    });
    assert!(
        serde_json::from_value::<RemoteCopyInput>(input.clone())
            .unwrap()
            .validate()
            .is_ok()
    );
    input["kind"] = serde_json::json!("move");
    assert!(serde_json::from_value::<RemoteCopyInput>(input).is_err());
}

#[tokio::test]
async fn cross_host_copy_uses_separate_endpoints_even_with_identical_paths() {
    let source = Server::start(true, Duration::ZERO).await;
    let target = Server::start_shared(
        true,
        Duration::ZERO,
        Some((source.database.clone(), source.engine.clone())),
    )
    .await;
    let from = source.open().await;
    let to = target.open().await;
    let files = Files::new(source.engine.clone(), 1);
    std::fs::create_dir_all(source.root.path().join("tree/empty")).unwrap();
    let content: Vec<_> = (0..100_123).map(|i| (i % 251) as u8).collect();
    std::fs::write(source.root.path().join("file"), &content).unwrap();
    std::fs::write(source.root.path().join("tree/child"), b"nested").unwrap();
    std::fs::write(target.root.path().join("unrelated"), b"keep").unwrap();
    source.faults.reject_writes.store(true, Ordering::SeqCst);
    let mut input = remote_input(&from.id, &["/file", "/tree"], "/");
    input.target_session_id = Some(to.id.clone());
    let task = files.transfers.start_remote_copy(input).unwrap();
    let info = finished(&files, &task.id).await;
    assert_eq!(info.state, "completed", "{:?}", info.message);
    assert_eq!(info.host_id, source.host.id);
    assert_eq!(info.session_id, from.id);
    assert_eq!(
        info.remote_target_host_id.as_deref(),
        Some(target.host.id.as_str())
    );
    assert_eq!(
        info.remote_target_session_id.as_deref(),
        Some(to.id.as_str())
    );
    assert_eq!((info.files_total, info.files_done), (4, 4));
    assert_eq!(info.transferred_bytes, content.len() as u64 + 6);
    for server in [&source, &target] {
        assert_eq!(
            std::fs::read(server.root.path().join("file")).unwrap(),
            content
        );
        assert_eq!(
            std::fs::read(server.root.path().join("tree/child")).unwrap(),
            b"nested"
        );
        assert!(server.root.path().join("tree/empty").is_dir());
        assert_eq!(server.faults.open_handles.load(Ordering::SeqCst), 0);
    }
    assert_eq!(
        std::fs::read(target.root.path().join("unrelated")).unwrap(),
        b"keep"
    );
    files.transfers.clear_host(&target.host.id).unwrap();
    assert!(files.transfers.list().unwrap().is_empty());
    source.engine.shutdown().await;
}

#[tokio::test]
async fn cross_host_copy_protects_existing_target_and_reports_destination_permission_failures() {
    let source = Server::start(true, Duration::ZERO).await;
    let target = Server::start_shared(
        true,
        Duration::ZERO,
        Some((source.database.clone(), source.engine.clone())),
    )
    .await;
    let from = source.open().await;
    let to = target.open().await;
    let files = Files::new(source.engine.clone(), 1);
    std::fs::write(source.root.path().join("file"), b"new bytes").unwrap();
    std::fs::write(target.root.path().join("file"), b"original").unwrap();
    let mut input = remote_input(&from.id, &["/file"], "/");
    input.target_session_id = Some(to.id.clone());
    let conflict = files.transfers.start_remote_copy(input.clone()).unwrap();
    assert_eq!(finished(&files, &conflict.id).await.state, "failed");
    input.conflict = ConflictPolicy::Overwrite;
    input.confirm_overwrite = true;
    target.faults.reject_writes.store(true, Ordering::SeqCst);
    let denied = files.transfers.start_remote_copy(input).unwrap();
    assert_eq!(finished(&files, &denied.id).await.state, "failed");
    assert_eq!(
        std::fs::read(target.root.path().join("file")).unwrap(),
        b"original"
    );
    target.faults.reject_writes.store(false, Ordering::SeqCst);
    let retry = files
        .transfers
        .retry(&denied.id, &from.id, ConflictPolicy::Overwrite, true)
        .unwrap();
    let info = finished(&files, &retry.id).await;
    assert_eq!(info.state, "completed", "{:?}", info.message);
    assert_eq!(
        info.remote_target_session_id.as_deref(),
        Some(to.id.as_str())
    );
    for server in [&source, &target] {
        assert_eq!(
            std::fs::read(server.root.path().join("file")).unwrap(),
            b"new bytes"
        );
        assert_eq!(std::fs::read_dir(server.root.path()).unwrap().count(), 1);
        assert_eq!(server.faults.open_handles.load(Ordering::SeqCst), 0);
    }
    source.engine.shutdown().await;
}

#[tokio::test]
async fn cross_host_copy_guards_and_cancels_both_endpoint_sessions() {
    for close_target in [false, true] {
        let source = Server::start(true, Duration::from_millis(10)).await;
        let target = Server::start_shared(
            true,
            Duration::from_millis(10),
            Some((source.database.clone(), source.engine.clone())),
        )
        .await;
        let from = source.open().await;
        let to = target.open().await;
        let files = Files::new(source.engine.clone(), 1);
        let content = vec![7u8; 8 * 1024 * 1024];
        std::fs::write(source.root.path().join("large"), &content).unwrap();
        std::fs::write(target.root.path().join("large"), b"keep target").unwrap();
        let mut input = remote_input(&from.id, &["/large"], "/");
        input.target_session_id = Some(to.id.clone());
        input.conflict = ConflictPolicy::Overwrite;
        input.confirm_overwrite = true;
        let task = files.transfers.start_remote_copy(input).unwrap();
        for id in [&from.id, &to.id] {
            assert_eq!(files.transfers.session_unfinished(id).unwrap(), 1);
            assert!(files.check_user_switch(id).is_err());
            assert_eq!(
                IpcError::from(files.close(id, false).await.unwrap_err()).code,
                "TRANSFERS_ACTIVE"
            );
        }
        tokio::time::timeout(Duration::from_secs(5), async {
            while files.transfers.list().unwrap()[0].transferred_bytes == 0 {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        let (closing, remaining) = if close_target {
            (&to.id, &from.id)
        } else {
            (&from.id, &to.id)
        };
        files.close(closing, true).await.unwrap();
        let info = finished(&files, &task.id).await;
        assert_eq!(info.state, "cancelled", "{:?}", info.message);
        assert!(info.recovery_paths.is_empty());
        assert!(source.engine.session_info(remaining).is_ok());
        assert_eq!(
            std::fs::read(source.root.path().join("large")).unwrap(),
            content
        );
        assert_eq!(
            std::fs::read(target.root.path().join("large")).unwrap(),
            b"keep target"
        );
        assert_eq!(std::fs::read_dir(target.root.path()).unwrap().count(), 1);
        assert_eq!(source.faults.open_handles.load(Ordering::SeqCst), 0);
        assert_eq!(target.faults.open_handles.load(Ordering::SeqCst), 0);
        source.engine.shutdown().await;
    }
}

#[tokio::test]
async fn cross_host_copy_counts_destination_concurrency_and_rejects_closed_targets() {
    let source = Server::start(true, Duration::from_millis(10)).await;
    let target = Server::start_shared(
        true,
        Duration::from_millis(10),
        Some((source.database.clone(), source.engine.clone())),
    )
    .await;
    let from = source.open().await;
    let to = target.open().await;
    let files = Files::new(source.engine.clone(), 1);
    std::fs::write(source.root.path().join("large"), vec![1u8; 8 * 1024 * 1024]).unwrap();
    let mut input = remote_input(&from.id, &["/large"], "/");
    input.target_session_id = Some(to.id.clone());
    let first = files.transfers.start_remote_copy(input.clone()).unwrap();
    input.session_id = to.id.clone();
    input.target_session_id = Some(from.id.clone());
    input.name = Some("back".into());
    let second = files.transfers.start_remote_copy(input.clone()).unwrap();
    assert_eq!(
        files
            .transfers
            .list()
            .unwrap()
            .iter()
            .find(|t| t.id == second.id)
            .unwrap()
            .state,
        "queued"
    );
    assert!(files.transfers.clear_host(&target.host.id).is_err());
    files.close(&to.id, true).await.unwrap();
    assert_eq!(finished(&files, &first.id).await.state, "cancelled");
    assert_eq!(finished(&files, &second.id).await.state, "cancelled");
    input.session_id = from.id.clone();
    input.target_session_id = Some(to.id.clone());
    assert!(files.transfers.start_remote_copy(input).is_err());
    assert!(source.engine.session_info(&from.id).is_ok());
    source.engine.shutdown().await;
}

#[tokio::test]
async fn cross_host_source_disconnect_cleans_target_stage_and_preserves_existing_data() {
    let source = Server::start(true, Duration::from_millis(10)).await;
    let target = Server::start_shared(
        true,
        Duration::ZERO,
        Some((source.database.clone(), source.engine.clone())),
    )
    .await;
    let from = source.open().await;
    let to = target.open().await;
    let files = Files::new(source.engine.clone(), 1);
    let content = vec![3u8; 8 * 1024 * 1024];
    std::fs::write(source.root.path().join("large"), &content).unwrap();
    std::fs::write(target.root.path().join("large"), b"original").unwrap();
    let mut input = remote_input(&from.id, &["/large"], "/");
    input.target_session_id = Some(to.id.clone());
    input.conflict = ConflictPolicy::Overwrite;
    input.confirm_overwrite = true;
    let task = files.transfers.start_remote_copy(input).unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        while files.transfers.list().unwrap()[0].transferred_bytes == 0 {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    source.cut_network();
    let info = finished(&files, &task.id).await;
    assert_eq!(info.state, "failed", "{:?}", info.message);
    assert!(info.recovery_paths.is_empty());
    assert!(source.engine.session_info(&to.id).is_ok());
    assert_eq!(
        std::fs::read(source.root.path().join("large")).unwrap(),
        content
    );
    assert_eq!(
        std::fs::read(target.root.path().join("large")).unwrap(),
        b"original"
    );
    assert_eq!(std::fs::read_dir(target.root.path()).unwrap().count(), 1);
    assert_eq!(target.faults.open_handles.load(Ordering::SeqCst), 0);
    source.engine.shutdown().await;
}

#[tokio::test]
async fn same_host_separate_leases_still_reject_self_copy_and_nested_targets() {
    let server = Server::start(true, Duration::ZERO).await;
    let from = server.open().await;
    let to = server.open_as(None).await;
    let files = Files::new(server.engine.clone(), 1);
    assert_ne!(from.id, to.id);
    for destination in ["/", "/tree/nested"] {
        let mut input = remote_input(&from.id, &["/tree"], destination);
        input.target_session_id = Some(to.id.clone());
        assert!(input.validate().is_ok());
        assert!(files.transfers.start_remote_copy(input).is_err());
    }
    assert!(files.transfers.list().unwrap().is_empty());
    server.engine.shutdown().await;
}

#[tokio::test]
async fn remote_copy_streams_named_file_and_preserves_source_bytes_mode_and_modified_time() {
    let server = Server::start(true, Duration::ZERO).await;
    let session = server.open().await;
    let files = Files::new(server.engine.clone(), 1);
    std::fs::create_dir(server.root.path().join("dest")).unwrap();
    let source = server.root.path().join("中文;$(id).bin");
    let content: Vec<_> = (0..100_123).map(|i| (i % 251) as u8).collect();
    std::fs::write(&source, &content).unwrap();
    let modified = std::time::UNIX_EPOCH + Duration::from_secs(1_600_000_000);
    std::fs::File::options()
        .write(true)
        .open(&source)
        .unwrap()
        .set_modified(modified)
        .unwrap();
    let mut input = remote_input(&session.id, &["/中文;$(id).bin"], "/dest/");
    input.name = Some("副本.bin".into());
    let task = files.transfers.start_remote_copy(input).unwrap();
    let info = finished(&files, &task.id).await;
    assert_eq!(info.state, "completed", "{:?}", info.message);
    assert!(info.remote_copy);
    assert_eq!(info.remote_name.as_deref(), Some("副本.bin"));
    assert_eq!(
        (
            info.total_bytes,
            info.transferred_bytes,
            info.files_total,
            info.files_done
        ),
        (content.len() as u64, content.len() as u64, 1, 1)
    );
    let target = server.root.path().join("dest/副本.bin");
    assert_eq!(std::fs::read(&target).unwrap(), content);
    assert_eq!(std::fs::read(&source).unwrap(), content);
    assert_eq!(
        std::fs::metadata(target).unwrap().modified().unwrap(),
        modified
    );
    assert_eq!(
        files
            .properties(&session.id, "/dest/副本.bin")
            .await
            .unwrap()
            .permissions,
        Some(0o600)
    );
    assert_eq!(server.faults.open_handles.load(Ordering::SeqCst), 0);
    assert_eq!(std::fs::read_dir(server.root.path()).unwrap().count(), 2);
    server.engine.shutdown().await;
}

#[tokio::test]
async fn remote_recursive_copy_preserves_empty_directories_skips_links_and_keeps_totals() {
    let server = Server::start(true, Duration::ZERO).await;
    let session = server.open().await;
    let files = Files::new(server.engine.clone(), 1);
    std::fs::create_dir_all(server.root.path().join("tree/empty")).unwrap();
    std::fs::create_dir(server.root.path().join("dest")).unwrap();
    std::fs::write(server.root.path().join("tree/a"), b"alpha").unwrap();
    std::fs::write(server.root.path().join("tree/b"), b"beta").unwrap();
    std::fs::write(server.root.path().join("tree/link"), b"link placeholder").unwrap();
    server
        .faults
        .links
        .lock()
        .unwrap()
        .insert("/tree/link".into(), "/tree".into());
    let task = files
        .transfers
        .start_remote_copy(remote_input(&session.id, &["/tree"], "/dest"))
        .unwrap();
    let info = finished(&files, &task.id).await;
    assert_eq!(info.state, "completed", "{:?}", info.message);
    assert_eq!(
        (
            info.files_total,
            info.files_done,
            info.skipped,
            info.total_bytes
        ),
        (5, 4, 1, 9)
    );
    assert!(server.root.path().join("dest/tree/empty").is_dir());
    assert!(!server.root.path().join("dest/tree/link").exists());
    assert_eq!(
        std::fs::read(server.root.path().join("dest/tree/a")).unwrap(),
        b"alpha"
    );
    assert_eq!(
        std::fs::read(server.root.path().join("dest/tree/b")).unwrap(),
        b"beta"
    );
    assert_eq!(server.faults.open_handles.load(Ordering::SeqCst), 0);
    server.engine.shutdown().await;
}

#[tokio::test]
async fn remote_directory_merge_replaces_confirmed_files_and_preserves_unrelated_target_entries() {
    let server = Server::start(true, Duration::ZERO).await;
    let session = server.open().await;
    let files = Files::new(server.engine.clone(), 1);
    for directory in ["tree", "dest/tree"] {
        std::fs::create_dir_all(server.root.path().join(directory)).unwrap();
    }
    for (name, bytes) in [
        ("tree/a", &b"new"[..]),
        ("tree/b", &b"added"[..]),
        ("dest/tree/a", &b"old"[..]),
        ("dest/tree/keep", &b"retain"[..]),
    ] {
        std::fs::write(server.root.path().join(name), bytes).unwrap();
    }
    let mut input = remote_input(&session.id, &["/tree"], "/dest");
    input.conflict = ConflictPolicy::Overwrite;
    input.confirm_overwrite = true;
    let task = files.transfers.start_remote_copy(input).unwrap();
    let info = finished(&files, &task.id).await;
    assert_eq!(info.state, "completed", "{:?}", info.message);
    for (name, bytes) in [
        ("dest/tree/a", &b"new"[..]),
        ("dest/tree/b", &b"added"[..]),
        ("dest/tree/keep", &b"retain"[..]),
    ] {
        assert_eq!(std::fs::read(server.root.path().join(name)).unwrap(), bytes);
    }
    assert!(
        server
            .faults
            .property_writes
            .lock()
            .unwrap()
            .iter()
            .all(|(path, _)| path != "/dest/tree")
    );
    assert!(server.root.path().join("tree/a").exists());
    server.engine.shutdown().await;
}

#[tokio::test]
async fn remote_conflicts_are_preflighted_and_skip_or_confirmed_overwrite_are_explicit() {
    let server = Server::start(true, Duration::ZERO).await;
    let session = server.open().await;
    let files = Files::new(server.engine.clone(), 1);
    std::fs::create_dir(server.root.path().join("dest")).unwrap();
    std::fs::write(server.root.path().join("a"), b"new a").unwrap();
    std::fs::write(server.root.path().join("b"), b"new b").unwrap();
    std::fs::write(server.root.path().join("dest/b"), b"original").unwrap();
    let task = files
        .transfers
        .start_remote_copy(remote_input(&session.id, &["/a", "/b"], "/dest"))
        .unwrap();
    assert_eq!(finished(&files, &task.id).await.state, "failed");
    assert!(server.root.path().join("a").exists());
    assert!(!server.root.path().join("dest/a").exists());
    let mut input = remote_input(&session.id, &["/a", "/b"], "/dest");
    input.conflict = ConflictPolicy::Skip;
    let task = files.transfers.start_remote_copy(input).unwrap();
    let info = finished(&files, &task.id).await;
    assert_eq!(info.state, "completed", "{:?}", info.message);
    assert_eq!((info.files_done, info.skipped), (1, 1));
    assert_eq!(
        std::fs::read(server.root.path().join("dest/b")).unwrap(),
        b"original"
    );
    let mut input = remote_input(&session.id, &["/b"], "/dest");
    let conflict = files.transfers.start_remote_copy(input.clone()).unwrap();
    assert_eq!(finished(&files, &conflict.id).await.state, "failed");
    assert!(
        files
            .transfers
            .retry(&conflict.id, &session.id, ConflictPolicy::Rename, false)
            .is_err()
    );
    input.conflict = ConflictPolicy::Overwrite;
    input.confirm_overwrite = true;
    let task = files.transfers.start_remote_copy(input).unwrap();
    let info = finished(&files, &task.id).await;
    assert_eq!(info.state, "completed", "{:?}", info.message);
    assert_eq!(
        std::fs::read(server.root.path().join("dest/b")).unwrap(),
        b"new b"
    );
    assert!(server.root.path().join("b").exists());
    server.engine.shutdown().await;
}

#[tokio::test]
async fn remote_copy_cancellation_drains_handles_and_preserves_original_and_target() {
    let server = Server::start(true, Duration::from_millis(15)).await;
    let session = server.open().await;
    let files = Files::new(server.engine.clone(), 1);
    std::fs::create_dir(server.root.path().join("dest")).unwrap();
    let original = vec![7u8; 12 * 1024 * 1024];
    std::fs::write(server.root.path().join("large"), &original).unwrap();
    std::fs::write(server.root.path().join("dest/large"), b"keep target").unwrap();
    let mut input = remote_input(&session.id, &["/large"], "/dest");
    input.conflict = ConflictPolicy::Overwrite;
    input.confirm_overwrite = true;
    let task = files.transfers.start_remote_copy(input).unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        while files
            .transfers
            .list()
            .unwrap()
            .iter()
            .find(|info| info.id == task.id)
            .unwrap()
            .transferred_bytes
            == 0
        {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    files.transfers.cancel(&task.id).unwrap();
    let info = finished(&files, &task.id).await;
    assert_eq!(info.state, "cancelled", "{:?}", info.message);
    assert_eq!(
        std::fs::read(server.root.path().join("large")).unwrap(),
        original
    );
    assert_eq!(
        std::fs::read(server.root.path().join("dest/large")).unwrap(),
        b"keep target"
    );
    assert_eq!(
        std::fs::read_dir(server.root.path().join("dest"))
            .unwrap()
            .count(),
        1
    );
    assert_eq!(server.faults.open_handles.load(Ordering::SeqCst), 0);
    server.engine.shutdown().await;
}

#[tokio::test]
async fn remote_copy_rejects_link_targets_and_non_atomic_overwrite_without_losing_data() {
    let server = Server::start(false, Duration::ZERO).await;
    let session = server.open().await;
    let files = Files::new(server.engine.clone(), 1);
    std::fs::create_dir(server.root.path().join("dest")).unwrap();
    std::fs::write(server.root.path().join("file"), b"source").unwrap();
    std::fs::write(server.root.path().join("dest/file"), b"original").unwrap();
    let mut input = remote_input(&session.id, &["/file"], "/dest");
    input.conflict = ConflictPolicy::Overwrite;
    input.confirm_overwrite = true;
    let task = files.transfers.start_remote_copy(input).unwrap();
    assert_eq!(finished(&files, &task.id).await.state, "failed");
    server
        .faults
        .links
        .lock()
        .unwrap()
        .insert("/alias".into(), "/dest".into());
    let task = files
        .transfers
        .start_remote_copy(remote_input(&session.id, &["/file"], "/alias"))
        .unwrap();
    assert_eq!(finished(&files, &task.id).await.state, "failed");
    assert_eq!(
        std::fs::read(server.root.path().join("dest/file")).unwrap(),
        b"original"
    );
    assert_eq!(
        std::fs::read(server.root.path().join("file")).unwrap(),
        b"source"
    );
    server.engine.shutdown().await;
}

#[tokio::test]
async fn remote_copy_retry_preserves_original_target_name() {
    let server = Server::start(true, Duration::ZERO).await;
    let session = server.open().await;
    let files = Files::new(server.engine.clone(), 1);
    std::fs::create_dir(server.root.path().join("dest")).unwrap();
    std::fs::write(server.root.path().join("file"), b"retry bytes").unwrap();
    server.faults.reject_writes.store(true, Ordering::SeqCst);
    let mut input = remote_input(&session.id, &["/file"], "/dest");
    input.name = Some("custom".into());
    let original = files.transfers.start_remote_copy(input).unwrap();
    assert_eq!(finished(&files, &original.id).await.state, "failed");
    server.faults.reject_writes.store(false, Ordering::SeqCst);
    let retried = files
        .transfers
        .retry(&original.id, &session.id, ConflictPolicy::Fail, false)
        .unwrap();
    let info = finished(&files, &retried.id).await;
    assert_eq!(info.state, "completed", "{:?}", info.message);
    assert!(info.remote_copy);
    assert_eq!(info.remote_name.as_deref(), Some("custom"));
    assert_eq!(
        std::fs::read(server.root.path().join("dest/custom")).unwrap(),
        b"retry bytes"
    );
    assert!(!server.root.path().join("dest/file").exists());
    server.engine.shutdown().await;
}
