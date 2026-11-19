use super::*;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serverdeck_core::terminal::{SshPaneSnapshot, SshPaneState};

pub(super) enum ShellCommand {
    Fixed(String),
    Interactive(Option<SshPaneSnapshot>),
}

pub(super) enum Capture {
    Layout(String),
    Bash(Tracker),
}

pub(super) struct Tracker {
    prefix: Vec<u8>,
    matched: usize,
    payload: Vec<u8>,
    identity: String,
    state: SshPaneState,
}
impl Tracker {
    fn new(id: &str, identity: String) -> Self {
        Self {
            prefix: format!("\x1b]777;sd-ssh;{id};").into_bytes(),
            matched: 0,
            payload: Vec::new(),
            identity,
            state: SshPaneState {
                directory: String::new(),
                command: String::new(),
            },
        }
    }
    pub(super) fn feed(&mut self, mut bytes: &[u8]) {
        while !bytes.is_empty() {
            if self.matched == 0 {
                let Some(start) = bytes.iter().position(|b| *b == 27) else {
                    return;
                };
                bytes = &bytes[start + 1..];
                self.matched = 1;
                self.payload.clear();
                continue;
            }
            let byte = bytes[0];
            bytes = &bytes[1..];
            if byte == 27 {
                self.matched = 1;
                self.payload.clear();
            } else if self.matched < self.prefix.len() {
                if self.prefix[self.matched] == byte {
                    self.matched += 1;
                } else {
                    self.matched = 0;
                }
            } else if byte == 7 {
                self.report();
                self.matched = 0;
            } else if self.payload.len() < 5468 {
                self.payload.push(byte);
            } else {
                self.invalidate();
                self.matched = 0;
            }
        }
    }
    fn invalidate(&mut self) {
        if self.payload.starts_with(b"cwd;") {
            self.state.directory.clear();
        }
        if self.payload.starts_with(b"cmd;") {
            self.state.command.clear();
        }
    }
    fn report(&mut self) {
        self.invalidate();
        let Some(encoded) = self.payload.get(4..) else {
            return;
        };
        let Some(text) = STANDARD
            .decode(encoded)
            .ok()
            .and_then(|v| String::from_utf8(v).ok())
        else {
            return;
        };
        if text.len() > 4096
            || text
                .chars()
                .any(|c| c.is_control() || matches!(c, '\u{2028}' | '\u{2029}'))
        {
            return;
        }
        if self.payload.starts_with(b"cwd;") && text.starts_with('/') {
            self.state.directory = text;
        } else if self.payload.starts_with(b"cmd;") {
            self.state.command = text;
        }
    }
}

impl Engine {
    pub fn open_interactive_plan(
        &self,
        host: Host,
        plan: ConnectionPlan,
        size: TerminalSize,
        sink: Sink,
        restore: Option<SshPaneSnapshot>,
    ) -> Result<TerminalSession, Error> {
        if let Some(state) = restore.as_ref().and_then(|pane| pane.state.as_ref()) {
            state.validate()?;
        }
        self.open_internal(
            host,
            plan,
            size,
            sink,
            SessionKind::Terminal,
            Some(ShellCommand::Interactive(restore)),
            None,
        )
    }
    pub fn shell_snapshot(
        &self,
        host_id: &str,
        session_id: &str,
    ) -> Result<SshPaneSnapshot, Error> {
        let control = self.control(session_id)?;
        if control.info.host_id != host_id
            || !control.ready.load(Ordering::Acquire)
            || control.cancel.is_cancelled()
        {
            return Err(Error::Validation("SSH 窗格已关闭或主机不匹配"));
        }
        let tracked = locked(&control.snapshot)?;
        match tracked.as_ref() {
            Some(Capture::Layout(identity)) => Ok(SshPaneSnapshot {
                identity: identity.clone(),
                state: None,
            }),
            Some(Capture::Bash(t)) if !t.state.directory.is_empty() => Ok(SshPaneSnapshot {
                identity: t.identity.clone(),
                state: Some(t.state.clone()),
            }),
            _ => Err(Error::Validation(
                "当前 SSH Shell 未提供会话目录和命令。请在 Bash 4.4 或更高版本的提示符出现后保存。",
            )),
        }
    }
}

// Probe on a separate, non-PTY channel. Appliances and non-Bash accounts
// keep their normal shell request, including servers which disallow exec.
pub(super) async fn supports_snapshot(handle: &connect::Connection) -> bool {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
    let Ok(Ok(mut channel)) =
        tokio::time::timeout_at(deadline, handle.channel_open_session()).await
    else {
        return false;
    };
    let check = async {
        let probe = r#"[[ -n $BASH_VERSION && ${SHELL##*/} == bash ]] && ! shopt -q restricted_shell && (( BASH_VERSINFO[0] * 100 + BASH_VERSINFO[1] >= 404 )) && command -v base64 >/dev/null && printf sd-bash-1"#;
        channel.exec(true, probe).await.ok()?;
        let mut output = Vec::new();
        while let Some(msg) = channel.wait().await {
            match msg {
                ChannelMsg::Data { data } if output.len() + data.len() <= 128 => {
                    output.extend_from_slice(&data)
                }
                ChannelMsg::Data { .. } | ChannelMsg::Failure => return None,
                ChannelMsg::Close => {
                    break;
                }
                _ => {}
            }
        }
        (output == b"sd-bash-1").then_some(())
    };
    let supported = matches!(tokio::time::timeout_at(deadline, check).await, Ok(Some(())));
    if !supported {
        // Shell-only servers may leave a rejected or unanswered exec channel open.
        let _ = tokio::time::timeout(Duration::from_secs(2), channel.close()).await;
    }
    supported
}

