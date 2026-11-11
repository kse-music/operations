//! Owner-bound model transport and display-only text buffers. No workflow interpretation.
use super::{
    state::{Call, failure},
    *,
};
use serde_json::{Value, json};
use serverdeck_ai::{ModelCall, provider::Completion, streaming::TextDelta};
use serverdeck_core::Error;
use serverdeck_plugin_core::permissions::denied;
use serverdeck_plugin_sdk::{platform::Message, streaming::Request};
use serverdeck_storage::ai::ModelRecord;
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::{Mutex, mpsc, oneshot};
use tokio_util::sync::CancellationToken;
use zeroize::Zeroizing;

pub(super) struct Progress {
    pub plugin: String,
    pub owner: String,
    pub generation: String,
    revision: u64,
    text: String,
}
struct Reader {
    deltas: mpsc::Receiver<TextDelta>,
    completion: Option<oneshot::Receiver<Result<Completion, Error>>>,
}
pub(super) struct ModelStream {
    pub plugin: String,
    pub owner: String,
    pub generation: String,
    model: String,
    revision: String,
    pub cancel: CancellationToken,
    reader: Mutex<Reader>,
    task: Mutex<Option<tokio::task::JoinHandle<()>>>,
}
impl Drop for ModelStream {
    fn drop(&mut self) {
        self.cancel.cancel();
    }
}

