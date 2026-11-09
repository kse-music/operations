//! Platform primitives. Service commands, SQL, prompts and workflow rules belong to plugins.
use crate::{ApiError, Permission};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Command {
    pub program: String,
    pub args: Vec<String>,
    /// Execute deadline. Stream/PTY resources instead end on explicit close or page lifecycle.
    pub timeout_secs: u16,
}
impl Command {
    pub fn new(program: impl Into<String>) -> Self {
        Self {
            program: program.into(),
            args: Vec::new(),
            timeout_secs: 30,
        }
    }
    pub fn arg(mut self, value: impl Into<String>) -> Self {
        self.args.push(value.into());
        self
    }
    pub fn script(value: impl Into<String>) -> Self {
        Self::new("sh").arg("-c").arg(value)
    }
    pub fn validate(&self) -> Result<(), ApiError> {
        if self.program.is_empty()
            || self.program.len() > 4096
            || self.program.contains('\0')
            || self.args.len() > 128
            || !(1..=30).contains(&self.timeout_secs)
            || self
                .args
                .iter()
                .any(|arg| arg.len() > 8192 || arg.contains('\0'))
            || self.program.len() + self.args.iter().map(String::len).sum::<usize>() > 16384
        {
            return Err(ApiError::new(
                "COMMAND_INPUT",
                "程序、参数或超时超过平台限制",
            ));
        }
        if serde_json::to_vec(self)
            .map_err(|_| ApiError::new("COMMAND_INPUT", "命令编码失败"))?
            .len()
            > 48 * 1024
        {
            return Err(ApiError::new("COMMAND_INPUT", "命令编码超过平台消息限制"));
        }
        Ok(())
    }
    pub fn shell(&self) -> Result<String, ApiError> {
        self.validate()?;
        let mut result = quote(&self.program)?;
        for arg in &self.args {
            result.push(' ');
            result.push_str(&quote(arg)?);
        }
        Ok(result)
    }
}
/// Quote one POSIX shell argument. Empty arguments are preserved.
pub fn quote(value: &str) -> Result<String, ApiError> {
    if value.len() > 16384 || value.contains('\0') {
        return Err(ApiError::new("ARGUMENT_INPUT", "参数过长或包含 NUL"));
    }
    Ok(format!("'{}'", value.replace('\'', "'\"'\"'")))
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    System,
    User,
    Assistant,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Message {
    pub role: Role,
    pub content: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Request {
    Info,
    Hosts,
    Host {
        host_id: String,
    },
    Models,
    TcpConnect {
        target: String,
        port: u16,
    },
    Model {
        model_id: String,
    },
    Execute {
        host_id: String,
        command: Command,
    },
    StreamOpen {
        host_id: String,
        command: Command,
    },
    StreamPoll {
        stream_id: String,
    },
    StreamPause {
        stream_id: String,
        paused: bool,
    },
    StreamStop {
        stream_id: String,
    },
    Terminal {
        host_id: String,
        command: Command,
    },
    ModelComplete {
        model_id: String,
        expected_revision: Option<String>,
        messages: Vec<Message>,
    },
    ReadFile {
        host_id: String,
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
        value: serde_json::Value,
    },
    Notify {
        message: String,
    },
    ResultRead {
        result_id: String,
        chunk: u32,
    },
    ResultClose {
        result_id: String,
    },
    OutputOpen {
        bytes: u32,
    },
    OutputPart {
        result_id: String,
        offset: u32,
        data_base64: String,
    },
    OutputFinish {
        result_id: String,
    },
}
impl Request {
    pub fn permission(&self) -> Permission {
        match self {
            Self::TcpConnect { .. } => Permission::NetworkConnect,
            Self::Info
            | Self::Notify { .. }
            | Self::ResultRead { .. }
            | Self::ResultClose { .. }
            | Self::OutputOpen { .. }
            | Self::OutputPart { .. }
            | Self::OutputFinish { .. } => Permission::UiContribute,
            Self::Hosts | Self::Host { .. } => Permission::HostsRead,
            Self::Execute { .. }
            | Self::StreamOpen { .. }
            | Self::StreamPoll { .. }
            | Self::StreamPause { .. }
            | Self::StreamStop { .. }
            | Self::Terminal { .. } => Permission::SshExecute,
            Self::Models | Self::Model { .. } | Self::ModelComplete { .. } => Permission::ModelsUse,
            Self::ReadFile { .. } | Self::CloseFile { .. } => Permission::SftpRead,
            Self::SaveFile { .. } | Self::FileDirty { .. } => Permission::SftpWrite,
            Self::SettingsRead => Permission::SettingsRead,
            Self::SettingsWrite { .. } => Permission::SettingsWrite,
        }
    }
    pub fn operation(&self) -> &'static str {
        match self {
            Self::TcpConnect { .. } => "network.connect",
            Self::Info
            | Self::ResultRead { .. }
            | Self::ResultClose { .. }
            | Self::OutputOpen { .. }
            | Self::OutputPart { .. }
            | Self::OutputFinish { .. } => "ui.contribute",
            Self::Notify { .. } => "ui.notify",
            Self::Hosts | Self::Host { .. } => "hosts.read",
            Self::Execute { .. }
            | Self::StreamOpen { .. }
            | Self::StreamPoll { .. }
            | Self::StreamPause { .. }
            | Self::StreamStop { .. }
            | Self::Terminal { .. } => "ssh.execute",
            Self::Models | Self::Model { .. } | Self::ModelComplete { .. } => "models.use",
            Self::ReadFile { .. } | Self::CloseFile { .. } => "sftp.read",
            Self::SaveFile { .. } | Self::FileDirty { .. } => "sftp.write",
            Self::SettingsRead => "settings.read",
            Self::SettingsWrite { .. } => "settings.write",
        }
    }
    pub fn needs_confirmation(&self) -> bool {
        matches!(
            self,
            Self::Execute { .. }
                | Self::StreamOpen { .. }
                | Self::Terminal { .. }
                | Self::SaveFile { .. }
                | Self::TcpConnect { .. }
        )
    }
    pub fn host(&self) -> Option<&str> {
        match self {
            Self::Execute { host_id, .. }
            | Self::StreamOpen { host_id, .. }
            | Self::Terminal { host_id, .. }
            | Self::ReadFile { host_id, .. } => Some(host_id),
            _ => None,
        }
    }
    pub fn allowed_after_cancel(&self) -> bool {
        matches!(
            self,
            Self::Info
                | Self::Notify { .. }
                | Self::CloseFile { .. }
                | Self::StreamStop { .. }
                | Self::ResultRead { .. }
                | Self::ResultClose { .. }
                | Self::OutputOpen { .. }
                | Self::OutputPart { .. }
                | Self::OutputFinish { .. }
                | Self::FileDirty { dirty: false, .. }
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn command_arguments_remain_literal_and_no_service_is_automatically_exempt() {
        let command = Command::new("tool").arg("").arg("x'$(touch BAD); y");
        assert_eq!(
            command.shell().unwrap(),
            "'tool' '' 'x'\"'\"'$(touch BAD); y'"
        );
        assert!(Command::new("x").arg("a\0b").validate().is_err());
        assert!(
            Request::Execute {
                host_id: "h".into(),
                command: Command::new("uname").arg("-a")
            }
            .needs_confirmation()
        );
        assert!(serde_json::from_str::<Request>(r#"{"kind":"nginx","action":"reload"}"#).is_err());
        assert!(serde_json::from_str::<Request>(r#"{"kind":"execute","hostId":"h","command":{"program":"x","args":[],"timeoutSecs":30},"confirmed":true}"#).is_err());
    }
}
