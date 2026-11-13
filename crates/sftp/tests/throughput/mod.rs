use super::*;
use russh_sftp::{
    client::RawSftpSession,
    protocol::{FileAttributes, OpenFlags},
};
use std::sync::atomic::Ordering;

async fn delayed_file_page_transfer(direction: Direction) {
    let server = Server::start(true, Duration::ZERO).await;
    server.faults.wire_delay_ms.store(10, Ordering::SeqCst);
    let session = server.open().await;
    let files = Files::new(server.engine.clone(), 1);
    let local = tempfile::tempdir().unwrap();
    // Include a partial final block; more than one window must be refilled.
    let bytes: Vec<u8> = (0..4 * 1024 * 1024 + 17).map(|n| (n % 251) as u8).collect();
    let (source, destination, target) = if direction == Direction::Upload {
        let source = local.path().join("payload.bin");
        std::fs::write(&source, &bytes).unwrap();
        (
            path(&source),
            "/".into(),
            server.root.path().join("payload.bin"),
        )
    } else {
        std::fs::write(server.root.path().join("payload.bin"), &bytes).unwrap();
        (
            "/payload.bin".into(),
            path(local.path()),
            local.path().join("payload.bin"),
        )
    };
    // Measure actual serialized requests on the same connection. This avoids assuming
    // timer precision or ignoring debug-build CPU overhead in a wall-clock threshold.
    let channel = server.engine.open_sftp_channel(&session.id).await.unwrap();
    let raw = RawSftpSession::new(channel.channel.into_stream());
    raw.init().await.unwrap();
    let handle = if direction == Direction::Upload {
        raw.open(
            "/serial.bin",
            OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::EXCLUDE,
            FileAttributes::default(),
        )
        .await
        .unwrap()
        .handle
    } else {
        raw.open("/payload.bin", OpenFlags::READ, FileAttributes::default())
            .await
            .unwrap()
            .handle
    };
    let started = std::time::Instant::now();
    for (block, chunk) in bytes.chunks(32768).enumerate() {
        let offset = (block * 32768) as u64;
        if direction == Direction::Upload {
            raw.write(&handle, offset, chunk.to_vec()).await.unwrap();
        } else {
            assert_eq!(
                raw.read(&handle, offset, chunk.len() as u32)
                    .await
                    .unwrap()
                    .data,
                chunk
            );
        }
    }
    let serial = started.elapsed();
    raw.close(handle).await.unwrap();
    let started = std::time::Instant::now();
    let task = files
        .transfers
        .start(input(
            &session.id,
            direction,
            vec![source],
            destination,
            ConflictPolicy::Fail,
        ))
        .unwrap();
    let done = finished(&files, &task.id).await;
    let elapsed = started.elapsed();
    assert_eq!(done.state, "completed", "{done:?}");
    assert_eq!(done.transferred_bytes, bytes.len() as u64);
    assert_eq!(done.remaining_bytes, 0);
    assert_eq!(std::fs::read(target).unwrap(), bytes);
    assert_eq!(server.faults.open_handles.load(Ordering::SeqCst), 0);
    eprintln!("file page {direction:?}: {elapsed:?}, serialized requests={serial:?}");
    assert!(
        elapsed < serial.mul_f64(0.7),
        "file page {direction:?} must overlap requests, including verification: {elapsed:?} vs {serial:?}"
    );
    files.shutdown().await;
    server.engine.shutdown().await;
}

#[tokio::test]
async fn upload_overlaps_round_trips_and_verifies_the_partial_last_block() {
    delayed_file_page_transfer(Direction::Upload).await;
}

#[tokio::test]
async fn download_overlaps_round_trips_and_verifies_the_partial_last_block() {
    delayed_file_page_transfer(Direction::Download).await;
}

#[tokio::test]
async fn cancelling_a_full_window_or_checksum_preserves_targets_and_closes_handles() {
    for direction in [Direction::Upload, Direction::Download] {
        for state in ["running", "verifying"] {
            let server = Server::start(true, Duration::ZERO).await;
            server.faults.wire_delay_ms.store(20, Ordering::SeqCst);
            let session = server.open().await;
            let files = Files::new(server.engine.clone(), 1);
            let local = tempfile::tempdir().unwrap();
            let local_file = local.path().join("payload.bin");
            let remote_file = server.root.path().join("payload.bin");
            let bytes = vec![42; 8 * 1024 * 1024];
            let (source, destination, target) = if direction == Direction::Upload {
                std::fs::write(&local_file, &bytes).unwrap();
                std::fs::write(&remote_file, b"preserve existing target").unwrap();
                (path(&local_file), "/".into(), remote_file)
            } else {
                std::fs::write(&remote_file, &bytes).unwrap();
                std::fs::write(&local_file, b"preserve existing target").unwrap();
                ("/payload.bin".into(), path(local.path()), local_file)
            };
            let task = files
                .transfers
                .start(input(
                    &session.id,
                    direction,
                    vec![source],
                    destination,
                    ConflictPolicy::Overwrite,
                ))
                .unwrap();
            tokio::time::timeout(Duration::from_secs(10), async {
                loop {
                    let info = files.transfers.list().unwrap().pop().unwrap();
                    assert!(info.unfinished(), "missed {direction:?} {state}: {info:?}");
                    if info.state == state && info.transferred_bytes > 0 {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(1)).await;
                }
            })
            .await
            .unwrap();
            files.transfers.cancel(&task.id).unwrap();
            let done = finished(&files, &task.id).await;
            assert_eq!(done.state, "cancelled", "{direction:?} {state}: {done:?}");
            assert!(done.recovery_paths.is_empty(), "{done:?}");
            assert_eq!(std::fs::read(target).unwrap(), b"preserve existing target");
            assert_eq!(server.faults.open_handles.load(Ordering::SeqCst), 0);
            assert_eq!(std::fs::read_dir(server.root.path()).unwrap().count(), 1);
            assert_eq!(std::fs::read_dir(local.path()).unwrap().count(), 1);
            files.list(&session.id, "/").await.unwrap();
            files.shutdown().await;
            server.engine.shutdown().await;
        }
    }
}

