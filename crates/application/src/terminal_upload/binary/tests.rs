use super::*;
#[cfg(windows)]
use tokio::io::{AsyncReadExt, AsyncWriteExt};

struct RecordedWire {
    incoming: VecDeque<Vec<u8>>,
    sent: Vec<Vec<u8>>,
    change_after_payload: Option<PathBuf>,
}
impl Wire for RecordedWire {
    async fn send(&mut self, bytes: &[u8]) -> Result<(), Error> {
        self.sent.push(bytes.to_vec());
        if bytes.len() == 256
            && let Some(path) = self.change_after_payload.take()
        {
            std::fs::write(path, b"changed after reading").unwrap();
        }
        Ok(())
    }
    async fn recv(&mut self) -> Result<Vec<u8>, Error> {
        self.incoming.pop_front().ok_or_else(protocol)
    }
}
#[derive(Clone, Copy)]
enum SourceChange {
    None,
    BeforeRead,
    AfterPayload,
}
async fn recorded(
    frames: &[&str],
    cancel_at_ready: bool,
    changed_source: SourceChange,
) -> (Result<TerminalDropResult, Error>, Vec<Vec<u8>>) {
    let source = tempfile::tempdir().unwrap();
    let path = source.path().join("file");
    std::fs::write(&path, (0..=255).collect::<Vec<u8>>()).unwrap();
    let uploads = TerminalUploads::default();
    let token = uploads.begin("test").unwrap();
    uploads.select("test", &token, vec![path.clone()]).unwrap();
    if matches!(changed_source, SourceChange::BeforeRead) {
        std::fs::write(&path, b"changed").unwrap();
    }
    let nonce = "a".repeat(32);
    let prepared = TerminalDropPrepared {
        size: 256,
        command: "bootstrap\r".into(),
        nonce: nonce.clone(),
    };
    let mut io = RecordedWire {
        incoming: frames
            .iter()
            .map(|f| format!("\x1eSDU:{nonce}:{f}\x1f").into_bytes())
            .collect(),
        sent: vec![],
        change_after_payload: matches!(changed_source, SourceChange::AfterPayload).then_some(path),
    };
    let cancel = CancellationToken::new();
    let cancelling = cancel.clone();
    let mut progress = Progress {
        value: TerminalDropProgress {
            phase: Phase::Starting,
            sent: 0,
            size: 256,
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
            if cancel_at_ready && p.phase == Phase::Uploading {
                cancelling.cancel();
            }
            true
        }),
    };
    let result = transfer(
        &uploads,
        "test",
        &token,
        1,
        &prepared,
        &mut io,
        &mut progress,
    )
    .await;
    (result, io.sent)
}
const READY: &str = "READY:0:cm9vdA==:L3Jvb3QvY3VycmVudAo=";
#[tokio::test]
async fn native_protocol_sends_raw_bytes_and_requires_ack_commit_and_return_fences() {
    let (result, sent) = recorded(
        &[
            READY,
            "ACK:256",
            "VERIFYING",
            "COMMIT_READY",
            "COMMITTING",
            "DONE:1",
            "RETURN",
        ],
        false,
        SourceChange::None,
    )
    .await;
    assert!(result.unwrap().code.is_none());
    assert_eq!(
        sent,
        [
            b"bootstrap\r".to_vec(),
            b"D0000256".to_vec(),
            (0..=255).collect::<Vec<u8>>(),
            format!("F{:x}", Sha256::digest((0..=255).collect::<Vec<u8>>())).into_bytes(),
            b"K".to_vec(),
            b"R".to_vec()
        ]
    );
}
#[tokio::test]
async fn rejects_bad_identity_premature_completion_ack_order_and_missing_return() {
    for frames in [
        vec!["DONE:1", "RETURN"],
        vec!["READY:0:!:L3Jvb3QvY3VycmVudAo="],
        vec!["READY:0:/w==:L3Jvb3QvY3VycmVudAo="],
        vec!["READY:0:cm9vdAA=:L3Jvb3QvY3VycmVudAo="],
        vec!["READY:0:cm9vdAo=:L3Jvb3QvY3VycmVudAo="],
        vec!["READY:0:cm9vdA==:bm90LWEtZGly"],
        vec![READY, "ACK:255"],
        vec![READY, "DONE:1", "RETURN"],
        vec![
            READY,
            "ACK:256",
            "VERIFYING",
            "COMMIT_READY",
            "COMMITTING",
            "DONE:1",
        ],
        vec![READY, "FAIL:STREAM:0"],
        vec![READY, "ERROR:TTY_RESTORE:0", "RETURN"],
    ] {
        let (result, _) = recorded(&frames, false, SourceChange::None).await;
        assert!(
            result.is_err(),
            "must reject invalid peer sequence: {frames:?}"
        );
    }
    let (_, sent) = recorded(&["DONE:1", "RETURN"], false, SourceChange::None).await;
    assert_eq!(
        sent,
        [b"bootstrap\r".to_vec()],
        "no payload before authenticated task READY"
    );
}
#[tokio::test]
async fn cancellation_before_payload_and_source_failure_wait_for_release_and_return() {
    for (cancel, changed, expected) in [
        (true, SourceChange::None, "CANCELLED"),
        (false, SourceChange::BeforeRead, "LOCAL_READ"),
    ] {
        let (result, sent) =
            recorded(&[READY, "ERROR:CANCELLED:0", "RETURN"], cancel, changed).await;
        assert_eq!(result.unwrap().code.as_deref(), Some(expected));
        assert_eq!(
            sent,
            [b"bootstrap\r".to_vec(), b"C".to_vec(), b"R".to_vec()]
        );
    }
    let (result, _) = recorded(
        &[
            READY,
            "ERROR:CLEANUP:0:Li8uc2VydmVyZGVjay11cGxvYWQudGVzdA==",
            "RETURN",
        ],
        true,
        SourceChange::None,
    )
    .await;
    let result = result.unwrap();
    assert_eq!(result.code.as_deref(), Some("CLEANUP"));
    assert_eq!(
        result.recovery.as_deref(),
        Some("./.serverdeck-upload.test")
    );
}

