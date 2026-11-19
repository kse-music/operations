use super::*;
use std::path::Path;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct ShellLaunch {
    pub directory: Option<String>,
    pub protected_command: Option<String>,
    pub token: uuid::Uuid,
}

impl ShellLaunch {
    pub(super) fn configure(&self, command: &mut CommandBuilder) {
        if let Some(directory) = &self.directory
            && valid_path(directory)
            && Path::new(directory).is_dir()
        {
            // The path is process data, never PowerShell source or terminal input.
            command.cwd(directory);
        }
        #[cfg(windows)]
        {
            use base64::Engine;
            // PowerShell can reset a native cwd containing wildcard characters during startup.
            // Restore its provider location with LiteralPath, passing the value only as data.
            command.env_remove("SERVERDECK_START_DIRECTORY");
            if let Some(directory) = command.get_cwd().cloned() {
                command.env("SERVERDECK_START_DIRECTORY", directory);
            }
            command.env_remove("SERVERDECK_START_COMMAND");
            if let Some(blob) = &self.protected_command
                && command.get_cwd().and_then(|cwd| cwd.to_str()) == self.directory.as_deref()
                && serverdeck_core::terminal::valid_protected_command(blob)
            {
                command.env("SERVERDECK_START_COMMAND", blob);
            }
            let script = include_str!("session.ps1").replace("__TOKEN__", &self.token.to_string());
            let bytes: Vec<_> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
            command.args([
                "-NoExit",
                "-EncodedCommand",
                &base64::engine::general_purpose::STANDARD.encode(bytes),
            ]);
        }
    }
}

fn valid_path(path: &str) -> bool {
    path.len() <= 32768 && Path::new(path).is_absolute() && !path.chars().any(char::is_control)
}

