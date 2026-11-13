use super::*;
use std::path::Path;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct LaunchDirectory {
    pub directory: Option<String>,
    pub token: uuid::Uuid,
}

impl LaunchDirectory {
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
            // PowerShell's provider location can differ from the process working directory.
            // Report only filesystem locations, after the command has finished.
            let script = format!(
                r#"if ($env:SERVERDECK_START_DIRECTORY) {{
    try {{ Set-Location -LiteralPath $env:SERVERDECK_START_DIRECTORY -ErrorAction Stop }}
    catch {{ Set-Location -LiteralPath $env:USERPROFILE -ErrorAction Stop }}
    Remove-Item Env:\SERVERDECK_START_DIRECTORY
}}
function global:prompt {{
    $serverDeckDirectory = ''
    if ($PWD.Provider.Name -eq 'FileSystem') {{ $serverDeckDirectory = $PWD.ProviderPath }}
    [Console]::Write(([string][char]27 + ']777;serverdeck-cwd;{};' + $serverDeckDirectory + [char]7))
    'PS ' + $executionContext.SessionState.Path.CurrentLocation + ('>' * ($nestedPromptLevel + 1)) + ' '
}}"#,
                self.token
            );
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
pub(super) struct DirectoryTracker {
    prefix: String,
    state: ParseState,
    bytes: Vec<u8>,
    previous: Option<String>,
}
impl DirectoryTracker {
    pub(super) fn new(token: uuid::Uuid) -> Self {
        Self {
            prefix: format!("777;serverdeck-cwd;{token};"),
            state: ParseState::Text,
            bytes: Vec::new(),
            previous: None,
        }
    }
    pub(super) fn feed(&mut self, data: &[u8]) -> Option<String> {
        let mut directory = None;
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
                    if let Ok(value) = std::str::from_utf8(&self.bytes)
                        && let Some(path) = value.strip_prefix(&self.prefix)
                        && (path.is_empty() || valid_path(path))
                        && self.previous.as_deref() != Some(path)
                    {
                        self.previous = Some(path.to_owned());
                        directory = self.previous.clone();
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
        directory
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
            let mut tracker = DirectoryTracker::new(token);
            let first = tracker.feed(&bytes[..split]);
            let second = tracker.feed(&bytes[split..]);
            assert_eq!(first.or(second), Some(path.clone()), "split at {split}");
            assert_eq!(
                tracker.feed(&bytes),
                None,
                "unchanged prompt needs no extra directory notification"
            );
        }
        let mut tracker = DirectoryTracker::new(token);
        let mut observed = None;
        for byte in bytes {
            observed = tracker.feed(&[byte]).or(observed);
        }
        assert_eq!(observed, Some(path.clone()));
        let second = root.path().to_str().unwrap();
        let st = format!("\x1b]777;serverdeck-cwd;{token};{second}\x1b\\");
        assert_eq!(tracker.feed(st.as_bytes()), Some(second.to_owned()));
        assert_eq!(
            tracker.feed(&marker(token, "")),
            Some(String::new()),
            "non-filesystem prompts must invalidate the previous directory"
        );
    }

    #[test]
    fn ignores_foreign_invalid_and_oversized_output_then_recovers() {
        let token = uuid::Uuid::new_v4();
        let root = tempfile::tempdir().unwrap();
        let path = root.path().to_str().unwrap();
        let mut tracker = DirectoryTracker::new(token);
        for bytes in [
            marker(uuid::Uuid::new_v4(), path),
            marker(token, "relative/path"),
            marker(token, &format!("{path}\ncommand")),
            marker(token, &"x".repeat(100_000)),
            b"\x1b]0;title\x07ordinary output".to_vec(),
            b"\x1b]777;serverdeck-cwd;\xff\x07".to_vec(),
        ] {
            assert_eq!(tracker.feed(&bytes), None);
            assert!(tracker.bytes.len() <= 32768 + tracker.prefix.len());
        }
        assert_eq!(tracker.feed(&marker(token, path)), Some(path.to_owned()));
    }

    #[test]
    fn missing_directory_keeps_the_home_fallback_and_paths_never_become_arguments() {
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().join("中文 space '&;$[]");
        std::fs::create_dir(&directory).unwrap();
        let launch = LaunchDirectory {
            directory: Some(directory.to_str().unwrap().to_owned()),
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
