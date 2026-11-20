use super::*;
use serverdeck_core::{
    IpcError,
    batch::{
        BatchCommand, BatchCommandInput, BatchPreview, BatchRequest, BatchResult, BatchRun,
        BatchStatus, BatchTarget, MAX_TARGETS,
    },
    hosts::Catalog,
    terminal::TerminalEvent,
};
use std::{
    collections::{HashMap, HashSet},
    sync::{Mutex, MutexGuard, atomic::AtomicUsize},
    time::{Duration, Instant},
};
use tokio::{sync::watch, task::JoinSet};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

const PREVIEW_LIFETIME: Duration = Duration::from_secs(300);
const MAX_OUTPUT: usize = 16 * 1024;
const COMMAND_TIMEOUT: u16 = 30;

fn changed_target() -> Error {
    Error::Connection {
        code: "BATCH_TARGET_CHANGED",
        message: "目标连接配置已变化，请重新预览确认",
        source: None,
    }
}

struct Prepared {
    preview: BatchPreview,
    profiles: Vec<Result<String, IpcError>>,
    at: Instant,
}

struct Active {
    snapshot: BatchRun,
    cancel: CancellationToken,
}

#[derive(Default)]
struct State {
    prepared: Option<Prepared>,
    active: Option<Active>,
}

pub(crate) struct BatchRuntime {
    state: Mutex<State>,
    gate: Arc<Semaphore>,
    stop: CancellationToken,
}

impl Default for BatchRuntime {
    fn default() -> Self {
        Self {
            state: Mutex::default(),
            gate: Arc::new(Semaphore::new(1)),
            stop: CancellationToken::new(),
        }
    }
}

impl BatchRuntime {
    fn lock(&self) -> Result<MutexGuard<'_, State>, Error> {
        self.state.lock().map_err(|_| Error::Busy)
    }

    fn update(&self, change: impl FnOnce(&mut BatchRun)) {
        match self.lock() {
            Ok(mut state) => {
                if let Some(active) = &mut state.active {
                    change(&mut active.snapshot);
                    active.snapshot.revision += 1;
                }
            }
            Err(error) => tracing::error!(operation = "batch_state", %error),
        }
    }

    fn row(&self, index: usize, result: &mut BatchResult, status: BatchStatus) {
        result.status = status;
        self.update(|snapshot| snapshot.results[index].status = status);
    }

    pub(crate) async fn shutdown(&self) {
        self.stop.cancel();
        // A run owns the permit until all of its SSH leases have been released.
        let _drained = self.gate.acquire().await;
    }
}

fn targets(catalog: Catalog, host_ids: &[String]) -> Result<Vec<BatchTarget>, Error> {
    let hosts: HashMap<_, _> = catalog
        .hosts
        .into_iter()
        .map(|host| (host.id.clone(), host))
        .collect();
    let tags: HashMap<_, _> = catalog
        .environment_tags
        .tags
        .into_iter()
        .map(|tag| (tag.id.clone(), tag))
        .collect();
    host_ids
        .iter()
        .map(|id| {
            let host = hosts.get(id).ok_or(Error::NotFound)?;
            Ok(BatchTarget {
                id: id.clone(),
                name: host.config.display_name(),
                hostname: host.config.hostname.clone(),
                port: host.config.port,
                username: host.config.username.clone(),
                environment: catalog
                    .environment_tags
                    .assignments
                    .get(id)
                    .and_then(|tag| tags.get(tag))
                    .cloned(),
            })
        })
        .collect()
}

impl Application {
    pub async fn batch_commands(&self) -> Result<Vec<BatchCommand>, Error> {
        self.blocking(|db| db.batch_commands()).await
    }

    pub async fn batch_save(
        &self,
        id: Option<String>,
        revision: Option<u32>,
        input: BatchCommandInput,
    ) -> Result<BatchCommand, Error> {
        self.blocking(move |db| db.save_batch_command(id.as_deref(), revision, input))
            .await
    }

    pub async fn batch_delete(&self, id: String, revision: u32) -> Result<(), Error> {
        self.blocking(move |db| db.delete_batch_command(&id, revision))
            .await
    }