// Parse the stream, not individual PTY frames: both UTF-8 and OSC can span reads.
// Unknown, malformed and overlong sequences never change the saved directory.
enum ParseState {
    Text,
    Escape,
    Osc,
    OscEscape,
    Discard,
    DiscardEscape,
}
pub(super) struct ShellTracker {
    prefix: String,
    command_prefix: String,
    state: ParseState,
    bytes: Vec<u8>,
    pub directory: Option<String>,
    pub protected_command: Option<String>,
}
impl ShellTracker {
    pub(super) fn new(token: uuid::Uuid) -> Self {
        Self {
            prefix: format!("777;serverdeck-cwd;{token};"),
            command_prefix: format!("777;serverdeck-command;{token};"),
            state: ParseState::Text,
            bytes: Vec::new(),
            directory: None,
            protected_command: None,
        }
    }
    pub(super) fn feed(&mut self, data: &[u8]) {
        for &byte in data {
            self.state = match (&self.state, byte) {
                (ParseState::Text, 27) => ParseState::Escape,
                (ParseState::Escape, b']') => {
                    self.bytes.clear();
                    ParseState::Osc
                }
                (ParseState::Escape, 27) => ParseState::Escape,
                (ParseState::Text | ParseState::Escape, _) => ParseState::Text,
                (ParseState::Osc, 7) | (ParseState::OscEscape, b'\\') => {
                    if let Ok(value) = std::str::from_utf8(&self.bytes) {
                        if let Some(path) = value.strip_prefix(&self.prefix)
                            && (path.is_empty() || valid_path(path))
                            && self.directory.as_deref() != Some(path)
                        {
                            self.directory = (!path.is_empty()).then(|| path.to_owned());
                        } else if let Some(blob) = value.strip_prefix(&self.command_prefix)
                            && (blob.is_empty()
                                || serverdeck_core::terminal::valid_protected_command(blob))
                        {
                            self.protected_command = (!blob.is_empty()).then(|| blob.to_owned());
                        }
                    }
                    self.bytes.clear();
                    ParseState::Text
                }
                (ParseState::Osc, 27) => ParseState::OscEscape,
                (ParseState::OscEscape, _) => {
                    self.bytes.clear();
                    ParseState::Discard
                }
                (ParseState::Osc, _) if self.bytes.len() < 32768 + self.prefix.len() => {
                    self.bytes.push(byte);
                    ParseState::Osc
                }
                (ParseState::Osc, _) => {
                    self.bytes.clear();
                    ParseState::Discard
                }
                (ParseState::Discard | ParseState::DiscardEscape, 7)
                | (ParseState::DiscardEscape, b'\\') => ParseState::Text,
                (ParseState::Discard | ParseState::DiscardEscape, 27) => ParseState::DiscardEscape,
                (ParseState::Discard | ParseState::DiscardEscape, _) => ParseState::Discard,
            };
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn marker(token: uuid::Uuid, directory: &str) -> Vec<u8> {
        format!("\x1b]777;serverdeck-cwd;{token};{directory}\x07").into_bytes()
    }

    #[test]
    fn tracks_fragmented_unicode_and_only_actual_directory_changes() {
        let token = uuid::Uuid::new_v4();
        let root = tempfile::tempdir().unwrap();
        let path = root
            .path()
            .join("中文 space '&;$[]")
            .to_str()
            .unwrap()
            .to_owned();
        let bytes = marker(token, &path);
        for split in 0..=bytes.len() {
            let mut tracker = ShellTracker::new(token);
            tracker.feed(&bytes[..split]);
            tracker.feed(&bytes[split..]);
            assert_eq!(tracker.directory.as_ref(), Some(&path), "split at {split}");
        }
        let mut tracker = ShellTracker::new(token);
        for byte in bytes {
            tracker.feed(&[byte]);
        }
        assert_eq!(tracker.directory, Some(path.clone()));
        let second = root.path().to_str().unwrap();
        let st = format!("\x1b]777;serverdeck-cwd;{token};{second}\x1b\\");
        tracker.feed(st.as_bytes());
        assert_eq!(tracker.directory.as_deref(), Some(second));
        tracker.feed(&marker(token, ""));
        assert_eq!(
            tracker.directory, None,
            "non-filesystem prompts must invalidate the previous directory"
        );
    }

    #[test]
    fn ignores_foreign_invalid_and_oversized_output_then_recovers() {
        let token = uuid::Uuid::new_v4();
        let root = tempfile::tempdir().unwrap();
        let path = root.path().to_str().unwrap();
        let mut tracker = ShellTracker::new(token);
        for bytes in [
            marker(uuid::Uuid::new_v4(), path),
            marker(token, "relative/path"),
            marker(token, &format!("{path}\ncommand")),
            marker(token, &"x".repeat(100_000)),
            b"\x1b]0;title\x07ordinary output".to_vec(),
            b"\x1b]777;serverdeck-cwd;\xff\x07".to_vec(),
        ] {
            tracker.feed(&bytes);
            assert_eq!(tracker.directory, None);
            assert!(tracker.bytes.len() <= 32768 + tracker.prefix.len());
        }
        tracker.feed(&marker(token, path));
        assert_eq!(tracker.directory.as_deref(), Some(path));
    }

    #[test]
    fn command_markers_are_bounded_and_isolated_per_shell() {
        let token = uuid::Uuid::new_v4();
        let command = |id, blob: &str| format!("\x1b]777;serverdeck-command;{id};{blob}\x07");
        let mut tracker = ShellTracker::new(token);
        for byte in command(token, "AQID").bytes() {
            tracker.feed(&[byte]);
        }
        for invalid in [
            command(uuid::Uuid::new_v4(), ""),
            command(token, "A\nBC"),
            command(token, &"A".repeat(8196)),
        ] {
            tracker.feed(invalid.as_bytes());
            assert_eq!(tracker.protected_command.as_deref(), Some("AQID"));
        }
        tracker.feed(command(token, "").as_bytes());
        assert!(tracker.protected_command.is_none());
    }

    #[test]
    fn missing_directory_keeps_the_home_fallback_and_paths_never_become_arguments() {
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().join("中文 space '&;$[]");
        std::fs::create_dir(&directory).unwrap();
        let launch = ShellLaunch {
            directory: Some(directory.to_str().unwrap().to_owned()),
            protected_command: None,
            token: uuid::Uuid::new_v4(),
        };
        let (mut command, _) = shell().unwrap();
        launch.configure(&mut command);
        assert_eq!(
            command.get_cwd().map(|path| path.as_os_str()),
            Some(directory.as_os_str())
        );
        assert!(
            command
                .get_argv()
                .iter()
                .all(|arg| !arg.to_string_lossy().contains("中文"))
        );
        std::fs::remove_dir(&directory).unwrap();
        let (mut command, _) = shell().unwrap();
        let home = command.get_cwd().map(ToOwned::to_owned);
        launch.configure(&mut command);
        assert_eq!(command.get_cwd(), home.as_ref());
    }
}
