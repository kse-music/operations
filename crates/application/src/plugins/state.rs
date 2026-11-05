use serde::{Deserialize, Serialize};
use serde_json::Value;
use serverdeck_core::Error;
use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::sync::{Notify, OwnedSemaphorePermit, Semaphore, mpsc};
use tokio_util::sync::CancellationToken;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContextInput {
    pub host_id: String,
    pub ops_session: Option<String>,
    pub file_session: Option<String>,
}
#[derive(Clone)]
pub(super) struct Context {
    pub input: ContextInput,
    pub profile: String,
}
struct Control {
    context: Option<Context>,
    generation: String,
    cancel: CancellationToken,
    window: Instant,
    messages: usize,
}
pub(super) struct Document {
    pub plugin: String,
    pub generation: String,
    pub internal_token: String,
    pub path: String,
}
pub(super) struct Log {
    pub plugin: String,
    pub generation: String,
    pub path: String,
    pub receiver: mpsc::Receiver<Value>,
}
pub(super) struct Monitor {
    pub plugin: String,
    pub generation: String,
    pub host: String,
    pub backend: serverdeck_monitor::Monitors,
}
pub(super) struct ResultData {
    pub plugin: String,
    pub generation: String,
    pub bytes: Vec<u8>,
    pub at: Instant,
}
pub(super) struct ShellTicket {
    pub plugin: String,
    pub generation: String,
    pub revision: String,
    pub host: String,
    pub container: String,
    pub bash: bool,
    pub at: Instant,
}
pub(super) struct ToolInputResource {
    pub plugin: String,
    pub generation: String,
    pub revision: String,
    pub input: super::tools::ToolInput,
    pub bytes: usize,
    pub at: Instant,
}
pub(super) struct ToolAiResource {
    pub plugin: String,
    pub generation: String,
    pub root: String,
    pub at: Instant,
    pub input_id: String,
}
pub(super) struct ActiveToolInput {
    pub input_id: String,
    pub generation: String,
    pub ai_request: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Approval {
    pub id: String,
    pub plugin_id: String,
    pub plugin_name: String,
    pub plugin_version: String,
    pub host_id: String,
    pub operation: String,
    pub description: String,
}
pub(super) struct Pending {
    pub public: Approval,
    pub digest: String,
    pub generation: String,
    pub revision: String,
    pub at: Instant,
    pub approved: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    pub plugin_id: String,
    pub kind: String,
    pub operation: String,
    pub message: String,
}
#[derive(Default)]
pub(super) struct Data {
    pub tool_inputs: BTreeMap<String, ToolInputResource>,
    pub tool_ai: BTreeMap<String, ToolAiResource>,
    pub tool_active: BTreeMap<String, ActiveToolInput>,
    pub monitors: BTreeMap<String, Monitor>,
    pub results: BTreeMap<String, ResultData>,
    pub shells: BTreeMap<String, ShellTicket>,
    controls: BTreeMap<String, Control>,
    busy: BTreeSet<String>,
    requests: BTreeMap<String, CancellationToken>,
    pub documents: BTreeMap<String, Document>,
    pub logs: BTreeMap<String, Log>,
    pub approvals: BTreeMap<String, Pending>,
    pub events: VecDeque<Event>,
}
#[derive(Clone)]
pub(crate) struct Host {
    pub(super) data: Arc<Mutex<Data>>,
    slots: Arc<Semaphore>,
    idle: Arc<Notify>,
}
impl Default for Host {
    fn default() -> Self {
        Self {
            data: Default::default(),
            slots: Arc::new(Semaphore::new(4)),
            idle: Default::default(),
        }
    }
}
pub(super) struct Call {
    host: Host,
    pub id: String,
    pub context: Option<Context>,
    pub generation: String,
    pub cancel: CancellationToken,
    _permit: OwnedSemaphorePermit,
}
impl Drop for Call {
    fn drop(&mut self) {
        if let Ok(mut data) = self.host.data.lock() {
            data.busy.remove(&self.id);
            data.requests.remove(&self.id);
        } else {
            tracing::error!(
                operation = "plugin_call_release",
                "plugin state lock poisoned"
            );
        }
        self.host.idle.notify_waiters();
    }
}
impl Host {
    pub(super) fn current(data: &Data, id: &str, generation: &str) -> bool {
        data.controls.get(id).is_some_and(|control| {
            control.generation == generation && !control.cancel.is_cancelled()
        })
    }
    pub(super) fn cancel_tool_input(
        &self,
        id: &str,
        input_id: &str,
        generation: &str,
    ) -> Result<(), Error> {
        let data = self.lock()?;
        if Self::current(&data, id, generation)
            && data
                .tool_active
                .get(id)
                .is_some_and(|a| a.input_id == input_id && a.generation == generation)
            && let Some(cancel) = data.requests.get(id)
        {
            cancel.cancel();
        }
        Ok(())
    }
    pub(super) fn generation(&self, id: &str) -> Result<String, Error> {
        let data = self.lock()?;
        let control = data.controls.get(id).ok_or(Error::NotFound)?;
        if control.cancel.is_cancelled() {
            return Err(failure("PLUGIN_CANCELLED", "插件能力已停止"));
        }
        Ok(control.generation.clone())
    }
    pub(super) fn lock(&self) -> Result<std::sync::MutexGuard<'_, Data>, Error> {
        self.data.lock().map_err(|_| Error::Busy)
    }
    pub(super) fn start(&self, id: &str) -> Result<Call, Error> {
        let permit = self
            .slots
            .clone()
            .try_acquire_owned()
            .map_err(|_| Error::Busy)?;
        let mut data = self.lock()?;
        if data.busy.contains(id) {
            return Err(Error::Busy);
        }
        if data.controls.len() >= 64 && !data.controls.contains_key(id) {
            return Err(Error::Busy);
        }
        let control = data.controls.entry(id.into()).or_insert_with(|| Control {
            context: None,
            generation: uuid::Uuid::new_v4().to_string(),
            cancel: CancellationToken::new(),
            window: Instant::now(),
            messages: 0,
        });
        if control.cancel.is_cancelled() {
            return Err(failure(
                "PLUGIN_CANCELLED",
                "插件能力已停止，请重新启用或绑定主机",
            ));
        }
        if control.window.elapsed() >= Duration::from_secs(1) {
            control.window = Instant::now();
            control.messages = 0;
        }
        if control.messages >= 20 {
            return Err(failure("PLUGIN_RATE_LIMIT", "插件能力请求超过每秒二十次"));
        }
        control.messages += 1;
        let call = Call {
            host: self.clone(),
            id: id.into(),
            context: control.context.clone(),
            generation: control.generation.clone(),
            cancel: control.cancel.child_token(),
            _permit: permit,
        };
        data.requests.insert(id.into(), call.cancel.clone());
        data.busy.insert(id.into());
        Ok(call)
    }
    pub fn resume(&self, id: &str, context: Option<(ContextInput, String)>) -> Result<(), Error> {
        let mut data = self.lock()?;
        if data.busy.contains(id) {
            return Err(Error::Busy);
        }
        let generation = uuid::Uuid::new_v4().to_string();
        let context = context.map(|(input, profile)| Context { input, profile });
        data.controls.insert(
            id.into(),
            Control {
                context,
                generation,
                cancel: CancellationToken::new(),
                window: Instant::now(),
                messages: 0,
            },
        );
        Ok(())
    }
    pub async fn stop(&self, id: &str) -> Result<(), Error> {
        {
            let data = self.lock()?;
            if let Some(c) = data.controls.get(id) {
                c.cancel.cancel();
            }
        }
        let draining = async {
            loop {
                let notified = self.idle.notified();
                if !self.lock()?.busy.contains(id) {
                    return Ok(());
                }
                notified.await;
            }
        };
        tokio::time::timeout(Duration::from_secs(40), draining)
            .await
            .map_err(|_| {
                failure(
                    "PLUGIN_COMMIT_PENDING",
                    "插件保存仍在安全收尾，请等待后重试停止",
                )
            })?
    }
    pub fn cancel(&self, id: &str) -> Result<(), Error> {
        if let Some(token) = self.lock()?.requests.get(id) {
            token.cancel();
        }
        Ok(())
    }
    pub fn forget(&self, id: &str) -> Result<(), Error> {
        let mut data = self.lock()?;
        if data.busy.contains(id) {
            return Err(Error::Busy);
        }
        data.controls.remove(id);
        Ok(())
    }
    pub(super) fn verify(&self, call: &Call) -> Result<(), Error> {
        let data = self.lock()?;
        if call.cancel.is_cancelled()
            || !data
                .controls
                .get(&call.id)
                .is_some_and(|c| c.generation == call.generation)
        {
            return Err(failure(
                "PLUGIN_CANCELLED",
                "插件请求已取消或主机上下文已变化",
            ));
        }
        Ok(())
    }
    pub fn event(&self, event: Event) -> Result<(), Error> {
        let mut data = self.lock()?;
        if data.events.len() >= 128 {
            data.events.pop_front();
        }
        data.events.push_back(event);
        Ok(())
    }
    pub fn ids(&self) -> Result<Vec<String>, Error> {
        Ok(self.lock()?.controls.keys().cloned().collect())
    }
}
pub(super) fn failure(code: &'static str, message: &'static str) -> Error {
    Error::Connection {
        code,
        message,
        source: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn call_cancel_does_not_cancel_future_calls_and_stop_drains_before_rebind() {
        let host = Host::default();
        let call = host.start("dev.one").unwrap();
        assert!(matches!(host.start("dev.one"), Err(Error::Busy)));
        host.cancel("dev.one").unwrap();
        assert!(call.cancel.is_cancelled());
        drop(call);
        let next = host.start("dev.one").unwrap();
        assert!(!next.cancel.is_cancelled());
        let old = next.generation.clone();
        let stop = host.stop("dev.one");
        tokio::pin!(stop);
        assert!(
            tokio::time::timeout(Duration::from_millis(10), &mut stop)
                .await
                .is_err()
        );
        assert!(next.cancel.is_cancelled());
        drop(next);
        tokio::time::timeout(Duration::from_secs(1), stop)
            .await
            .unwrap()
            .unwrap();
        assert!(host.start("dev.one").is_err());
        host.resume("dev.one", None).unwrap();
        let rebound = host.start("dev.one").unwrap();
        assert_ne!(old, rebound.generation);
    }
    #[test]
    fn global_concurrency_is_bounded_without_an_unbounded_queue() {
        let host = Host::default();
        let calls = (0..4)
            .map(|n| host.start(&format!("dev.p{n}")).unwrap())
            .collect::<Vec<_>>();
        assert!(matches!(host.start("dev.excess"), Err(Error::Busy)));
        drop(calls);
        assert!(host.start("dev.excess").is_ok());
    }
}
