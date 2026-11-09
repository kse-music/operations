use super::support::Server;
use serverdeck_core::{IpcError, files::*};
use serverdeck_sftp::Files;
use std::{path::Path, time::Duration};

async fn downloaded(files: &Files, token: &ExternalDocument) {
    tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            let task = files
                .transfers
                .list()
                .unwrap()
                .into_iter()
                .find(|task| task.id == token.transfer_id)
                .unwrap();
            if !task.unfinished() {
                assert_eq!(task.state, "completed", "{:?}", task.message);
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn external_binary_roundtrip_requires_confirmation_preserves_metadata_and_detects_conflicts()
{
    let server = Server::start(true, Duration::ZERO).await;
    let session = server.open().await;
    let files = Files::new(server.engine.clone(), 3);
    let local = tempfile::tempdir().unwrap();
    let path = server.root.path().join("中文 config.ini");
    let original = b"[server]\r\nname=\xd6\xd0\xce\xc4\0\xff";
    tokio::fs::write(&path, original).await.unwrap();
    assert_eq!(
        IpcError::from(
            files
                .read_text(&session.id, "/中文 config.ini")
                .await
                .unwrap_err()
        )
        .code,
        "TEXT_BINARY"
    );
    let external = files
        .prepare_external(&session.id, "/中文 config.ini", local.path())
        .await
        .unwrap();
    assert!(!external.ready);
    downloaded(&files, &external).await;
    let external = files.external_ready(&external.token).await.unwrap();
    assert!(external.ready);
    assert_eq!(
        tokio::fs::read(&external.local_path).await.unwrap(),
        original
    );
    assert_eq!(files.dirty_count(), 1);
    assert!(files.has_external_editors().unwrap());
    assert!(files.editor_dirty(&external.token, false).is_err());
    assert_eq!(files.dirty_count(), 1);
    assert!(files.close(&session.id, false).await.is_err());
    assert!(files.check_user_switch(&session.id).is_err());
    let edited = b"[server]\r\nname=\xb2\xe2\xca\xd4\0\xff";
    tokio::fs::write(&external.local_path, edited)
        .await
        .unwrap();
    assert!(
        files
            .save_external(external.token.clone(), false)
            .await
            .is_err()
    );
    assert_eq!(tokio::fs::read(&path).await.unwrap(), original);
    assert!(
        files
            .save_text(SaveText {
                token: external.token.clone(),
                content: "bypass".into(),
                confirm_replace: true
            })
            .await
            .is_err()
    );
    let result = files
        .save_external(external.token.clone(), true)
        .await
        .unwrap()
        .document
        .unwrap();
    assert_eq!(tokio::fs::read(&path).await.unwrap(), edited);
    assert_eq!(result.permissions, Some(0o600));
    assert_eq!(result.uid, Some(1000));
    assert_eq!(result.gid, Some(1000));
    assert_eq!(
        files.dirty_count(),
        1,
        "an external app may edit again after upload"
    );
    tokio::fs::write(&external.local_path, b"second edit")
        .await
        .unwrap();
    files
        .save_external(external.token.clone(), true)
        .await
        .unwrap()
        .document
        .unwrap();
    assert_eq!(tokio::fs::read(&path).await.unwrap(), b"second edit");
    let mtime = std::fs::metadata(&path).unwrap().modified().unwrap();
    tokio::fs::write(&path, b"other bytes").await.unwrap();
    std::fs::File::options()
        .write(true)
        .open(&path)
        .unwrap()
        .set_times(std::fs::FileTimes::new().set_modified(mtime))
        .unwrap();
    tokio::fs::write(&external.local_path, b"must not overwrite")
        .await
        .unwrap();
    assert_eq!(
        IpcError::from(
            files
                .save_external(external.token.clone(), true)
                .await
                .unwrap_err()
        )
        .code,
        "EDITOR_CONFLICT"
    );
    assert_eq!(tokio::fs::read(&path).await.unwrap(), b"other bytes");
    assert!(files.close_editor(&external.token, false).is_err());
    files.close_editor(&external.token, true).unwrap();
    assert_eq!(files.dirty_count(), 0);
    assert!(!files.has_external_editors().unwrap());
    assert_eq!(
        tokio::fs::read(&external.local_path).await.unwrap(),
        b"must not overwrite"
    );
    files.shutdown().await;
    server.engine.shutdown().await;
}

#[tokio::test]
async fn external_large_files_stream_and_failures_keep_both_original_and_local_copy() {
    let server = Server::start(true, Duration::ZERO).await;
    let session = server.open().await;
    let files = Files::new(server.engine.clone(), 3);
    let local = tempfile::tempdir().unwrap();
    let path = server.root.path().join("binary.dat");
    let bytes = vec![0xff; TEXT_LIMIT + 1];
    tokio::fs::write(&path, &bytes).await.unwrap();
    let external = files
        .prepare_external(&session.id, "/binary.dat", local.path())
        .await
        .unwrap();
    downloaded(&files, &external).await;
    files.external_ready(&external.token).await.unwrap();
    tokio::fs::write(&external.local_path, b"new\0bytes")
        .await
        .unwrap();
    server
        .faults
        .reject_writes
        .store(true, std::sync::atomic::Ordering::SeqCst);
    assert!(
        files
            .save_external(external.token.clone(), true)
            .await
            .is_err()
    );
    assert_eq!(tokio::fs::read(&path).await.unwrap(), bytes);
    assert_eq!(
        tokio::fs::read(&external.local_path).await.unwrap(),
        b"new\0bytes"
    );
    assert_eq!(
        server
            .faults
            .open_handles
            .load(std::sync::atomic::Ordering::SeqCst),
        0
    );
    server
        .faults
        .reject_writes
        .store(false, std::sync::atomic::Ordering::SeqCst);
    files
        .save_external(external.token.clone(), true)
        .await
        .unwrap()
        .document
        .unwrap();
    assert_eq!(tokio::fs::read(&path).await.unwrap(), b"new\0bytes");
    // Replacing the local file with a directory is never followed or uploaded.
    tokio::fs::remove_file(&external.local_path).await.unwrap();
    tokio::fs::create_dir(&external.local_path).await.unwrap();
    assert!(
        files
            .save_external(external.token.clone(), true)
            .await
            .is_err()
    );
    assert_eq!(tokio::fs::read(&path).await.unwrap(), b"new\0bytes");
    files.close_editor(&external.token, true).unwrap();
    files.shutdown().await;
    server.engine.shutdown().await;
}

#[tokio::test]
async fn external_download_snapshot_and_atomic_capability_are_enforced() {
    let server = Server::start(false, Duration::ZERO).await;
    let session = server.open().await;
    let files = Files::new(server.engine.clone(), 3);
    let local = tempfile::tempdir().unwrap();
    let path = server.root.path().join("file.ini");
    tokio::fs::write(&path, b"\xffkeep").await.unwrap();
    let external = files
        .prepare_external(&session.id, "/file.ini", local.path())
        .await
        .unwrap();
    downloaded(&files, &external).await;
    let ready = files.external_ready(&external.token).await.unwrap();
    assert!(!ready.atomic_save);
    tokio::fs::write(&ready.local_path, b"new").await.unwrap();
    assert_eq!(
        IpcError::from(
            files
                .save_external(ready.token.clone(), true)
                .await
                .unwrap_err()
        )
        .code,
        "SFTP_ATOMIC_UNSUPPORTED"
    );
    assert_eq!(tokio::fs::read(&path).await.unwrap(), b"\xffkeep");
    files.close_editor(&ready.token, true).unwrap();
    let second = tempfile::tempdir().unwrap();
    let external = files
        .prepare_external(&session.id, "/file.ini", second.path())
        .await
        .unwrap();
    downloaded(&files, &external).await;
    tokio::fs::write(&path, b"changed").await.unwrap();
    assert_eq!(
        IpcError::from(files.external_ready(&external.token).await.unwrap_err()).code,
        "EDITOR_CONFLICT"
    );
    assert!(Path::new(&external.local_path).is_file());
    files.close_editor(&external.token, true).unwrap();
    assert!(
        files
            .prepare_external(&session.id, "/", local.path())
            .await
            .is_err()
    );
    assert!(
        files
            .prepare_external(&session.id, "/../file.ini", local.path())
            .await
            .is_err()
    );
    files.shutdown().await;
    server.engine.shutdown().await;
}

#[tokio::test]
async fn cancelling_external_upload_keeps_original_and_allows_retry() {
    let server = Server::start(true, Duration::from_millis(5)).await;
    let session = server.open().await;
    let files = Files::new(server.engine.clone(), 3);
    let local = tempfile::tempdir().unwrap();
    let original = vec![0; 512 * 1024];
    let path = server.root.path().join("cancel.bin");
    tokio::fs::write(&path, &original).await.unwrap();
    let external = files
        .prepare_external(&session.id, "/cancel.bin", local.path())
        .await
        .unwrap();
    downloaded(&files, &external).await;
    files.external_ready(&external.token).await.unwrap();
    let edited = vec![1; original.len()];
    tokio::fs::write(&external.local_path, &edited)
        .await
        .unwrap();
    let copy = files.clone();
    let token = external.token.clone();
    let uploading = tokio::spawn(async move { copy.save_external(token, true).await });
    tokio::time::sleep(Duration::from_millis(20)).await;
    files.cancel_external_save(&external.token).unwrap();
    assert_eq!(
        IpcError::from(uploading.await.unwrap().unwrap_err()).code,
        "EDITOR_CANCELLED"
    );
    assert_eq!(tokio::fs::read(&path).await.unwrap(), original);
    assert_eq!(tokio::fs::read(&external.local_path).await.unwrap(), edited);
    files
        .save_external(external.token.clone(), true)
        .await
        .unwrap()
        .document
        .unwrap();
    assert_eq!(tokio::fs::read(&path).await.unwrap(), edited);
    let after_reload = vec![2; edited.len()];
    tokio::fs::write(&external.local_path, &after_reload)
        .await
        .unwrap();
    let copy = files.clone();
    let token = external.token.clone();
    let uploading = tokio::spawn(async move { copy.save_external(token, true).await });
    tokio::time::sleep(Duration::from_millis(20)).await;
    files.reset_editors();
    assert_eq!(
        IpcError::from(uploading.await.unwrap().unwrap_err()).code,
        "EDITOR_CANCELLED"
    );
    assert_eq!(files.dirty_count(), 0);
    assert!(!files.has_external_editors().unwrap());
    assert_eq!(tokio::fs::read(&path).await.unwrap(), edited);
    assert_eq!(
        tokio::fs::read(&external.local_path).await.unwrap(),
        after_reload
    );
    assert!(
        files
            .save_external(external.token.clone(), true)
            .await
            .is_err()
    );
    files.shutdown().await;
    server.engine.shutdown().await;
}
