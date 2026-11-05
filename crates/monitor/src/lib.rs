mod disk;
pub mod parse;
use serverdeck_core::{
    Error, IpcError,
    hosts::Host,
    monitor::*,
    terminal::{TerminalEvent, TerminalSession},
};
use serverdeck_ssh::{ConnectionPlan, Engine, Sink};
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{sync::watch, task::JoinHandle};
use tokio_util::sync::CancellationToken;

fn failure(code: &'static str, message: &'static str) -> Error {
    Error::Connection {
        code,
        message,
        source: None,
    }
}
fn lock<T>(value: &Mutex<T>) -> Result<std::sync::MutexGuard<'_, T>, Error> {
    value
        .lock()
        .map_err(|_| failure("MONITOR_STATE", "监控状态不可用"))
}
#[derive(Clone, Copy)]
struct Settings {
    visible: bool,
    interval: u8,
}
struct Control {
    session: TerminalSession,
    stop: CancellationToken,
    done: AtomicBool,
    settings: watch::Sender<Settings>,
    snapshot: Mutex<MonitorSnapshot>,
    task: Mutex<Option<JoinHandle<()>>>,
}
struct Registry {
    tasks: HashMap<String, Arc<Control>>,
    stopping: bool,
}
#[derive(Clone)]
pub struct Monitors {
    engine: Engine,
    registry: Arc<Mutex<Registry>>,
}

