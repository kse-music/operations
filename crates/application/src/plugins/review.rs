use super::{tools::ToolInput, *};
use serde::Serialize;
use serde_json::{Value, json};
use serverdeck_core::automation;

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
        name: &str,
    ) -> Result<Option<ToolReview>, Error> {
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
                value
            }
            ToolInput::BatchStart { input } => {
                let ids = input
                    .targets
                    .iter()
                    .map(|t| t.host_id.clone())
                    .collect::<Vec<_>>();
                let targets = self
                    .blocking(move |db| {
                        ids.iter()
                            .map(|id| db.host(id))
                            .collect::<Result<Vec<_>, _>>()
                    })
                    .await?;
                let connections = self.terminals.connection_status()?;
                let targets = targets.iter().zip(&input.targets).map(|(host,target)| {
                    if let Some(connection) = target.session_id.as_ref().and_then(|id| connections.iter().find(|c| c.id == *id && c.host_id == target.host_id)) {
                        json!({"hostname":connection.hostname,"port":connection.port,"username":connection.username,"state":connection.state})
                    } else {
                        json!({"hostname":host.config.hostname,"port":host.config.port,"username":host.config.username,"state":"未连接，不会执行"})
                    }
                }).collect::<Vec<_>>();
                json!({"targets":targets,"input":raw})
            }
            ToolInput::BatchRetryFile { id, .. } | ToolInput::BatchCancel { id, .. } => {
                let task = self
                    .tasks
                    .batch_list()?
                    .into_iter()
                    .find(|t| t.id == *id)
                    .ok_or(Error::NotFound)?;
                json!({"task":task.input,"request":raw})
            }
            ToolInput::AutomationStart { input } => {
                let (entry, targets) = self
                    .automation_prepare(
                        input.entry_id.clone(),
                        input.expected_revision,
                        input.host_ids.clone(),
                    )
                    .await?;
                let (_, parameters, _) = automation::values(&entry.input, &input.parameters)?;
                json!({"entry":entry,"targets":targets,"parameters":parameters,"input":raw})
            }
            ToolInput::AutomationScheduleSave { input, .. } => {
                let (entry, targets) = self
                    .automation_prepare(
                        input.entry_id.clone(),
                        input.expected_entry_revision,
                        input.host_ids.clone(),
                    )
                    .await?;
                json!({"entry":entry,"targets":targets,"input":raw})
            }
            ToolInput::AutomationApprove { id, .. } => {
                let run = self.automation_run(id.clone()).await?;
                json!({"id":run.id,"spec":run.spec,"input":raw})
            }
            ToolInput::AutomationEntryDelete { .. }
            | ToolInput::AutomationGroupDelete { .. }
            | ToolInput::AutomationCancel { .. }
            | ToolInput::AutomationScheduleDisable { .. }
            | ToolInput::AutomationScheduleDelete { .. }
            | ToolInput::AutomationRunDelete { .. } => raw,
            _ => return Ok(None),
        };
        let message =
            serde_json::to_string_pretty(&details).map_err(|e| Error::Worker(Box::new(e)))?;
        Ok(Some(ToolReview {
            title: format!("确认插件操作 · {name}"),
            message,
            confirmation_text,
        }))
    }
}
