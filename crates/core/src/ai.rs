use crate::{Error, ops::LogSource};
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;
mod agent;
pub use agent::*;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Provider {
    OpenaiCompatible,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Config {
    pub provider: Provider,
    /// Base URL, including /v1 when required by the provider.
    pub base_url: String,
    pub model: String,
    pub allow_insecure_http: bool,
    pub max_output_tokens: u32,
    #[serde(default = "default_context_window_tokens")]
    pub context_window_tokens: u32,
}
fn default_context_window_tokens() -> u32 {
    131_072
}
impl Default for Config {
    fn default() -> Self {
        Self {
            provider: Provider::OpenaiCompatible,
            base_url: "https://api.openai.com/v1".into(),
            model: String::new(),
            allow_insecure_http: false,
            max_output_tokens: 2048,
            context_window_tokens: default_context_window_tokens(),
        }
    }
}
impl Config {
    pub fn validate(&self) -> Result<(), Error> {
        if self.base_url.len() > 2048 || self.base_url.chars().any(char::is_control) {
            return Err(Error::Validation("AI 地址无效"));
        }
        if self.model.trim().is_empty()
            || self.model.len() > 200
            || self.model.chars().any(char::is_control)
            || !(256..=8192).contains(&self.max_output_tokens)
        {
            return Err(Error::Validation(
                "请填写模型 ID，输出上限须为 256–8192 Token",
            ));
        }
        if !(1024..=10_000_000).contains(&self.context_window_tokens)
            || self.context_window_tokens <= self.max_output_tokens
        {
            return Err(Error::Validation(
                "上下文窗口须为 1024–10000000 Token，且大于最大输出 Token",
            ));
        }
        Ok(())
    }
}

// Secret-bearing input must not implement Debug or Serialize.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelInput {
    pub id: Option<String>,
    pub expected_revision: Option<String>,
    pub name: String,
    pub config: Config,
    pub api_key: Option<Zeroizing<String>>,
    pub clear_key: bool,
    #[serde(default)]
    pub test_id: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelTest {
    pub id: String,
    pub elapsed_ms: u64,
    pub expires_in_seconds: u64,
}
impl ModelInput {
    pub fn validate(&self) -> Result<(), Error> {
        self.config.validate()?;
        validate_model_name(&self.name)?;
        if self.id.is_some() != self.expected_revision.is_some() {
            return Err(Error::Validation(
                "编辑模型需要 ID 和对应版本，新建模型不接受旧版本",
            ));
        }
        if self.clear_key && self.api_key.is_some() {
            return Err(Error::Validation("替换和清除 Key 不能同时选择"));
        }
        if self.api_key.as_ref().is_some_and(|k| {
            k.trim().is_empty() || k.len() > 4096 || k.chars().any(char::is_control)
        }) {
            return Err(Error::Validation("API Key 须为 1–4096 字节且不含控制字符"));
        }
        Ok(())
    }
}
pub fn validate_model_name(name: &str) -> Result<(), Error> {
    if name.trim().is_empty() || name.chars().count() > 120 || name.chars().any(char::is_control) {
        return Err(Error::Validation("模型名称须为 1–120 个字符且不含控制字符"));
    }
    Ok(())
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Model {
    pub id: String,
    pub name: String,
    pub revision: String,
    pub config: Config,
    pub has_key: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelDeleteInput {
    pub id: String,
    pub expected_revision: String,
    pub confirmed: bool,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContextSelection {
    pub server: bool,
    pub metrics: bool,
    pub processes: bool,
    pub docker: bool,
    pub log: Option<LogSource>,
    pub log_lines: u16,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PrepareInput {
    pub model_id: String,
    pub session_id: Option<String>,
    pub question: String,
    pub selection: ContextSelection,
    pub mask_addresses: bool,
    pub redact_values: Vec<Zeroizing<String>>,
    #[serde(default)]
    pub history: Vec<ChatMessage>,
    #[serde(default)]
    pub session_ids: Vec<String>,
    #[serde(default)]
    pub auto_hosts: bool,
    #[serde(default)]
    pub expected_model_revision: Option<String>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostAsset {
    pub id: String,
    pub name: String,
    pub hostname: String,
    pub port: u16,
    pub username: String,
    pub group: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResolveHostsInput {
    pub model_id: String,
    pub request_id: String,
    pub question: String,
    pub previous_host_ids: Vec<String>,
    pub mask_addresses: bool,
    pub redact_values: Vec<Zeroizing<String>>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostChoice {
    pub host_ids: Vec<String>,
    pub message: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostRoute {
    pub host_ids: Vec<String>,
    pub message: String,
    pub model_revision: String,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ChatRole {
    User,
    Assistant,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChatMessage {
    pub role: ChatRole,
    pub content: String,
}
pub fn validate_history(history: &[ChatMessage]) -> Result<(), Error> {
    if history.len() > 12
        || !history.len().is_multiple_of(2)
        || history.iter().map(|m| m.content.len()).sum::<usize>() > 48 * 1024
        || history.iter().enumerate().any(|(i, m)| {
            m.content.trim().is_empty()
                || !matches!(
                    (i % 2, &m.role),
                    (0, ChatRole::User) | (1, ChatRole::Assistant)
                )
        })
    {
        return Err(Error::Validation(
            "对话历史最多六轮、48 KiB，且仅允许成对的问题与回答",
        ));
    }
    Ok(())
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub id: String,
    pub model_id: String,
    pub destination: String,
    pub model: String,
    /// Exact redacted JSON body frozen for sending.
    pub body: String,
    pub estimated_input_tokens: u64,
    pub max_output_tokens: u32,
    pub estimated_max_cost: Option<f64>,
    pub warnings: Vec<String>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CommandRisk {
    ReadOnly,
    Change,
    ManualOnly,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Proposal {
    pub id: String,
    pub command: String,
    pub risk: CommandRisk,
    pub reason: &'static str,
    pub target: Option<String>,
    pub change_confirmation: Option<String>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Usage {
    pub input_tokens: u64,
    pub output_tokens: u64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Answer {
    pub text: String,
    pub proposals: Vec<Proposal>,
    pub usage: Option<Usage>,
    pub estimated_cost: Option<f64>,
    pub warnings: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent: Option<AgentReport>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExecuteInput {
    pub proposal_id: String,
    pub confirmed: bool,
    pub change_confirmation: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Execution {
    pub success: bool,
    pub output: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent: Option<AgentExecution>,
}
