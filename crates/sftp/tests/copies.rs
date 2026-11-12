#[allow(dead_code)] // Shared protocol fixture also exposes desktop-only operations.
mod support;
use serverdeck_core::Error;
use serverdeck_sftp::{CopyGuard, CopyHandle, CopySource, Files};
use sha2::{Digest, Sha256};
use std::{
    future::Future,
    pin::Pin,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use support::Server;

struct Guard {
    checks: AtomicUsize,
    reject: usize,
}
impl CopyGuard for Guard {
    fn check(&self) -> Pin<Box<dyn Future<Output = Result<(), Error>> + Send + '_>> {
        Box::pin(async move {
            if self.checks.fetch_add(1, Ordering::SeqCst) >= self.reject {
                Err(Error::Conflict)
            } else {
                Ok(())
            }
        })
    }
}
fn guard(reject: usize) -> Arc<Guard> {
    Arc::new(Guard {
        checks: AtomicUsize::new(0),
        reject,
    })
}
async fn finished(job: &CopyHandle) -> serverdeck_core::files::TransferInfo {
    tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            let info = job.info().unwrap();
            if !info.unfinished() {
                return info;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap()
}
fn local(path: &std::path::Path) -> CopySource {
    CopySource::Local {
        path: path.to_str().unwrap().into(),
    }
}

#[tokio::test]
async fn transfer_preflight_identifies_missing_source_and_destination_without_writing() {
    let source = Server::start(true, Duration::ZERO).await;
    let target = Server::start_shared(
        true,
        Duration::ZERO,
        Some((source.database.clone(), source.engine.clone())),
    )
    .await;
    let src = source.open().await;
    let dst = target.open().await;
    let files = Files::new(source.engine.clone(), 3);
    let bytes = vec![b'x'; 131072];
    std::fs::write(source.root.path().join("image.tar"), &bytes).unwrap();
    std::fs::write(target.root.path().join("existing.tar"), "do not replace").unwrap();
    for (path, directory, expected) in [
        (
            "/image.tar",
            "/new-image.tar",
            "TRANSFER_DIRECTORY_NOT_FOUND",
        ),
        ("/missing.tar", "/", "TRANSFER_SOURCE_NOT_FOUND"),
        ("/image.tar", "/existing.tar", "TRANSFER_DIRECTORY_REQUIRED"),
    ] {
        let error = files
            .transfers
            .prepare_copy(
                CopySource::Remote {
                    session: src.id.clone(),
                    path: path.into(),
                },
                &dst.id,
                directory,
                false,
            )
            .await
            .err()
            .expect("preflight must fail");
        assert!(
            matches!(&error, Error::Connection { code, .. } if *code == expected),
            "{error:?}"
        );
        if expected.ends_with("NOT_FOUND") {
            let cause = std::error::Error::source(&error).unwrap();
            assert!(cause.to_string().contains("不存在"));
            assert!(
                cause.source().is_some(),
                "original SFTP cause must be retained"
            );
        }
        assert!(files.transfers.list().unwrap().is_empty());
        assert!(!target.root.path().join("image.tar").exists());
        assert_eq!(
            std::fs::read_to_string(target.root.path().join("existing.tar")).unwrap(),
            "do not replace"
        );
    }
    // Correct only the directory, keeping the exact original source file.
    let plan = files
        .transfers
        .prepare_copy(
            CopySource::Remote {
                session: src.id.clone(),
                path: "/image.tar".into(),
            },
            &dst.id,
            "/",
            false,
        )
        .await
        .unwrap();
    assert_eq!(plan.destination, "/image.tar");
    let done = finished(
        &files
            .transfers
            .start_copy(plan.clone(), guard(usize::MAX))
            .unwrap(),
    )
    .await;
    assert_eq!(done.state, "completed", "{done:?}");
    assert_eq!(done.transferred_bytes, bytes.len() as u64);
    assert_eq!(
        std::fs::read(target.root.path().join("image.tar")).unwrap(),
        bytes
    );
    assert_eq!(
        plan.sha256().unwrap(),
        Some(format!("{:x}", Sha256::digest(&bytes)))
    );
    assert_eq!(
        std::fs::read(source.root.path().join("image.tar")).unwrap(),
        bytes
    );
    source.engine.shutdown().await;
}

#[tokio::test]
async fn local_upload_and_remote_relay_commit_verified_bytes_in_shared_queue() {
    let source = Server::start(true, Duration::ZERO).await;
    let target = Server::start_shared(
        true,
        Duration::ZERO,
        Some((source.database.clone(), source.engine.clone())),
    )
    .await;
    let src = source.open().await;
    let dst = target.open().await;
    let files = Files::new(source.engine.clone(), 3);
    let temp = tempfile::tempdir().unwrap();
    let input = temp.path().join("archive.tar.gz");
    let content = (0..200000).map(|i| (i % 251) as u8).collect::<Vec<_>>();
    std::fs::write(&input, &content).unwrap();
    for origin in [
        local(&input),
        CopySource::Remote {
            session: src.id.clone(),
            path: "/archive.tar.gz".into(),
        },
    ] {
        std::fs::write(source.root.path().join("archive.tar.gz"), &content).unwrap();
        let plan = files
            .transfers
            .prepare_copy(origin, &dst.id, "/", true)
            .await
            .unwrap();
        let frozen = plan.clone();
        let auth = guard(usize::MAX);
        let job = files.transfers.start_copy(plan, auth.clone()).unwrap();
        let done = finished(&job).await;
        assert_eq!(done.state, "completed", "{:?}", done.message);
        assert_eq!(done.transferred_bytes, content.len() as u64);
        assert_eq!(
            std::fs::read(target.root.path().join("archive.tar.gz")).unwrap(),
            content
        );
        assert_eq!(
            frozen.sha256().unwrap(),
            Some(format!("{:x}", Sha256::digest(&content)))
        );
        assert!(auth.checks.load(Ordering::SeqCst) >= 3);
        assert!(
            files
                .transfers
                .list()
                .unwrap()
                .iter()
                .any(|item| item.id == done.id)
        );
    }
    assert!(
        !std::fs::read_dir(target.root.path()).unwrap().any(|e| e
            .unwrap()
            .file_name()
            .to_string_lossy()
            .ends_with(".part"))
    );
    source.engine.shutdown().await;
}

#[tokio::test]
async fn frozen_source_target_and_overwrite_policy_prevent_unapproved_changes() {
    let server = Server::start(true, Duration::ZERO).await;
    let session = server.open().await;
    let files = Files::new(server.engine.clone(), 3);
    let temp = tempfile::tempdir().unwrap();
    let input = temp.path().join("x.yaml");
    std::fs::write(&input, "original").unwrap();
    std::fs::create_dir(server.root.path().join("work")).unwrap();
    let trailing = files
        .transfers
        .prepare_copy(local(&input), &session.id, "/work/", false)
        .await
        .unwrap();
    assert_eq!(trailing.destination, "/work/x.yaml");
    let plan = files
        .transfers
        .prepare_copy(local(&input), &session.id, "/", false)
        .await
        .unwrap();
    std::fs::write(&input, "source changed").unwrap();
    let done = finished(
        &files
            .transfers
            .start_copy(plan.clone(), guard(usize::MAX))
            .unwrap(),
    )
    .await;
    assert_eq!(done.state, "failed");
    assert!(!plan.may_have_committed());
    assert!(!server.root.path().join("x.yaml").exists());
    let plan = files
        .transfers
        .prepare_copy(local(&input), &session.id, "/", false)
        .await
        .unwrap();
    std::fs::write(server.root.path().join("x.yaml"), "other writer").unwrap();
    assert_eq!(
        finished(&files.transfers.start_copy(plan, guard(usize::MAX)).unwrap())
            .await
            .state,
        "failed"
    );
    assert_eq!(
        std::fs::read_to_string(server.root.path().join("x.yaml")).unwrap(),
        "other writer"
    );
    assert!(
        files
            .transfers
            .prepare_copy(local(&input), &session.id, "/", false)
            .await
            .is_err()
    );
    assert!(
        files
            .transfers
            .prepare_copy(local(temp.path()), &session.id, "/", true)
            .await
            .is_err()
    );
    server.engine.shutdown().await;
}

#[tokio::test]
async fn checksum_failure_revocation_and_cancel_preserve_existing_target() {
    let server = Server::start(true, Duration::from_millis(20)).await;
    let session = server.open().await;
    let files = Files::new(server.engine.clone(), 3);
    let temp = tempfile::tempdir().unwrap();
    let input = temp.path().join("data");
    std::fs::write(&input, vec![b'x'; 1024 * 1024]).unwrap();
    for scenario in 0..3 {
        std::fs::write(server.root.path().join("data"), "keep me").unwrap();
        let plan = files
            .transfers
            .prepare_copy(local(&input), &session.id, "/", true)
            .await
            .unwrap();
        server
            .faults
            .corrupt_reads
            .store(scenario == 0, Ordering::SeqCst);
        let job = files
            .transfers
            .start_copy(
                plan.clone(),
                guard(if scenario == 1 { 0 } else { usize::MAX }),
            )
            .unwrap();
        if scenario == 2 {
            job.cancel_and_wait().await.unwrap();
        }
        let done = finished(&job).await;
        assert_eq!(
            done.state,
            if scenario == 2 { "cancelled" } else { "failed" },
            "{:?}",
            done.message
        );
        assert!(!plan.may_have_committed());
        assert!(plan.sha256().unwrap().is_none());
        assert_eq!(
            std::fs::read_to_string(server.root.path().join("data")).unwrap(),
            "keep me"
        );
    }
    server.engine.shutdown().await;
}

#[tokio::test]
async fn no_atomic_overwrite_or_remote_link_is_accepted() {
    let server = Server::start(false, Duration::ZERO).await;
    let session = server.open().await;
    let files = Files::new(server.engine.clone(), 3);
    let temp = tempfile::tempdir().unwrap();
    let input = temp.path().join("data");
    std::fs::write(&input, "new").unwrap();
    std::fs::write(server.root.path().join("data"), "old").unwrap();
    assert!(
        files
            .transfers
            .prepare_copy(local(&input), &session.id, "/", true)
            .await
            .is_err()
    );
    server
        .faults
        .links
        .lock()
        .unwrap()
        .insert("/alias".into(), "/data".into());
    assert!(
        files
            .transfers
            .prepare_copy(
                CopySource::Remote {
                    session: session.id.clone(),
                    path: "/alias".into()
                },
                &session.id,
                "/",
                false
            )
            .await
            .is_err()
    );
    server.engine.shutdown().await;
}

#[tokio::test]
async fn post_commit_revocation_retains_an_explicit_uncertain_outcome_without_replay() {
    let server = Server::start(true, Duration::ZERO).await;
    let session = server.open().await;
    let files = Files::new(server.engine.clone(), 3);
    let temp = tempfile::tempdir().unwrap();
    let input = temp.path().join("data");
    std::fs::write(&input, "committed bytes").unwrap();
    let plan = files
        .transfers
        .prepare_copy(local(&input), &session.id, "/", false)
        .await
        .unwrap();
    let done = finished(&files.transfers.start_copy(plan.clone(), guard(2)).unwrap()).await;
    assert_eq!(done.state, "failed");
    assert!(plan.may_have_committed());
    assert!(plan.sha256().unwrap().is_none());
    assert_eq!(
        std::fs::read_to_string(server.root.path().join("data")).unwrap(),
        "committed bytes"
    );
    assert!(
        files
            .transfers
            .retry(
                &done.id,
                &session.id,
                serverdeck_core::files::ConflictPolicy::Fail,
                false
            )
            .is_err(),
        "native copies must be re-prepared, never replayed"
    );
    server.engine.shutdown().await;
}

#[tokio::test]
async fn pipelined_relay_beats_serial_round_trips_without_changing_verified_bytes() {
    use russh_sftp::{
        client::RawSftpSession,
        protocol::{FileAttributes, OpenFlags},
    };
    let source = Server::start(true, Duration::ZERO).await;
    let target = Server::start_shared(
        true,
        Duration::ZERO,
        Some((source.database.clone(), source.engine.clone())),
    )
    .await;
    source.faults.wire_delay_ms.store(10, Ordering::SeqCst);
    target.faults.wire_delay_ms.store(10, Ordering::SeqCst);
    let src = source.open().await;
    let dst = target.open().await;
    let bytes = (0..2 * 1024 * 1024)
        .map(|n| (n % 251) as u8)
        .collect::<Vec<_>>();
    std::fs::write(source.root.path().join("image.tar"), &bytes).unwrap();
    let input = source.engine.open_sftp_channel(&src.id).await.unwrap();
    let output = source.engine.open_sftp_channel(&dst.id).await.unwrap();
    let input = RawSftpSession::new(input.channel.into_stream());
    input.init().await.unwrap();
    let output = RawSftpSession::new(output.channel.into_stream());
    output.init().await.unwrap();
    let reader = input
        .open("/image.tar", OpenFlags::READ, FileAttributes::default())
        .await
        .unwrap()
        .handle;
    let writer = output
        .open(
            "/serial.tar",
            OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::EXCLUDE,
            FileAttributes::default(),
        )
        .await
        .unwrap()
        .handle;
    let started = std::time::Instant::now();
    for offset in (0..bytes.len()).step_by(32768) {
        let data = input
            .read(&reader, offset as u64, 32768)
            .await
            .unwrap()
            .data;
        output.write(&writer, offset as u64, data).await.unwrap();
    }
    let serial = started.elapsed();
    input.close(reader).await.unwrap();
    output.close(writer).await.unwrap();
    let files = Files::new(source.engine.clone(), 3);
    let plan = files
        .transfers
        .prepare_copy(
            CopySource::Remote {
                session: src.id.clone(),
                path: "/image.tar".into(),
            },
            &dst.id,
            "/",
            false,
        )
        .await
        .unwrap();
    let frozen = plan.clone();
    let started = std::time::Instant::now();
    let done = finished(&files.transfers.start_copy(plan, guard(usize::MAX)).unwrap()).await;
    let parallel = started.elapsed();
    assert_eq!(done.state, "completed", "{done:?}");
    assert_eq!(
        std::fs::read(target.root.path().join("image.tar")).unwrap(),
        bytes
    );
    assert_eq!(
        std::fs::read(target.root.path().join("serial.tar")).unwrap(),
        bytes
    );
    assert_eq!(
        frozen.sha256().unwrap(),
        Some(format!("{:x}", Sha256::digest(&bytes)))
    );
    eprintln!(
        "relay benchmark: {} bytes, 10 ms reply latency per endpoint; serial={serial:?}, pipelined={parallel:?}",
        bytes.len()
    );
    assert!(
        parallel.as_secs_f64() < serial.as_secs_f64() * 0.7,
        "bounded pipelining must reduce round-trip stalls: serial={serial:?}, parallel={parallel:?}"
    );
    source.engine.shutdown().await;
}

#[tokio::test]
async fn zero_length_metadata_must_not_silently_truncate_dynamic_source_bytes() {
    let source = Server::start(true, Duration::ZERO).await;
    let target = Server::start_shared(
        true,
        Duration::ZERO,
        Some((source.database.clone(), source.engine.clone())),
    )
    .await;
    let src = source.open().await;
    let dst = target.open().await;
    let files = Files::new(source.engine.clone(), 3);
    for (name, content, expected) in [
        ("empty", "", "completed"),
        ("dynamic", "actual bytes", "failed"),
    ] {
        std::fs::write(source.root.path().join(name), content).unwrap();
        source
            .faults
            .reported_sizes
            .lock()
            .unwrap()
            .insert(format!("/{name}"), 0);
        let plan = files
            .transfers
            .prepare_copy(
                CopySource::Remote {
                    session: src.id.clone(),
                    path: format!("/{name}"),
                },
                &dst.id,
                "/",
                false,
            )
            .await
            .unwrap();
        let frozen = plan.clone();
        let done = finished(&files.transfers.start_copy(plan, guard(usize::MAX)).unwrap()).await;
        assert_eq!(done.state, expected, "{done:?}");
        if expected == "completed" {
            assert!(
                std::fs::read(target.root.path().join(name))
                    .unwrap()
                    .is_empty()
            );
        } else {
            assert!(!target.root.path().join(name).exists());
            assert!(!frozen.may_have_committed());
        }
    }
    source.engine.shutdown().await;
}

#[tokio::test]
async fn cancelling_pipelined_readback_drains_handles_and_preserves_the_old_target() {
    let source = Server::start(true, Duration::ZERO).await;
    let target = Server::start_shared(
        true,
        Duration::from_millis(20),
        Some((source.database.clone(), source.engine.clone())),
    )
    .await;
    let src = source.open().await;
    let dst = target.open().await;
    std::fs::write(
        source.root.path().join("image.tar"),
        vec![b'x'; 1024 * 1024],
    )
    .unwrap();
    std::fs::write(target.root.path().join("image.tar"), "original").unwrap();
    let files = Files::new(source.engine.clone(), 3);
    let plan = files
        .transfers
        .prepare_copy(
            CopySource::Remote {
                session: src.id.clone(),
                path: "/image.tar".into(),
            },
            &dst.id,
            "/",
            true,
        )
        .await
        .unwrap();
    let frozen = plan.clone();
    let handle = files.transfers.start_copy(plan, guard(usize::MAX)).unwrap();
    tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            let state = handle.info().unwrap();
            if state.state == "verifying" {
                break;
            }
            assert!(state.unfinished(), "{state:?}");
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    handle.cancel_and_wait().await.unwrap();
    let state = handle.info().unwrap();
    assert_eq!(state.state, "cancelled", "{state:?}");
    assert!(!frozen.may_have_committed());
    assert_eq!(
        std::fs::read_to_string(target.root.path().join("image.tar")).unwrap(),
        "original"
    );
    assert!(
        !std::fs::read_dir(target.root.path())
            .unwrap()
            .any(|entry| entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .ends_with(".part"))
    );
    assert_eq!(target.faults.open_handles.load(Ordering::SeqCst), 0);
    assert_eq!(source.faults.open_handles.load(Ordering::SeqCst), 0);
    source.engine.shutdown().await;
}
