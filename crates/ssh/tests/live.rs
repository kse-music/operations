//! Opt-in real Linux validation. Secrets are process environment only, never arguments/files.
use serverdeck_core::{
    hosts::{AuthType, HostInput},
    terminal::{TerminalEvent, TerminalSession, TerminalSize},
};
use serverdeck_ssh::{Authentication, Engine};
use serverdeck_storage::Database;
use std::{sync::Arc, time::Duration};
use tokio::sync::mpsc;
use zeroize::Zeroizing;

struct Shell {
    info: TerminalSession,
    events: mpsc::Receiver<TerminalEvent>,
    text: String,
}
async fn receive(engine: &Engine, shell: &mut Shell) -> TerminalEvent {
    let event = tokio::time::timeout(Duration::from_secs(30), shell.events.recv())
        .await
        .expect("SSH event timeout")
        .expect("event stream");
    if let TerminalEvent::Data { sequence, data } = &event {
        engine
            .acknowledge(&shell.info.id, *sequence)
            .expect("acknowledge");
        shell.text.push_str(&String::from_utf8_lossy(data));
        if shell.text.len() > 128 * 1024 {
            shell.text.drain(..64 * 1024);
        }
    }
    event
}
async fn until(engine: &Engine, shell: &mut Shell, needle: &str) {
    println!("Checking real PTY output marker: {needle:?}");
    let result = tokio::time::timeout(Duration::from_secs(25), async {
        loop {
            if shell.text.contains(needle) {
                return;
            }
            if let TerminalEvent::State {
                state: "failed",
                code,
                ..
            } = receive(engine, shell).await
            {
                panic!("SSH failed: {code:?}");
            }
        }
    })
    .await;
    assert!(result.is_ok(), "expected real PTY output marker {needle:?}");
}
async fn connected(engine: &Engine, shell: &mut Shell, pin: &str) {
    loop {
        match receive(engine, shell).await {
            TerminalEvent::Trust { fingerprint, .. } => {
                assert_eq!(fingerprint, pin, "untrusted host fingerprint");
                engine
                    .confirm(&shell.info.id, true)
                    .expect("confirm verified fingerprint");
            }
            TerminalEvent::State {
                state: "connected", ..
            } => return,
            TerminalEvent::State {
                state: "failed",
                code,
                ..
            } => panic!("SSH failed: {code:?}"),
            _ => (),
        }
    }
}
fn open(engine: &Engine, host: serverdeck_core::hosts::Host, password: &str) -> Shell {
    let (tx, events) = mpsc::channel(16);
    let info = engine
        .open(
            host,
            1,
            Authentication::Password(Zeroizing::new(password.to_owned())),
            TerminalSize {
                cols: 100,
                rows: 30,
            },
            Arc::new(move |event| tx.try_send(event).is_ok()),
        )
        .expect("open terminal");
    Shell {
        info,
        events,
        text: String::new(),
    }
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires authorized Linux target and SERVERDECK_TEST_* environment"]
async fn real_linux_password_pty_multichannel_resize_interactive_reconnect_and_output() {
    let hostname = std::env::var("SERVERDECK_TEST_HOST").expect("test host");
    let username = std::env::var("SERVERDECK_TEST_USER").expect("test user");
    let password = Zeroizing::new(
        std::env::var("SERVERDECK_TEST_PASSWORD").unwrap_or_else(|_| {
            rpassword::prompt_password("SSH test password (not stored): ").expect("password input")
        }),
    );
    let pin = std::env::var("SERVERDECK_TEST_PIN").expect("verified fingerprint");
    let directory = tempfile::tempdir().expect("tempdir");
    let db = Database::open(directory.path().join("db")).expect("database");
    let host = db
        .host_create(HostInput {
            ssh: Default::default(),
            name: "Authorized Linux validation".into(),
            hostname,
            port: 22,
            username,
            auth_type: AuthType::Password,
            credential_id: None,
            group_id: None,
            tags: vec![],
            description: String::new(),
            favorite: false,
            connect_timeout_secs: 15,
        })
        .expect("host");
    let engine = Engine::new(db);
    // Prime only explicit pin confirmation; every measured sample must establish a fresh transport.
    let mut warmup = open(&engine, host.clone(), &password);
    connected(&engine, &mut warmup, &pin).await;
    engine.close(&warmup.info.id).await.expect("warmup close");
    let mut milliseconds = Vec::new();
    for _ in 0..5 {
        assert_eq!(engine.counts().expect("before connect"), (0, 0));
        let started = std::time::Instant::now();
        let mut sample = open(&engine, host.clone(), &password);
        connected(&engine, &mut sample, &pin).await;
        milliseconds.push(started.elapsed().as_secs_f64() * 1000.0);
        engine
            .close(&sample.info.id)
            .await
            .expect("measured transport close");
    }
    println!("SSH_CONNECT_BENCH_MS={milliseconds:?}");
    let mut first = open(&engine, host.clone(), &password);
    connected(&engine, &mut first, &pin).await;
    engine
        .input(
            &first.info.id,
            b"printf '\\n__SD_%s__\\n' LINUX; uname -s; stty size\n".to_vec(),
        )
        .expect("command");
    until(&engine, &mut first, "__SD_LINUX__").await;
    until(&engine, &mut first, "Linux\r\n").await;
    until(&engine, &mut first, "30 100\r\n").await;
    engine
        .resize(
            &first.info.id,
            TerminalSize {
                cols: 110,
                rows: 42,
            },
        )
        .expect("resize");
    tokio::time::sleep(Duration::from_millis(150)).await;
    engine
        .input(&first.info.id, b"stty size\n".to_vec())
        .expect("stty");
    until(&engine, &mut first, "42 110\r\n").await;
    let mut second = open(&engine, host.clone(), &password);
    connected(&engine, &mut second, &pin).await;
    assert_eq!(
        first.info.transport_id, second.info.transport_id,
        "same transport"
    );
    assert_ne!(first.info.id, second.info.id, "independent shells");
    engine
        .input(
            &second.info.id,
            b"printf '\\n__SD_%s__\\n' SECOND\n".to_vec(),
        )
        .expect("second shell");
    until(&engine, &mut second, "__SD_SECOND__").await;
    engine
        .close(&first.info.id)
        .await
        .expect("close first only");
    assert_eq!(engine.counts().expect("counts"), (1, 1));
    engine
        .input(
            &second.info.id,
            b"printf '\\n__SD_%s__\\n' SURVIVED\n".to_vec(),
        )
        .expect("surviving shell");
    until(&engine, &mut second, "__SD_SURVIVED__").await;
    // Real fullscreen applications, no file writes or package installation.
    engine
        .input(&second.info.id, b"vim -Nu NONE -n -i NONE\n".to_vec())
        .expect("vim");
    until(&engine, &mut second, "VIM").await;
    engine
        .input(&second.info.id, b":q!\r".to_vec())
        .expect("quit vim");
    until(&engine, &mut second, "\x1b[?1049l").await;
    engine
        .input(
            &second.info.id,
            b"printf '\\n__SD_%s__\\n' VIM_DONE\n".to_vec(),
        )
        .expect("after vim");
    until(&engine, &mut second, "__SD_VIM_DONE__").await;
    engine
        .input(&second.info.id, b"LC_ALL=C top -d 1\n".to_vec())
        .expect("top");
    until(&engine, &mut second, "Tasks:").await;
    engine
        .input(&second.info.id, b"q".to_vec())
        .expect("quit top");
    second.text.clear();
    tokio::time::sleep(Duration::from_millis(200)).await;
    engine
        .input(
            &second.info.id,
            b"printf '\\n__SD_%s__\\n' TOP_DONE\n".to_vec(),
        )
        .expect("after top");
    until(&engine, &mut second, "__SD_TOP_DONE__").await;
    engine
        .input(&second.info.id, b"sleep 30\n".to_vec())
        .expect("sleep");
    tokio::time::sleep(Duration::from_millis(150)).await;
    engine.input(&second.info.id, vec![3]).expect("Ctrl+C");
    engine
        .input(
            &second.info.id,
            b"printf '\\n__SD_%s__\\n' INTERRUPTED\n".to_vec(),
        )
        .expect("after interrupt");
    until(&engine, &mut second, "__SD_INTERRUPTED__").await;
    second.text.clear();
    engine
        .input(
            &second.info.id,
            b"head -c 2097152 /dev/zero | tr '\\000' x; printf '\\n__SD_%s__\\n' BULK_DONE\n"
                .to_vec(),
        )
        .expect("bulk");
    let mut bytes = 0;
    loop {
        if second.text.contains("__SD_BULK_DONE__") {
            break;
        }
        if let TerminalEvent::Data { data, .. } = receive(&engine, &mut second).await {
            bytes += data.len();
        }
    }
    assert!(bytes >= 2 * 1024 * 1024, "all large output delivered");
    engine
        .input(&second.info.id, b"exit\n".to_vec())
        .expect("exit");
    loop {
        if matches!(
            receive(&engine, &mut second).await,
            TerminalEvent::State {
                state: "closed",
                ..
            }
        ) {
            break;
        }
    }
    engine.close(&second.info.id).await.expect("cleanup");
    let mut third = open(&engine, host, &password);
    connected(&engine, &mut third, &pin).await;
    assert_ne!(second.info.id, third.info.id);
    assert_ne!(second.info.transport_id, third.info.transport_id);
    engine.shutdown().await;
    assert_eq!(engine.counts().expect("released resources"), (0, 0));
    println!(
        "Real Linux: password, pinned TOFU, PTY/resize, shared transport, independent shells, vim, top, Ctrl+C, 2MiB output, normal exit, reconnect, resource release passed"
    );
}