#[tokio::test]
async fn source_changed_after_final_payload_cancels_before_checksum_and_commit() {
    let (result, sent) = recorded(
        &[READY, "ACK:256", "ERROR:CANCELLED:0", "RETURN"],
        false,
        SourceChange::AfterPayload,
    )
    .await;
    let result = result.unwrap();
    assert_eq!(result.code.as_deref(), Some("LOCAL_READ"));
    assert_eq!(result.committed, 0);
    assert_eq!(
        sent,
        [
            b"bootstrap\r".to_vec(),
            b"D0000256".to_vec(),
            (0..=255).collect::<Vec<u8>>(),
            b"C".to_vec(),
            b"R".to_vec(),
        ]
    );
}

#[test]
fn control_frames_are_bounded_fragmented_and_ignore_bootstrap_echo() {
    let nonce = "a".repeat(32);
    let mut frames = Frames::default();
    for byte in format!("/bin/sh -c 'sd_nonce=$1'\r\n\x1eSDU:other:RETURN\x1f\x1eSDU:{nonce}:ACK:4194304\x1f\x1eSDU:{nonce}:RETURN\x1fShell prompt").bytes() {
        frames.push(&[byte], &nonce).unwrap();
    }
    assert_eq!(
        frames.frames.into_iter().collect::<Vec<_>>(),
        ["ACK:4194304", "RETURN"]
    );
    let mut frames = Frames::default();
    assert!(
        frames
            .push(
                format!("\x1eSDU:{nonce}:{}", "x".repeat(16385)).as_bytes(),
                &nonce
            )
            .is_err()
    );
    assert!(text("invalid!").is_err());
    assert!(text("/w==").is_err());
}

#[cfg(windows)]
struct Pty {
    child: tokio::process::Child,
    input: tokio::process::ChildStdin,
    output: tokio::process::ChildStdout,
    corrupt_hash: bool,
}
#[cfg(windows)]
impl Wire for Pty {
    async fn send(&mut self, bytes: &[u8]) -> Result<(), Error> {
        if self.corrupt_hash && bytes.len() == 65 && bytes[0] == b'F' {
            return self
                .input
                .write_all(format!("F{}", "0".repeat(64)).as_bytes())
                .await
                .map_err(io_error);
        }
        self.input.write_all(bytes).await.map_err(io_error)
    }
    async fn recv(&mut self) -> Result<Vec<u8>, Error> {
        let mut bytes = vec![0; 32768];
        let n = self.output.read(&mut bytes).await.map_err(io_error)?;
        if n == 0 {
            return Err(Error::NotFound);
        }
        bytes.truncate(n);
        Ok(bytes)
    }
}