    pub async fn batch_prepare(&self, input: BatchRequest) -> Result<BatchPreview, Error> {
        if input.host_ids.is_empty()
            || input.host_ids.len() > MAX_TARGETS
            || ![1, 3, 5].contains(&input.concurrency)
            || input.host_ids.iter().any(|id| id.len() > 128)
            || input.host_ids.iter().collect::<HashSet<_>>().len() != input.host_ids.len()
        {
            return Err(Error::Validation(
                "请选择 1–32 台不同的主机及有效的并发上限",
            ));
        }
        let engine = self.terminals.clone();
        let prepared = self
            .blocking(move |db| {
                let command = db.batch_command(&input.command_id, input.revision)?;
                let targets = targets(db.catalog()?, &input.host_ids)?;
                let profiles = targets
                    .iter()
                    .map(|target| engine.profile_signature(&target.id).map_err(Into::into))
                    .collect();
                Ok(Prepared {
                    preview: BatchPreview {
                        token: Uuid::new_v4().to_string(),
                        command,
                        concurrency: input.concurrency,
                        targets,
                    },
                    profiles,
                    at: Instant::now(),
                })
            })
            .await?;
        let mut state = self.batch.lock()?;
        if state
            .active
            .as_ref()
            .is_some_and(|run| !run.snapshot.finished)
        {
            return Err(Error::Busy);
        }
        let preview = prepared.preview.clone();
        state.prepared = Some(prepared);
        Ok(preview)
    }

    pub async fn batch_start(
        &self,
        token: String,
        production_confirmed: bool,
    ) -> Result<BatchRun, Error> {
        let permit = self
            .batch
            .gate
            .clone()
            .try_acquire_owned()
            .map_err(|_| Error::Busy)?;
        if self.batch.stop.is_cancelled() {
            return Err(Error::ShuttingDown);
        }
        let prepared = {
            let mut state = self.batch.lock()?;
            let preview = state
                .prepared
                .as_ref()
                .filter(|item| item.preview.token == token && item.at.elapsed() <= PREVIEW_LIFETIME)
                .ok_or(Error::Conflict)?;
            if !production_confirmed && preview.preview.targets.iter().any(BatchTarget::production)
            {
                return Err(Error::Validation("请先确认生产主机"));
            }
            state.prepared.take().ok_or(Error::Conflict)?
        };
        let expected = prepared.preview.clone();
        self.blocking(move |db| {
            let command = db.batch_command(&expected.command.id, expected.command.revision)?;
            let ids: Vec<_> = expected
                .targets
                .iter()
                .map(|target| target.id.clone())
                .collect();
            if command != expected.command || targets(db.catalog()?, &ids)? != expected.targets {
                return Err(Error::Conflict);
            }
            Ok(())
        })
        .await?;
        let cancel = self.batch.stop.child_token();
        let snapshot = BatchRun {
            id: Uuid::new_v4().to_string(),
            revision: 0,
            command: prepared.preview.command.clone(),
            finished: false,
            stopping: false,
            results: prepared
                .preview
                .targets
                .iter()
                .cloned()
                .map(BatchResult::new)
                .collect(),
        };
        self.batch.lock()?.active = Some(Active {
            snapshot: snapshot.clone(),
            cancel: cancel.clone(),
        });
        let app = self.clone();
        tokio::spawn(async move {
            let _permit = permit;
            app.run_batch(prepared, cancel).await;
        });
        Ok(snapshot)
    }

    pub fn batch_status(
        &self,
        id: Option<&str>,
        known_revision: Option<u64>,
    ) -> Result<Option<BatchRun>, Error> {
        let state = self.batch.lock()?;
        Ok(state
            .active
            .as_ref()
            .map(|active| &active.snapshot)
            .filter(|snapshot| {
                id != Some(snapshot.id.as_str()) || known_revision != Some(snapshot.revision)
            })
            .cloned())
    }

    pub fn batch_cancel(&self, id: &str) -> Result<(), Error> {
        let mut state = self.batch.lock()?;
        let active = state
            .active
            .as_mut()
            .filter(|run| run.snapshot.id == id)
            .ok_or(Error::NotFound)?;
        if !active.snapshot.finished && !active.snapshot.stopping {
            active.snapshot.stopping = true;
            active.snapshot.revision += 1;
            active.cancel.cancel();
        }
        Ok(())
    }

