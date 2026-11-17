use super::*;
use std::sync::{Arc, Mutex, atomic::Ordering};

fn request(path: &str, query: &str, recursive: bool, include_hidden: bool) -> FileSearchInput {
    FileSearchInput {
        request_id: uuid::Uuid::new_v4().to_string(),
        path: path.into(),
        query: query.into(),
        recursive,
        include_hidden,
    }
}
fn sink() -> (
    serverdeck_sftp::SearchSink,
    Arc<Mutex<Vec<FileSearchEvent>>>,
) {
    let events: Arc<Mutex<Vec<FileSearchEvent>>> = Arc::default();
    let captured = events.clone();
    (
        Arc::new(move |event| {
            captured.lock().unwrap().push(event);
            true
        }),
        events,
    )
}
async fn complete(events: &Mutex<Vec<FileSearchEvent>>) -> Vec<FileSearchEvent> {
    tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            let current = events.lock().unwrap().clone();
            if current
                .last()
                .is_some_and(|event| event.status != FileSearchStatus::Running)
            {
                return current;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("search completion")
}
async fn run(files: &Files, id: &str, input: FileSearchInput) -> Vec<FileSearchEvent> {
    let (sink, events) = sink();
    let request_id = input.request_id.clone();
    files.start_search(id, input, sink).unwrap();
    let output = complete(&events).await;
    files.cancel_search(id, &request_id).await.unwrap();
    output
}
fn results(events: &[FileSearchEvent]) -> Vec<String> {
    let mut paths: Vec<_> = events
        .iter()
        .flat_map(|event| event.entries.iter().map(|result| result.entry.path.clone()))
        .collect();
    paths.sort();
    paths
}

#[tokio::test]
async fn search_scopes_names_hidden_entries_unicode_and_does_not_follow_changed_directories() {
    let server = Server::start(true, Duration::ZERO).await;
    for directory in ["scope/sub/nested", "scope/.hidden", "scope/link", "outside"] {
        std::fs::create_dir_all(server.root.path().join(directory)).unwrap();
    }
    for name in [
        "scope/Needle.txt",
        "scope/sub/needle.txt",
        "scope/sub/nested/NEEDLE.txt",
        "scope/.needle",
        "scope/.hidden/needle.txt",
        "scope/link/needle-secret.txt",
        "outside/needle.txt",
        "scope/中文 空格.txt",
    ] {
        std::fs::write(server.root.path().join(name), b"content").unwrap();
    }
    server
        .faults
        .links
        .lock()
        .unwrap()
        .insert("/scope/link".into(), "/outside".into());
    let session = server.open().await;
    let files = Files::new(server.engine.clone(), 1);
    let top = run(
        &files,
        &session.id,
        request("/scope", "NEEDLE", false, false),
    )
    .await;
    assert_eq!(results(&top), vec!["/scope/Needle.txt"]);
    let nested = run(
        &files,
        &session.id,
        request("/scope", "needle", true, false),
    )
    .await;
    assert_eq!(
        results(&nested),
        vec![
            "/scope/Needle.txt",
            "/scope/sub/needle.txt",
            "/scope/sub/nested/NEEDLE.txt"
        ]
    );
    assert_eq!(nested.last().unwrap().skipped_directories, 1);
    let hidden = run(&files, &session.id, request("/scope", "needle", true, true)).await;
    assert_eq!(results(&hidden).len(), 5);
    let unicode = run(
        &files,
        &session.id,
        request("/scope", "中文 空格", true, false),
    )
    .await;
    assert_eq!(results(&unicode), vec!["/scope/中文 空格.txt"]);
    assert_eq!(unicode.last().unwrap().status, FileSearchStatus::Completed);
    server.engine.shutdown().await;
}

#[tokio::test]
async fn wildcards_match_extensions_single_unicode_characters_and_explicit_scopes() {
    let server = Server::start(true, Duration::ZERO).await;
    std::fs::create_dir_all(server.root.path().join("scope/sub")).unwrap();
    for name in [
        "run.sh",
        "Build.SH",
        ".hidden.sh",
        "run.sh.bak",
        "runXsh",
        "service1.sh",
        "service12.sh",
        "中文.sh",
        "λ.sh",
        "sub/nested.sh",
    ] {
        std::fs::write(server.root.path().join("scope").join(name), b"script").unwrap();
    }
    let session = server.open().await;
    let files = Files::new(server.engine.clone(), 1);
    let top = run(&files, &session.id, request("/scope", "*.sh", false, false)).await;
    assert_eq!(
        results(&top),
        vec![
            "/scope/Build.SH",
            "/scope/run.sh",
            "/scope/service1.sh",
            "/scope/service12.sh",
            "/scope/λ.sh",
            "/scope/中文.sh"
        ]
    );
    assert_eq!(top.last().unwrap().status, FileSearchStatus::Completed);
    let single = run(
        &files,
        &session.id,
        request("/scope", "service?.SH", false, false),
    )
    .await;
    assert_eq!(results(&single), vec!["/scope/service1.sh"]);
    let unicode = run(
        &files,
        &session.id,
        request("/scope", "??.sh", false, false),
    )
    .await;
    assert_eq!(results(&unicode), vec!["/scope/中文.sh"]);
    let nested = run(&files, &session.id, request("/scope", "*.sh", true, false)).await;
    assert_eq!(results(&nested).len(), 7);
    assert!(results(&nested).contains(&"/scope/sub/nested.sh".to_owned()));
    let hidden = run(&files, &session.id, request("/scope", "*.sh", false, true)).await;
    assert_eq!(results(&hidden).len(), 7);
    assert!(results(&hidden).contains(&"/scope/.hidden.sh".to_owned()));
    server.engine.shutdown().await;
}

#[tokio::test]
async fn unreadable_children_are_partial_but_an_unreadable_root_fails() {
    let server = Server::start(true, Duration::ZERO).await;
    std::fs::create_dir_all(server.root.path().join("scope/denied")).unwrap();
    std::fs::write(server.root.path().join("scope/needle.txt"), b"safe").unwrap();
    server
        .faults
        .unreadable_directories
        .lock()
        .unwrap()
        .insert("/scope/denied".into());
    let session = server.open().await;
    let files = Files::new(server.engine.clone(), 1);
    let partial = run(
        &files,
        &session.id,
        request("/scope", "needle", true, false),
    )
    .await;
    assert_eq!(results(&partial), vec!["/scope/needle.txt"]);
    assert_eq!(partial.last().unwrap().status, FileSearchStatus::Completed);
    assert_eq!(partial.last().unwrap().skipped_directories, 1);
    assert!(
        partial
            .iter()
            .flat_map(|event| &event.issues)
            .any(|issue| issue.path == "/scope/denied" && issue.message.contains("权限"))
    );
    let failed = run(
        &files,
        &session.id,
        request("/scope/denied", "needle", true, false),
    )
    .await;
    assert_eq!(failed.last().unwrap().status, FileSearchStatus::Failed);
    assert!(
        failed
            .last()
            .unwrap()
            .message
            .as_deref()
            .unwrap()
            .contains("权限")
    );
    assert!(results(&failed).is_empty());
    server.engine.shutdown().await;
}

#[tokio::test]
async fn stopping_drains_open_handles_rejects_overlapping_searches_and_keeps_browsing_usable() {
    let server = Server::start(true, Duration::ZERO).await;
    std::fs::create_dir(server.root.path().join("sub")).unwrap();
    std::fs::write(server.root.path().join("needle.txt"), b"safe").unwrap();
    let session = server.open().await;
    let files = Files::new(server.engine.clone(), 1);
    server.faults.wire_delay_ms.store(80, Ordering::SeqCst);
    let input = request("/", "needle", true, false);
    let request_id = input.request_id.clone();
    let (sink, events) = sink();
    files
        .start_search(&session.id, input, sink.clone())
        .unwrap();
    assert!(
        files
            .start_search(&session.id, request("/", "needle", true, false), sink)
            .is_err()
    );
    files
        .cancel_search(&session.id, &uuid::Uuid::new_v4().to_string())
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        while server.faults.open_handles.load(Ordering::SeqCst) == 0 {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("open search handle");
    files.cancel_search(&session.id, &request_id).await.unwrap();
    let done = complete(&events).await;
    assert_eq!(done.last().unwrap().status, FileSearchStatus::Cancelled);
    assert_eq!(server.faults.open_handles.load(Ordering::SeqCst), 0);
    let count = events.lock().unwrap().len();
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(events.lock().unwrap().len(), count);
    assert_eq!(files.list(&session.id, "/").await.unwrap().entries.len(), 2);
    let again = run(&files, &session.id, request("/", "needle", false, false)).await;
    assert_eq!(results(&again), vec!["/needle.txt"]);
    server.engine.shutdown().await;
}

#[tokio::test]
async fn result_limits_are_explicit_and_closing_a_lease_cancels_its_search() {
    let server = Server::start(true, Duration::ZERO).await;
    for index in 0..1001 {
        std::fs::write(server.root.path().join(format!("needle-{index}.txt")), b"").unwrap();
    }
    let session = server.open().await;
    let files = Files::new(server.engine.clone(), 1);
    let limited = run(&files, &session.id, request("/", "needle", true, false)).await;
    assert_eq!(results(&limited).len(), 1000);
    assert_eq!(limited.last().unwrap().status, FileSearchStatus::Limited);
    assert!(
        limited
            .last()
            .unwrap()
            .message
            .as_deref()
            .unwrap()
            .contains("1000")
    );
    server.faults.wire_delay_ms.store(80, Ordering::SeqCst);
    let (sink, events) = sink();
    files
        .start_search(&session.id, request("/", "needle", true, false), sink)
        .unwrap();
    files.close(&session.id, false).await.unwrap();
    assert_eq!(
        complete(&events).await.last().unwrap().status,
        FileSearchStatus::Cancelled
    );
    assert_eq!(server.faults.open_handles.load(Ordering::SeqCst), 0);
    server.engine.shutdown().await;
}
