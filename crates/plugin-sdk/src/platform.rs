//! Platform primitives. Service commands, SQL, prompts and workflow rules belong to plugins.
use crate::{ApiError, Permission};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalMode {
    #[default]
    Request,
    Assist,
    Full,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApprovalOperation {
    pub request: Box<Request>,
    pub count: u16,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
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
    /// Only whole argv entries can vary. Programs and script text remain literal.
    pub fn validate_argument_template(&self) -> Result<bool, ApiError> {
        self.validate()?;
        if self.program.contains("{{sd:") {
            return Err(argument_template_error());
        }
        let mut parameterized = false;
        for arg in &self.args {
            parameterized |= ArgumentRule::parse(arg)?.is_some();
        }
        if parameterized
            && (self.program != "sh"
                || self.args.first().map(String::as_str) != Some("-c")
                || self.args.len() < 4
                || self.args[..3].iter().any(|arg| arg.contains("{{sd:")))
        {
            return Err(argument_template_error());
        }
        Ok(parameterized)
    }
    pub fn matches_argument_template(&self, command: &Self) -> bool {
        if self.program != command.program
            || self.timeout_secs != command.timeout_secs
            || self.args.len() != command.args.len()
            || !matches!(self.validate_argument_template(), Ok(true))
            || command.validate().is_err()
        {
            return false;
        }
        self.args.iter().zip(&command.args).all(|(template, arg)| {
            match ArgumentRule::parse(template) {
                Ok(Some(rule)) => rule.matches(arg),
                Ok(None) => template == arg,
                Err(_) => false,
            }
        })
    }
}

enum ArgumentRule<'a> {
    Text { max: usize },
    Uint { min: u32, max: u32 },
    Hex { len: usize },
    Identifier { max: usize, suffix: &'a str },
}
fn argument_template_error() -> ApiError {
    ApiError::new(
        "COMMAND_TEMPLATE",
        "参数模板须为独立且有界的整数、十六进制、标识符或文本参数",
    )
}
impl<'a> ArgumentRule<'a> {
    fn parse(value: &'a str) -> Result<Option<Self>, ApiError> {
        if !value.contains("{{sd:") {
            return Ok(None);
        }
        let value = value
            .strip_prefix("{{sd:")
            .and_then(|v| v.strip_suffix("}}"))
            .ok_or_else(argument_template_error)?;
        let parts = value.split(':').collect::<Vec<_>>();
        let number = |value: &str| value.parse::<u32>().map_err(|_| argument_template_error());
        let rule = match parts.as_slice() {
            ["text", max] if (1..=4096).contains(&number(max)?) => Self::Text {
                max: number(max)? as usize,
            },
            ["uint", min, max] => {
                let (min, max) = (number(min)?, number(max)?);
                if min > max {
                    return Err(argument_template_error());
                }
                Self::Uint { min, max }
            }
            ["hex", len] if (1..=128).contains(&number(len)?) => Self::Hex {
                len: number(len)? as usize,
            },
            ["identifier", max, suffix]
                if (1..=256).contains(&number(max)?)
                    && suffix.len() <= 32
                    && suffix.bytes().all(identifier_byte) =>
            {
                Self::Identifier {
                    max: number(max)? as usize,
                    suffix,
                }
            }
            _ => return Err(argument_template_error()),
        };
        Ok(Some(rule))
    }
    fn matches(&self, value: &str) -> bool {
        match self {
            Self::Text { max } => {
                !value.is_empty() && value.len() <= *max && !value.chars().any(char::is_control)
            }
            Self::Uint { min, max } => {
                !value.is_empty()
                    && value.bytes().all(|c| c.is_ascii_digit())
                    && value
                        .parse::<u32>()
                        .is_ok_and(|n| (*min..=*max).contains(&n))
            }
            Self::Hex { len } => {
                value.len() == *len && value.bytes().all(|c| c.is_ascii_hexdigit())
            }
            Self::Identifier { max, suffix } => {
                !value.is_empty()
                    && value.len() <= *max
                    && !value.starts_with('-')
                    && value.ends_with(suffix)
                    && value.bytes().all(identifier_byte)
            }
        }
    }
}
fn identifier_byte(value: u8) -> bool {
    value.is_ascii_alphanumeric() || b"_.@:-\\".contains(&value)
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

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum TransferSource {
    Local { path: String },
    Remote { host_id: String, path: String },
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemotePath {
    pub host_id: String,
    pub path: String,
}

/// Remote destinations retain the existing wire shape; local downloads use localPath.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(untagged)]
pub enum TransferDestination {
    Remote(RemotePath),
    Local(LocalPath),
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LocalPath {
    pub local_path: String,
}
impl TransferDestination {
    pub fn path(&self) -> &str {
        match self {
            Self::Remote(remote) => &remote.path,
            Self::Local(local) => &local.local_path,
        }
    }
    pub fn remote(&self) -> Option<&RemotePath> {
        match self {
            Self::Remote(remote) => Some(remote),
            Self::Local(_) => None,
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TransferPreview<D = RemotePath> {
    pub id: String,
    pub source: TransferSource,
    pub destination: D,
    pub bytes: u64,
    pub overwrite: bool,
    pub target_exists: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TransferState {
    pub id: String,
    pub state: String,
    pub total_bytes: u64,
    pub transferred_bytes: u64,
    pub bytes_per_second: u64,
    pub sha256: Option<String>,
    pub message: Option<String>,
    pub recovery_paths: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Request {
    ApprovalMode {
        mode: ApprovalMode,
    },
    ConfirmOperations {
        operations: Vec<ApprovalOperation>,
    },
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
    Streaming {
        request: crate::streaming::Request,
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
    TransferPrepare {
        source: TransferSource,
        destination: RemotePath,
        overwrite: bool,
    },
    TransferDownloadPrepare {
        source: RemotePath,
        destination: String,
    },
    TransferStart {
        id: String,
    },
    TransferStatus {
        id: String,
    },
    TransferCancel {
        id: String,
    },
    TransferClose {
        id: String,
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
            Self::Streaming { request } => request.permission(),
            Self::ApprovalMode {
                mode: ApprovalMode::Full,
            } => Permission::OperationsFullPreapproved,
            Self::TcpConnect { .. } => Permission::NetworkConnect,
            Self::Info
            | Self::ApprovalMode { .. }
            | Self::ConfirmOperations { .. }
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
            Self::TransferPrepare { .. }
            | Self::TransferDownloadPrepare { .. }
            | Self::TransferStart { .. }
            | Self::TransferStatus { .. }
            | Self::TransferCancel { .. }
            | Self::TransferClose { .. } => Permission::SftpTransfer,
            Self::SettingsRead => Permission::SettingsRead,
            Self::SettingsWrite { .. } => Permission::SettingsWrite,
        }
    }
    pub fn operation(&self) -> &'static str {
        match self {
            Self::Streaming { request } => request.operation(),
            Self::ApprovalMode {
                mode: ApprovalMode::Full,
            } => "operations.full.preapproved",
            Self::TcpConnect { .. } => "network.connect",
            Self::Info
            | Self::ApprovalMode { .. }
            | Self::ConfirmOperations { .. }
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
            Self::TransferPrepare { .. }
            | Self::TransferDownloadPrepare { .. }
            | Self::TransferStart { .. }
            | Self::TransferStatus { .. }
            | Self::TransferCancel { .. }
            | Self::TransferClose { .. } => "sftp.transfer",
            Self::SettingsRead => "settings.read",
            Self::SettingsWrite { .. } => "settings.write",
        }
    }
    pub fn needs_confirmation(&self) -> bool {
        matches!(
            self,
            Self::ApprovalMode {
                mode: ApprovalMode::Full
            } | Self::Execute { .. }
                | Self::ConfirmOperations { .. }
                | Self::StreamOpen { .. }
                | Self::Terminal { .. }
                | Self::SaveFile { .. }
                | Self::ReadFile { .. }
                | Self::TransferPrepare { .. }
                | Self::TransferDownloadPrepare { .. }
                | Self::TransferStart { .. }
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
        if let Self::Streaming { request } = self {
            return request.cleanup();
        }
        matches!(
            self,
            Self::Info
                | Self::ApprovalMode {
                    mode: ApprovalMode::Request
                }
                | Self::Notify { .. }
                | Self::CloseFile { .. }
                | Self::StreamStop { .. }
                | Self::ResultRead { .. }
                | Self::ResultClose { .. }
                | Self::OutputOpen { .. }
                | Self::OutputPart { .. }
                | Self::OutputFinish { .. }
                | Self::FileDirty { dirty: false, .. }
                | Self::TransferStatus { .. }
                | Self::TransferCancel { .. }
                | Self::TransferClose { .. }
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn whole_text_arguments_are_bounded_and_never_change_program_or_script() {
        let template = Command::script("test -f \"$1\"")
            .arg("guarded")
            .arg("{{sd:text:64}}");
        for text in [
            "/tmp/file name.tar",
            "/tmp/\"$(touch injected).tar",
            "registry/team/image:tag",
        ] {
            let command = Command::script("test -f \"$1\"").arg("guarded").arg(text);
            assert!(template.matches_argument_template(&command));
            let mut changed = command.clone();
            changed.args[1].push_str("; reboot");
            assert!(!template.matches_argument_template(&changed));
        }
        for text in ["".to_string(), "x".repeat(65), "/tmp/x\nfile".to_string()] {
            assert!(!template.matches_argument_template(
                &Command::script("test -f \"$1\"").arg("guarded").arg(text)
            ));
        }
    }

    #[test]
    fn cancellation_allows_authority_reduction_but_never_elevation() {
        assert!(
            Request::ApprovalMode {
                mode: ApprovalMode::Request
            }
            .allowed_after_cancel()
        );
        for mode in [ApprovalMode::Assist, ApprovalMode::Full] {
            assert!(!Request::ApprovalMode { mode }.allowed_after_cancel());
        }
        assert!(
            Request::ApprovalMode {
                mode: ApprovalMode::Full
            }
            .needs_confirmation()
        );
    }
    #[test]
    fn parameterized_reads_keep_script_literal_and_validate_each_argument() {
        let template = Command::script("printf '%s' \"$1\"")
            .arg("fixture-read")
            .arg("{{sd:uint:2:2147483647}}");
        let command = Command::script("printf '%s' \"$1\"")
            .arg("fixture-read")
            .arg("835251");
        assert!(template.matches_argument_template(&command));
        for value in [
            "1",
            "-1",
            "2147483648",
            "2;reboot",
            "$(reboot)",
            "2\n",
            "",
            "2 3",
        ] {
            let mut changed = command.clone();
            changed.args[3] = value.into();
            assert!(!template.matches_argument_template(&changed), "{value}");
        }
        for changed in [
            Command::script("reboot").arg("fixture-read").arg("835251"),
            command.clone().arg("extra"),
        ] {
            assert!(!template.matches_argument_template(&changed));
        }
        for marker in ["{{sd:hex:64}}", "{{sd:identifier:256:.service}}"] {
            let template = Command::script("printf '%s' \"$1\"")
                .arg("fixture-read")
                .arg(marker);
            let mut value = template.clone();
            value.args[3] = if marker.contains("hex") {
                "a".repeat(64)
            } else {
                "app@prod.service".into()
            };
            assert!(template.matches_argument_template(&value));
            for unsafe_value in [
                "app.service;reboot",
                "../../app.service",
                "-app.service",
                "app.socket",
            ] {
                value.args[3] = unsafe_value.into();
                assert!(!template.matches_argument_template(&value));
            }
        }
        for invalid in [
            Command::script("{{sd:identifier:256:}}"),
            Command::new("{{sd:identifier:256:}}"),
            Command::script("echo ok")
                .arg("fixture-read")
                .arg("prefix{{sd:uint:2:3}}"),
            Command::script("echo ok")
                .arg("fixture-read")
                .arg("{{sd:uint:4:2}}"),
            Command::script("echo ok")
                .arg("fixture-read")
                .arg("{{sd:hex:0}}"),
        ] {
            assert!(invalid.validate_argument_template().is_err());
        }
    }
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
