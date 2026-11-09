use crate::Error;
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Provider {
    OpenaiCompatible,
    LocalCodex,
    LocalClaudeCode,
}
impl Provider {
    pub fn is_local(self) -> bool {
        matches!(self, Self::LocalCodex | Self::LocalClaudeCode)
    }
}

pub const LOCAL_CODEX_MODEL_ID: &str = "local-codex";
pub const LOCAL_CLAUDE_CODE_MODEL_ID: &str = "local-claude-code";

pub fn local_provider(id: &str) -> Option<Provider> {
    match id {
        LOCAL_CODEX_MODEL_ID => Some(Provider::LocalCodex),
        LOCAL_CLAUDE_CODE_MODEL_ID => Some(Provider::LocalClaudeCode),
        _ => None,
    }
}
pub fn is_local_model(id: &str) -> bool {
    local_provider(id).is_some()
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalCodexStatus {
    pub installed: bool,
    pub install_supported: bool,
    pub authorized: bool,
    pub model: Option<Model>,
    pub message: String,
}
pub type LocalClaudeCodeStatus = LocalCodexStatus;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Config {
    pub provider: Provider,
    /// Base URL, including /v1 when required by the provider.
    pub base_url: String,
    pub model: String,
    pub allow_insecure_http: bool,
    pub max_output_tokens: u32,
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
        if self.config.provider.is_local() {
            return Err(Error::Validation("本地智能体请在 AI 运维助手中授权使用"));
        }
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
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Usage {
    pub input_tokens: u64,
    pub output_tokens: u64,
}