#[cfg(windows)]
async fn real_pty(
    scenario: &str,
    cancel_phase: Option<Phase>,
    size: usize,
    single_file: bool,
) -> (serde_json::Value, TerminalDropResult, f64) {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .unwrap();
    let peer_path = root.join("tools/terminal-drop-peer.py");
    let win = peer_path
        .to_string_lossy()
        .replace("\\\\?\\", "")
        .replace('\\', "/");
    let linux = format!("/mnt/{}/{}", win[..1].to_ascii_lowercase(), &win[3..]);
    let shell = std::env::var("SERVERDECK_TEST_DROP_SHELL").ok();
    if let Some(shell) = &shell {
        assert!(shell.starts_with('/'));
        assert!(
            shell
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"/_.-".contains(&c))
        );
    }
    let mut child = tokio::process::Command::new("wsl.exe")
        .args(["-d", "Ubuntu-24.04", "--exec", "python3", &linux, scenario])
        .args(shell.iter())
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let input = child.stdin.take().unwrap();
    let output = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();
    let mut io = Pty {
        child,
        input,
        output,
        corrupt_hash: scenario == "checksum",
    };
    let marker = if ["sudo-root", "su-user", "sudo-user"].contains(&scenario) {
        "\x1eSD_PEER_READY\x1f"
    } else {
        "SD_TEST_PROMPT> "
    };
    tokio::time::timeout(DEADLINE, async {
        let mut prompt = vec![];
        loop {
            prompt.extend(io.recv().await.unwrap());
            if prompt.windows(marker.len()).any(|b| b == marker.as_bytes()) {
                break;
            }
        }
    })
    .await
    .expect("real interactive Shell prompt");
    let source = tempfile::tempdir().unwrap();
    let bytes: Vec<u8> = (0..size).map(|i| (i % 256) as u8).collect();
    let filename = if scenario == "unicode" {
        "中文 ' $(touch injected);.bin"
    } else {
        "plain.bin"
    };
    std::fs::write(source.path().join(filename), &bytes).unwrap();
    std::fs::create_dir_all(source.path().join("folder/空目录")).unwrap();
    std::fs::write(
        source.path().join("folder/中文 空格.txt"),
        "中文\r\nbinary \0 😀\n",
    )
    .unwrap();
    std::fs::write(source.path().join("folder/.hidden"), []).unwrap();
    std::fs::write(
        source.path().join("folder/quote' $(touch injected) ;.txt"),
        "literal filename",
    )
    .unwrap();
    let uploads = TerminalUploads::default();
    let token = uploads.begin("pty").unwrap();
    let modified = 1_645_594_860;
    use std::os::windows::fs::OpenOptionsExt;
    for entry in [
        filename,
        "folder/中文 空格.txt",
        "folder/.hidden",
        "folder/空目录",
        "folder",
    ] {
        File::options()
            .write(true)
            .custom_flags(0x02000000)
            .open(source.path().join(entry))
            .unwrap()
            .set_modified(SystemTime::UNIX_EPOCH + Duration::from_secs(modified))
            .unwrap();
    }
    let released = uploads.released("pty", &token).unwrap();
    let paths = if single_file {
        vec![source.path().join(filename)]
    } else {
        vec![source.path().join(filename), source.path().join("folder")]
    };
    let items = paths.len();
    let prepared_source = super::super::drop::prepare_source(paths, &released).unwrap();
    assert_eq!(prepared_source.temporary.is_none(), single_file);
    let size = prepared_source.selected.size;
    let nonce = uuid::Uuid::new_v4().simple().to_string();
    let mut prepared = TerminalDropPrepared {
        size,
        command: super::super::drop::command(
            &nonce,
            size,
            prepared_source.filename.as_deref(),
            modified,
        ),
        nonce,
    };
    if let Some(shell) = shell {
        prepared.command = prepared
            .command
            .replacen("/bin/sh -c", &format!("{shell} -c"), 1);
    }
    // Run the production script with real older GNU binaries without replacing
    // any host commands. Only this isolated test can override the fixed PATH.
    if let Ok(directory) = std::env::var("SERVERDECK_TEST_DROP_TOOLS") {
        assert!(directory.starts_with('/'));
        assert!(
            directory
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"/_.-".contains(&c))
        );
        prepared.command = prepared.command.replace(
            "PATH=/usr/bin:/bin:/usr/sbin:/sbin",
            &format!("PATH={directory}:/usr/bin:/bin:/usr/sbin:/sbin"),
        );
    }
    if scenario == "write-failure" {
        // Real ENOSPC on tee's file output, while keeping the archive readable
        // for the receiver's length check. All queued frames must still drain.
        let command = prepared
            .command
            .replace("tee -a \"$sd_stage/archive\"", "tee -a /dev/full");
        assert_ne!(command, prepared.command);
        prepared.command = command;
    }
    if scenario == "metadata-failure" {
        let command = prepared.command.replace(
            "touch -m -d \"@$sd_mtime\" -- \"$sd_stage/archive\"",
            "false",
        );
        assert_ne!(command, prepared.command);
        prepared.command = command;
    }
    {
        let mut selections = locked(&uploads.0).unwrap();
        let selection = selections.get_mut("pty").unwrap();
        selection.files = vec![Arc::new(Mutex::new(prepared_source.selected))];
        selection.temporary = prepared_source.temporary;
    }
    let cancel = CancellationToken::new();
    let cancel_copy = cancel.clone();
    let timing = Arc::new(Mutex::new((None::<Instant>, None::<Duration>)));
    let record = timing.clone();
    let mut progress = Progress {
        value: TerminalDropProgress {
            phase: Phase::Preparing,
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
            let mut timing = record.lock().unwrap();
            if p.phase == Phase::Uploading && timing.0.is_none() {
                timing.0 = Some(Instant::now());
            }
            if p.phase == Phase::Verifying && timing.1.is_none() {
                timing.1 = timing.0.map(|s| s.elapsed());
            }
            if cancel_phase == Some(p.phase) && (p.phase != Phase::Uploading || p.sent > 0) {
                cancel_copy.cancel();
            }
            true
        }),
    };
    let result = tokio::time::timeout(
        Duration::from_secs(120),
        transfer(
            &uploads,
            "pty",
            &token,
            items,
            &prepared,
            &mut io,
            &mut progress,
        ),
    )
    .await
    .expect("native protocol deadline")
    .expect("native binary transfer");
    io.send(b"printf '__SD_AFTER__\\n'; exit\r").await.unwrap();
    let mut after = vec![];
    io.output.read_to_end(&mut after).await.unwrap();
    let status = io.child.wait().await.unwrap();
    let mut diagnostic = String::new();
    stderr.read_to_string(&mut diagnostic).await.unwrap();
    assert!(status.success(), "{diagnostic}");
    assert!(
        String::from_utf8_lossy(&after).contains("__SD_AFTER__"),
        "Shell must accept input after recovery"
    );
    let report = diagnostic
        .lines()
        .find_map(|line| line.strip_prefix("SD_PEER_RESULT="))
        .expect(&diagnostic);
    let report: serde_json::Value = serde_json::from_str(report).unwrap();
    assert_eq!(
        report["restored"], true,
        "TTY flags must be restored: {report}"
    );
    if scenario != "permission" {
        assert_eq!(
            progress.value.uid.as_deref(),
            Some(report["uid"].as_u64().unwrap().to_string().as_str()),
            "receiver must reach READY before transferring: {result:?}"
        );
        assert_eq!(
            progress.value.username.as_deref().unwrap_or(""),
            report["username"].as_str().unwrap()
        );
        assert!(
            progress
                .value
                .directory
                .as_ref()
                .unwrap()
                .contains("serverdeck-drop-")
        );
    }
    let entries = report["entries"].as_object().unwrap();
    assert!(
        !entries.keys().any(|k| k.starts_with(".serverdeck-upload.")),
        "temporary files must be cleaned: {entries:?}"
    );
    assert!(!entries.contains_key("injected"));
    if result.code.is_none() {
        use sha2::{Digest, Sha256};
        assert_eq!(
            entries[filename]["sha256"],
            format!("{:x}", Sha256::digest(&bytes))
        );
        assert_eq!(entries[filename]["uid"], report["uid"]);
        assert_eq!(entries[filename]["modified"], modified);
        assert_eq!(entries[filename]["mode"].as_u64().unwrap() & 0o022, 0);
        if scenario == "private" {
            assert_eq!(entries[filename]["mode"], 0o600);
        }
        if single_file {
            assert_eq!(entries.len(), 1);
        } else {
            assert_eq!(entries["folder/中文 空格.txt"]["uid"], report["uid"]);
            for entry in [
                "folder",
                "folder/空目录",
                "folder/中文 空格.txt",
                "folder/.hidden",
            ] {
                assert_eq!(entries[entry]["modified"], modified, "source time: {entry}");
            }
            assert!(entries.contains_key("folder/空目录"));
            assert!(entries.contains_key("folder/.hidden"));
            assert!(entries.contains_key("folder/quote' $(touch injected) ;.txt"));
        }
    } else if scenario == "conflict-file" {
        use sha2::{Digest, Sha256};
        assert_eq!(
            entries["plain.bin"]["sha256"],
            format!("{:x}", Sha256::digest(b"existing-content"))
        );
    } else if scenario == "conflict-directory" {
        assert_eq!(entries.keys().collect::<Vec<_>>(), ["folder"]);
    } else if scenario == "conflict-link" {
        assert_eq!(entries["plain.bin"]["link"], "missing-target");
    } else {
        assert!(
            entries.is_empty(),
            "failure/cancellation must not commit: {entries:?}"
        );
    }
    let seconds = timing.lock().unwrap().1.map_or(0.0, |d| d.as_secs_f64());
    let rate = if seconds > 0.0 {
        prepared.size as f64 / seconds / 1_000_000.0
    } else {
        0.0
    };
    eprintln!(
        "native binary PTY {scenario} single={single_file} cancel={cancel_phase:?}: {result:?}, data={rate:.1} MB/s"
    );
    (report, result, rate)
}