async fn until_marker(
    channel: &mut Channel<client::Msg>,
    marker: &[u8],
    output: &mut Vec<u8>,
) -> Result<(), Error> {
    let start = output.len();
    loop {
        if let Some(index) = output[start..]
            .windows(marker.len())
            .position(|w| w == marker)
        {
            output.drain(start + index..start + index + marker.len());
            return Ok(());
        }
        match channel.wait().await {
            Some(ChannelMsg::Data { data } | ChannelMsg::ExtendedData { data, .. })
                if output.len() + data.len() <= 64 * 1024 =>
            {
                output.extend_from_slice(&data)
            }
            Some(
                ChannelMsg::Data { .. }
                | ChannelMsg::ExtendedData { .. }
                | ChannelMsg::Close
                | ChannelMsg::Eof
                | ChannelMsg::Failure,
            )
            | None => return Err(Error::Validation("远端 Shell 无法恢复保存的会话")),
            _ => {}
        }
    }
}

pub(super) async fn start(
    handle: &connect::Connection,
    channel: &mut Channel<client::Msg>,
    control: &Control,
    host: &Host,
    restore: Option<SshPaneSnapshot>,
) -> Result<Vec<u8>, Error> {
    let identity = serde_json::to_string(&(
        &host.id,
        &host.config.hostname,
        host.config.port,
        &host.config.username,
        &handle.verified_key,
    ))
    .map_err(|_| Error::Validation("无法验证 SSH 会话身份"))?;
    if restore
        .as_ref()
        .is_some_and(|pane| pane.identity != identity)
    {
        return Err(Error::Validation(
            "SSH 主机密钥、地址或登录用户已变更，无法恢复原会话",
        ));
    }
    let restore = restore.and_then(|pane| pane.state);
    if handle.bash_snapshot.get() != Some(&true) {
        if restore.is_some() {
            return Err(Error::Validation("远端 Shell 无法恢复保存的会话"));
        }
        channel.request_shell(true).await.map_err(network)?;
        accepted(channel).await?;
        *locked(&control.snapshot)? = Some(Capture::Layout(identity));
        return Ok(Vec::new());
    }
    let id = &control.info.id;
    let script = include_str!("session.bash")
        .replace("\r\n", "\n")
        .replace("__TOKEN__", id)
        .replace("__RESTORE__", if restore.is_some() { "yes" } else { "no" });
    // Only bundled source and the generated UUID enter the exec request.
    let encoded = STANDARD.encode(script);
    let command = format!(r#"exec "$SHELL" --rcfile <(printf %s '{encoded}' | base64 -d) -i"#);
    channel.exec(true, command).await.map_err(network)?;
    accepted(channel).await?;
    let mut output = Vec::new();
    if let Some(pane) = restore {
        until_marker(
            channel,
            format!("\x1b]777;sd-read;{id}\x07").as_bytes(),
            &mut output,
        )
        .await?;
        let payload = format!(
            "{}\n{}\n",
            STANDARD.encode(&pane.directory),
            STANDARD.encode(&pane.command)
        );
        channel
            .data_bytes(payload.into_bytes())
            .await
            .map_err(network)?;
        until_marker(
            channel,
            format!("\x1b]777;sd-edit;{id}\x07").as_bytes(),
            &mut output,
        )
        .await?;
        if !pane.command.is_empty() {
            channel
                .data_bytes(b"\x1b[777~".to_vec())
                .await
                .map_err(network)?;
        }
    }
    *locked(&control.snapshot)? = Some(Capture::Bash(Tracker::new(id, identity)));
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn shell_snapshot_tracks_fragmented_private_reports_and_discards_invalid_values() {
        let report = |id, tag, value: &str| {
            format!("\x1b]777;sd-ssh;{id};{tag};{}\x07", STANDARD.encode(value))
        };
        let mut tracker = Tracker::new("pane", "identity".into());
        for byte in report("pane", "cwd", "/工作/a b")
            .bytes()
            .chain(report("pane", "cmd", "echo ok").bytes())
        {
            tracker.feed(&[byte]);
        }
        tracker.feed(report("other", "cmd", "wrong").as_bytes());
        tracker.feed(b"Password: hidden");
        assert_eq!(tracker.state.directory, "/工作/a b");
        assert_eq!(tracker.state.command, "echo ok");
        for invalid in ["bad\ncommand".to_owned(), "X".repeat(9000)] {
            tracker.feed(report("pane", "cmd", &invalid).as_bytes());
            assert!(tracker.state.command.is_empty());
        }
        tracker.feed(report("pane", "cwd", "relative").as_bytes());
        assert!(tracker.state.directory.is_empty());
    }
}
