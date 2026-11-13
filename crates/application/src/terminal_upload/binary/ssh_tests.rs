use super::*;
use russh::keys::{Algorithm, PrivateKey, ssh_key::LineEnding};
use serverdeck_core::{
    hosts::{AuthType, HostInput},
    terminal::{TerminalEvent, TerminalSize},
};
use serverdeck_ssh::{Authentication, Engine};
use serverdeck_storage::Database;
use sha2::{Digest, Sha256};
use std::io::Write as _;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

async fn output(
    engine: &Engine,
    id: &str,
    events: &mut tokio::sync::mpsc::Receiver<TerminalEvent>,
    marker: &[u8],
) -> Vec<u8> {
    tokio::time::timeout(DEADLINE, async {
        let mut result = vec![];
        loop {
            match events.recv().await.expect("SSH events") {
                TerminalEvent::Data { sequence, data } => {
                    engine.acknowledge(id, sequence).unwrap();
                    result.extend(data);
                    if result.windows(marker.len()).any(|v| v == marker) {
                        return result;
                    }
                    assert!(result.len() < 65536);
                }
                TerminalEvent::State {
                    state: "failed" | "closed",
                    code,
                    ..
                } => panic!("unexpected SSH close: {code:?}"),
                _ => (),
            }
        }
    })
    .await
    .expect("SSH output deadline")
}

