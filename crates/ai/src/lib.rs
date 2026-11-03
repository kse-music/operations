pub mod commands;
mod model_test;
pub mod provider;
pub mod redact;
pub mod routing;
pub use model_test::ModelTestBinding;

use provider::{ModelProvider, OpenAiCompatible};
use redact::Redactor;
use serde::Deserialize;
use serde_json::Value;
use serverdeck_core::{Error, ai::*, ops::Request, terminal::TerminalSession};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;

pub fn failure(code: &'static str, message: &'static str) -> Error {
    Error::Connection {
        code,
        message,
        source: None,
    }
}
fn lock<T>(value: &Mutex<T>) -> Result<std::sync::MutexGuard<'_, T>, Error> {
    value
        .lock()
        .map_err(|_| failure("AI_STATE", "AI 状态不可用"))
}
#[derive(Clone)]
pub struct Binding {
    pub session: TerminalSession,
    pub profile: String,
    pub hostname: String,
    pub username: String,
    pub port: u16,
}
pub struct PreparedContext {
    pub related_bindings: Vec<Binding>,
    pub history: Vec<ChatMessage>,
    pub model_id: String,
    pub revision: String,
    pub config: Config,
    pub question: String,
    pub context: Value,
    pub binding: Option<Binding>,
    pub redactor: Redactor,
    pub warnings: Vec<String>,
}
struct Pending {
    related_bindings: Vec<Binding>,
    model_id: String,
    at: Instant,
    revision: String,
    config: Config,
    body: Value,
    binding: Option<Binding>,
    redactor: Arc<Redactor>,
}
struct ApprovedCommand {
    model_id: String,
    at: Instant,
    request_id: String,
    proposal: Proposal,
    binding: Binding,
    request: Request,
    redactor: Arc<Redactor>,
}
#[derive(Default)]
struct State {
    tests: HashMap<String, model_test::TestReceipt>,
    previews: HashMap<String, Pending>,
    commands: HashMap<String, ApprovedCommand>,
    active: HashMap<String, (String, CancellationToken)>,
}
impl State {
    fn prune(&mut self) {
        self.tests
            .retain(|_, t| t.at.elapsed() < Duration::from_secs(300));
        self.previews
            .retain(|_, p| p.at.elapsed() < Duration::from_secs(300));
        self.commands
            .retain(|_, c| c.at.elapsed() < Duration::from_secs(600));
    }
}
#[derive(Clone)]
pub struct Assistant {
    state: Arc<Mutex<State>>,
    slots: Arc<Semaphore>,
    executions: Arc<Semaphore>,
    stop: CancellationToken,
}
impl Default for Assistant {
    fn default() -> Self {
        Self {
            state: Arc::default(),
            slots: Arc::new(Semaphore::new(1)),
            executions: Arc::new(Semaphore::new(1)),
            stop: CancellationToken::new(),
        }
    }
}
impl Assistant {
    pub fn prepare(&self, input: PreparedContext) -> Result<Preview, Error> {
        let PreparedContext {
            related_bindings,
            history,
            model_id,
            revision,
            config,
            question,
            mut context,
            binding,
            redactor,
            mut warnings,
        } = input;
        if self.stop.is_cancelled() {
            return Err(Error::ShuttingDown);
        }
        if question.trim().is_empty() || question.len() > 8192 {
            return Err(Error::Validation("问题须为 1–8192 字节"));
        }
        let destination = provider::endpoint(&config)?.to_string();
        redactor.value(&mut context);
        validate_history(&history)?;
        let mut body = provider::request(&config, &redactor.text(&question), context);
        let messages = body["messages"]
            .as_array_mut()
            .ok_or(Error::Validation("模型消息格式无效"))?;
        for (index, message) in history.into_iter().enumerate() {
            messages.insert(
                index + 1,
                serde_json::json!({"role":message.role,"content":redactor.text(&message.content)}),
            );
        }
        let serialized =
            serde_json::to_string_pretty(&body).map_err(|e| Error::Worker(Box::new(e)))?;
        if serialized.len() > 96 * 1024 {
            return Err(failure(
                "AI_CONTEXT_LIMIT",
                "发送上下文超过 96 KiB，请减少所选数据",
            ));
        }
        // Conservative UTF-8 byte estimate, not a model tokenizer or a billing guarantee.
        let estimated_input_tokens = serde_json::to_vec(&body)
            .map_err(|e| Error::Worker(Box::new(e)))?
            .len() as u64
            + 64;
        let id = uuid::Uuid::new_v4().to_string();
        warnings.push(
            "问题、历史和上下文已进行自动脱敏，仍可能遗漏敏感内容。执行输出不会作为对话历史发送。"
                .into(),
        );
        if config.allow_insecure_http && destination.starts_with("http:") {
            warnings.push("当前目标使用 HTTP，API Key 和上下文会明文传输。".into());
        }
        let preview = Preview {
            id: id.clone(),
            model_id: model_id.clone(),
            destination,
            model: config.model.clone(),
            body: serialized,
            estimated_input_tokens,
            max_output_tokens: config.max_output_tokens,
            estimated_max_cost: cost(
                &config,
                estimated_input_tokens,
                config.max_output_tokens as u64,
            ),
            warnings,
        };
        let mut state = lock(&self.state)?;
        state.prune();
        if state.previews.len() >= 8 {
            return Err(Error::Busy);
        }
        state.previews.insert(
            id,
            Pending {
                related_bindings,
                model_id,
                at: Instant::now(),
                revision,
                config,
                body,
                binding,
                redactor: Arc::new(redactor),
            },
        );
        Ok(preview)
    }
    pub fn preview_binding(&self, id: &str) -> Result<Option<Binding>, Error> {
        let mut state = lock(&self.state)?;
        state.prune();
        Ok(state
            .previews
            .get(id)
            .ok_or(Error::NotFound)?
            .binding
            .clone())
    }
    pub fn preview_model_id(&self, id: &str) -> Result<String, Error> {
        let mut state = lock(&self.state)?;
        state.prune();
        Ok(state
            .previews
            .get(id)
            .ok_or(Error::NotFound)?
            .model_id
            .clone())
    }
    pub fn preview_bindings(&self, id: &str) -> Result<Vec<Binding>, Error> {
        let mut state = lock(&self.state)?;
        state.prune();
        let pending = state.previews.get(id).ok_or(Error::NotFound)?;
        Ok(pending
            .binding
            .iter()
            .cloned()
            .chain(pending.related_bindings.iter().cloned())
            .collect())
    }
    pub fn revoke_model(&self, id: &str) -> Result<(), Error> {
        let mut state = lock(&self.state)?;
        state.previews.retain(|_, p| p.model_id != id);
        state.commands.retain(|_, c| c.model_id != id);
        for (model_id, cancel) in state.active.values() {
            if model_id == id {
                cancel.cancel();
            }
        }
        Ok(())
    }
    pub async fn send(
        &self,
        id: &str,
        revision: &str,
        key: &[u8],
        confirmed: bool,
    ) -> Result<Answer, Error> {
        if !confirmed {
            return Err(Error::Validation("请明确发送此问题"));
        }
        if self.stop.is_cancelled() {
            return Err(Error::ShuttingDown);
        }
        let _permit = self.slots.try_acquire().map_err(|_| Error::Busy)?;
        let cancel = self.stop.child_token();
        let pending = {
            let mut state = lock(&self.state)?;
            state.prune();
            let pending = state.previews.remove(id).ok_or(Error::NotFound)?;
            if pending.revision != revision {
                return Err(Error::Conflict);
            }
            state
                .active
                .insert(id.to_owned(), (pending.model_id.clone(), cancel.clone()));
            pending
        };
        let result = tokio::select! {
            r = OpenAiCompatible.complete(&pending.config, key, &pending.body) => r,
            _ = cancel.cancelled() => Err(failure("AI_CANCELLED", "AI 请求已取消；服务端仍可能计费")),
        };
        let mut state = lock(&self.state)?;
        state.active.remove(id);
        let completion = result?;
        if cancel.is_cancelled() {
            return Err(failure("AI_CANCELLED", "AI 请求已取消"));
        }
        let mut warnings =
            vec!["模型内容不可信，分析可能有误。执行输出仅在本地展示，不自动回传模型。".into()];
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Structured {
            answer: String,
            commands: Vec<String>,
        }
        let structured = serde_json::from_str::<Structured>(&completion.text);
        let (text, commands) = match structured {
            Ok(s)
                if !completion.incomplete
                    && s.commands.len() <= 8
                    && s.commands
                        .iter()
                        .all(|c| c.len() <= 2048 && !c.chars().any(char::is_control)) =>
            {
                (s.answer, s.commands)
            }
            _ => {
                warnings.push("响应未遵守建议格式或被截断，按纯文本显示，未开放命令执行。".into());
                (completion.text, vec![])
            }
        };
        state.prune();
        let mut proposals = Vec::new();
        for command in commands {
            let command = pending.redactor.text(&command);
            let request = commands::classify(&command);
            let executable =
                pending.binding.is_some() && request.is_some() && state.commands.len() < 64;
            let change = request.as_ref().is_some_and(|r| r.action().is_some());
            let proposal = Proposal {
                id: uuid::Uuid::new_v4().to_string(),
                command: command.clone(),
                risk: if !executable {
                    CommandRisk::ManualOnly
                } else if change {
                    CommandRisk::Change
                } else {
                    CommandRisk::ReadOnly
                },
                reason: if !executable {
                    "未匹配受控命令或未绑定服务器，仅可人工审阅"
                } else if change {
                    "将修改系统状态，需单独输入确认语句；不提权、不重试"
                } else {
                    "匹配固定只读诊断命令，仍须逐条批准"
                },
                target: pending
                    .binding
                    .as_ref()
                    .map(|b| format!("{}@{}:{}", b.username, b.hostname, b.port)),
                change_confirmation: if executable && change {
                    Some(format!("批准变更：{command}"))
                } else {
                    None
                },
            };
            if executable && let (Some(binding), Some(request)) = (&pending.binding, request) {
                state.commands.insert(
                    proposal.id.clone(),
                    ApprovedCommand {
                        model_id: pending.model_id.clone(),
                        at: Instant::now(),
                        request_id: id.into(),
                        proposal: proposal.clone(),
                        binding: binding.clone(),
                        request,
                        redactor: pending.redactor.clone(),
                    },
                );
            }
            proposals.push(proposal);
        }
        let estimated_cost = completion
            .usage
            .as_ref()
            .and_then(|u| cost(&pending.config, u.input_tokens, u.output_tokens));
        Ok(Answer {
            text: pending.redactor.text(&text),
            proposals,
            usage: completion.usage,
            estimated_cost,
            warnings,
        })
    }
    pub fn execution_binding(&self, id: &str) -> Result<Binding, Error> {
        let mut state = lock(&self.state)?;
        state.prune();
        Ok(state
            .commands
            .get(id)
            .ok_or(Error::NotFound)?
            .binding
            .clone())
    }
    pub fn take_command(&self, input: ExecuteInput) -> Result<(Request, Arc<Redactor>), Error> {
        if self.stop.is_cancelled() {
            return Err(Error::ShuttingDown);
        }
        let mut state = lock(&self.state)?;
        state.prune();
        let c = state
            .commands
            .get(&input.proposal_id)
            .ok_or(Error::NotFound)?;
        if !input.confirmed {
            return Err(Error::Validation("每条诊断命令均须用户明确批准"));
        }
        if c.proposal.change_confirmation.is_some()
            && c.proposal.change_confirmation != input.change_confirmation
        {
            return Err(Error::Validation("修改系统状态须单独输入完整确认语句"));
        }
        let c = state
            .commands
            .remove(&input.proposal_id)
            .ok_or(Error::NotFound)?;
        Ok((c.request, c.redactor))
    }
    pub fn execution_slot(&self) -> Result<tokio::sync::OwnedSemaphorePermit, Error> {
        self.executions
            .clone()
            .try_acquire_owned()
            .map_err(|_| Error::Busy)
    }
    pub fn cancel(&self, id: &str) -> Result<(), Error> {
        let mut state = lock(&self.state)?;
        state.previews.remove(id);
        state.commands.retain(|_, c| c.request_id != id);
        if let Some((_, cancel)) = state.active.get(id) {
            cancel.cancel();
        }
        Ok(())
    }
    pub async fn shutdown(&self) {
        self.stop.cancel();
        if let Ok(mut state) = self.state.lock() {
            state.previews.clear();
            state.commands.clear();
        }
        if tokio::time::timeout(Duration::from_secs(3), self.slots.acquire())
            .await
            .is_err()
        {
            tracing::warn!(
                operation = "ai_shutdown",
                "AI request did not drain in time"
            );
        }
    }
}
pub fn cost(config: &Config, input: u64, output: u64) -> Option<f64> {
    Some(
        (config.input_price_per_million? * input as f64
            + config.output_price_per_million? * output as f64)
            / 1_000_000.0,
    )
}

#[cfg(test)]
mod tests;
