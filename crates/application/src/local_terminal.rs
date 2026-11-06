use portable_pty::{ChildKiller, CommandBuilder, PtySize, native_pty_system};
use serverdeck_core::{
    Error,
    terminal::{LocalTerminalSession, TerminalEvent, TerminalSize},
};
use serverdeck_ssh::Sink;
use std::{
    collections::HashMap,
    io::{Read, Write},
    sync::{
        Arc, Condvar, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    time::{Duration, Instant},
};
use tokio::sync::{Semaphore, oneshot, watch};

const LIMIT: usize = 16;
const ACK_TIMEOUT: Duration = Duration::from_secs(30);
enum Command {
    Input(Vec<u8>),
    Resize(TerminalSize),
}
struct Control {
    input: mpsc::SyncSender<Command>,
    cancelled: AtomicBool,
    // (last sent, last parsed); only one output frame may await parsing.
    sequence: Mutex<(u64, u64)>,
    parsed: Condvar,
    killer: Mutex<Option<Box<dyn ChildKiller + Send + Sync>>>,
    done: watch::Sender<bool>,
}
impl Control {
    fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
        self.parsed.notify_all();
    }
}
#[derive(Clone)]
pub(crate) struct LocalTerminals {
    sessions: Arc<Mutex<HashMap<String, Arc<Control>>>>,
    slots: Arc<Semaphore>,
    stopped: Arc<AtomicBool>,
}
fn failed(
    message: &'static str,
    source: impl Into<Box<dyn std::error::Error + Send + Sync>>,
) -> Error {
    Error::Connection {
        code: "LOCAL_TERMINAL",
        message,
        source: Some(source.into()),
    }
}
fn lock<T>(value: &Mutex<T>) -> Result<std::sync::MutexGuard<'_, T>, Error> {
    value.lock().map_err(|_| Error::Connection {
        code: "LOCAL_TERMINAL",
        message: "本地终端状态不可用",
        source: None,
    })
}
fn dimensions(size: TerminalSize) -> PtySize {
    PtySize {
        rows: size.rows as u16,
        cols: size.cols as u16,
        pixel_width: 0,
        pixel_height: 0,
    }
}
#[cfg(unix)]
fn unix_shell(mut command: CommandBuilder) -> (CommandBuilder, String) {
    let path = command.get_shell();
    let name = std::path::Path::new(&path)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("sh")
        .to_owned();
    // Select the user's shell, but keep it non-login so Bash reads .bashrc.
    *command.get_argv_mut() = vec![path.clone().into(), "-i".into()];
    command.env("SHELL", path);
    (command, name)
}
fn shell() -> Result<(CommandBuilder, String), Error> {
    #[cfg(windows)]
    let (mut command, name) = {
        let root = std::env::var_os("SystemRoot")
            .ok_or(Error::Validation("无法定位 Windows PowerShell"))?;
        let path =
            std::path::PathBuf::from(root).join("System32/WindowsPowerShell/v1.0/powershell.exe");
        let mut command = CommandBuilder::new(path);
        command.args(["-NoLogo", "-NoProfile"]);
        (command, "PowerShell".to_owned())
    };
    #[cfg(unix)]
    let (mut command, name) = unix_shell(CommandBuilder::new_default_prog());
    // Start in the user's own directory; never interpolate a path into shell text.
    let home = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    if let Some(path) = std::env::var_os(home) {
        command.cwd(path);
    }
    command.env("TERM", "xterm-256color");
    Ok((command, name))
}
impl LocalTerminals {
    pub(crate) fn new() -> Self {
        Self {
            sessions: Default::default(),
            slots: Arc::new(Semaphore::new(LIMIT)),
            stopped: Default::default(),
        }
    }
    pub(crate) async fn open(
        &self,
        size: TerminalSize,
        sink: Sink,
    ) -> Result<LocalTerminalSession, Error> {
        size.validate()?;
        let permit = self
            .slots
            .clone()
            .try_acquire_owned()
            .map_err(|_| Error::Busy)?;
        let (input, receiver) = mpsc::sync_channel(64);
        let (done, _) = watch::channel(false);
        let control = Arc::new(Control {
            input,
            done,
            cancelled: AtomicBool::new(false),
            sequence: Mutex::new((0, 0)),
            parsed: Condvar::new(),
            killer: Mutex::new(None),
        });
        let id = format!("local:{}", uuid::Uuid::new_v4());
        {
            let mut sessions = lock(&self.sessions)?;
            if self.stopped.load(Ordering::Acquire) {
                return Err(Error::ShuttingDown);
            }
            sessions.insert(id.clone(), control.clone());
        }
        let (ready, opening) = oneshot::channel();
        let sessions = self.sessions.clone();
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            let result = run(&id, size, &control, &sink, receiver, ready);
            if let Err(error) = result {
                tracing::warn!(operation = "local_terminal", error = %error, source = ?std::error::Error::source(&error), "local terminal failed");
                let error = serverdeck_core::IpcError::from(error);
                sink(TerminalEvent::State {
                    state: "failed",
                    code: Some(error.code),
                    message: Some(error.message),
                });
            }
            control.done.send_replace(true);
            match lock(&sessions) {
                Ok(mut sessions) => {
                    sessions.remove(&id);
                }
                Err(error) => tracing::error!(operation = "local_terminal_cleanup", error = %error),
            }
        });
        opening
            .await
            .map_err(|error| failed("本地终端未能启动", error))?
    }
    fn get(&self, id: &str) -> Result<Arc<Control>, Error> {
        lock(&self.sessions)?
            .get(id)
            .cloned()
            .ok_or(Error::NotFound)
    }
    pub(crate) fn input(&self, id: &str, data: Vec<u8>) -> Result<(), Error> {
        if data.is_empty() || data.len() > 16 * 1024 {
            return Err(Error::Validation("终端输入须为 1–16384 字节"));
        }
        self.send(id, Command::Input(data))
    }
    pub(crate) fn resize(&self, id: &str, size: TerminalSize) -> Result<(), Error> {
        size.validate()?;
        self.send(id, Command::Resize(size))
    }
    fn send(&self, id: &str, command: Command) -> Result<(), Error> {
        let control = self.get(id)?;
        if control.cancelled.load(Ordering::Acquire) {
            return Err(Error::NotFound);
        }
        control
            .input
            .try_send(command)
            .map_err(|error| match error {
                mpsc::TrySendError::Full(_) => Error::Busy,
                mpsc::TrySendError::Disconnected(_) => Error::NotFound,
            })
    }
    pub(crate) fn ack(&self, id: &str, value: u64) -> Result<(), Error> {
        let control = self.get(id)?;
        let mut sequence = lock(&control.sequence)?;
        if value > sequence.0 {
            return Err(Error::Validation("本地终端确认序号无效"));
        }
        sequence.1 = sequence.1.max(value);
        control.parsed.notify_all();
        Ok(())
    }
    pub(crate) async fn close(&self, id: &str) -> Result<(), Error> {
        let control = match self.get(id) {
            Ok(value) => value,
            Err(Error::NotFound) => return Ok(()),
            Err(error) => return Err(error),
        };
        let mut done = control.done.subscribe();
        control.cancel();
        // A blocked PTY write must not prevent cancellation from killing the shell.
        let killing = tokio::task::spawn_blocking(move || {
            if let Some(killer) = lock(&control.killer)?.as_mut() {
                killer
                    .kill()
                    .map_err(|error| failed("无法关闭本地终端进程", error))?;
            }
            Ok::<_, Error>(())
        })
        .await
        .map_err(|error| failed("本地终端清理任务失败", error))?;
        // Completion confirms that wait() reaped the shell and the PTY reader ended.
        // portable-pty 0.9's Windows cloned killer can report an error after successful termination.
        if tokio::time::timeout(Duration::from_secs(10), done.wait_for(|value| *value))
            .await
            .map_err(|error| {
                killing
                    .err()
                    .unwrap_or_else(|| failed("本地终端关闭超时，请核对本地进程", error))
            })?
            .is_err()
        {
            return Err(Error::Validation("本地终端清理状态不可用"));
        }
        Ok(())
    }
    pub(crate) async fn close_all(&self, shutdown: bool) -> Result<(), Error> {
        let ids = {
            let sessions = lock(&self.sessions)?;
            if shutdown {
                self.stopped.store(true, Ordering::Release);
            }
            for control in sessions.values() {
                control.cancel();
            }
            sessions.keys().cloned().collect::<Vec<_>>()
        };
        let mut failure = None;
        for id in ids {
            if let Err(error) = self.close(&id).await {
                failure = Some(error);
            }
        }
        failure.map_or(Ok(()), Err)
    }
}