    async fn run_batch(&self, prepared: Prepared, cancel: CancellationToken) {
        let prepared = Arc::new(prepared);
        let cursor = Arc::new(AtomicUsize::new(0));
        let mut workers = JoinSet::new();
        let count = prepared
            .preview
            .targets
            .len()
            .min(prepared.preview.concurrency.into());
        for _ in 0..count {
            let (app, prepared, cancel, cursor) = (
                self.clone(),
                prepared.clone(),
                cancel.clone(),
                cursor.clone(),
            );
            workers.spawn(async move {
                loop {
                    let index = cursor.fetch_add(1, Ordering::Relaxed);
                    let Some(target) = prepared.preview.targets.get(index) else {
                        break;
                    };
                    let mut row = BatchResult::new(target.clone());
                    match &prepared.profiles[index] {
                        _ if cancel.is_cancelled() => row.status = BatchStatus::NotSent,
                        Err(error) => {
                            row.status = BatchStatus::ConnectionFailed;
                            row.message = Some(error.message.clone());
                        }
                        Ok(profile) => {
                            app.batch.row(index, &mut row, BatchStatus::Connecting);
                            if let Err(error) = app
                                .execute_batch_target(
                                    &prepared.preview.command.command,
                                    profile,
                                    &cancel,
                                    index,
                                    &mut row,
                                )
                                .await
                            {
                                let error = IpcError::from(error);
                                row.status = if cancel.is_cancelled() {
                                    BatchStatus::NotSent
                                } else {
                                    BatchStatus::ConnectionFailed
                                };
                                row.message = Some(error.message);
                            }
                        }
                    }
                    app.batch.update(|snapshot| snapshot.results[index] = row);
                }
            });
        }
        while let Some(result) = workers.join_next().await {
            if let Err(error) = result {
                tracing::error!(
                    operation = "batch_worker",
                    panic = error.is_panic(),
                    cancelled = error.is_cancelled()
                );
                cancel.cancel();
            }
        }
        self.batch.update(|snapshot| {
            for result in &mut snapshot.results {
                match result.status {
                    BatchStatus::Queued | BatchStatus::Connecting => {
                        result.status = BatchStatus::NotSent
                    }
                    BatchStatus::Running => result.status = BatchStatus::Unknown,
                    _ => {}
                }
            }
            snapshot.finished = true;
        });
    }

    async fn execute_batch_target(
        &self,
        command: &str,
        profile: &str,
        cancel: &CancellationToken,
        index: usize,
        row: &mut BatchResult,
    ) -> Result<(), Error> {
        let secrets = self.secrets.clone();
        let id = row.target.id.clone();
        let (host, plan) = self
            .blocking(move |db| super::terminal::connection_plan(&db, secrets.as_ref(), &id))
            .await?;
        if cancel.is_cancelled() {
            return Err(Error::ShuttingDown);
        }
        if plan.signature()? != profile
            || host.config.hostname != row.target.hostname
            || host.config.port != row.target.port
            || host.config.username != row.target.username
        {
            return Err(changed_target());
        }
        let (tx, mut ready) = watch::channel(None);
        let lease = self.terminals.open_batch_plan(
            host,
            plan,
            Arc::new(move |event| {
                if let TerminalEvent::State { state, message, .. } = event
                    && matches!(state, "connected" | "failed" | "closed")
                {
                    tx.send_replace(Some((state, message)));
                }
                true
            }),
        )?;
        let result = async {
            let connected = tokio::select! {
                biased;
                _ = cancel.cancelled() => return Err(Error::ShuttingDown),
                result = tokio::time::timeout(Duration::from_secs(120), ready.wait_for(Option::is_some)) => {
                    match result {
                        Ok(Ok(state)) => (*state).clone(),
                        Ok(Err(_)) => None,
                        Err(_) => Some(("failed", Some("批量命令建立 SSH 连接超时".to_owned()))),
                    }
                }
            };
            if !matches!(connected, Some(("connected", _))) {
                row.status = BatchStatus::ConnectionFailed;
                row.message = connected.and_then(|(_, message)| message).or_else(|| Some("SSH 连接未就绪".to_owned()));
                return Ok(());
            }
            let slot = self.tasks.command_slot(cancel).await?;
            let engine = self.terminals.clone();
            let id = row.target.id.clone();
            let expected = profile.to_owned();
            self.blocking(move |_| {
                if engine.profile_signature(&id)? != expected {
                    return Err(changed_target());
                }
                Ok(())
            }).await?;
            if cancel.is_cancelled() {
                return Err(Error::ShuttingDown);
            }
            self.batch.row(index, row, BatchStatus::Running);
            let outcome = self.tasks.execute_command(&lease.id, command, COMMAND_TIMEOUT, cancel, slot, |chunk, error| {
                let remaining = MAX_OUTPUT.saturating_sub(row.stdout.len() + row.stderr.len());
                let mut end = remaining.min(chunk.len());
                while !chunk.is_char_boundary(end) {
                    end -= 1;
                }
                let output = if error { &mut row.stderr } else { &mut row.stdout };
                output.push_str(&chunk[..end]);
                row.truncated |= end < chunk.len();
            }).await;
            row.status = match outcome.state {
                "completed" => BatchStatus::Succeeded,
                "failed" => BatchStatus::CommandFailed,
                _ => BatchStatus::Unknown,
            };
            row.exit_code = outcome.code;
            row.message = outcome.message;
            Ok(())
        }.await;
        if let Err(error) = self.terminals.close(&lease.id).await {
            tracing::error!(
                operation = "batch_lease_close",
                code = IpcError::from(error).code
            );
        }
        result
    }
}
