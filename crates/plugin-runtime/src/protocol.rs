use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const PROTOCOL_VERSION: u32 = 1;
pub const MAX_MESSAGE: usize = 64 * 1024;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
#[repr(i32)]
pub enum Operation {
    Startup = 0,
    Activate = 1,
    Deactivate = 2,
    Health = 3,
    Cancel = 4,
    Exit = 5,
    Invoke = 6,
    Resume = 7,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Message {
    pub protocol_version: u32,
    pub request_id: u64,
    pub operation: Operation,
    pub payload: Value,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Reply {
    pub protocol_version: u32,
    pub result: Value,
    pub error: Option<GuestError>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GuestError {
    pub code: String,
    pub message: String,
}
impl std::fmt::Display for GuestError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "guest error {}", self.code)
    }
}
impl std::error::Error for GuestError {}
pub(crate) fn success(reply: Reply) -> Result<Reply, serverdeck_core::Error> {
    if let Some(error) = reply.error {
        return Err(serverdeck_core::Error::Connection {
            code: "PLUGIN_GUEST_ERROR",
            message: "插件报告生命周期操作失败",
            source: Some(Box::new(error)),
        });
    }
    Ok(reply)
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum State {
    Starting,
    Active,
    Stopping,
    Stopped,
    Crashed,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub id: String,
    pub revision: String,
    pub state: State,
    pub error_code: Option<String>,
    pub diagnostic: Option<Value>,
}