impl Monitors {
    /// Bounded one-shot sampling on an existing verified operations connection.
    pub async fn sample_once(&self, id: &str, cancel: &CancellationToken) -> Result<Sample, Error> {
        let mut processor = parse::Processor::default();
        let mut sample = None;
        // CPU usage and network rates require two readings from the same transport.
        for reading in 0..2 {
            if reading == 1 {
                tokio::select! {
                    _ = tokio::time::sleep(Duration::from_millis(250)) => (),
                    _ = cancel.cancelled() => return Err(Error::ShuttingDown),
                }
            }
            let bytes = self.engine.collect_ops_monitor(id, cancel).await?;
            let now = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(|_| failure("MONITOR_CLOCK", "本地时钟无效"))?
                .as_millis() as u64;
            sample = Some(
                processor
                    .ingest(&bytes, now)
                    .map_err(|_| failure("MONITOR_FORMAT", "监控响应不完整或格式不兼容"))?,
            );
        }
        sample.ok_or_else(|| failure("MONITOR_FORMAT", "监控响应为空"))
    }
    pub fn new(engine: Engine) -> Self {
        Self {
            engine,
            registry: Arc::new(Mutex::new(Registry {
                tasks: HashMap::new(),
                stopping: false,
            })),
        }
    }
    pub fn open(
        &self,
        host: Host,
        plan: ConnectionPlan,
        interval: u8,
        sink: Sink,
    ) -> Result<TerminalSession, Error> {
        if ![3, 5, 10, 30].contains(&interval) {
            return Err(Error::Validation("监控间隔须为 3、5、10 或 30 秒"));
        }
        let mut registry = lock(&self.registry)?;
        if registry.stopping {
            return Err(Error::ShuttingDown);
        }
        if let Some(existing) = registry.tasks.get(&host.id)
            && !existing.done.load(Ordering::Acquire)
        {
            if existing.stop.is_cancelled() {
                return Err(Error::Busy);
            }
            existing.settings.send_if_modified(|s| {
                let changed = !s.visible || s.interval != interval;
                s.visible = true;
                s.interval = interval;
                changed
            });
            sink(TerminalEvent::State {
                state: if self
                    .engine
                    .monitor_ready(&existing.session.id)
                    .unwrap_or(false)
                {
                    "connected"
                } else {
                    "connecting"
                },
                code: None,
                message: None,
            });
            return Ok(existing.session.clone());
        }
        if !registry.tasks.contains_key(&host.id) && registry.tasks.len() >= 8 {
            return Err(failure(
                "MONITOR_LIMIT",
                "最多保留 8 台主机的监控，请先停止不用的监控",
            ));
        }
        let session = self.engine.open_monitor_plan(host.clone(), plan, sink)?;
        let (settings, receiver) = watch::channel(Settings {
            visible: true,
            interval,
        });
        let control = Arc::new(Control {
            session: session.clone(),
            stop: CancellationToken::new(),
            done: AtomicBool::new(false),
            settings,
            snapshot: Mutex::new(MonitorSnapshot {
                host_id: host.id.clone(),
                session_id: session.id.clone(),
                revision: 1,
                state: "connecting".into(),
                interval_secs: interval,
                error: None,
                sample: None,
                history: vec![],
            }),
            task: Mutex::new(None),
        });
        registry.tasks.insert(host.id, control.clone());
        let manager = self.clone();
        let running = control.clone();
        let task = tokio::spawn(async move {
            manager.run(&running, receiver).await;
            running.done.store(true, Ordering::Release);
        });
        *lock(&control.task)? = Some(task);
        Ok(session)
    }
    fn control(&self, host: &str) -> Result<Arc<Control>, Error> {
        lock(&self.registry)?
            .tasks
            .get(host)
            .cloned()
            .ok_or(Error::NotFound)
    }
    pub fn visible(&self, host: &str, visible: bool) -> Result<(), Error> {
        self.control(host)?.settings.send_if_modified(|s| {
            let changed = s.visible != visible;
            s.visible = visible;
            changed
        });
        Ok(())
    }
    pub fn configure(&self, interval: u8) {
        if let Ok(registry) = self.registry.lock() {
            for control in registry.tasks.values() {
                control.settings.send_if_modified(|s| {
                    let changed = s.interval != interval;
                    s.interval = interval;
                    changed
                });
            }
        }
    }
    pub fn pause_all(&self) {
        if let Ok(registry) = self.registry.lock() {
            for control in registry.tasks.values() {
                control.settings.send_if_modified(|s| {
                    let changed = s.visible;
                    s.visible = false;
                    changed
                });
            }
        }
    }
    pub fn snapshot(
        &self,
        host: &str,
        after: Option<u64>,
    ) -> Result<Option<MonitorSnapshot>, Error> {
        let control = self.control(host)?;
        let snapshot = lock(&control.snapshot)?;
        Ok((after != Some(snapshot.revision)).then(|| snapshot.clone()))
    }
    pub fn count(&self) -> Result<usize, Error> {
        Ok(lock(&self.registry)?
            .tasks
            .values()
            .filter(|c| !c.done.load(Ordering::Acquire))
            .count())
    }
    pub async fn stop(&self, host: &str) -> Result<(), Error> {
        let control = self.control(host)?;
        self.release(control.clone()).await;
        let mut registry = lock(&self.registry)?;
        if registry
            .tasks
            .get(host)
            .is_some_and(|c| Arc::ptr_eq(c, &control))
        {
            registry.tasks.remove(host);
        }
        Ok(())
    }
    async fn release(&self, control: Arc<Control>) {
        control.stop.cancel();
        let task = control.task.lock().ok().and_then(|mut t| t.take());
        if let Some(task) = task
            && task.await.is_err()
        {
            tracing::warn!(
                operation = "monitor_shutdown",
                "monitor task did not exit normally"
            );
        }
        if self.engine.close(&control.session.id).await.is_err() {
            tracing::warn!(
                operation = "monitor_shutdown",
                "monitor lease cleanup failed"
            );
        }
    }
    pub async fn shutdown(&self) {
        let tasks = if let Ok(mut registry) = self.registry.lock() {
            registry.stopping = true;
            registry.tasks.drain().map(|(_, c)| c).collect::<Vec<_>>()
        } else {
            vec![]
        };
        for task in &tasks {
            task.stop.cancel();
        }
        for task in tasks {
            self.release(task).await;
        }
    }
    async fn run(&self, control: &Control, mut settings: watch::Receiver<Settings>) {
        let mut processor = parse::Processor::default();
        let closed = match self.engine.session_closed(&control.session.id) {
            Ok(token) => token,
            Err(_) => {
                update(control, |s| {
                    s.state = "failed".into();
                    s.error = Some("SSH 监控连接已结束".into());
                });
                return;
            }
        };
        loop {
            if control.stop.is_cancelled() {
                break;
            }
            let options = *settings.borrow_and_update();
            if !options.visible {
                processor.reset();
                update(control, |s| {
                    s.state = "paused".into();
                    s.interval_secs = options.interval;
                });
                tokio::select! {_=control.stop.cancelled()=>break,_=closed.cancelled()=>{update(control,|s|{s.state="failed".into();s.error=Some("SSH 连接已断开，监控已停止".into());});break;},result=settings.changed()=>{if result.is_err(){break;}continue;}}
            }
            match self.engine.monitor_ready(&control.session.id) {
                Ok(false) => {
                    tokio::select! {_=control.stop.cancelled()=>break,_=tokio::time::sleep(Duration::from_millis(100))=>continue, result=settings.changed()=>{if result.is_err(){break;}continue;}}
                }
                Err(_) => {
                    update(control, |s| {
                        s.state = "failed".into();
                        s.error = Some("SSH 监控连接已结束，请手动重连".into());
                    });
                    break;
                }
                Ok(true) => (),
            }
            update(control, |s| {
                s.state = "sampling".into();
                s.interval_secs = options.interval;
            });
            let result = self
                .engine
                .collect_monitor(&control.session.id, &control.stop)
                .await
                .and_then(|bytes| {
                    let now = SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .map_err(|_| failure("MONITOR_CLOCK", "本地时钟无效"))?
                        .as_millis() as u64;
                    processor
                        .ingest(&bytes, now)
                        .map_err(|_| failure("MONITOR_FORMAT", "监控响应不完整或格式不兼容"))
                });
            if control.stop.is_cancelled() {
                break;
            }
            match result {
                Ok(sample) => update(control, |s| {
                    let rates = sample
                        .network
                        .iter()
                        .filter(|n| n.name != "lo")
                        .collect::<Vec<_>>();
                    let receive = (!rates.is_empty()
                        && rates.iter().all(|n| n.receive_rate.is_some()))
                    .then(|| rates.iter().filter_map(|n| n.receive_rate).sum());
                    let send = (!rates.is_empty() && rates.iter().all(|n| n.send_rate.is_some()))
                        .then(|| rates.iter().filter_map(|n| n.send_rate).sum());
                    if s.sample
                        .as_ref()
                        .and_then(|p| p.uptime)
                        .zip(sample.uptime)
                        .is_some_and(|(a, b)| b < a)
                    {
                        s.history.clear();
                    }
                    s.history.push(HistoryPoint {
                        sampled_at: sample.sampled_at,
                        uptime: sample.uptime,
                        cpu: sample
                            .cpus
                            .iter()
                            .find(|c| c.name == "cpu")
                            .and_then(|c| c.usage),
                        memory: sample.memory.as_ref().map(|m| m.usage),
                        receive_rate: receive,
                        send_rate: send,
                    });
                    prune_history(&mut s.history, sample.sampled_at);
                    s.state = if sample.warnings.is_empty() {
                        "running"
                    } else {
                        "partial"
                    }
                    .into();
                    s.error = None;
                    s.sample = Some(sample);
                }),
                Err(error) => {
                    let ipc = IpcError::from(error);
                    processor.reset();
                    tracing::warn!(
                        operation = "monitor_sample",
                        code = ipc.code,
                        "monitor sample failed"
                    );
                    update(control, |s| {
                        s.state = "error".into();
                        s.error = Some(ipc.message);
                        s.history.push(HistoryPoint {
                            sampled_at: SystemTime::now()
                                .duration_since(UNIX_EPOCH)
                                .map(|d| d.as_millis() as u64)
                                .unwrap_or(0),
                            uptime: None,
                            cpu: None,
                            memory: None,
                            receive_rate: None,
                            send_rate: None,
                        });
                        let now = s.history.last().map(|p| p.sampled_at).unwrap_or(0);
                        prune_history(&mut s.history, now);
                    });
                    if !self
                        .engine
                        .monitor_ready(&control.session.id)
                        .unwrap_or(false)
                    {
                        break;
                    }
                }
            }
            tokio::select! {_=control.stop.cancelled()=>break,_=tokio::time::sleep(Duration::from_secs(u64::from(options.interval)))=>(),result=settings.changed()=>{if result.is_err(){break;}}}
        }
        let _ = self.engine.close(&control.session.id).await;
    }
}
fn update(control: &Control, operation: impl FnOnce(&mut MonitorSnapshot)) {
    if let Ok(mut snapshot) = control.snapshot.lock() {
        operation(&mut snapshot);
        snapshot.revision = snapshot.revision.saturating_add(1);
    }
}

fn prune_history(history: &mut Vec<HistoryPoint>, now: u64) {
    let cutoff = now.saturating_sub((HISTORY_SECONDS * 1000.0) as u64);
    history.retain(|h| h.sampled_at >= cutoff);
    if history.len() > HISTORY_LIMIT {
        history.drain(..history.len() - HISTORY_LIMIT);
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn history_has_time_and_count_limits_and_keeps_missing_points() {
        let mut history = (0..1000)
            .map(|n| HistoryPoint {
                sampled_at: n * 1000,
                uptime: None,
                cpu: None,
                memory: None,
                receive_rate: None,
                send_rate: None,
            })
            .collect::<Vec<_>>();
        prune_history(&mut history, 999000);
        assert_eq!(history.len(), 600);
        assert_eq!(history[0].sampled_at, 400000);
        assert!(history[0].cpu.is_none());
        prune_history(&mut history, 3000000);
        assert!(history.is_empty());
    }
}