#[tokio::test]
async fn rejected_writes_and_corrupt_readback_never_commit_or_leak_handles() {
    for reject_writes in [true, false] {
        let server = Server::start(true, Duration::ZERO).await;
        server.faults.wire_delay_ms.store(10, Ordering::SeqCst);
        server
            .faults
            .reject_writes
            .store(reject_writes, Ordering::SeqCst);
        server
            .faults
            .corrupt_reads
            .store(!reject_writes, Ordering::SeqCst);
        let session = server.open().await;
        let files = Files::new(server.engine.clone(), 1);
        let local = tempfile::tempdir().unwrap();
        let source = local.path().join("payload.bin");
        std::fs::write(&source, vec![42; 2 * 1024 * 1024 + 7]).unwrap();
        let target = server.root.path().join("payload.bin");
        std::fs::write(&target, b"keep").unwrap();
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
        let done = finished(&files, &task.id).await;
        assert_eq!(done.state, "failed", "{done:?}");
        assert!(done.message.as_deref().unwrap().contains(if reject_writes {
            "权限"
        } else {
            "SHA-256"
        }));
        assert!(done.recovery_paths.is_empty(), "{done:?}");
        assert_eq!(std::fs::read(target).unwrap(), b"keep");
        assert_eq!(server.faults.open_handles.load(Ordering::SeqCst), 0);
        assert_eq!(std::fs::read_dir(server.root.path()).unwrap().count(), 1);
        files.shutdown().await;
        server.engine.shutdown().await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "manual release throughput measurement over loopback SSH and real temporary files"]
async fn large_file_throughput() {
    let server = Server::start(true, Duration::ZERO).await;
    let session = server.open().await;
    let files = Files::new(server.engine.clone(), 1);
    let source = tempfile::tempdir().unwrap();
    let destination = tempfile::tempdir().unwrap();
    let bytes: Vec<u8> = (0..128 * 1024 * 1024).map(|n| (n % 251) as u8).collect();
    let source_file = source.path().join("payload.bin");
    std::fs::write(&source_file, &bytes).unwrap();
    for direction in [Direction::Upload, Direction::Download] {
        let (source, destination) = if direction == Direction::Upload {
            (path(&source_file), "/".into())
        } else {
            ("/payload.bin".into(), path(destination.path()))
        };
        let started = std::time::Instant::now();
        let task = files
            .transfers
            .start(input(
                &session.id,
                direction,
                vec![source],
                destination,
                ConflictPolicy::Fail,
            ))
            .unwrap();
        let mut data_phase = None;
        let done = tokio::time::timeout(Duration::from_secs(60), async {
            loop {
                let info = files
                    .transfers
                    .list()
                    .unwrap()
                    .into_iter()
                    .find(|t| t.id == task.id)
                    .unwrap();
                if info.state == "verifying" && data_phase.is_none() {
                    data_phase = Some(started.elapsed());
                }
                if !info.unfinished() {
                    break info;
                }
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
        })
        .await
        .unwrap();
        assert_eq!(done.state, "completed", "{done:?}");
        let total = started.elapsed();
        let data_phase = data_phase.unwrap();
        eprintln!(
            "128 MiB loopback {direction:?}: data phase={data_phase:?} ({:.1} MB/s); including SHA-256 and commit={total:?} ({:.1} MB/s)",
            bytes.len() as f64 / data_phase.as_secs_f64() / 1_000_000.0,
            bytes.len() as f64 / total.as_secs_f64() / 1_000_000.0
        );
    }
    assert_eq!(
        std::fs::read(server.root.path().join("payload.bin")).unwrap(),
        bytes
    );
    assert_eq!(
        std::fs::read(destination.path().join("payload.bin")).unwrap(),
        bytes
    );
    files.shutdown().await;
    server.engine.shutdown().await;
}