impl Application {
    async fn plugin_model_request(
        &self,
        model: String,
        expected: Option<String>,
        mut messages: Vec<Message>,
    ) -> Result<(ModelRecord, Zeroizing<Vec<u8>>, Value, ModelCall), Error> {
        if messages.is_empty()
            || messages.len() > 64
            || messages.iter().any(|m| m.content.len() > 48 * 1024)
            || serde_json::to_vec(&messages)
                .map_err(|e| Error::Worker(Box::new(e)))?
                .len()
                > 48 * 1024
        {
            return Err(Error::Validation("模型消息超过平台限制"));
        }
        let (record, key) = self.ai_credentials(model.clone()).await?;
        if expected.as_ref().is_some_and(|r| r != &record.revision) {
            return Err(Error::Conflict);
        }
        let model_call = self.models_runtime.begin(&model)?;
        if self.ai_credentials(model).await?.0.revision != record.revision {
            return Err(Error::Conflict);
        }
        if record.config.provider == serverdeck_core::ai::Provider::OpenaiCompatible
            && let Ok(secret) = std::str::from_utf8(&key)
            && !secret.is_empty()
        {
            for message in &mut messages {
                message.content = message.content.replace(secret, "[REDACTED]");
            }
        }
        let body = json!({"model":record.config.model,"messages":messages,"max_completion_tokens":record.config.max_output_tokens,"stream":false,"store":false});
        Ok((record, key, body, model_call))
    }
    pub(super) async fn plugin_model_complete(
        &self,
        call: &Call,
        model: String,
        expected: Option<String>,
        messages: Vec<Message>,
    ) -> Result<Value, Error> {
        let (record, key, body, model_call) =
            self.plugin_model_request(model, expected, messages).await?;
        let completion = tokio::select! {
            _ = model_call.cancel.cancelled() => return Err(Error::Conflict),
            result = tokio::time::timeout(Duration::from_secs(150), serverdeck_ai::provider::complete(&record.config, &key, &body)) => result.map_err(|_| failure("MODEL_TIMEOUT", "模型调用超时"))??,
            _ = call.cancel.cancelled() => return Err(if call.user_cancelled.load(std::sync::atomic::Ordering::Acquire) { failure("USER_CANCELLED", "模型调用已取消") } else { failure("PLUGIN_CANCELLED", "模型调用已停止") }),
        };
        if self.ai_credentials(record.id.clone()).await?.0.revision != record.revision {
            return Err(Error::Conflict);
        }
        let binding = self.plugin_model_binding(call, &record.id, &record.revision)?;
        Ok(
            json!({"text":completion.text,"usage":completion.usage,"incomplete":completion.incomplete,"binding":binding}),
        )
    }
    pub(super) async fn plugin_streaming(
        &self,
        call: &Call,
        request: Request,
    ) -> Result<Value, Error> {
        let key_matches = |plugin: &str, owner: &str, generation: &str| {
            plugin == call.id && owner == call.owner && generation == call.generation
        };
        match request {
            Request::ProgressOpen => {
                let mut data = self.plugin_host.lock()?;
                if data.progress.len() >= 16 {
                    return Err(Error::Busy);
                }
                let id = uuid::Uuid::new_v4().to_string();
                data.progress.insert(
                    id.clone(),
                    Progress {
                        plugin: call.id.clone(),
                        owner: call.owner.clone(),
                        generation: call.generation.clone(),
                        revision: 1,
                        text: String::new(),
                    },
                );
                Ok(json!({"id":id}))
            }
            Request::ProgressPublish { id, text, reset } => {
                if text.len() > 16 * 1024 {
                    return Err(Error::Validation("进度文本片段超过16 KiB"));
                }
                let mut data = self.plugin_host.lock()?;
                let progress = data.progress.get_mut(&id).ok_or(Error::NotFound)?;
                if !key_matches(&progress.plugin, &progress.owner, &progress.generation) {
                    return Err(denied());
                }
                let total = if reset { 0 } else { progress.text.len() } + text.len();
                if total > 256 * 1024 {
                    return Err(Error::Validation("进度文本超过256 KiB"));
                }
                if reset {
                    progress.text.clear();
                    progress.revision += 1;
                }
                progress.text.push_str(&text);
                Ok(Value::Null)
            }
            Request::ProgressRead {
                id,
                revision,
                offset,
            } => {
                let data = self.plugin_host.lock()?;
                let progress = data.progress.get(&id).ok_or(Error::NotFound)?;
                if !key_matches(&progress.plugin, &progress.owner, &progress.generation) {
                    return Err(denied());
                }
                let start = if revision != progress.revision {
                    0
                } else {
                    offset
                };
                if start > progress.text.len() || !progress.text.is_char_boundary(start) {
                    return Err(Error::Validation("进度读取位置无效"));
                }
                let mut end = (start + 8 * 1024).min(progress.text.len());
                while !progress.text.is_char_boundary(end) {
                    end -= 1;
                }
                Ok(
                    json!({"revision":progress.revision,"text":progress.text[start..end],"offset":end}),
                )
            }
            Request::ProgressClose { id } => {
                let mut data = self.plugin_host.lock()?;
                if let Some(progress) = data.progress.get(&id) {
                    if !key_matches(&progress.plugin, &progress.owner, &progress.generation) {
                        return Err(denied());
                    }
                    data.progress.remove(&id);
                }
                Ok(Value::Null)
            }
            Request::ModelStart {
                model_id,
                expected_revision,
                messages,
            } => {
                let (record, key, mut body, model_call) = self
                    .plugin_model_request(model_id, expected_revision, messages)
                    .await?;
                self.plugin_host.verify(call)?;
                if call.cancel.is_cancelled() {
                    return Err(failure("USER_CANCELLED", "模型流启动已取消"));
                }
                body["stream"] = json!(true);
                if !record.config.provider.is_local() {
                    body["stream_options"] = json!({"include_usage":true});
                }
                let id = uuid::Uuid::new_v4().to_string();
                let cancel = call.cancel.child_token();
                let task_cancel = cancel.clone();
                let (sender, deltas) = mpsc::channel(32);
                let (done, completion) = oneshot::channel();
                let plugin = call.id.clone();
                let owner = call.owner.clone();
                let generation = call.generation.clone();
                let model = record.id.clone();
                let revision = record.revision.clone();
                let mut data = self.plugin_host.lock()?;
                if data.model_streams.len() >= 8 {
                    return Err(Error::Busy);
                }
                let task = tokio::spawn(async move {
                    let result = tokio::select! {
                        biased;
                        _ = task_cancel.cancelled() => Err(failure("USER_CANCELLED", "模型流已停止")),
                        _ = model_call.cancel.cancelled() => Err(Error::Conflict),
                        result = tokio::time::timeout(Duration::from_secs(150), serverdeck_ai::streaming::complete(&record.config, &key, &body, sender)) => result.map_err(|_| failure("MODEL_TIMEOUT", "模型流超时")).and_then(|r| r),
                    };
                    let _ = done.send(result);
                });
                data.model_streams.insert(
                    id.clone(),
                    Arc::new(ModelStream {
                        plugin,
                        owner,
                        generation,
                        model,
                        revision,
                        cancel,
                        reader: Mutex::new(Reader {
                            deltas,
                            completion: Some(completion),
                        }),
                        task: Mutex::new(Some(task)),
                    }),
                );
                Ok(json!({"id":id}))
            }
            Request::ModelPoll { id } => {
                let stream = self.plugin_model_stream(call, &id)?;
                let started = Instant::now();
                let mut reader = stream.reader.lock().await;
                let mut deltas = Vec::new();
                let mut bytes = 0usize;
                loop {
                    let left = Duration::from_millis(250).saturating_sub(started.elapsed());
                    if left.is_zero() || bytes >= 16 * 1024 {
                        break;
                    }
                    let delta = tokio::select! {
                        _ = call.cancel.cancelled() => return Err(failure("USER_CANCELLED", "模型流读取已停止")),
                        delta = tokio::time::timeout(left, reader.deltas.recv()) => match delta { Ok(Some(delta)) => delta, _ => break },
                    };
                    bytes += delta.text.len();
                    deltas.push(delta);
                }
                let completion = if let Some(done) = reader.completion.as_mut() {
                    match done.try_recv() {
                        Ok(result) => {
                            reader.completion = None;
                            Some(result?)
                        }
                        Err(oneshot::error::TryRecvError::Empty) => None,
                        Err(oneshot::error::TryRecvError::Closed) => {
                            return Err(failure("MODEL_STREAM_FAILED", "模型流任务异常结束"));
                        }
                    }
                } else {
                    return Err(failure("MODEL_STREAM_CONSUMED", "模型流已完成，不能重放"));
                };
                drop(reader);
                self.plugin_host.verify(call)?;
                if self.ai_credentials(stream.model.clone()).await?.0.revision != stream.revision {
                    return Err(Error::Conflict);
                }
                let complete = if let Some(completion) = completion {
                    let binding =
                        self.plugin_model_binding(call, &stream.model, &stream.revision)?;
                    json!({"text":completion.text,"usage":completion.usage,"incomplete":completion.incomplete,"binding":binding})
                } else {
                    Value::Null
                };
                Ok(json!({"deltas":deltas,"completion":complete}))
            }
            Request::ModelClose { id } => {
                let stream = self.plugin_model_stream(call, &id)?;
                self.plugin_host.lock()?.model_streams.remove(&id);
                Self::plugin_close_model_stream(stream).await?;
                Ok(Value::Null)
            }
        }
    }
    fn plugin_model_stream(&self, call: &Call, id: &str) -> Result<Arc<ModelStream>, Error> {
        let stream = self
            .plugin_host
            .lock()?
            .model_streams
            .get(id)
            .cloned()
            .ok_or(Error::NotFound)?;
        if stream.plugin != call.id
            || stream.owner != call.owner
            || stream.generation != call.generation
        {
            return Err(denied());
        }
        Ok(stream)
    }
    async fn plugin_close_model_stream(stream: Arc<ModelStream>) -> Result<(), Error> {
        stream.cancel.cancel();
        if let Some(mut task) = stream.task.lock().await.take() {
            match tokio::time::timeout(Duration::from_secs(3), &mut task).await {
                Ok(result) => result.map_err(|e| Error::Worker(Box::new(e)))?,
                Err(error) => {
                    task.abort();
                    let _ = task.await;
                    return Err(Error::Worker(Box::new(error)));
                }
            }
        }
        Ok(())
    }
    pub(super) async fn plugin_close_streaming(
        &self,
        plugin: &str,
        owner: Option<&str>,
    ) -> Result<(), Error> {
        let streams = {
            let mut data = self.plugin_host.lock()?;
            data.progress
                .retain(|_, p| p.plugin != plugin || owner.is_some_and(|owner| p.owner != owner));
            let ids = data
                .model_streams
                .iter()
                .filter(|(_, s)| s.plugin == plugin && owner.is_none_or(|owner| s.owner == owner))
                .map(|(id, _)| id.clone())
                .collect::<Vec<_>>();
            ids.into_iter()
                .filter_map(|id| data.model_streams.remove(&id))
                .collect::<Vec<_>>()
        };
        let mut first = None;
        for stream in streams {
            if let Err(error) = Self::plugin_close_model_stream(stream).await {
                if first.is_none() {
                    first = Some(error);
                } else {
                    tracing::warn!(
                        operation = "plugin_stream_cleanup",
                        code = serverdeck_core::IpcError::from(error).code,
                        "Additional model stream cleanup failed"
                    );
                }
            }
        }
        match first {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }
}
