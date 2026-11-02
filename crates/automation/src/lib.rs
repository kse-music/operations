mod runner;
mod scheduler;
use serverdeck_core::{Error, IpcError, automation::*};
use serverdeck_storage::Database;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;
use zeroize::Zeroizing;
pub(crate) fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|v| v.as_millis() as u64)
        .unwrap_or(0)
}
pub(crate) fn lock<T>(value: &Mutex<T>) -> Result<std::sync::MutexGuard<'_, T>, Error> {
    value
        .lock()
        .map_err(|_| Error::Validation("自动化任务状态不可用"))
}
struct Control {
    info: Mutex<Run>,
    queued: CancellationToken,
    running: CancellationToken,
    join: Mutex<Option<tokio::task::JoinHandle<()>>>,
}
impl Control {
    fn update(&self, f: impl FnOnce(&mut Run)) -> Result<Run, Error> {
        let mut r = lock(&self.info)?;
        f(&mut r);
        r.revision += 1;
        r.state = aggregate(&r.rows);
        Ok(r.clone())
    }
    fn snapshot(&self) -> Result<Run, Error> {
        Ok(lock(&self.info)?.clone())
    }
}
#[derive(Clone)]
pub struct Automation {
    database: Database,
    engine: serverdeck_ssh::Engine,
    tasks: serverdeck_tasks::Tasks,
    controls: Arc<Mutex<HashMap<String, Arc<Control>>>>,
    db_slot: Arc<Semaphore>,
    db_waiters: Arc<Semaphore>,
    run_slots: Arc<Semaphore>,
    launch: Arc<tokio::sync::Mutex<()>>,
    stop: CancellationToken,
    scheduler: Arc<Mutex<Option<tokio::task::JoinHandle<()>>>>,
    scheduler_error: Arc<Mutex<Option<String>>>,
}
impl Automation {
    pub(crate) fn record_error(&self, message: String) {
        if let Ok(mut error) = self.scheduler_error.lock() {
            *error = Some(message);
        }
    }
    pub fn new(
        database: Database,
        engine: serverdeck_ssh::Engine,
        tasks: serverdeck_tasks::Tasks,
    ) -> Result<Self, Error> {
        database.automation_recover(now())?;
        Ok(Self {
            database,
            engine,
            tasks,
            controls: Arc::default(),
            db_slot: Arc::new(Semaphore::new(1)),
            db_waiters: Arc::new(Semaphore::new(16)),
            run_slots: Arc::new(Semaphore::new(4)),
            launch: Arc::default(),
            stop: CancellationToken::new(),
            scheduler: Arc::default(),
            scheduler_error: Arc::default(),
        })
    }
    async fn db<T: Send + 'static>(
        &self,
        f: impl FnOnce(Database) -> Result<T, Error> + Send + 'static,
    ) -> Result<T, Error> {
        let waiter = self
            .db_waiters
            .clone()
            .try_acquire_owned()
            .map_err(|_| Error::Busy)?;
        let slot =
            tokio::time::timeout(Duration::from_secs(3), self.db_slot.clone().acquire_owned())
                .await
                .map_err(|_| Error::Busy)?
                .map_err(|_| Error::ShuttingDown)?;
        let database = self.database.clone();
        tokio::task::spawn_blocking(move || {
            let _waiter = waiter;
            let _slot = slot;
            f(database)
        })
        .await
        .map_err(|e| Error::Worker(Box::new(e)))?
    }
    pub async fn prepare(
        &self,
        entry_id: String,
        expected: u32,
        host_ids: Vec<String>,
    ) -> Result<(Entry, Vec<Target>), Error> {
        let engine = self.engine.clone();
        self.db(move |d| {
            let entry = d.automation_entry(&entry_id)?;
            if entry.revision != expected {
                return Err(Error::Validation("条目已变化，请刷新后预览"));
            }
            Ok((entry, targets(&d, &engine, host_ids)?))
        })
        .await
    }
    pub async fn catalog(&self) -> Result<Catalog, Error> {
        self.db(|d| {
            Ok(Catalog {
                entries: d.automation_entries()?,
                groups: d.automation_groups()?,
                schedules: d.automation_schedules()?,
                templates: templates(),
            })
        })
        .await
    }
    pub async fn entry_save(
        &self,
        id: Option<String>,
        expected: Option<u32>,
        input: EntryInput,
    ) -> Result<Entry, Error> {
        if self.stop.is_cancelled() {
            return Err(Error::ShuttingDown);
        }
        self.db(move |d| d.automation_entry_save(id.as_deref(), expected, input, now()))
            .await
    }
    pub async fn entry_delete(&self, id: String, confirmed: bool) -> Result<(), Error> {
        if !confirmed {
            return Err(Error::Validation("删除条目及其计划必须确认"));
        }
        self.db(move |d| d.automation_entry_delete(&id)).await
    }
    pub async fn group_save(&self, id: Option<String>, name: String) -> Result<Group, Error> {
        self.db(move |d| d.automation_group_save(id.as_deref(), &name))
            .await
    }
    pub async fn group_delete(&self, id: String, confirmed: bool) -> Result<(), Error> {
        if !confirmed {
            return Err(Error::Validation("删除分组必须确认"));
        }
        self.db(move |d| d.automation_group_delete(&id)).await
    }
    pub async fn history(&self, query: HistoryQuery) -> Result<Vec<RunSummary>, Error> {
        self.db(move |d| d.automation_history(query)).await
    }
    pub async fn run(&self, id: String) -> Result<Run, Error> {
        let c = lock(&self.controls)?.get(&id).cloned();
        if let Some(c) = c {
            return c.snapshot();
        }
        self.db(move |d| d.automation_run(&id)).await
    }
    pub async fn run_delete(&self, id: String, confirmed: bool) -> Result<(), Error> {
        if !confirmed {
            return Err(Error::Validation("删除历史必须确认"));
        }
        if lock(&self.controls)?.get(&id).is_some_and(|c| {
            c.join
                .lock()
                .is_ok_and(|j| j.as_ref().is_none_or(|h| !h.is_finished()))
        }) {
            return Err(Error::Validation("任务结果仍在保存，请稍后再删除历史"));
        }
        let run = self.run(id.clone()).await?;
        if !terminal(run.state) {
            return Err(Error::Validation("请先取消未结束任务"));
        }
        self.db({
            let id = id.clone();
            move |d| d.automation_run_delete(&id)
        })
        .await?;
        lock(&self.controls)?.remove(&id);
        Ok(())
    }
    pub fn pending(&self) -> Result<usize, Error> {
        Ok(lock(&self.controls)?
            .values()
            .filter(|c| {
                let active = c.info.lock().map(|r| !terminal(r.state)).unwrap_or(true);
                let joining = c
                    .join
                    .lock()
                    .map(|j| j.as_ref().is_some_and(|h| !h.is_finished()))
                    .unwrap_or(true);
                active || joining
            })
            .count())
    }
    pub async fn status(&self) -> Result<Status, Error> {
        let active = self.pending()?;
        let error = lock(&self.scheduler_error)?.clone();
        self.db(move |d| {
            let mut failures = d.automation_history(HistoryQuery {
                state: Some(State::Failed),
                ..Default::default()
            })?;
            failures.extend(d.automation_history(HistoryQuery {
                state: Some(State::Unknown),
                ..Default::default()
            })?);
            failures.sort_by_key(|r| std::cmp::Reverse(r.created_at));
            let schedules = d
                .automation_schedules()?
                .into_iter()
                .map(|s| ScheduleStatus {
                    id: s.id,
                    revision: s.revision,
                    enabled: s.enabled,
                    next_at: s.next_at,
                    last_message: s.last_message,
                })
                .collect();
            Ok(Status {
                active,
                awaiting: d.automation_pending_approval()?,
                latest_failure: failures.into_iter().next(),
                schedules,
                scheduler_error: error,
            })
        })
        .await
    }
    pub async fn cancel(&self, id: String, running: bool) -> Result<(), Error> {
        let _gate = self.launch.lock().await;
        let c = lock(&self.controls)?.get(&id).cloned();
        if let Some(c) = c {
            c.queued.cancel();
            if running {
                c.running.cancel();
            }
            return Ok(());
        }
        self.db(move |d| {
            let mut r = d.automation_run(&id)?;
            if r.state == State::Pending {
                r.approval_required = false;
                for row in &mut r.rows {
                    row.state = State::Cancelled;
                    row.finished_at = Some(now());
                    row.message = Some("待确认任务已取消，未执行".into());
                }
                r.state = State::Cancelled;
                r.finished_at = Some(now());
                r.revision += 1;
                d.automation_run_save(&r)?;
            }
            Ok(())
        })
        .await
    }
    pub async fn start(&self, input: RunInput) -> Result<Run, Error> {
        let _gate = self.launch.lock().await;
        if self.stop.is_cancelled() {
            return Err(Error::ShuttingDown);
        }
        if !input.confirmed {
            return Err(Error::Validation("必须预览全部目标和实际正文并确认"));
        }
        let slot = self
            .run_slots
            .clone()
            .try_acquire_owned()
            .map_err(|_| Error::Busy)?;
        let engine = self.engine.clone();
        let (run, payload) = self
            .db(move |d| {
                let entry = d.automation_entry(&input.entry_id)?;
                if entry.revision != input.expected_revision {
                    return Err(Error::Validation("条目已修改，请重新预览"));
                }
                if entry.input.risk == Risk::Dangerous && !input.danger_confirmed {
                    return Err(Error::Validation("危险任务必须单独确认"));
                }
                limits(input.concurrency, input.timeout_secs)?;
                let (args, parameters, has_secrets) = values(&entry.input, &input.parameters)?;
                let targets = targets(&d, &engine, input.host_ids)?;
                guard_targets(&targets, &input.expected_profiles)?;
                let payload = payload(&entry.input.body, &args)?;
                let run = Run::new(
                    RunSpec {
                        entry,
                        targets,
                        parameters,
                        has_secrets,
                        concurrency: input.concurrency,
                        timeout_secs: input.timeout_secs,
                    },
                    now(),
                );
                d.automation_run_insert(&run)?;
                Ok((run, payload))
            })
            .await?;
        self.dispatch(run.clone(), Arc::new(payload), slot)?;
        Ok(run)
    }
    pub async fn approve(
        &self,
        id: String,
        confirmed: bool,
        danger_confirmed: bool,
    ) -> Result<Run, Error> {
        let _gate = self.launch.lock().await;
        if self.stop.is_cancelled() {
            return Err(Error::ShuttingDown);
        }
        if !confirmed {
            return Err(Error::Validation("必须预览待确认任务"));
        }
        let slot = self
            .run_slots
            .clone()
            .try_acquire_owned()
            .map_err(|_| Error::Busy)?;
        let engine = self.engine.clone();
        let (run, payload) = self
            .db(move |d| {
                let mut run = d.automation_run(&id)?;
                if !run.approval_required || run.state != State::Pending {
                    return Err(Error::Validation("此任务已确认、取消或结束"));
                }
                if run.spec.entry.input.risk == Risk::Dangerous && !danger_confirmed {
                    return Err(Error::Validation("危险任务必须单独确认"));
                }
                validate_spec(&d, &engine, &run.spec)?;
                let payload = spec_payload(&run.spec)?;
                run.approval_required = false;
                run.message = Some("用户已确认执行；不自动重试".into());
                run.revision += 1;
                d.automation_run_save(&run)?;
                Ok((run, payload))
            })
            .await?;
        self.dispatch(run.clone(), Arc::new(payload), slot)?;
        Ok(run)
    }
    pub async fn shutdown(&self) {
        self.stop.cancel();
        let scheduler = lock(&self.scheduler).ok().and_then(|mut s| s.take());
        if let Some(s) = scheduler {
            let _ = s.await;
        }
        let controls = lock(&self.controls)
            .map(|c| c.values().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        let mut handles = Vec::new();
        for c in controls {
            c.queued.cancel();
            c.running.cancel();
            if let Ok(mut j) = c.join.lock()
                && let Some(j) = j.take()
            {
                handles.push(j);
            }
        }
        for h in handles {
            if tokio::time::timeout(Duration::from_secs(15), h)
                .await
                .is_err()
            {
                tracing::warn!(
                    operation = "automation_shutdown",
                    "worker cleanup did not finish before deadline"
                );
            }
        }
    }
}
fn targets(
    d: &Database,
    engine: &serverdeck_ssh::Engine,
    ids: Vec<String>,
) -> Result<Vec<Target>, Error> {
    if ids.is_empty() || ids.len() > 32 {
        return Err(Error::Validation("请选择 1–32 台目标"));
    }
    let mut seen = std::collections::HashSet::new();
    ids.into_iter()
        .map(|id| {
            uuid_id(&id)?;
            if !seen.insert(id.clone()) {
                return Err(Error::Validation("目标不可重复"));
            }
            let h = d.host(&id)?;
            Ok(Target {
                route_signature: engine.profile_signature(&id)?,
                host_id: id,
                name: h.config.display_name(),
                hostname: h.config.hostname,
                port: h.config.port,
                username: h.config.username,
            })
        })
        .collect()
}
fn validate_spec(
    d: &Database,
    engine: &serverdeck_ssh::Engine,
    spec: &RunSpec,
) -> Result<(), Error> {
    let current = d.automation_entry(&spec.entry.id)?;
    if !current.input.same_execution(&spec.entry.input) {
        return Err(Error::Validation("条目已修改，授权快照失效"));
    }
    for target in &spec.targets {
        if engine.profile_signature(&target.host_id)? != target.route_signature {
            return Err(Error::Validation(
                "目标或跳板/代理/凭据已变更，请重新预览授权",
            ));
        }
    }
    Ok(())
}
fn payload(script: &str, args: &[Zeroizing<String>]) -> Result<Zeroizing<Vec<u8>>, Error> {
    #[derive(serde::Serialize)]
    struct Wire<'a> {
        script: &'a str,
        args: Vec<&'a str>,
    }
    let p = Zeroizing::new(
        serde_json::to_vec(&Wire {
            script,
            args: args.iter().map(|v| v.as_str()).collect(),
        })
        .map_err(|_| Error::Validation("脚本输入编码失败"))?,
    );
    if p.len() > 262144 {
        return Err(Error::Validation("脚本及参数编码后超过 256 KiB"));
    }
    Ok(p)
}
fn spec_payload(spec: &RunSpec) -> Result<Zeroizing<Vec<u8>>, Error> {
    if spec.has_secrets {
        return Err(Error::Validation("含秘密参数的任务不能由持久化计划执行"));
    }
    let input = spec
        .parameters
        .iter()
        .map(|(k, v)| (k.clone(), Zeroizing::new(v.clone())))
        .collect();
    let (args, _, secret) = values(&spec.entry.input, &input)?;
    if secret {
        return Err(Error::Validation("计划不可保存秘密参数"));
    }
    payload(&spec.entry.input.body, &args)
}

fn guard_targets(
    targets: &[Target],
    expected: &std::collections::BTreeMap<String, String>,
) -> Result<(), Error> {
    if targets.len() != expected.len()
        || expected.values().any(|s| s.len() > 16384)
        || targets
            .iter()
            .any(|t| expected.get(&t.host_id) != Some(&t.route_signature))
    {
        return Err(Error::Validation(
            "目标配置在预览后已变化，请重新核对全部目标",
        ));
    }
    Ok(())
}
