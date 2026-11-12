use super::*;
use serde::{Deserialize, Serialize};
use serverdeck_windows_terminal as native;
use std::io;
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    net::windows::named_pipe::ClientOptions,
    sync::mpsc as async_mpsc,
};

const HELPER: &str = "--serverdeck-elevated-terminal";
const VERSION: u32 = 1;
const MAX_FRAME: usize = 128 * 1024;
const START_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
enum Frame {
    Start {
        version: u32,
        size: TerminalSize,
    },
    Ready {},
    Input {
        data: Vec<u8>,
    },
    Resize {
        size: TerminalSize,
    },
    Ack {
        sequence: u64,
    },
    Close {},
    Data {
        sequence: u64,
        data: Vec<u8>,
    },
    Exit {
        status: Option<u32>,
    },
    State {
        state: State,
        message: Option<String>,
    },
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum State {
    Connected,
    Closed,
    Failed,
}

fn invalid(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}
async fn read_frame(reader: &mut (impl AsyncRead + Unpin)) -> io::Result<Frame> {
    let length = reader.read_u32_le().await? as usize;
    if length == 0 || length > MAX_FRAME {
        return Err(invalid("Invalid terminal frame size"));
    }
    let mut bytes = vec![0; length];
    reader.read_exact(&mut bytes).await?;
    serde_json::from_slice(&bytes).map_err(|_| invalid("Invalid terminal protocol frame"))
}
async fn write_frame(writer: &mut (impl AsyncWrite + Unpin), frame: &Frame) -> io::Result<()> {
    let bytes = serde_json::to_vec(frame).map_err(io::Error::other)?;
    if bytes.len() > MAX_FRAME {
        return Err(invalid("Terminal frame is too large"));
    }
    tokio::time::timeout(Duration::from_secs(3), async {
        writer.write_u32_le(bytes.len() as u32).await?;
        writer.write_all(&bytes).await
    })
    .await
    .map_err(io::Error::other)?
}
fn pipe_name(id: uuid::Uuid) -> String {
    format!(r"\\.\pipe\ServerDeck-terminal-{id}")
}

pub(super) async fn run(
    id: &str,
    size: TerminalSize,
    control: &Control,
    sink: &Sink,
    receiver: mpsc::Receiver<Command>,
    ready: oneshot::Sender<Result<LocalTerminalSession, Error>>,
) -> Result<(), Error> {
    let startup = async {
        let nonce = uuid::Uuid::new_v4();
        let pipe = native::create_pipe(&pipe_name(nonce))?;
        let executable = std::env::current_exe()?;
        // Only a fixed helper mode, random pipe identifier and process ID cross UAC.
        let arguments = format!("{HELPER} {nonce} {}", std::process::id());
        let process = tokio::task::spawn_blocking(move || native::launch(&executable, &arguments))
            .await
            .map_err(io::Error::other)??;
        if control.cancelled.load(Ordering::Acquire) {
            return Err(io::Error::other("Terminal opening cancelled"));
        }
        tokio::time::timeout(START_TIMEOUT, pipe.connect())
            .await
            .map_err(io::Error::other)??;
        native::authenticate_client(&pipe, &process)?;
        let mut pipe = pipe;
        write_frame(
            &mut pipe,
            &Frame::Start {
                version: VERSION,
                size,
            },
        )
        .await?;
        match tokio::time::timeout(START_TIMEOUT, read_frame(&mut pipe))
            .await
            .map_err(io::Error::other)??
        {
            Frame::Ready {} => Ok((pipe, process)),
            _ => Err(invalid("Terminal helper did not become ready")),
        }
    }
    .await;
    let (pipe, process) = match startup {
        Ok(value) => value,
        Err(error) => {
            let message = if error.raw_os_error() == Some(1223) {
                "已取消管理员终端授权"
            } else {
                "无法启动管理员终端，请检查系统授权后重试"
            };
            tracing::warn!(operation = "local_terminal_elevation", error = %error, "could not start elevated terminal");
            let _ = ready.send(Err(failed(message, error)));
            return Ok(());
        }
    };
    let (mut reader, mut writer) = tokio::io::split(pipe);
    let (events, mut incoming) = async_mpsc::channel(2);
    let reading = tokio::spawn(async move {
        loop {
            let event = read_frame(&mut reader).await;
            let end = event.is_err();
            if events.send(event).await.is_err() || end {
                break;
            }
        }
    });
    // Dropping both halves closes the pipe and makes the helper terminate its job.
    let result = async {
        if ready.send(Ok(LocalTerminalSession { id: id.into(), shell: "PowerShell".into(), elevated: true })).is_err() {
            control.cancel();
        }
        let mut tick = tokio::time::interval(Duration::from_millis(20));
        let mut closing = None;
        let mut last_ack = 0;
        loop {
            tokio::select! {
                event = incoming.recv() => {
                    let frame = event.ok_or_else(|| invalid("Terminal helper disconnected"))??;
                    let event = match frame {
                        Frame::Data { sequence, data } if !data.is_empty() && data.len() <= 16384 => {
                            let mut values = lock(&control.sequence).map_err(io::Error::other)?;
                            if sequence != values.0 + 1 || values.0 != last_ack { return Err(invalid("Unexpected terminal output sequence")); }
                            values.0 = sequence;
                            TerminalEvent::Data { sequence, data }
                        },
                        Frame::Exit { status } => TerminalEvent::Exit { status },
                        Frame::State { state, message } => {
                            let state = match state { State::Connected => "connected", State::Closed => "closed", State::Failed => "failed" };
                            let closed = state == "closed" || state == "failed";
                            sink(TerminalEvent::State { state, code: (state == "failed").then_some("LOCAL_TERMINAL"), message });
                            if closed { break; }
                            continue;
                        },
                        _ => return Err(invalid("Unexpected terminal helper frame")),
                    };
                    if !control.cancelled.load(Ordering::Acquire) && !sink(event) { control.cancel(); }
                },
                _ = tick.tick() => {
                    if control.cancelled.load(Ordering::Acquire) {
                        if closing.is_none() {
                            write_frame(&mut writer, &Frame::Close {}).await?;
                            closing = Some(Instant::now());
                        }
                        if closing.is_some_and(|at| at.elapsed() > Duration::from_secs(5)) {
                            return Err(io::Error::new(io::ErrorKind::TimedOut, "Elevated terminal did not close"));
                        }
                        continue;
                    }
                    let ack = lock(&control.sequence).map_err(io::Error::other)?.1;
                    if ack > last_ack {
                        write_frame(&mut writer, &Frame::Ack { sequence: ack }).await?;
                        last_ack = ack;
                    }
                    match receiver.try_recv() {
                        Ok(Command::Input(data)) => write_frame(&mut writer, &Frame::Input { data }).await?,
                        Ok(Command::Resize(size)) => write_frame(&mut writer, &Frame::Resize { size }).await?,
                        Err(mpsc::TryRecvError::Empty) => (),
                        Err(mpsc::TryRecvError::Disconnected) => control.cancel(),
                    }
                }
            }
        }
        Ok::<_, io::Error>(())
    }.await;
    reading.abort();
    let _ = reading.await;
    drop(writer);
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut reported = false;
    while !process
        .has_exited()
        .map_err(|error| failed("无法确认管理员终端退出", error))?
    {
        if !reported && Instant::now() >= deadline {
            reported = true;
            sink(TerminalEvent::State {
                state: "failed",
                code: Some("LOCAL_TERMINAL"),
                message: Some("管理员终端代理尚未退出，请核对本地进程后重试关闭".into()),
            });
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    result.map_err(|error| failed("管理员终端通信中断，会话已停止", error))
}

fn helper_arguments(arguments: &[String]) -> io::Result<(uuid::Uuid, u32)> {
    if arguments.len() != 3 || arguments[0] != HELPER {
        return Err(invalid("Invalid helper arguments"));
    }
    let id =
        uuid::Uuid::parse_str(&arguments[1]).map_err(|_| invalid("Invalid terminal identifier"))?;
    let parent = arguments[2]
        .parse::<u32>()
        .map_err(|_| invalid("Invalid terminal host"))?;
    if parent == 0 {
        return Err(invalid("Invalid terminal host"));
    }
    Ok((id, parent))
}

// Called before Tauri/single-instance/storage/plugin initialization. This process is
// a PTY helper only; it never opens a WebView, database, credentials or plugin runtime.
pub(crate) fn helper_entry() {
    let arguments: Vec<_> = std::env::args().skip(1).collect();
    if arguments.first().map(String::as_str) != Some(HELPER) {
        return;
    }
    let result = (|| -> io::Result<()> {
        let (id, parent) = helper_arguments(&arguments)?;
        if !native::is_elevated()? {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "Administrator token required",
            ));
        }
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()?;
        let _job = native::contain_helper()?;
        let result = runtime.block_on(helper(id, parent));
        // A PTY write may be blocked. Process exit closes the job and terminates all
        // descendants without waiting forever on blocking worker shutdown.
        if let Err(ref error) = result {
            eprintln!("Elevated terminal helper failed: {error}");
        }
        std::process::exit(if result.is_ok() { 0 } else { 1 });
    })();
    if let Err(error) = result {
        eprintln!("Elevated terminal helper rejected startup: {error}");
    }
    std::process::exit(1);
}

async fn helper(id: uuid::Uuid, parent: u32) -> io::Result<()> {
    // Tokio's default SECURITY_IDENTIFICATION prevents the unelevated pipe server
    // from impersonating this elevated client.
    let mut pipe = ClientOptions::new().open(pipe_name(id))?;
    let _parent = native::authenticate_server(&pipe, parent)?;
    let size = match tokio::time::timeout(START_TIMEOUT, read_frame(&mut pipe))
        .await
        .map_err(io::Error::other)??
    {
        Frame::Start {
            version: VERSION,
            size,
        } => size.validate().map_err(io::Error::other)?,
        _ => return Err(invalid("Unsupported terminal handshake")),
    };
    let terminals = LocalTerminals::new();
    let (send, mut events) = async_mpsc::channel(16);
    let sink: Sink = Arc::new(move |event| {
        let frame = match event {
            TerminalEvent::Data { sequence, data } => Frame::Data { sequence, data },
            TerminalEvent::Exit { status } => Frame::Exit { status },
            TerminalEvent::State { state, message, .. } => Frame::State {
                state: match state {
                    "connected" => State::Connected,
                    "closed" => State::Closed,
                    _ => State::Failed,
                },
                message,
            },
            _ => return false,
        };
        send.try_send(frame).is_ok()
    });
    let session = terminals.open(size, sink).await.map_err(io::Error::other)?;
    write_frame(&mut pipe, &Frame::Ready {}).await?;
    let (mut reader, mut writer) = tokio::io::split(pipe);
    let (send, mut commands) = async_mpsc::channel(64);
    let reading = tokio::spawn(async move {
        loop {
            let command = read_frame(&mut reader).await;
            let end = command.is_err();
            if send.send(command).await.is_err() || end {
                break;
            }
        }
    });
    let result = async {
        loop {
            tokio::select! {
                command = commands.recv() => {
                    match command.ok_or_else(|| invalid("Terminal host disconnected"))?? {
                        Frame::Input { data } => terminals.input(&session.id, data),
                        Frame::Resize { size } => terminals.resize(&session.id, size),
                        Frame::Ack { sequence } => terminals.ack(&session.id, sequence),
                        Frame::Close {} => break,
                        _ => return Err(invalid("Unexpected terminal command")),
                    }.map_err(io::Error::other)?;
                },
                event = events.recv() => {
                    let event = event.ok_or_else(|| invalid("Terminal event stream closed"))?;
                    let closed = matches!(event, Frame::State { state: State::Closed | State::Failed, .. });
                    write_frame(&mut writer, &event).await?;
                    if closed { break; }
                }
            }
        }
        Ok(())
    }.await;
    reading.abort();
    let _ = reading.await;
    terminals.close_all(true).await.map_err(io::Error::other)?;
    // Confirm cleanup to the parent, including a requested close.
    write_frame(
        &mut writer,
        &Frame::State {
            state: State::Closed,
            message: None,
        },
    )
    .await?;
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn helper_accepts_only_fixed_mode_uuid_and_parent() {
        let id = uuid::Uuid::new_v4().to_string();
        assert!(helper_arguments(&[HELPER.into(), id.clone(), "42".into()]).is_ok());
        for args in [
            vec![HELPER.into(), id.clone(), "0".into()],
            vec![HELPER.into(), id.clone(), "42 & calc".into()],
            vec![HELPER.into(), "\\\\remote\\pipe".into(), "42".into()],
            vec![HELPER.into(), id, "42".into(), "powershell".into()],
        ] {
            assert!(helper_arguments(&args).is_err());
        }
    }

    #[tokio::test]
    async fn wire_roundtrip_and_rejects_oversized_truncated_and_unknown_frames() {
        let (mut write, mut read) = tokio::io::duplex(MAX_FRAME + 4);
        let data = vec![255; 16384];
        write_frame(&mut write, &Frame::Input { data: data.clone() })
            .await
            .unwrap();
        assert!(
            matches!(read_frame(&mut read).await.unwrap(), Frame::Input { data: value } if value == data)
        );
        write.write_u32_le(MAX_FRAME as u32 + 1).await.unwrap();
        assert!(read_frame(&mut read).await.is_err());
        let bytes = br#"{"type":"close","command":"calc"}"#;
        write.write_u32_le(bytes.len() as u32).await.unwrap();
        write.write_all(bytes).await.unwrap();
        assert!(read_frame(&mut read).await.is_err());
        write.write_u32_le(100).await.unwrap();
        drop(write);
        assert!(read_frame(&mut read).await.is_err());
    }
}