fn output(mut reader: Box<dyn Read + Send>, control: &Control, sink: &Sink) -> Result<(), Error> {
    let mut buffer = [0; 8192];
    let mut failure = None;
    loop {
        let count = match reader.read(&mut buffer) {
            Ok(0) => return failure.map_or(Ok(()), Err),
            Ok(count) => count,
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::BrokenPipe | std::io::ErrorKind::UnexpectedEof
                ) || (cfg!(unix) && error.raw_os_error() == Some(5)) =>
            {
                return failure.map_or(Ok(()), Err);
            }
            Err(error) => return Err(failed("读取本地终端输出失败", error)),
        };
        // Drain after cancellation so ConPTY teardown cannot deadlock on its output pipe.
        if control.cancelled.load(Ordering::Acquire) {
            continue;
        }
        let value = {
            let mut sequence = lock(&control.sequence)?;
            sequence.0 += 1;
            sequence.0
        };
        if !sink(TerminalEvent::Data {
            sequence: value,
            data: buffer[..count].to_vec(),
        }) {
            control.cancel();
            continue;
        }
        let deadline = Instant::now() + ACK_TIMEOUT;
        let mut sequence = lock(&control.sequence)?;
        while sequence.1 < value && !control.cancelled.load(Ordering::Acquire) {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                failure = Some(Error::Connection {
                    code: "LOCAL_TERMINAL",
                    message: "本地终端输出确认超时，会话已停止",
                    source: None,
                });
                control.cancel();
                break;
            }
            sequence = control
                .parsed
                .wait_timeout(sequence, remaining)
                .map_err(|_| Error::Validation("本地终端输出状态不可用"))?
                .0;
        }
    }
}
fn run(
    id: &str,
    size: TerminalSize,
    control: &Arc<Control>,
    sink: &Sink,
    receiver: mpsc::Receiver<Command>,
    ready: oneshot::Sender<Result<LocalTerminalSession, Error>>,
) -> Result<(), Error> {
    let startup = (|| {
        let (command, name) = shell()?;
        let pair = native_pty_system()
            .openpty(dimensions(size))
            .map_err(|error| failed("无法创建本地伪终端", error))?;
        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|error| failed("无法读取本地伪终端", error))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|error| failed("无法写入本地伪终端", error))?;
        let child = pair
            .slave
            .spawn_command(command)
            .map_err(|error| failed("无法启动本地 Shell", error))?;
        drop(pair.slave);
        Ok::<_, Error>((pair.master, reader, writer, child, name))
    })();
    let (master, reader, mut writer, mut child, name) = match startup {
        Ok(value) => value,
        Err(error) => {
            tracing::warn!(operation = "local_terminal_start", error = %error, source = ?std::error::Error::source(&error), "could not start local shell");
            let _ = ready.send(Err(error));
            return Ok(());
        }
    };
    *lock(&control.killer)? = Some(child.clone_killer());
    let output_control = control.clone();
    let output_sink = sink.clone();
    let reader = std::thread::Builder::new()
        .name("local-pty-output".into())
        .spawn(move || {
            let result = output(reader, &output_control, &output_sink);
            if result.is_err() {
                output_control.cancel();
            }
            result
        });
    let reader = match reader {
        Ok(value) => value,
        Err(error) => {
            child
                .kill()
                .map_err(|error| failed("无法停止本地 Shell", error))?;
            child
                .wait()
                .map_err(|error| failed("无法回收本地 Shell", error))?;
            return Err(failed("无法启动本地终端输出任务", error));
        }
    };
    if ready
        .send(Ok(LocalTerminalSession {
            id: id.into(),
            shell: name,
        }))
        .is_err()
    {
        control.cancel();
    }
    if !sink(TerminalEvent::State {
        state: "connected",
        code: None,
        message: None,
    }) {
        control.cancel();
    }
    let result = (|| {
        loop {
            if control.cancelled.load(Ordering::Acquire) {
                child
                    .kill()
                    .map_err(|error| failed("无法停止本地 Shell", error))?;
                break child
                    .wait()
                    .map_err(|error| failed("无法回收本地 Shell", error));
            }
            if let Some(status) = child
                .try_wait()
                .map_err(|error| failed("无法读取本地进程状态", error))?
            {
                break Ok(status);
            }
            match receiver.recv_timeout(Duration::from_millis(20)) {
                Ok(Command::Input(data)) => writer
                    .write_all(&data)
                    .and_then(|()| writer.flush())
                    .map_err(|error| failed("本地终端输入失败", error))?,
                Ok(Command::Resize(size)) => master
                    .resize(dimensions(size))
                    .map_err(|error| failed("本地终端尺寸调整失败", error))?,
                Err(mpsc::RecvTimeoutError::Timeout) => (),
                Err(mpsc::RecvTimeoutError::Disconnected) => control.cancel(),
            }
        }
    })();
    if result.is_err() {
        control.cancel();
        if let Err(error) = child.kill().and_then(|()| child.wait().map(|_| ())) {
            tracing::warn!(operation = "local_terminal_cleanup", error = %error, "could not reap shell after failure");
        }
    }
    // The reader continues draining while Windows closes the pseudoconsole.
    drop(writer);
    drop(master);
    let read_result = reader
        .join()
        .map_err(|_| Error::Validation("本地终端输出任务异常结束"))?;
    *lock(&control.killer)? = None;
    let status = result?;
    read_result?;
    sink(TerminalEvent::Exit {
        status: Some(status.exit_code()),
    });
    sink(TerminalEvent::State {
        state: "closed",
        code: None,
        message: None,
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    #[test]
    fn user_shell_path_is_a_single_executable_argument() {
        let root = tempfile::tempdir().expect("shell directory");
        let path = root.path().join("user shell '$");
        std::os::unix::fs::symlink("/bin/sh", &path).expect("shell symlink");
        let mut defaults = CommandBuilder::new_default_prog();
        defaults.env("SHELL", &path);
        let (command, name) = unix_shell(defaults);
        assert_eq!(name, "user shell '$");
        assert_eq!(command.get_argv(), &[path.as_os_str(), "-i".as_ref()]);
        assert_eq!(command.get_env("SHELL"), Some(path.as_os_str()));
    }
    #[cfg(unix)]
    #[test]
    fn missing_or_invalid_shell_falls_back_to_account_shell() {
        let mut defaults = CommandBuilder::new_default_prog();
        defaults.env_remove("SHELL");
        let account_shell = defaults.get_shell();
        let (command, _) = unix_shell(defaults);
        assert_eq!(command.get_argv()[0], account_shell.as_str());
        let root = tempfile::tempdir().expect("shell directory");
        let not_executable = root.path().join("not-executable");
        std::fs::write(&not_executable, "exit 1\n").expect("non executable file");
        for value in [
            std::ffi::OsStr::new(""),
            root.path().join("missing-shell").as_os_str(),
            not_executable.as_os_str(),
            std::ffi::OsStr::new("/bin/sh -c 'exit 1'"),
        ] {
            let mut defaults = CommandBuilder::new_default_prog();
            defaults.env("SHELL", value);
            let (command, _) = unix_shell(defaults);
            assert_eq!(command.get_argv()[0], account_shell.as_str());
            assert_eq!(command.get_env("SHELL"), Some(account_shell.as_ref()));
        }
    }
    #[cfg(target_os = "linux")]
    #[test]
    fn interactive_bash_loads_user_prompt_and_aliases() {
        let home = tempfile::tempdir().expect("isolated home");
        std::fs::write(
            home.path().join(".bashrc"),
            "PS1='__SD_USER_PROMPT__ '; alias sd_rc_probe='printf SD_RC_%s 741'\n",
        )
        .expect("user bashrc");
        let mut defaults = CommandBuilder::new_default_prog();
        defaults.env("SHELL", "/bin/bash");
        defaults.env("HOME", home.path());
        let (mut command, name) = unix_shell(defaults);
        command.cwd(home.path());
        command.env("TERM", "xterm-256color");
        assert_eq!(name, "bash");
        let pair = native_pty_system()
            .openpty(dimensions(TerminalSize { cols: 90, rows: 25 }))
            .expect("PTY");
        let reader = pair.master.try_clone_reader().expect("reader");
        let mut writer = pair.master.take_writer().expect("writer");
        let mut child = pair.slave.spawn_command(command).expect("Bash");
        drop(pair.slave);
        let (send, receive) = mpsc::sync_channel(1);
        let reading = std::thread::spawn(move || {
            let mut output = Vec::new();
            let result = reader.take(64 * 1024).read_to_end(&mut output);
            send.send((result, output)).expect("read result");
        });
        writer
            .write_all(b"sd_rc_probe; printf '\\n'; exit 7\r")
            .expect("input");
        writer.flush().expect("flush");
        let output = receive.recv_timeout(Duration::from_secs(15));
        if output.is_err() {
            child.kill().expect("stop timed out shell");
        }
        let status = child.wait().expect("reap Bash");
        drop(writer);
        drop(pair.master);
        reading.join().expect("PTY reader");
        let (read_result, output) = output.expect("Bash output timeout");
        if let Err(error) = read_result {
            assert_eq!(error.raw_os_error(), Some(5), "PTY EOF: {error}");
        }
        assert_eq!(status.exit_code(), 7);
        let output = String::from_utf8(output).expect("UTF-8 output");
        assert!(output.contains("__SD_USER_PROMPT__"), "{output}");
        assert!(output.contains("SD_RC_741"), "{output}");
    }
    async fn next(events: &mut tokio::sync::mpsc::Receiver<TerminalEvent>) -> TerminalEvent {
        tokio::time::timeout(Duration::from_secs(15), events.recv())
            .await
            .expect("PTY event timeout")
            .expect("PTY events")
    }
    fn events() -> (Sink, tokio::sync::mpsc::Receiver<TerminalEvent>) {
        let (send, receive) = tokio::sync::mpsc::channel(32);
        (Arc::new(move |event| send.try_send(event).is_ok()), receive)
    }
    async fn until(
        engine: &LocalTerminals,
        id: &str,
        events: &mut tokio::sync::mpsc::Receiver<TerminalEvent>,
        marker: &str,
    ) -> String {
        let mut text = String::new();
        loop {
            match next(events).await {
                TerminalEvent::Data { sequence, data } => {
                    let chunk = String::from_utf8_lossy(&data);
                    if chunk.contains("\x1b[6n") {
                        engine
                            .input(id, b"\x1b[1;1R".to_vec())
                            .expect("cursor report");
                    }
                    text.push_str(&chunk);
                    engine.ack(id, sequence).expect("parsed output");
                    if text.contains(marker) {
                        return text;
                    }
                }
                TerminalEvent::State {
                    state: "failed",
                    message,
                    ..
                } => panic!("PTY failure: {message:?}"),
                _ => (),
            }
        }
    }
    #[tokio::test(flavor = "multi_thread")]
    async fn real_shell_input_output_resize_exit_and_independent_cancellation() {
        let engine = LocalTerminals::new();
        let (sink, mut first_events) = events();
        let first = engine
            .open(TerminalSize { cols: 90, rows: 25 }, sink)
            .await
            .expect("first PTY");
        assert_eq!(first.shell, shell().expect("default shell").1);
        let (sink, mut second_events) = events();
        let second = engine
            .open(TerminalSize { cols: 90, rows: 25 }, sink)
            .await
            .expect("second PTY");
        // Do not acknowledge the first session: closing must unblock its reader anyway.
        loop {
            if matches!(next(&mut first_events).await, TerminalEvent::Data { .. }) {
                break;
            }
        }
        assert!(engine.ack(&first.id, u64::MAX).is_err());
        engine
            .close(&first.id)
            .await
            .expect("close unacknowledged PTY");
        assert!(
            engine.get(&second.id).is_ok(),
            "closing one must preserve the other"
        );
        engine
            .resize(
                &second.id,
                TerminalSize {
                    cols: 101,
                    rows: 31,
                },
            )
            .expect("resize");
        let command = if cfg!(windows) {
            "[Console]::WriteLine(('SD_REAL_' + (17*19))); [Console]::WriteLine(('SD_COLS_' + [Console]::WindowWidth));\r"
        } else {
            "printf 'SD_REAL_%s\\n' \"$((17*19))\"; printf 'SD_COLS_%s\\n' \"$(stty size | cut -d' ' -f2)\"\r"
        };
        engine
            .input(&second.id, command.as_bytes().to_vec())
            .expect("input");
        let output = until(&engine, &second.id, &mut second_events, "SD_COLS_101").await;
        assert!(
            output.contains("SD_REAL_323"),
            "real shell must evaluate arithmetic"
        );
        engine
            .input(&second.id, b"exit 7\r".to_vec())
            .expect("exit command");
        loop {
            match next(&mut second_events).await {
                TerminalEvent::Data { sequence, .. } => {
                    engine.ack(&second.id, sequence).expect("ACK");
                }
                TerminalEvent::Exit { status } => {
                    assert_eq!(status, Some(7));
                    break;
                }
                TerminalEvent::State {
                    state: "failed",
                    message,
                    ..
                } => panic!("exit failure: {message:?}"),
                _ => (),
            }
        }
        engine.close_all(true).await.expect("shutdown");
        assert!(lock(&engine.sessions).expect("sessions").is_empty());
        let (sink, _) = events();
        assert!(matches!(
            engine.open(TerminalSize { cols: 80, rows: 24 }, sink).await,
            Err(Error::ShuttingDown)
        ));
    }
    #[tokio::test]
    async fn rejects_invalid_dimensions_input_and_excess_sessions_before_starting_shell() {
        let engine = LocalTerminals::new();
        let (sink, _) = events();
        assert!(matches!(
            engine
                .open(TerminalSize { cols: 0, rows: 24 }, sink.clone())
                .await,
            Err(Error::Validation(_))
        ));
        let _slots = engine
            .slots
            .clone()
            .acquire_many_owned(LIMIT as u32)
            .await
            .expect("slots");
        assert!(matches!(
            engine.open(TerminalSize { cols: 80, rows: 24 }, sink).await,
            Err(Error::Busy)
        ));
        assert!(matches!(
            engine.input("missing", vec![0; 16385]),
            Err(Error::Validation(_))
        ));
        assert!(matches!(
            engine.input("missing", vec![1]),
            Err(Error::NotFound)
        ));
    }
}
