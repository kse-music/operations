use crate::{Error, hosts::EnvironmentTag, hosts::validate_name};
use serde::{Deserialize, Serialize};

pub const MAX_TARGETS: usize = 32;

#[derive(Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BatchCommand {
    pub id: String,
    pub revision: u32,
    pub name: String,
    pub command: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BatchCommandInput {
    pub name: String,
    pub command: String,
}

pub fn validate_command(name: &str, command: &str) -> Result<(), Error> {
    validate_name(name)?;
    if command.trim().is_empty() || command.len() > 8192 || command.contains('\0') {
        return Err(Error::Validation(
            "SSH 命令不能为空、超过 8192 字节或包含空字符",
        ));
    }
    Ok(())
}

#[derive(Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchTarget {
    pub id: String,
    pub name: String,
    pub hostname: String,
    pub port: u16,
    pub username: String,
    pub environment: Option<EnvironmentTag>,
}

impl BatchTarget {
    pub fn production(&self) -> bool {
        self.environment
            .as_ref()
            .is_some_and(|tag| tag.name == "生产" || tag.name.eq_ignore_ascii_case("production"))
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchPreview {
    pub token: String,
    pub command: BatchCommand,
    pub concurrency: u8,
    pub targets: Vec<BatchTarget>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BatchRequest {
    pub command_id: String,
    pub revision: u32,
    pub host_ids: Vec<String>,
    pub concurrency: u8,
}

#[derive(Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum BatchStatus {
    Queued,
    Connecting,
    Running,
    Succeeded,
    ConnectionFailed,
    CommandFailed,
    Unknown,
    NotSent,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchResult {
    pub target: BatchTarget,
    pub status: BatchStatus,
    pub exit_code: Option<u32>,
    pub stdout: String,
    pub stderr: String,
    pub truncated: bool,
    pub message: Option<String>,
}

impl BatchResult {
    pub fn new(target: BatchTarget) -> Self {
        Self {
            target,
            status: BatchStatus::Queued,
            exit_code: None,
            stdout: String::new(),
            stderr: String::new(),
            truncated: false,
            message: None,
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchRun {
    pub id: String,
    pub revision: u64,
    pub command: BatchCommand,
    pub finished: bool,
    pub stopping: bool,
    pub results: Vec<BatchResult>,
}
