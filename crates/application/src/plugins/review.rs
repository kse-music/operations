use super::{tools::ToolInput, *};
use serde::Serialize;
use serde_json::{Value, json};
use serverdeck_plugin_core::{InstalledPlugin, repository::PluginSource};

pub(super) fn builtin_assistant(plugin: &InstalledPlugin) -> bool {
    plugin.source == PluginSource::System && plugin.manifest.id == "cn.hiboot.plugins.assistant"
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolReview {
    title: String,
    message: String,
    confirmation_text: Option<String>,
}
fn redacted(value: &mut Value) {
    match value {
        Value::Object(fields) => {
            for (key, value) in fields {
                if ["parameters", "secret", "password", "apikey", "redactvalues"]
                    .iter()
                    .any(|name| key.to_ascii_lowercase().contains(name))
                {
                    *value = json!("[已隐藏]");
                } else {
                    redacted(value);
                }
            }
        }
        Value::Array(values) => {
            for value in values {
                redacted(value);
            }
        }
        _ => (),
    }
}
impl Application {
    pub(super) async fn plugin_tool_review(
        &self,
        input: &ToolInput,
        mut raw: Value,
        plugin: &InstalledPlugin,
    ) -> Result<Option<ToolReview>, Error> {
        if builtin_assistant(plugin)
            && matches!(
                input,
                ToolInput::AiResolveHosts { .. } | ToolInput::AiSend { .. }
            )
        {
            return Ok(None);
        }
        redacted(&mut raw);
        let mut confirmation_text = None;
        let details = match input {
            ToolInput::AiResolveHosts { input } => {
                let model_id = input.model_id.clone();
                let model = self.blocking(move |db| db.ai_model(&model_id)).await?;
                json!({"destination":serverdeck_ai::provider::endpoint(&model.config)?.to_string(),"question":input.question,"notice":"将发送经脱敏处理的资产索引以匹配相关主机","input":raw})
            }
            ToolInput::AiSend { id, .. } => self.assistant.review_send(id)?,
            ToolInput::AiExecute { input } => {
                let value = self.assistant.review_command(&input.proposal_id)?;
                confirmation_text = value["changeConfirmation"].as_str().map(str::to_owned);
                if let Some(steps) = value["steps"].as_array() {
                    let targets = steps
                        .iter()
                        .enumerate()
                        .map(|(index, step)| {
                            format!(
                                "{}. {}：{}",
                                index + 1,
                                step["action"].as_str().unwrap_or("操作"),
                                step["target"].as_str().unwrap_or("")
                            )
                        })
                        .collect::<Vec<_>>()
                        .join("\n");
                    return Ok(Some(ToolReview {
                        title: "确认 AI 运维计划".into(),
                        message: format!(
                            "主机：{}\n\n{}\n\n执行前重新核对目标状态，执行后逐项复查。任何失败或结果未确认都会停止后续操作；不强制、不提权、不自动重试。",
                            value["proposal"]["target"].as_str().unwrap_or(""),
                            targets
                        ),
                        confirmation_text,
                    }));
                }
                value
            }
            _ => return Ok(None),
        };
        let message =
            serde_json::to_string_pretty(&details).map_err(|e| Error::Worker(Box::new(e)))?;
        Ok(Some(ToolReview {
            title: format!("确认插件操作 · {}", plugin.manifest.name),
            message,
            confirmation_text,
        }))
    }
}