async fn tty(
    engine: &Engine,
    id: &str,
    events: &mut tokio::sync::mpsc::Receiver<TerminalEvent>,
) -> Vec<u8> {
    engine
        .input(
            id,
            b"printf '\\036SD_TTY:%s\\037' \"$(stty -g)\"\r".to_vec(),
        )
        .unwrap();
    let bytes = output(engine, id, events, &[31]).await;
    let at = bytes.windows(8).position(|b| b == b"\x1eSD_TTY:").unwrap() + 8;
    let end = bytes[at..].iter().position(|&b| b == 31).unwrap() + at;
    bytes[at..end].to_vec()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires isolated WSL OpenSSH; verifies the production SSH engine and receiver together"]
async fn real_openssh_binary_upload_cancel_and_terminal_recovery() {
    let qa = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../.local/qa/terminal-direct-tests");
    std::fs::create_dir_all(&qa).unwrap();
    let directory = tempfile::tempdir_in(qa).unwrap();
    let key = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).unwrap();
    let key_path = directory.path().join("client-key");
    key.write_openssh_file(&key_path, LineEnding::LF).unwrap();
    let public_key = key.public_key().to_openssh().unwrap();
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .unwrap();
    let path = root
        .join("tools/terminal-drop-ssh-peer.py")
        .to_string_lossy()
        .replace("\\\\?\\", "")
        .replace('\\', "/");
    let path = format!("/mnt/{}/{}", path[..1].to_ascii_lowercase(), &path[3..]);
    let shell = std::env::var("SERVERDECK_TEST_DROP_SHELL").unwrap_or_else(|_| "/bin/bash".into());
    assert!(
        shell.starts_with('/')
            && shell
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"/_.-".contains(&b))
    );
    let mut peer = tokio::process::Command::new("wsl.exe")
        .args([
            "-d",
            "Ubuntu-24.04",
            "--exec",
            "python3",
            &path,
            &public_key,
            &shell,
        ])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::inherit())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let mut control = peer.stdin.take().unwrap();
    let mut reports = BufReader::new(peer.stdout.take().unwrap()).lines();
    let endpoint: serde_json::Value =
        serde_json::from_str(&reports.next_line().await.unwrap().unwrap()).unwrap();
    let port = endpoint["port"].as_u64().unwrap() as u16;
    let host_key = endpoint["publicKey"].as_str().unwrap();
    let fingerprint = russh::keys::PublicKey::from_openssh(host_key)
        .unwrap()
        .fingerprint(russh::keys::HashAlg::Sha256)
        .to_string();
    let db = Database::open(directory.path().join("db")).unwrap();
    db.trust_key("127.0.0.1", port, host_key, &fingerprint)
        .unwrap();
    let host = db
        .host_create(HostInput {
            name: "Isolated upload SSH".into(),
            hostname: "127.0.0.1".into(),
            port,
            username: "root".into(),
            auth_type: AuthType::PrivateKey,
            credential_id: None,
            group_id: None,
            description: String::new(),
            favorite: false,
            connect_timeout_secs: 15,
            ssh: Default::default(),
        })
        .unwrap();
    // Wait for the owned listener without assuming WSL forwarding is immediate.
    tokio::time::timeout(DEADLINE, async {
        loop {
            if tokio::net::TcpStream::connect(("127.0.0.1", port))
                .await
                .is_ok()
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    })
    .await
    .unwrap();
    let engine = Engine::new(db);
    let (sender, mut events) = tokio::sync::mpsc::channel(32);
    let session = engine
        .open(
            host,
            1,
            Authentication::PrivateKey {
                path: key_path.to_string_lossy().into_owned(),
                passphrase: None,
            },
            TerminalSize {
                cols: 100,
                rows: 30,
            },
            Arc::new(move |e| sender.try_send(e).is_ok()),
        )
        .unwrap();
    output(&engine, &session.id, &mut events, b"SD_SSH> ").await;
    let original_tty = tty(&engine, &session.id, &mut events).await;
    let file = directory.path().join("payload.bin");
    let large = std::env::var_os("SERVERDECK_TEST_DROP_LARGE").is_some();
    let size = if large {
        5 * 1024 * 1024 * 1024 + 17
    } else {
        16 * 1024 * 1024 + 17
    };
    let mut source_file = File::create(&file).unwrap();
    source_file.set_len(size).unwrap();
    let pattern: Vec<u8> = (0..65536).map(|i| (i % 256) as u8).collect();
    source_file.write_all(&pattern).unwrap();
    source_file
        .seek(SeekFrom::End(-(pattern.len() as i64)))
        .unwrap();
    source_file.write_all(&pattern).unwrap();
    drop(source_file);
    for cancel_data in [false, true] {
        let uploads = TerminalUploads::default();
        let token = uploads.begin(&session.id).unwrap();
        let released = uploads.released(&session.id, &token).unwrap();
        let started = Instant::now();
        let source = super::super::drop::prepare_source(vec![file.clone()], &released).unwrap();
        eprintln!(
            "direct source size={} preparation={:?}",
            source.selected.size,
            started.elapsed()
        );
        assert!(source.temporary.is_none());
        let size = source.selected.size;
        let nonce = uuid::Uuid::new_v4().simple().to_string();
        let mut command = super::super::drop::command(
            &nonce,
            size,
            source.filename.as_deref(),
            super::super::modified_seconds(source.selected.modified).unwrap(),
        )
        .replacen("/bin/sh -c", &format!("{shell} -c"), 1);
        if let Ok(tools) = std::env::var("SERVERDECK_TEST_DROP_TOOLS") {
            assert!(
                tools.starts_with('/')
                    && tools
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"/_.-".contains(&b))
            );
            command = command.replace(
                "PATH=/usr/bin:/bin:/usr/sbin:/sbin",
                &format!("PATH={tools}:/usr/bin:/bin:/usr/sbin:/sbin"),
            );
        }
        let prepared = TerminalDropPrepared {
            size,
            nonce,
            command,
        };
        {
            let mut selections = locked(&uploads.0).unwrap();
            let selection = selections.get_mut(&session.id).unwrap();
            selection.files = vec![Arc::new(Mutex::new(source.selected))];
            selection.temporary = source.temporary;
        }
        let cancel = CancellationToken::new();
        let stop = cancel.clone();
        let mut progress = Progress {
            value: TerminalDropProgress {
                phase: Phase::Starting,
                sent: 0,
                size,
                bytes_per_second: 0,
                elapsed_seconds: 0,
                uid: None,
                username: None,
                directory: None,
            },
            started: None,
            last: Instant::now(),
            cancel,
            sink: Arc::new(move |p| {
                if cancel_data && p.sent > 0 {
                    stop.cancel();
                }
                true
            }),
        };
        let mut io = engine
            .terminal_transfer(&session.id, &prepared.nonce)
            .unwrap();
        let result = {
            let operation = transfer(
                &uploads,
                &session.id,
                &token,
                1,
                &prepared,
                &mut io,
                &mut progress,
            );
            tokio::pin!(operation);
            loop {
                tokio::select! {
                    result = &mut operation => break result.unwrap(),
                    event = events.recv() => match event.expect("SSH event stream") {
                        // Like the WebView, continue acknowledging normal output
                        // already queued before the exclusive binary route began.
                        TerminalEvent::Data { sequence, data } => {
                            assert!(!data.windows(5).any(|b| b == b"\x1eSDU:"));
                            engine.acknowledge(&session.id, sequence).unwrap();
                        }
                        TerminalEvent::State { state: "failed" | "closed", code, .. } => panic!("SSH closed during upload: {code:?}"),
                        _ => (),
                    }
                }
            }
        };
        assert_eq!(
            result.code.as_deref(),
            if cancel_data { Some("CANCELLED") } else { None }
        );
        eprintln!(
            "direct SSH upload cancel={cancel_data} received={} total={:?}",
            progress.value.sent,
            started.elapsed()
        );
        assert_eq!(progress.value.uid.as_deref(), Some("0"));
        assert_eq!(
            progress.value.directory.as_deref(),
            endpoint["directory"].as_str()
        );
        drop(io);
        assert_eq!(
            tty(&engine, &session.id, &mut events).await,
            original_tty,
            "SSH PTY must recover and accept normal input"
        );
        uploads.release(&session.id, &token).unwrap();
    }
    control.write_all(b"report\n").await.unwrap();
    let entries: serde_json::Value =
        serde_json::from_str(&reports.next_line().await.unwrap().unwrap()).unwrap();
    assert_eq!(
        entries.as_object().unwrap().len(),
        1,
        "no staging directory or partial commit"
    );
    let expected = tokio::task::spawn_blocking(move || {
        let mut file = File::open(file).unwrap();
        let mut hash = Sha256::new();
        let mut buffer = vec![0; BLOCK];
        loop {
            let n = file.read(&mut buffer).unwrap();
            if n == 0 {
                break;
            }
            hash.update(&buffer[..n]);
        }
        format!("{:x}", hash.finalize())
    })
    .await
    .unwrap();
    assert_eq!(entries["payload.bin"], expected);
    engine.shutdown().await;
    control.write_all(b"stop\n").await.unwrap();
    assert!(peer.wait().await.unwrap().success());
}
