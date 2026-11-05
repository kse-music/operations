use crate::Error;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Tool {
    Ping,
    Tcp,
    Dns,
    Traceroute,
    Mtr,
    Interfaces,
    Connections,
    SshLatency,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Origin {
    Local,
    Remote { host_id: String, session_id: String },
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DiagnosticInput {
    pub tool: Tool,
    pub origin: Origin,
    pub target: String,
    pub port: u16,
    pub count: u8,
    pub timeout_secs: u16,
}
impl DiagnosticInput {
    pub fn validate(&self) -> Result<(), Error> {
        if self.target.len() > 253 || self.target.contains('\0') {
            return Err(Error::Validation("诊断目标超过 253 字节或含 NUL"));
        }
        if let Origin::Remote {
            host_id,
            session_id,
        } = &self.origin
        {
            for id in [host_id, session_id] {
                uuid::Uuid::parse_str(id)
                    .map_err(|_| Error::Validation("远程诊断的主机或会话标识无效"))?;
            }
        }
        if !(1..=100).contains(&self.count) || !(1..=300).contains(&self.timeout_secs) {
            return Err(Error::Validation("诊断次数须为 1–100，超时须为 1–300 秒"));
        }
        if !matches!(
            self.tool,
            Tool::Interfaces | Tool::Connections | Tool::SshLatency
        ) {
            target(&self.target)?;
        }
        if self.tool == Tool::Tcp && self.port == 0 {
            return Err(Error::Validation("TCP 端口须为 1–65535"));
        }
        if self.tool == Tool::SshLatency && matches!(self.origin, Origin::Local) {
            return Err(Error::Validation(
                "SSH 延迟需要已验证的远程 SSH 连接；本机 TCP 延迟请用 TCP 检测",
            ));
        }
        Ok(())
    }
}
pub fn target(s: &str) -> Result<(), Error> {
    if s.is_empty()
        || s.len() > 253
        || s.starts_with('-')
        || !s
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b".-:_%".contains(&c))
    {
        return Err(Error::Validation(
            "目标应为 IP 或域名，不可包含空白、Shell 字符或选项",
        ));
    }
    Ok(())
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostic {
    pub id: String,
    pub input: DiagnosticInput,
    pub state: String,
    pub output: String,
    pub dropped_bytes: u64,
    pub exit_code: Option<u32>,
    pub message: Option<String>,
    pub started_at: u64,
    pub finished_at: Option<u64>,
    pub revision: u64,
}
pub fn active(state: &str) -> bool {
    matches!(state, "queued" | "running")
}
