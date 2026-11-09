use crate::Error;
use serde::{Deserialize, Serialize};

pub const fn default_concurrency() -> u8 {
    3
}
pub const TEXT_LIMIT: usize = 2 * 1024 * 1024;
pub const TREE_LIMIT: usize = 100_000;
pub const LIST_LIMIT: usize = 20_000;

// Runtime-only sudo authorization. Never serialize or log the password.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SftpUser {
    pub username: String,
    pub server_path: String,
    pub password: Option<zeroize::Zeroizing<String>>,
}
impl SftpUser {
    pub fn validate(&self) -> Result<(), Error> {
        if self.username.is_empty()
            || self.username.len() > 64
            || self.username.starts_with('-')
            || !self
                .username
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"_.-".contains(&c))
        {
            return Err(Error::Validation(
                "目标用户名须为 1–64 位字母、数字、下划线、点或连字符，不能以 - 开头",
            ));
        }
        if !self.server_path.is_empty()
            && (!self.server_path.starts_with('/')
                || self.server_path.len() > 4096
                || self.server_path.chars().any(char::is_control)
                || self.server_path.split('/').any(|part| part == ".."))
        {
            return Err(Error::Validation(
                "SFTP 服务程序须为远程绝对路径，留空时自动查找",
            ));
        }
        if self.password.as_ref().is_some_and(|password| {
            password.is_empty() || password.len() > 4096 || password.chars().any(char::is_control)
        }) {
            return Err(Error::Validation(
                "sudo 密码不能含换行或控制字符，最多 4096 字节",
            ));
        }
        Ok(())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileUserSession {
    pub session: crate::terminal::TerminalSession,
    pub listing: DirectoryListing,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EntryKind {
    File,
    Directory,
    Symlink,
    Other,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub kind: EntryKind,
    pub size: Option<u64>,
    pub modified: Option<u64>,
    pub permissions: Option<u32>,
    #[serde(default)]
    pub owner: Option<String>,
    pub uid: Option<u32>,
    pub gid: Option<u32>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryListing {
    pub path: String,
    pub parent: Option<String>,
    pub entries: Vec<FileEntry>,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum RemoteAction {
    Mkdir {
        path: String,
    },
    Rename {
        path: String,
        destination: String,
    },
    Remove {
        paths: Vec<String>,
        recursive: bool,
        confirmed: bool,
    },
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Direction {
    Upload,
    Download,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConflictPolicy {
    Fail,
    Skip,
    Rename,
    Overwrite,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TransferInput {
    pub session_id: String,
    pub direction: Direction,
    pub sources: Vec<String>,
    pub destination: String,
    pub conflict: ConflictPolicy,
    pub confirm_overwrite: bool,
}
impl TransferInput {
    pub fn validate(&self) -> Result<(), Error> {
        if self.sources.is_empty() || self.sources.len() > 256 {
            return Err(Error::Validation("每次请选择 1–256 个源项目"));
        }
        if self.sources.iter().map(String::len).sum::<usize>() + self.destination.len() > 64 * 1024
        {
            return Err(Error::Validation(
                "一次任务的源和目标路径总长不能超过 64 KiB，请分批传输",
            ));
        }
        for path in self
            .sources
            .iter()
            .chain(std::iter::once(&self.destination))
        {
            valid_path(path)?;
        }
        if self.conflict == ConflictPolicy::Overwrite && !self.confirm_overwrite {
            return Err(Error::Validation("覆盖传输必须显式确认"));
        }
        uuid::Uuid::parse_str(&self.session_id)
            .map_err(|_| Error::Validation("文件会话标识无效"))?;
        Ok(())
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferInfo {
    pub id: String,
    pub host_id: String,
    pub session_id: String,
    pub direction: Direction,
    pub state: String,
    pub sources: Vec<String>,
    pub destination: String,
    pub total_bytes: u64,
    pub transferred_bytes: u64,
    pub remaining_bytes: u64,
    pub bytes_per_second: u64,
    pub files_total: usize,
    pub files_done: usize,
    pub skipped: usize,
    pub message: Option<String>,
    pub recovery_paths: Vec<String>,
}
impl TransferInfo {
    pub fn unfinished(&self) -> bool {
        matches!(
            self.state.as_str(),
            "queued" | "scanning" | "running" | "verifying" | "cancelling"
        )
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextDocument {
    pub token: String,
    pub session_id: String,
    pub path: String,
    pub content: String,
    pub sha256: String,
    pub permissions: Option<u32>,
    pub uid: Option<u32>,
    pub gid: Option<u32>,
    pub atomic_save: bool,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveText {
    pub token: String,
    pub content: String,
    pub confirm_replace: bool,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveResult {
    pub document: Option<TextDocument>,
    pub recovery_path: Option<String>,
    pub message: Option<String>,
}

pub fn valid_path(path: &str) -> Result<(), Error> {
    if path.is_empty() || path.len() > 4096 || path.contains('\0') {
        return Err(Error::Validation("路径为空、包含 NUL 或超过 4096 字节"));
    }
    Ok(())
}
pub fn remote_absolute(path: &str) -> Result<(), Error> {
    valid_path(path)?;
    if !path.starts_with('/') || path.split('/').any(|part| part == "." || part == "..") {
        return Err(Error::Validation("文件操作需要不含 . 或 .. 的远程绝对路径"));
    }
    Ok(())
}
pub fn remote_join(parent: &str, name: &str) -> Result<String, Error> {
    remote_absolute(parent)?;
    if name.is_empty() || matches!(name, "." | "..") || name.contains(['/', '\0']) {
        return Err(Error::Validation("远程文件名无效"));
    }
    let result = format!("{}/{}", parent.trim_end_matches('/'), name);
    valid_path(&result)?;
    Ok(result)
}
pub fn remote_parent(path: &str) -> Option<String> {
    let path = path.trim_end_matches('/');
    if path.is_empty() {
        None
    } else {
        Some(
            path.rsplit_once('/')
                .map_or("/", |(p, _)| if p.is_empty() { "/" } else { p })
                .into(),
        )
    }
}
pub fn shell_quote(path: &str) -> Result<String, Error> {
    remote_absolute(path)?;
    Ok(format!("'{}'", path.replace('\'', "'\"'\"'")))
}
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum FileTerminalAction {
    Directory { path: String },
    View { path: String },
    Tail { path: String },
}
impl FileTerminalAction {
    pub fn command(&self) -> Result<String, Error> {
        Ok(match self {
            Self::Directory { path } => format!(
                "cd -- {} && exec \"${{SHELL:-/bin/sh}}\" -i",
                shell_quote(path)?
            ),
            Self::View { path } => format!("exec less -- {}", shell_quote(path)?),
            Self::Tail { path } => format!("exec tail -f -- {}", shell_quote(path)?),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn paths_preserve_unicode_and_metacharacters_without_shell_execution() {
        let name = "中文 空格 ;$'\\.txt";
        assert_eq!(
            remote_join("/tmp", name).expect("join"),
            format!("/tmp/{name}")
        );
        assert!(remote_join("/tmp", "../escape").is_err());
        assert!(remote_absolute("/tmp/../etc").is_err());
        assert_eq!(remote_parent("/a"), Some("/".into()));
        assert_eq!(remote_parent("/"), None);
        assert_eq!(
            shell_quote("/a'b;$(id)").expect("quote"),
            "'/a'\"'\"'b;$(id)'"
        );
    }
}

#[cfg(test)]
mod config_tests {
    #[test]
    fn current_transfer_settings_are_required_and_limits_are_validated() {
        let mut value = serde_json::to_value(crate::AppConfig::default()).expect("json");
        value
            .as_object_mut()
            .expect("object")
            .remove("transferConcurrency");
        value["terminalFontSize"] = 18.into();
        assert!(serde_json::from_value::<crate::AppConfig>(value).is_err());
        let mut config = crate::AppConfig {
            terminal_font_size: 18,
            ..Default::default()
        };
        assert_eq!(config.transfer_concurrency, 3);
        assert_eq!(config.terminal_font_size, 18);
        config.transfer_concurrency = 0;
        assert!(config.validate().is_err());
        config.transfer_concurrency = 7;
        assert!(config.validate().is_err());
        config.transfer_concurrency = 6;
        config.validate().expect("valid limit");
    }
}
