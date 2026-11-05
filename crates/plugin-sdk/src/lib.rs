//! Public API: no dependency on ServerDeck's private crates, Tauri, SSH or secret stores.
use serde::{Deserialize, Serialize};
use serde_json::Value;
pub mod server;
#[cfg(test)]
mod server_tests;
pub mod tools;
pub mod ui;
pub const API_VERSION: u32 = 1;
pub const MAX_MESSAGE: usize = 64 * 1024;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
pub enum Permission {
    #[serde(rename = "assistant.use")]
    AssistantUse,
    #[serde(rename = "metrics.read")]
    MetricsRead,
    #[serde(rename = "system.read")]
    SystemRead,
    #[serde(rename = "system.manage")]
    SystemManage,
    #[serde(rename = "logs.read")]
    LogsRead,
    #[serde(rename = "hosts.read")]
    HostsRead,
    #[serde(rename = "ssh.execute")]
    SshExecute,
    #[serde(rename = "sftp.read")]
    SftpRead,
    #[serde(rename = "sftp.write")]
    SftpWrite,
    #[serde(rename = "ui.contribute")]
    UiContribute,
    #[serde(rename = "settings.read")]
    SettingsRead,
    #[serde(rename = "settings.write")]
    SettingsWrite,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Capability {
    ToolInvoke {
        input_id: String,
        operation: tools::Operation,
    },
    SystemQuery {
        request: server::Query,
    },
    SystemFeedback,
    MetricsOpen {
        interval_secs: u8,
    },
    MetricsSnapshot {
        monitor_id: String,
        after_revision: Option<u64>,
    },
    MetricsVisible {
        monitor_id: String,
        visible: bool,
    },
    MetricsClose {
        monitor_id: String,
    },
    SystemLogStart {
        source: server::LogSource,
        lines: u16,
        follow: bool,
    },
    SystemLogPoll {
        log_id: String,
    },
    SystemLogPause {
        log_id: String,
        paused: bool,
    },
    SystemLogStop {
        log_id: String,
    },
    ContainerShell {
        id: String,
        bash: bool,
    },
    ResultRead {
        result_id: String,
        chunk: u32,
    },
    ResultClose {
        result_id: String,
    },
    HostsRead,
    Execute {
        command: String,
        timeout_secs: u16,
    },
    ReadFile {
        path: String,
    },
    SaveFile {
        document_id: String,
        content: String,
    },
    CloseFile {
        document_id: String,
        discard: bool,
    },
    FileDirty {
        document_id: String,
        dirty: bool,
    },
    SettingsRead,
    SettingsWrite {
        value: Value,
    },
    Notify {
        message: String,
    },
    LogStart {
        path: String,
        lines: u16,
    },
    LogPoll {
        log_id: String,
    },
    LogPause {
        log_id: String,
        paused: bool,
    },
    LogStop {
        log_id: String,
    },
}
impl Capability {
    pub fn permission(&self) -> Permission {
        match self {
            Self::ToolInvoke { operation, .. } => operation.tool().permission(),
            Self::SystemQuery { request } if request.sensitive() => Permission::SystemManage,
            Self::SystemQuery { .. } | Self::SystemFeedback => Permission::SystemRead,
            Self::ContainerShell { .. } => Permission::SystemManage,
            Self::MetricsOpen { .. }
            | Self::MetricsSnapshot { .. }
            | Self::MetricsVisible { .. }
            | Self::MetricsClose { .. } => Permission::MetricsRead,
            Self::SystemLogStart { .. }
            | Self::SystemLogPoll { .. }
            | Self::SystemLogPause { .. }
            | Self::SystemLogStop { .. } => Permission::LogsRead,
            Self::ResultRead { .. } | Self::ResultClose { .. } => Permission::UiContribute,
            Self::HostsRead => Permission::HostsRead,
            Self::Execute { .. } => Permission::SshExecute,
            Self::ReadFile { .. }
            | Self::CloseFile { .. }
            | Self::LogStart { .. }
            | Self::LogPoll { .. }
            | Self::LogPause { .. }
            | Self::LogStop { .. } => Permission::SftpRead,
            Self::SaveFile { .. } | Self::FileDirty { .. } => Permission::SftpWrite,
            Self::SettingsRead => Permission::SettingsRead,
            Self::SettingsWrite { .. } => Permission::SettingsWrite,
            Self::Notify { .. } => Permission::UiContribute,
        }
    }
    pub fn operation(&self) -> &'static str {
        match self {
            Self::ToolInvoke { operation, .. } => operation.tool().operation(),
            Self::SystemQuery { request } if request.sensitive() => "system.manage",
            Self::SystemQuery { .. } | Self::SystemFeedback => "system.read",
            Self::ContainerShell { .. } => "system.shell",
            Self::MetricsOpen { .. }
            | Self::MetricsSnapshot { .. }
            | Self::MetricsVisible { .. }
            | Self::MetricsClose { .. } => "metrics.read",
            Self::SystemLogStart { .. }
            | Self::SystemLogPoll { .. }
            | Self::SystemLogPause { .. }
            | Self::SystemLogStop { .. } => "logs.read",
            Self::ResultRead { .. } | Self::ResultClose { .. } => "ui.contribute",
            Self::HostsRead => "hosts.read",
            Self::Execute { command, .. } if read_only(command) => "ssh.read_only",
            Self::Execute { .. } => "ssh.execute",
            Self::ReadFile { .. } | Self::CloseFile { .. } => "sftp.read",
            Self::SaveFile { .. } | Self::FileDirty { .. } => "sftp.write",
            Self::SettingsRead => "settings.read",
            Self::SettingsWrite { .. } => "settings.write",
            Self::Notify { .. } => "ui.notify",
            Self::LogStart { .. }
            | Self::LogPoll { .. }
            | Self::LogPause { .. }
            | Self::LogStop { .. } => "logs.read",
        }
    }
    pub fn needs_confirmation(&self) -> bool {
        matches!(self, Self::SaveFile { .. })
            || matches!(self, Self::SystemQuery { request } if request.sensitive())
            || matches!(self, Self::ContainerShell { .. })
            || matches!(self, Self::Execute { command, .. } if !read_only(command))
    }
    pub fn uses_host(&self) -> bool {
        !matches!(
            self,
            Self::SettingsRead
                | Self::SettingsWrite { .. }
                | Self::Notify { .. }
                | Self::ToolInvoke { .. }
                | Self::ResultRead { .. }
                | Self::ResultClose { .. }
        )
    }
}
/// Exact allowlist only. Arguments, pipelines, env changes and alternate whitespace need approval.
pub fn read_only(command: &str) -> bool {
    [
        "uname -a",
        "uname -s",
        "nginx -v",
        "nginx -V",
        "systemctl is-active nginx",
        "systemctl status nginx --no-pager",
        "command -v nginx",
    ]
    .contains(&command)
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub api_version: u32,
    pub request_id: String,
    pub operation: Capability,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApiError {
    pub code: String,
    pub message: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Response {
    pub request_id: String,
    pub result: Value,
    pub error: Option<ApiError>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostInfo {
    pub id: String,
    pub name: String,
    pub hostname: String,
    pub port: u16,
    pub username: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommandResult {
    pub state: String,
    pub exit_code: Option<u32>,
    pub stdout: String,
    pub stderr: String,
    pub truncated: bool,
    pub message: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileDocument {
    pub id: String,
    pub path: String,
    pub content: String,
    pub sha256: String,
    pub atomic_save: bool,
    pub permissions: Option<u32>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SavedDocument {
    pub id: String,
    pub path: String,
    pub sha256: String,
    pub atomic_save: bool,
    pub permissions: Option<u32>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveResult {
    pub saved: bool,
    pub document: Option<SavedDocument>,
    pub recovery_path: Option<String>,
    pub message: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Yield {
    HostCall { request: Request },
    Done { value: Value },
}

pub fn host_call(request_id: &str, operation: Capability) -> Value {
    serde_json::json!({"kind":"host_call","request":{"apiVersion":API_VERSION,"requestId":request_id,"operation":operation}})
}

/// Safe buffer ABI: host writes only into the buffer reserved by sd_alloc. No raw pointer dereference.
/// The generated exports are intended for a wasm32 cdylib; native tests can call the handler directly.
#[macro_export]
macro_rules! export_plugin {
    ($handler:path) => {
        std::thread_local! {
            static SD_INPUT: std::cell::RefCell<Vec<u8>> = const { std::cell::RefCell::new(Vec::new()) };
            static SD_OUTPUT: std::cell::RefCell<Vec<u8>> = const { std::cell::RefCell::new(Vec::new()) };
        }
        #[unsafe(no_mangle)]
        pub extern "C" fn sd_api_version() -> i32 { 1 }
        #[unsafe(no_mangle)]
        pub extern "C" fn sd_alloc(length: i32) -> i32 {
            if length < 0 || length as usize > $crate::MAX_MESSAGE { return -1; }
            SD_INPUT.with_borrow_mut(|buffer| { buffer.resize(length as usize, 0); buffer.as_mut_ptr() as i32 })
        }
        #[unsafe(no_mangle)]
        pub extern "C" fn sd_handle(operation: i32, pointer: i32, length: i32) -> i64 {
            let reply = SD_INPUT.with_borrow(|buffer| {
                if pointer != buffer.as_ptr() as i32 || length < 0 || length as usize != buffer.len() { return $crate::json_error("ABI", "Invalid input buffer"); }
                let message: $crate::serde_json::Value = match $crate::serde_json::from_slice(buffer) { Ok(v) => v, Err(_) => return $crate::json_error("PROTOCOL", "Invalid JSON") };
                if message.get("protocolVersion").and_then(|v|v.as_u64()) != Some(1) { return $crate::json_error("VERSION", "Protocol version mismatch"); }
                $handler(operation, message.get("payload").cloned().unwrap_or($crate::serde_json::Value::Null))
            });
            SD_OUTPUT.with_borrow_mut(|buffer| {
                *buffer = match $crate::serde_json::to_vec(&reply) { Ok(bytes) => bytes, Err(_) => br#"{"protocolVersion":1,"result":null,"error":{"code":"SERIALIZE","message":"Unable to encode reply"}}"#.to_vec() };
                if buffer.len() > $crate::MAX_MESSAGE { return 65537; }
                (((buffer.as_ptr() as u32 as u64) << 32) | buffer.len() as u64) as i64
            })
        }
    };
}
pub use serde_json;
pub fn json_reply(result: Value) -> Value {
    serde_json::json!({"protocolVersion":1,"result":result,"error":null})
}
pub fn json_error(code: &str, message: &str) -> Value {
    serde_json::json!({"protocolVersion":1,"result":null,"error":{"code":code,"message":message}})
}
