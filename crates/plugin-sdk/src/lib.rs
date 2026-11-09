//! Public API: no dependency on ServerDeck's private crates, Tauri, SSH or secret stores.
use serde::{Deserialize, Serialize};
use serde_json::Value;
pub mod backend;
pub mod platform;
pub mod ui;
pub const API_VERSION: u32 = 1;
pub const MAX_MESSAGE: usize = 64 * 1024;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
pub enum Permission {
    #[serde(rename = "hosts.read")]
    HostsRead,
    #[serde(rename = "ssh.execute")]
    SshExecute,
    #[serde(rename = "sftp.read")]
    SftpRead,
    #[serde(rename = "sftp.write")]
    SftpWrite,
    #[serde(rename = "models.use")]
    ModelsUse,
    #[serde(rename = "network.connect")]
    NetworkConnect,
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
    Platform {
        request: platform::Request,
        bindings: Vec<String>,
    },
}
impl Capability {
    pub fn permission(&self) -> Permission {
        let Self::Platform { request, .. } = self;
        request.permission()
    }
    pub fn operation(&self) -> &'static str {
        let Self::Platform { request, .. } = self;
        request.operation()
    }
    pub fn needs_confirmation(&self) -> bool {
        let Self::Platform { request, .. } = self;
        request.needs_confirmation()
    }
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
impl ApiError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
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
impl CommandResult {
    pub fn checked(self) -> std::result::Result<Self, ApiError> {
        if self.truncated {
            return Err(ApiError::new(
                "OUTPUT_LIMIT",
                "命令输出超过平台限制，未返回不完整结果",
            ));
        }
        if self.state != "completed" || self.exit_code != Some(0) {
            let message = if !self.stderr.is_empty() {
                self.stderr.clone()
            } else if let Some(message) = &self.message {
                message.clone()
            } else if !self.stdout.is_empty() {
                self.stdout.clone()
            } else {
                "命令未确认成功，请核对远端状态".into()
            };
            return Err(ApiError::new("REMOTE_COMMAND", message));
        }
        Ok(self)
    }
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