#[cfg(windows)]
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires the local Ubuntu-24.04 WSL test environment and real Linux PTYs"]
async fn real_linux_pty_binary_identity_permissions_conflicts_and_cancel_recovery() {
    for scenario in [
        "ordinary",
        "sudo-root",
        "su-user",
        "sudo-user",
        "unnamed",
        "permission",
        "conflict-file",
        "conflict-directory",
        "conflict-link",
        "checksum",
    ] {
        let (_, result, _) = real_pty(scenario, None, 1024 * 1024 + 17, false).await;
        let expected = match scenario {
            "permission" => Some("PERMISSION"),
            "conflict-file" | "conflict-directory" | "conflict-link" => Some("CONFLICT"),
            "checksum" => Some("CHECKSUM"),
            _ => None,
        };
        assert_eq!(result.code.as_deref(), expected, "{scenario}: {result:?}");
    }
    for phase in [Phase::Uploading, Phase::Verifying] {
        let (_, result, _) = real_pty("cancel", Some(phase), 12 * 1024 * 1024 + 17, false).await;
        assert_eq!(result.code.as_deref(), Some("CANCELLED"));
    }
    let (_, result, _) = real_pty("write-failure", None, 12 * 1024 * 1024 + 17, false).await;
    assert_eq!(result.code.as_deref(), Some("RECEIVE"));
    for (scenario, size, expected) in [
        ("ordinary", 0, None),
        ("private", 1024, None),
        ("unicode", 1024 * 1024 + 17, None),
        ("sudo-root", 1024 * 1024 + 17, None),
        ("su-user", 1024 * 1024 + 17, None),
        ("permission", 1024, Some("PERMISSION")),
        ("checksum", 1024, Some("CHECKSUM")),
        ("metadata-failure", 1024, Some("METADATA")),
        ("conflict-file", 1024, Some("CONFLICT")),
        ("conflict-link", 1024, Some("CONFLICT")),
        ("write-failure", 12 * 1024 * 1024 + 17, Some("RECEIVE")),
    ] {
        let (_, result, _) = real_pty(scenario, None, size, true).await;
        assert_eq!(result.code.as_deref(), expected);
    }
    for phase in [Phase::Uploading, Phase::Verifying] {
        let (_, result, _) = real_pty("cancel", Some(phase), 12 * 1024 * 1024 + 17, true).await;
        assert_eq!(result.code.as_deref(), Some("CANCELLED"));
    }
}

#[cfg(windows)]
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "manual release throughput measurement through a real Linux PTY"]
async fn real_linux_pty_binary_throughput() {
    let (_, result, rate) = real_pty("ordinary", None, 128 * 1024 * 1024, true).await;
    assert!(result.code.is_none(), "{result:?}");
    assert!(rate > 0.0);
}
