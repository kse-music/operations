//! Platform model transports, connection-test receipts and cancellation. No plugin workflows.
pub mod claude;
pub mod codex;
mod local_cli;
pub mod local_tools;
mod model_test;
pub mod provider;
pub mod streaming;
pub use model_test::ModelTestBinding;
use provider::{ModelProvider, OpenAiCompatible};
use serverdeck_core::{Error, ai::*};
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
        .map_err(|_| failure("MODEL_STATE", "模型运行状态不可用"))
}
pub const REQUEST_LIMIT_BYTES: usize = 96 * 1024;
const INPUT_TOKEN_MARGIN: u64 = 64;

pub fn request_byte_limit(config: &Config) -> usize {
    let input = u64::from(config.context_window_tokens)
        .saturating_sub(u64::from(config.max_output_tokens) + INPUT_TOKEN_MARGIN);
    (input as usize).min(REQUEST_LIMIT_BYTES)
}

fn check_request_budget(
    config: &Config,
    wire_bytes: usize,
    output_tokens: u64,
) -> Result<u64, Error> {
    if wire_bytes > REQUEST_LIMIT_BYTES {
        return Err(failure(
            "AI_CONTEXT_LIMIT",
            "问题、历史与上下文合计超过 96 KiB，请缩小问题或主机范围，或开启新对话",
        ));
    }
    // Conservative UTF-8 byte estimate, independent of any specific provider tokenizer.
    let estimated_input_tokens = wire_bytes as u64 + INPUT_TOKEN_MARGIN;
    if estimated_input_tokens.saturating_add(output_tokens)
        > u64::from(config.context_window_tokens)
    {
        return Err(failure(
            "AI_CONTEXT_LIMIT",
            "估算的输入加输出预留超过模型上下文窗口，请缩小问题范围或调整模型的 Token 限制",
        ));
    }
    Ok(estimated_input_tokens)
}

#[derive(Default)]
struct State {
    tests: HashMap<String, model_test::TestReceipt>,
    active: HashMap<String, (String, CancellationToken)>,
}
impl State {
    fn prune(&mut self) {
        self.tests
            .retain(|_, receipt| receipt.at.elapsed() < Duration::from_secs(300));
    }
}
#[derive(Clone)]
pub struct Models {
    state: Arc<Mutex<State>>,
    slots: Arc<Semaphore>,
    stop: CancellationToken,
}
impl Default for Models {
    fn default() -> Self {
        Self {
            state: Arc::default(),
            slots: Arc::new(Semaphore::new(4)),
            stop: CancellationToken::new(),
        }
    }
}
pub struct ModelCall {
    state: Arc<Mutex<State>>,
    id: String,
    pub cancel: CancellationToken,
    _slot: tokio::sync::OwnedSemaphorePermit,
}
impl Drop for ModelCall {
    fn drop(&mut self) {
        match lock(&self.state) {
            Ok(mut state) => {
                state.active.remove(&self.id);
            }
            Err(_) => tracing::error!(
                operation = "model_call_release",
                "Model state lock poisoned"
            ),
        }
    }
}
impl Models {
    pub fn begin(&self, model: &str) -> Result<ModelCall, Error> {
        if self.stop.is_cancelled() {
            return Err(Error::ShuttingDown);
        }
        let slot = self
            .slots
            .clone()
            .try_acquire_owned()
            .map_err(|_| Error::Busy)?;
        let id = uuid::Uuid::new_v4().to_string();
        let cancel = self.stop.child_token();
        lock(&self.state)?
            .active
            .insert(id.clone(), (model.to_owned(), cancel.clone()));
        Ok(ModelCall {
            state: self.state.clone(),
            id,
            cancel,
            _slot: slot,
        })
    }
    pub fn revoke_model(&self, model: &str) -> Result<(), Error> {
        for (id, cancel) in lock(&self.state)?.active.values() {
            if id == model {
                cancel.cancel();
            }
        }
        Ok(())
    }
    pub async fn shutdown(&self) {
        self.stop.cancel();
        if let Ok(mut state) = self.state.lock() {
            state.tests.clear();
        }
        if tokio::time::timeout(Duration::from_secs(3), self.slots.acquire_many(4))
            .await
            .is_err()
        {
            tracing::warn!(
                operation = "model_shutdown",
                "Model calls did not drain in time"
            );
        }
    }
}
#[cfg(test)]
mod tests;
