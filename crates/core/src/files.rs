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
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PropertyRequest {
    pub request_id: String,
    pub path: String,
    pub operation: PropertyOperation,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum PropertyOperation {
    Size,
    Checksum,
    Apply { change: PropertyChange },
}
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PropertyChange {
    pub expected: FileEntry,
    pub permissions: Option<u32>,
    pub uid: Option<u32>,
    pub gid: Option<u32>,
    pub recursive: bool,
    pub directory_execute: bool,
    pub confirmed: bool,
}
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PropertyResult {
    pub bytes: u64,
    pub files: usize,
    pub directories: usize,
    pub skipped_links: usize,
    pub changed: usize,
    pub checksum: Option<String>,
    pub cancelled: bool,
    pub message: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryListing {
    pub path: String,
    pub parent: Option<String>,
    pub entries: Vec<FileEntry>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DirectoryBookmark {
    pub name: String,
    pub path: String,
}
impl DirectoryBookmark {
    pub fn validate(&self) -> Result<(), Error> {
        remote_absolute(&self.path)?;
        if self.name.is_empty()
            || self.name.trim() != self.name
            || self.name.chars().count() > 80
            || self.name.chars().any(char::is_control)
        {
            return Err(Error::Validation(
                "书签名称须为 1–80 个字符，不能含控制字符",
            ));
        }
        Ok(())
    }
}
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileSearchInput {
    pub request_id: String,
    pub path: String,
    pub query: String,
    pub recursive: bool,
    pub include_hidden: bool,
}
impl FileSearchInput {
    pub fn validate(&self) -> Result<(), Error> {
        uuid::Uuid::parse_str(&self.request_id)
            .map_err(|_| Error::Validation("文件搜索标识无效"))?;
        remote_absolute(&self.path)?;
        if self.query.trim().is_empty()
            || self.query.len() > 256
            || self.query.contains('/')
            || self.query.chars().any(char::is_control)
        {
            return Err(Error::Validation(
                "文件名关键词须为 1–256 字节，不能包含 / 或控制字符",
            ));
        }
        Ok(())
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FileSearchStatus {
    Running,
    Completed,
    Cancelled,
    Limited,
    Failed,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileSearchResult {
    pub entry: FileEntry,
    pub parent: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileSearchIssue {
    pub path: String,
    pub message: String,
}
/// Incremental batches; counters are cumulative, results and issues are deltas.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileSearchEvent {
    pub request_id: String,
    pub status: FileSearchStatus,
    pub entries: Vec<FileSearchResult>,
    pub issues: Vec<FileSearchIssue>,
    pub scanned_directories: usize,
    pub scanned_entries: usize,
    pub skipped_directories: usize,
    pub current_path: Option<String>,
    pub message: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalDrive {
    pub path: String,
    pub name: String,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LocalRecycle {
    pub parent: String,
    pub paths: Vec<String>,
    pub confirmed: bool,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LocalRename {
    pub parent: String,
    pub path: String,
    pub name: String,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum RemoteAction {
    Mkdir {
        path: String,
        permissions: Option<u32>,
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
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoteCopyInput {
    pub session_id: String,
    #[serde(default)]
    pub target_session_id: Option<String>,
    pub sources: Vec<String>,
    pub destination: String,
    pub name: Option<String>,
    pub conflict: ConflictPolicy,
    pub confirmed: bool,
    pub confirm_overwrite: bool,
}
impl RemoteCopyInput {
    pub fn validate(&self) -> Result<(), Error> {
        TransferInput {
            session_id: self.session_id.clone(),
            direction: Direction::Upload,
            sources: self.sources.clone(),
            destination: self.destination.clone(),
            conflict: self.conflict,
            confirm_overwrite: self.confirm_overwrite,
        }
        .validate()?;
        remote_absolute(&self.destination)?;
        if let Some(target) = &self.target_session_id {
            uuid::Uuid::parse_str(target).map_err(|_| Error::Validation("目标文件会话标识无效"))?;
        }
        if !self.confirmed || self.conflict == ConflictPolicy::Rename {
            return Err(Error::Validation("远程复制须确认目标及有效的冲突策略"));
        }
        if let Some(name) = &self.name {
            if self.sources.len() != 1 {
                return Err(Error::Validation("多选项目不能指定同一个新名称"));
            }
            remote_join("/", name)?;
        }
        let mut targets = std::collections::HashSet::new();
        for (index, source) in self.sources.iter().enumerate() {
            remote_absolute(source)?;
            if source == "/" || source.ends_with('/') {
                return Err(Error::Validation("不能复制远程根目录，源路径不能以 / 结尾"));
            }
            if self.sources.iter().enumerate().any(|(other, path)| {
                other != index && (path == source || path.starts_with(&format!("{source}/")))
            }) {
                return Err(Error::Validation("源项目不能重复或相互包含"));
            }
            let name = self
                .name
                .as_deref()
                .unwrap_or_else(|| source.rsplit('/').next().unwrap_or(""));
            let directory = self.destination.trim_end_matches('/');
            let destination =
                remote_join(if directory.is_empty() { "/" } else { directory }, name)?;
            if !targets.insert(destination.clone()) {
                return Err(Error::Validation("多个源项目指向同一个目标，请分开操作"));
            }
            for original in self.sources.iter().filter(|_| {
                self.target_session_id
                    .as_ref()
                    .is_none_or(|target| target == &self.session_id)
            }) {
                if destination == *original
                    || destination.starts_with(&format!("{original}/"))
                    || original.starts_with(&format!("{destination}/"))
                {
                    return Err(Error::Validation(
                        "目标不能与源相同，或位于源项目的内部、祖先路径",
                    ));
                }
            }
        }
        Ok(())
    }
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
pub struct UploadRestartPrompt {
    pub token: String,
    pub target: String,
    pub partial_bytes: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferInfo {
    #[serde(default)]
    pub restart_prompt: Option<UploadRestartPrompt>,
    #[serde(default)]
    pub resumed_bytes: u64,
    pub id: String,
    pub host_id: String,
    pub session_id: String,
    pub direction: Direction,
    #[serde(default)]
    pub remote_copy: bool,
    #[serde(default)]
    pub remote_name: Option<String>,
    #[serde(default)]
    pub remote_target_host_id: Option<String>,
    #[serde(default)]
    pub remote_target_session_id: Option<String>,
    pub state: String,
    pub sources: Vec<String>,
    pub destination: String,
    pub total_bytes: u64,
    pub transferred_bytes: u64,
    pub remaining_bytes: u64,
    pub bytes_per_second: u64,
    pub elapsed_seconds: u64,
    pub drag_export: bool,
    pub files_total: usize,
    pub files_done: usize,
    pub skipped: usize,
    pub message: Option<String>,
    pub recovery_paths: Vec<String>,
}
impl TransferInfo {
    pub fn uses_host(&self, host: &str) -> bool {
        self.host_id == host || self.remote_target_host_id.as_deref() == Some(host)
    }
    pub fn unfinished(&self) -> bool {
        matches!(
            self.state.as_str(),
            "queued" | "scanning" | "running" | "verifying" | "awaitingRestart" | "cancelling"
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalDocument {
    pub token: String,
    pub session_id: String,
    pub path: String,
    pub local_path: String,
    pub transfer_id: String,
    pub atomic_save: bool,
    pub ready: bool,
}

#[derive(Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FileSide {
    Local,
    #[default]
    Remote,
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

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn mkdir_accepts_optional_permissions_and_rejects_unknown_fields() {
        for value in [
            serde_json::json!({"kind":"mkdir", "path":"/folder"}),
            serde_json::json!({"kind":"mkdir", "path":"/folder", "permissions":null}),
        ] {
            assert!(matches!(
                serde_json::from_value::<RemoteAction>(value).expect("default permissions"),
                RemoteAction::Mkdir {
                    permissions: None,
                    ..
                }
            ));
        }
        assert!(matches!(
            serde_json::from_value::<RemoteAction>(serde_json::json!({
                "kind":"mkdir", "path":"/folder", "permissions":0o2770
            }))
            .expect("custom permissions"),
            RemoteAction::Mkdir {
                permissions: Some(0o2770),
                ..
            }
        ));
        for value in [
            serde_json::json!({"kind":"mkdir", "path":"/folder", "permissions":-1}),
            serde_json::json!({"kind":"mkdir", "path":"/folder", "permissions":"0755"}),
            serde_json::json!({"kind":"mkdir", "path":"/folder", "shell":"mkdir"}),
        ] {
            assert!(serde_json::from_value::<RemoteAction>(value).is_err());
        }
    }
    #[test]
    fn file_search_accepts_literal_names_and_rejects_invalid_scope_and_unknown_fields() {
        let mut input = FileSearchInput {
            request_id: uuid::Uuid::new_v4().to_string(),
            path: "/srv/中文 空格".into(),
            query: " ;$(id)'*.txt ".into(),
            recursive: true,
            include_hidden: false,
        };
        input
            .validate()
            .expect("literal names do not execute shell syntax");
        for path in ["relative", "/srv/../etc", "/srv/./app", "/bad\0path"] {
            input.path = path.into();
            assert!(input.validate().is_err(), "{path:?}");
        }
        input.path = "/".into();
        for query in ["", "  ", "a/b", "bad\nname"] {
            input.query = query.into();
            assert!(input.validate().is_err());
        }
        input.query = "a".repeat(257);
        assert!(input.validate().is_err());
        input.query = "text".into();
        input.request_id = "invalid".into();
        assert!(input.validate().is_err());
        assert!(serde_json::from_value::<FileSearchInput>(serde_json::json!({
            "requestId":uuid::Uuid::new_v4().to_string(), "path":"/", "query":"a", "recursive":true,
            "includeHidden":false, "shell":"find /"
        })).is_err());
    }
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
