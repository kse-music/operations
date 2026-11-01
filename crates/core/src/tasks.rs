use crate::{
    Error,
    files::{ConflictPolicy, remote_absolute},
};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

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
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Target {
    pub host_id: String,
    pub session_id: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum BatchOperation {
    Command {
        command: String,
    },
    File {
        source: String,
        destination: String,
        conflict: ConflictPolicy,
        confirm_overwrite: bool,
    },
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BatchInput {
    pub targets: Vec<Target>,
    pub operation: BatchOperation,
    pub concurrency: u8,
    pub timeout_secs: u16,
    pub confirmed: bool,
}
impl BatchInput {
    pub fn validate(&self) -> Result<(), Error> {
        if !self.confirmed {
            return Err(Error::Validation("必须核对全部目标及命令/文件并显式确认"));
        }
        if self.targets.is_empty()
            || self.targets.len() > 32
            || !(1..=8).contains(&self.concurrency)
            || !(1..=3600).contains(&self.timeout_secs)
        {
            return Err(Error::Validation(
                "请选择 1–32 台主机，并发为 1–8，超时为 1–3600 秒",
            ));
        }
        let mut ids = HashSet::new();
        for t in &self.targets {
            uuid::Uuid::parse_str(&t.host_id).map_err(|_| Error::Validation("主机标识无效"))?;
            if let Some(id) = &t.session_id {
                uuid::Uuid::parse_str(id).map_err(|_| Error::Validation("目标会话标识无效"))?;
            }
            if !ids.insert(&t.host_id) {
                return Err(Error::Validation("批量目标不可重复"));
            }
        }
        match &self.operation {
            BatchOperation::Command { command } => {
                if command.trim().is_empty() || command.len() > 16384 || command.contains('\0') {
                    return Err(Error::Validation("命令为空、含 NUL 或超过 16 KiB"));
                }
            }
            BatchOperation::File {
                source,
                destination,
                conflict,
                confirm_overwrite,
            } => {
                crate::files::valid_path(source)?;
                remote_absolute(destination)?;
                if *conflict == ConflictPolicy::Overwrite && !confirm_overwrite {
                    return Err(Error::Validation("覆盖文件必须单独确认"));
                }
            }
        }
        Ok(())
    }
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
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchRow {
    pub host_id: String,
    pub session_id: Option<String>,
    pub state: String,
    pub stdout: String,
    pub stderr: String,
    pub dropped_bytes: u64,
    pub exit_code: Option<u32>,
    pub message: Option<String>,
    pub transfer: Option<crate::files::TransferInfo>,
    pub started_at: Option<u64>,
    pub finished_at: Option<u64>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Batch {
    pub id: String,
    pub input: BatchInput,
    pub rows: Vec<BatchRow>,
    pub finished: bool,
    pub created_at: u64,
    pub revision: u64,
}
pub fn active(state: &str) -> bool {
    matches!(state, "queued" | "running")
}
