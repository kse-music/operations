use crate::{failure, protocol::*, vm::Vm};
use serde_json::Value;
use serverdeck_core::Error;
use serverdeck_plugin_core::{InstalledPlugin, Repository};
use std::{
    collections::BTreeMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::sync::Semaphore;

const MAX_ACTIVE: usize = 8;
struct Slot {
    status: Status,
    vm: Option<Vm>,
    cancelled: Arc<AtomicBool>,
    window: Instant,
    messages: usize,
}
struct Instance {
    state: Mutex<Slot>,
    cancelled: Arc<AtomicBool>,
}
impl Instance {
    fn lock(&self) -> std::sync::LockResult<std::sync::MutexGuard<'_, Slot>> {
        self.state.lock()
    }
    fn try_lock(&self) -> std::sync::TryLockResult<std::sync::MutexGuard<'_, Slot>> {
        self.state.try_lock()
    }
}
#[derive(Clone)]
pub struct Runtime {
    repository: Repository,
    slots: Arc<Mutex<BTreeMap<String, Arc<Instance>>>>,
    concurrent: Arc<Semaphore>,
    controls: Arc<Semaphore>,
    closing: Arc<AtomicBool>,
}
impl Runtime {
    pub fn new(repository: Repository) -> Self {
        Self {
            repository,
            slots: Default::default(),
            concurrent: Arc::new(Semaphore::new(2)),
            controls: Arc::new(Semaphore::new(8)),
            closing: Default::default(),
        }
    }
    pub fn statuses(&self) -> Result<Vec<Status>, Error> {
        let slots: Vec<_> = self
            .slots
            .lock()
            .map_err(|_| Error::Busy)?
            .values()
            .cloned()
            .collect();
        slots
            .into_iter()
            .map(|s| {
                s.try_lock()
                    .map(|s| s.status.clone())
                    .map_err(|_| Error::Busy)
            })
            .collect()
    }
    pub async fn activate(&self, id: &str) -> Result<Status, Error> {
        self.check_open()?;
        let permit = self
            .concurrent
            .clone()
            .try_acquire_owned()
            .map_err(|_| Error::Busy)?;
        let plugin = self.metadata(id).await?;
        if !plugin.enabled {
            return Err(failure("PLUGIN_DISABLED", "插件未启用"));
        }
        let slot = {
            let mut slots = self.slots.lock().map_err(|_| Error::Busy)?;
            if let Some(slot) = slots.get(id) {
                let state = slot.try_lock().map_err(|_| Error::Busy)?;
                if state.status.revision == plugin.revision
                    && state.status.state == State::Active
                    && !slot.cancelled.load(Ordering::Acquire)
                {
                    return Ok(state.status.clone());
                }
                if state.status.state == State::Starting || state.status.state == State::Stopping {
                    return Err(Error::Busy);
                }
            }
            let active = slots
                .values()
                .filter(|s| {
                    s.try_lock().map_or(true, |s| {
                        matches!(
                            s.status.state,
                            State::Starting | State::Active | State::Stopping
                        )
                    })
                })
                .count();
            let replaces_active = slots
                .get(id)
                .is_some_and(|s| s.try_lock().is_ok_and(|s| s.status.state == State::Active));
            if (active >= MAX_ACTIVE && !replaces_active)
                || (!slots.contains_key(id) && slots.len() >= 64)
            {
                return Err(failure("PLUGIN_QUOTA", "插件运行时最多八个活动实例"));
            }
            let cancelled = Arc::new(AtomicBool::new(false));
            let slot = Arc::new(Instance {
                cancelled: cancelled.clone(),
                state: Mutex::new(Slot {
                    status: Status {
                        id: id.into(),
                        revision: plugin.revision.clone(),
                        state: State::Starting,
                        error_code: None,
                        diagnostic: None,
                    },
                    vm: None,
                    cancelled,
                    window: Instant::now(),
                    messages: 0,
                }),
            });
            slots.insert(id.into(), slot.clone());
            slot
        };
        let repository = self.repository.clone();
        let worker = slot.clone();
        let closing = self.closing.clone();
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            let mut state = worker.lock().map_err(|_| Error::Busy)?;
            let result = (|| {
                let current = repository.detail(&plugin.manifest.id)?;
                if !current.enabled
                    || current.revision != plugin.revision
                    || closing.load(Ordering::Acquire)
                {
                    return Err(failure("PLUGIN_DISABLED", "插件已禁用或版本已变化"));
                }
                let backend = plugin
                    .manifest
                    .entry
                    .backend
                    .as_ref()
                    .ok_or_else(|| failure("PLUGIN_NO_BACKEND", "插件没有后端入口"))?;
                let bytes = repository.read_file(&plugin, backend)?;
                let mut vm = Vm::new(&bytes, state.cancelled.clone())?;
                success(vm.call(Operation::Startup, Value::Null)?)?;
                let reply = success(vm.call(Operation::Activate, Value::Null)?)?;
                state.status.diagnostic = Some(reply.result);
                state.vm = Some(vm);
                Ok(())
            })();
            finish(&mut state, result)?;
            Ok(state.status.clone())
        })
        .await
        .map_err(|e| Error::Worker(Box::new(e)))?
    }
    pub async fn call(&self, id: &str, payload: Value) -> Result<Reply, Error> {
        self.request(id, Operation::Invoke, payload).await
    }
    pub async fn health(&self, id: &str) -> Result<Reply, Error> {
        self.request(id, Operation::Health, Value::Null).await
    }
    /// Host-only continuation. There is no UI IPC that selects this opcode.
    pub async fn resume(&self, id: &str, response: Value) -> Result<Reply, Error> {
        self.request(id, Operation::Resume, response).await
    }
    async fn request(
        &self,
        id: &str,
        operation: Operation,
        payload: Value,
    ) -> Result<Reply, Error> {
        self.check_open()?;
        if serde_json::to_vec(&payload)
            .map_err(|e| Error::Worker(Box::new(e)))?
            .len()
            > MAX_MESSAGE - 1024
        {
            return Err(failure("PLUGIN_MESSAGE_LIMIT", "插件请求消息过大"));
        }
        let permit = self
            .concurrent
            .clone()
            .try_acquire_owned()
            .map_err(|_| Error::Busy)?;
        let plugin = self.metadata(id).await?;
        if !plugin.enabled {
            return Err(failure("PLUGIN_DISABLED", "插件未启用"));
        }
        let slot = self.slot(id)?;
        {
            let mut state = slot.try_lock().map_err(|_| Error::Busy)?;
            if state.status.state != State::Active || state.status.revision != plugin.revision {
                return Err(failure("PLUGIN_INACTIVE", "插件未激活或版本已变化"));
            }
            if state.window.elapsed() > Duration::from_secs(1) {
                state.window = Instant::now();
                state.messages = 0;
            }
            if state.messages >= 20 {
                return Err(failure("PLUGIN_RATE_LIMIT", "插件消息速率超过每秒二十次"));
            }
            state.messages += 1;
        }
        let repository = self.repository.clone();
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            let mut state = slot.try_lock().map_err(|_| Error::Busy)?;
            let current = repository.detail(&plugin.manifest.id)?;
            if !current.enabled || current.revision != plugin.revision {
                return Err(failure("PLUGIN_DISABLED", "插件已禁用或升级"));
            }
            let result = state
                .vm
                .as_mut()
                .ok_or_else(|| failure("PLUGIN_INACTIVE", "插件实例已释放"))?
                .call(operation, payload);
            match result {
                Ok(reply) => Ok(reply),
                Err(e) => {
                    crash(&mut state, &e);
                    Err(e)
                }
            }
        })
        .await
        .map_err(|e| Error::Worker(Box::new(e)))?
    }
    /// Cancel token is independent of the VM lock: cancellation never waits behind guest execution.
    pub fn cancel(&self, id: &str) -> Result<(), Error> {
        let slot = self.slot(id)?;
        slot.cancelled.store(true, Ordering::Release);
        Ok(())
    }
    pub async fn deactivate(&self, id: &str) -> Result<(), Error> {
        let control = self
            .controls
            .clone()
            .try_acquire_owned()
            .map_err(|_| Error::Busy)?;
        let slot = match self.slot(id) {
            Ok(s) => s,
            Err(Error::NotFound) => return Ok(()),
            Err(e) => return Err(e),
        };
        let was_cancelled = slot.cancelled.swap(true, Ordering::AcqRel);
        let permit = self
            .concurrent
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| Error::ShuttingDown)?;
        // Blocking work has a finite fuel budget. Drain it; never detach an unbounded worker.
        tokio::task::spawn_blocking(move || {
            let _control = control;
            let _permit = permit;
            let mut state = slot.lock().map_err(|_| Error::Busy)?;
            // Releasing a hidden page must not erase a crash that requires an explicit restart.
            if state.status.state == State::Crashed {
                return Ok(());
            }
            state.status.state = State::Stopping;
            state.cancelled.store(false, Ordering::Release);
            let result = if let Some(vm) = state.vm.as_mut() {
                let cancelled = if was_cancelled {
                    vm.call(Operation::Cancel, Value::Null)
                        .and_then(success)
                        .map(|_| ())
                } else {
                    Ok(())
                };
                cancelled
                    .and_then(|_| vm.call(Operation::Deactivate, Value::Null))
                    .and_then(success)
                    .and_then(|_| vm.call(Operation::Exit, Value::Null))
                    .and_then(success)
                    .map(|_| ())
            } else {
                Ok(())
            };
            state.cancelled.store(true, Ordering::Release);
            state.vm = None;
            state.status.state = State::Stopped;
            state.status.error_code = result.as_ref().err().map(code);
            result
        })
        .await
        .map_err(|e| Error::Worker(Box::new(e)))?
    }
    pub async fn remove(&self, id: &str) -> Result<(), Error> {
        let result = self.deactivate(id).await;
        self.slots.lock().map_err(|_| Error::Busy)?.remove(id);
        result
    }
    pub async fn shutdown(&self) -> Result<(), Error> {
        self.closing.store(true, Ordering::Release);
        let ids = self
            .slots
            .lock()
            .map_err(|_| Error::Busy)?
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        let mut first = None;
        for id in ids {
            if let Err(e) = self.remove(&id).await {
                first.get_or_insert(e);
            }
        }
        first.map_or(Ok(()), Err)
    }
    fn slot(&self, id: &str) -> Result<Arc<Instance>, Error> {
        self.slots
            .lock()
            .map_err(|_| Error::Busy)?
            .get(id)
            .cloned()
            .ok_or(Error::NotFound)
    }
    async fn metadata(&self, id: &str) -> Result<InstalledPlugin, Error> {
        let repository = self.repository.clone();
        let id = id.to_owned();
        tokio::task::spawn_blocking(move || repository.detail(&id))
            .await
            .map_err(|e| Error::Worker(Box::new(e)))?
    }
    fn check_open(&self) -> Result<(), Error> {
        if self.closing.load(Ordering::Acquire) {
            Err(Error::ShuttingDown)
        } else {
            Ok(())
        }
    }
}
fn code(error: &Error) -> String {
    match error {
        Error::Connection { code, .. } => (*code).into(),
        _ => "PLUGIN_RUNTIME".into(),
    }
}
fn crash(slot: &mut Slot, error: &Error) {
    slot.vm = None;
    slot.status.state = State::Crashed;
    slot.status.error_code = Some(code(error));
}
fn finish(slot: &mut Slot, result: Result<(), Error>) -> Result<(), Error> {
    match result {
        Ok(()) => {
            slot.status.state = State::Active;
            Ok(())
        }
        Err(e) => {
            crash(slot, &e);
            Err(e)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tests::{Fixture, module};
    #[tokio::test]
    async fn saturated_execution_and_stop_admission_reject_without_spawning_more_work() {
        let f = Fixture::new(&module(""));
        f.enable();
        f.runtime.activate("dev.runtime").await.unwrap();
        let permits = f
            .runtime
            .concurrent
            .clone()
            .acquire_many_owned(2)
            .await
            .unwrap();
        assert!(matches!(
            f.runtime.call("dev.runtime", Value::Null).await,
            Err(Error::Busy)
        ));
        drop(permits);
        assert!(f.runtime.call("dev.runtime", Value::Null).await.is_ok());
        let waiting = f
            .runtime
            .controls
            .clone()
            .acquire_many_owned(8)
            .await
            .unwrap();
        assert!(matches!(
            f.runtime.deactivate("dev.runtime").await,
            Err(Error::Busy)
        ));
        drop(waiting);
        f.runtime.deactivate("dev.runtime").await.unwrap();
        assert_eq!(f.runtime.statuses().unwrap()[0].state, State::Stopped);
        f.runtime.shutdown().await.unwrap();
    }
}
