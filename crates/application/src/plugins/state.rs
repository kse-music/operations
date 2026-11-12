use serde::{Deserialize, Serialize};
use serde_json::Value;
use serverdeck_core::Error;
use std::sync::atomic::{AtomicBool, Ordering};
use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::sync::{Notify, OwnedSemaphorePermit, Semaphore, mpsc};
use tokio_util::sync::CancellationToken;

struct Control {
    generation: String,
    cancel: CancellationToken,
    window: Instant,
    messages: usize,
}
pub(super) struct Document {
    pub settings: Value,
    pub at: Instant,
    pub dirty: bool,
    pub profile: String,
    pub owner: String,
    pub plugin: String,
    pub generation: String,
    pub internal_token: String,
    pub path: String,
    pub host: String,
}
#[derive(Clone)]
pub(super) struct Copy {
    pub settings: Value,
    pub plugin: String,
    pub owner: String,
    pub generation: String,
    pub revision: String,
    pub preview: serverdeck_plugin_sdk::platform::TransferPreview<
        serverdeck_plugin_sdk::platform::TransferDestination,
    >,
    pub plan: serverdeck_sftp::PreparedCopy,
    pub job: Option<serverdeck_sftp::CopyHandle>,
    pub cancelled: bool,
    pub at: Instant,
    pub targets: Vec<RevisionTarget>,
    pub sessions: Vec<(String, String)>,
}
pub(super) struct Log {
    pub profile: String,
    pub owner: String,
    pub plugin: String,
    pub generation: String,
    pub host: String,
    pub receiver: mpsc::Receiver<Value>,
}
pub(super) struct ResultData {
    pub owner: String,
    pub plugin: String,
    pub generation: String,
    pub bytes: Vec<u8>,
    pub at: Instant,
}
pub(super) struct OutputData {
    pub plugin: String,
    pub owner: String,
    pub generation: String,
    pub expected: usize,
    pub bytes: Vec<u8>,
    pub at: Instant,
}
#[derive(Clone, PartialEq)]
pub(super) enum RevisionTarget {
    ApprovalMode(serverdeck_plugin_sdk::platform::ApprovalMode),
    Model { id: String, revision: String },
    Host { id: String, profile: String },
}
pub(super) struct RevisionBinding {
    pub plugin: String,
    pub owner: String,
    pub generation: String,
    pub target: RevisionTarget,
    pub at: Instant,
}
impl RevisionBinding {
    pub fn expired(&self) -> bool {
        self.target
            != RevisionTarget::ApprovalMode(serverdeck_plugin_sdk::platform::ApprovalMode::Full)
            && self.at.elapsed() >= Duration::from_secs(600)
    }
}
pub(super) struct PlatformTerminalTicket {
    pub plugin: String,
    pub owner: String,
    pub generation: String,
    pub revision: String,
    pub host: String,
    pub profile: String,
    pub command: serverdeck_plugin_sdk::platform::Command,
    pub bindings: Vec<String>,
    pub at: Instant,
}
pub(super) struct PlatformTerminalOwner {
    pub plugin: String,
    pub owner: String,
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
    pub target: Option<String>,
}
pub(super) struct Pending {
    pub owner: String,
    pub public: Approval,
    pub digest: String,
    pub at: Instant,
    pub approved: bool,
}
pub(super) struct Continuation {
    pub owner: String,
    pub plugin: String,
    pub generation: String,
    pub revision: String,
    pub request: serverdeck_plugin_sdk::Request,
    pub remaining: usize,
    pub stream_remaining: usize,
    pub started: Instant,
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
    pub copies: BTreeMap<String, Copy>,
    pub model_streams: BTreeMap<String, Arc<super::streaming::ModelStream>>,
    pub progress: BTreeMap<String, super::streaming::Progress>,
    pub lifecycle_requests: BTreeMap<String, CancellationToken>,
    pub user_cancellations: BTreeMap<String, Arc<AtomicBool>>,
    pub closed_owners: BTreeSet<(String, String)>,
    pub bindings: BTreeMap<String, RevisionBinding>,
    pub full_access_sessions: BTreeMap<(String, String), String>,
    pub outputs: BTreeMap<String, OutputData>,
    pub platform_terminals: BTreeMap<String, PlatformTerminalTicket>,
    pub open_terminals: BTreeMap<String, PlatformTerminalOwner>,
    pub visible_owners: BTreeMap<(String, String), bool>,
    pub retained_owners: BTreeSet<(String, String)>,
    pub request_owners: BTreeMap<String, String>,
    pub continuations: BTreeMap<String, Continuation>,
    pub results: BTreeMap<String, ResultData>,
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
    pub collecting: bool,
    pub batch: Arc<Mutex<Option<BatchConsent>>>,
    pub lifecycle: CancellationToken,
    pub user_cancelled: Arc<AtomicBool>,
    pub owner: String,
    host: Host,
    pub id: String,
    pub generation: String,
    pub cancel: CancellationToken,
    owns_busy: bool,
    _permit: Option<OwnedSemaphorePermit>,
}
pub(super) struct BatchConsent {
    pub at: Instant,
    pub operations: BTreeMap<String, u16>,
}
impl Call {
    pub fn collector(&self) -> Self {
        Self {
            collecting: true,
            batch: Arc::default(),
            lifecycle: self.lifecycle.clone(),
            user_cancelled: self.user_cancelled.clone(),
            owner: self.owner.clone(),
            host: self.host.clone(),
            id: self.id.clone(),
            generation: self.generation.clone(),
            cancel: self.cancel.clone(),
            owns_busy: false,
            _permit: None,
        }
    }
    pub fn has_batch(&self) -> Result<bool, Error> {
        Ok(self.batch.lock().map_err(|_| Error::Busy)?.is_some())
    }
}
impl Drop for Call {
    fn drop(&mut self) {
        if !self.owns_busy {
            return;
        }
        if let Ok(mut data) = self.host.data.lock() {
            data.busy.remove(&self.id);
            data.requests.remove(&self.id);
            data.lifecycle_requests.remove(&self.id);
            data.user_cancellations.remove(&self.id);
            data.request_owners.remove(&self.id);
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
    /// Cancellation and authority reduction never occupy or release an in-flight Guest action.
    pub(super) fn start_control_scoped(&self, id: &str, owner: &str) -> Result<Call, Error> {
        if owner.is_empty() || owner.len() > 512 || owner.contains('\0') {
            return Err(Error::Validation("插件页面标识无效"));
        }
        let mut data = self.lock()?;
        if data
            .closed_owners
            .contains(&(id.to_owned(), owner.to_owned()))
        {
            return Err(failure("PLUGIN_CANCELLED", "插件页面已关闭"));
        }
        let control = data.controls.get_mut(id).ok_or(Error::NotFound)?;
        if control.cancel.is_cancelled() {
            return Err(failure("PLUGIN_CANCELLED", "插件已停止"));
        }
        if control.window.elapsed() >= Duration::from_secs(1) {
            control.window = Instant::now();
            control.messages = 0;
        }
        if control.messages >= 20 {
            return Err(failure("PLUGIN_RATE_LIMIT", "插件能力请求超过每秒二十次"));
        }
        control.messages += 1;
        let lifecycle = control.cancel.child_token();
        Ok(Call {
            collecting: false,
            batch: Arc::default(),
            lifecycle: lifecycle.clone(),
            user_cancelled: Arc::new(AtomicBool::new(false)),
            owner: owner.into(),
            host: self.clone(),
            id: id.into(),
            generation: control.generation.clone(),
            cancel: lifecycle.child_token(),
            owns_busy: false,
            _permit: None,
        })
    }
    pub(super) fn verify_resource(
        &self,
        id: &str,
        generation: &str,
        owner: &str,
    ) -> Result<(), Error> {
        let data = self.lock()?;
        if data
            .closed_owners
            .contains(&(id.to_owned(), owner.to_owned()))
            || !data
                .controls
                .get(id)
                .is_some_and(|c| c.generation == generation && !c.cancel.is_cancelled())
        {
            return Err(failure("PLUGIN_CANCELLED", "所属插件或页面已关闭"));
        }
        Ok(())
    }
    pub(super) fn lock(&self) -> Result<std::sync::MutexGuard<'_, Data>, Error> {
        self.data.lock().map_err(|_| Error::Busy)
    }
    pub(super) fn start_scoped(&self, id: &str, owner: &str) -> Result<Call, Error> {
        if owner.is_empty() || owner.len() > 512 || owner.contains('\0') {
            return Err(Error::Validation("插件页面标识无效"));
        }
        let permit = self
            .slots
            .clone()
            .try_acquire_owned()
            .map_err(|_| Error::Busy)?;
        let mut data = self.lock()?;
        if data
            .closed_owners
            .contains(&(id.to_owned(), owner.to_owned()))
        {
            return Err(failure("PLUGIN_CANCELLED", "插件页面已关闭"));
        }
        if data.busy.contains(id) {
            return Err(Error::Busy);
        }
        if data.controls.len() >= 64 && !data.controls.contains_key(id) {
            return Err(Error::Busy);
        }
        let control = data.controls.entry(id.into()).or_insert_with(|| Control {
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
        let lifecycle = control.cancel.child_token();
        let call = Call {
            collecting: false,
            batch: Arc::default(),
            lifecycle: lifecycle.clone(),
            user_cancelled: Arc::new(AtomicBool::new(false)),
            owner: owner.to_owned(),
            host: self.clone(),
            id: id.into(),
            generation: control.generation.clone(),
            cancel: lifecycle.child_token(),
            owns_busy: true,
            _permit: Some(permit),
        };
        data.requests.insert(id.into(), call.cancel.clone());
        data.lifecycle_requests
            .insert(id.into(), call.lifecycle.clone());
        data.user_cancellations
            .insert(id.into(), call.user_cancelled.clone());
        data.request_owners.insert(id.into(), owner.to_owned());
        data.busy.insert(id.into());
        Ok(call)
    }
    pub fn resume(&self, id: &str) -> Result<(), Error> {
        let mut data = self.lock()?;
        if data.busy.contains(id) {
            return Err(Error::Busy);
        }
        let generation = uuid::Uuid::new_v4().to_string();
        data.closed_owners.retain(|(plugin, _)| plugin != id);
        data.controls.insert(
            id.into(),
            Control {
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
    pub async fn stop_scope(&self, id: &str, owner: &str) -> Result<(), Error> {
        {
            let data = self.lock()?;
            if data
                .request_owners
                .get(id)
                .is_some_and(|current| current == owner)
                && let Some(token) = data.lifecycle_requests.get(id)
            {
                token.cancel();
            }
        }
        let draining = async {
            loop {
                let notified = self.idle.notified();
                if !self
                    .lock()?
                    .request_owners
                    .get(id)
                    .is_some_and(|current| current == owner)
                {
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
                    "插件保存仍在安全收尾，请等待后再关闭页面",
                )
            })?
    }
    pub fn cancel(&self, id: &str) -> Result<(), Error> {
        if let Some(token) = self.lock()?.requests.get(id) {
            token.cancel();
        }
        Ok(())
    }
    pub fn cancel_scope(&self, id: &str, owner: &str) -> Result<(), Error> {
        let data = self.lock()?;
        if data
            .request_owners
            .get(id)
            .is_some_and(|current| current == owner)
        {
            if let Some(flag) = data.user_cancellations.get(id) {
                flag.store(true, Ordering::Release);
            }
            if let Some(token) = data.requests.get(id) {
                token.cancel();
            }
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
        if call.lifecycle.is_cancelled()
            || (call.cancel.is_cancelled() && !call.user_cancelled.load(Ordering::Acquire))
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
        let call = host.start_scoped("dev.one", "default").unwrap();
        assert!(matches!(
            host.start_scoped("dev.one", "default"),
            Err(Error::Busy)
        ));
        host.cancel("dev.one").unwrap();
        assert!(call.cancel.is_cancelled());
        drop(call);
        let next = host.start_scoped("dev.one", "default").unwrap();
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
        assert!(host.start_scoped("dev.one", "default").is_err());
        host.resume("dev.one").unwrap();
        let rebound = host.start_scoped("dev.one", "default").unwrap();
        assert_ne!(old, rebound.generation);
    }
    #[test]
    fn global_concurrency_is_bounded_without_an_unbounded_queue() {
        let host = Host::default();
        let calls = (0..4)
            .map(|n| host.start_scoped(&format!("dev.p{n}"), "default").unwrap())
            .collect::<Vec<_>>();
        assert!(matches!(
            host.start_scoped("dev.excess", "default"),
            Err(Error::Busy)
        ));
        drop(calls);
        assert!(host.start_scoped("dev.excess", "default").is_ok());
    }
}
