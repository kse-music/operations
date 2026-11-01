use crate::*;
use exec::Outcome;
use serverdeck_core::files::{Direction, TransferInput};
impl BatchControl {
    fn row(&self, n: usize, f: impl FnOnce(&mut BatchRow)) {
        match self.info.lock() {
            Ok(mut i) => {
                f(&mut i.rows[n]);
                i.revision += 1;
            }
            Err(_) => tracing::error!(operation = "batch_state", "batch state lock poisoned"),
        }
    }
    fn output(&self, n: usize, s: &str, stderr: bool) {
        if s.is_empty() {
            return;
        }
        self.row(n, |r| {
            r.dropped_bytes += append(
                if stderr { &mut r.stderr } else { &mut r.stdout },
                s,
                32 * 1024,
            );
        });
    }
}
impl Tasks {
    pub async fn batch_start(&self, input: BatchInput) -> Result<Batch, Error> {
        input.validate()?;
        if self.stop.is_cancelled() {
            return Err(Error::ShuttingDown);
        }
        if let BatchOperation::File { source, .. } = &input.operation {
            if !std::path::Path::new(source).is_absolute() {
                return Err(Error::Validation("分发源必须是本地绝对路径"));
            }
            let metadata = tokio::fs::symlink_metadata(source)
                .await
                .map_err(|_| Error::Validation("无法读取本地分发源文件"))?;
            if !metadata.is_file() || metadata.file_type().is_symlink() {
                return Err(Error::Validation(
                    "批量分发仅接受一个本地普通文件，不接受链接或目录",
                ));
            }
        }
        let rows = input
            .targets
            .iter()
            .map(|t| BatchRow {
                host_id: t.host_id.clone(),
                session_id: t.session_id.clone(),
                state: "queued".into(),
                stdout: String::new(),
                stderr: String::new(),
                dropped_bytes: 0,
                exit_code: None,
                message: None,
                transfer: None,
                started_at: None,
                finished_at: None,
            })
            .collect();
        let info = Batch {
            id: uuid::Uuid::new_v4().to_string(),
            input: input.clone(),
            rows,
            finished: false,
            created_at: now(),
            revision: 1,
        };
        let c = Arc::new(BatchControl {
            info: Mutex::new(info.clone()),
            queued: self.stop.child_token(),
            running: self.stop.child_token(),
            join: Mutex::new(None),
        });
        {
            let mut bs = lock(&self.batches)?;
            if bs
                .iter()
                .filter(|b| b.info.lock().is_ok_and(|i| !i.finished))
                .count()
                >= 4
            {
                return Err(Error::Busy);
            }
            while bs.len() >= 8 {
                if let Some(n) = bs
                    .iter()
                    .position(|b| b.info.lock().is_ok_and(|i| i.finished))
                {
                    bs.remove(n);
                } else {
                    return Err(Error::Busy);
                }
            }
            bs.push_back(c.clone());
        }
        let service = self.clone();
        let run = c.clone();
        let join = tokio::spawn(async move {
            let per_batch = Arc::new(tokio::sync::Semaphore::new(input.concurrency.into()));
            let mut workers = tokio::task::JoinSet::new();
            for (n, target) in input.targets.iter().cloned().enumerate() {
                let this = service.clone();
                let b = run.clone();
                let operation = input.operation.clone();
                let semaphore = per_batch.clone();
                let seconds = input.timeout_secs;
                workers.spawn(async move {
                    let queued = async {
                        let p = semaphore.acquire_owned().await.ok()?;
                        let g = this.slots.clone().acquire_owned().await.ok()?;
                        Some((p, g))
                    };
                    let permits = tokio::select! {p=queued=>p,_=b.queued.cancelled()=>None};
                    if permits.is_none() || b.queued.is_cancelled() {
                        b.row(n, |r| {
                            r.state = "cancelled".into();
                            r.message = Some("尚未执行，已取消".into());
                            r.finished_at = Some(now());
                        });
                        return;
                    }
                    b.row(n, |r| {
                        r.state = "running".into();
                        r.started_at = Some(now());
                    });
                    let result = match &target.session_id {
                        None => {
                            Outcome::failed("该目标没有已认证连接，未执行；请显式连接后重新选择")
                        }
                        Some(id) => {
                            if this
                                .engine
                                .session_info(id)
                                .is_ok_and(|s| s.host_id == target.host_id)
                            {
                                match operation {
                                    BatchOperation::Command { command } => {
                                        exec::remote(
                                            &this.engine,
                                            id,
                                            &command,
                                            seconds,
                                            &b.running,
                                            |s, e| b.output(n, s, e),
                                        )
                                        .await
                                    }
                                    BatchOperation::File {
                                        source,
                                        destination,
                                        conflict,
                                        confirm_overwrite,
                                    } => {
                                        this.distribute(
                                            &b,
                                            n,
                                            TransferInput {
                                                session_id: id.clone(),
                                                direction: Direction::Upload,
                                                sources: vec![source],
                                                destination,
                                                conflict,
                                                confirm_overwrite,
                                            },
                                            seconds,
                                        )
                                        .await
                                    }
                                }
                            } else {
                                Outcome::failed(
                                    "目标 HostId 与 SessionId 不匹配或连接已结束，未执行",
                                )
                            }
                        }
                    };
                    b.row(n, |r| {
                        r.state = result.state.into();
                        r.exit_code = result.code;
                        r.message = result.message;
                        r.finished_at = Some(now());
                    });
                    drop(permits);
                });
            }
            while let Some(r) = workers.join_next().await {
                if r.is_err() {
                    tracing::error!(operation = "batch_worker", "batch worker failed");
                }
            }
            if let Ok(mut i) = run.info.lock() {
                for r in &mut i.rows {
                    if active(&r.state) {
                        r.state = "uncertain".into();
                        r.message = Some("任务异常结束，结果未确认".into());
                        r.finished_at = Some(now());
                    }
                }
                i.finished = true;
                i.revision += 1;
            }
        });
        *lock(&c.join)? = Some(join);
        Ok(info)
    }
    async fn distribute(
        &self,
        b: &BatchControl,
        n: usize,
        input: TransferInput,
        seconds: u16,
    ) -> Outcome {
        if !self
            .engine
            .file_connections()
            .is_ok_and(|ss| ss.iter().any(|s| s.id == input.session_id))
        {
            return Outcome::failed("目标文件连接未就绪，未分发");
        }
        let t = match self.files.transfers.start(input) {
            Ok(t) => t,
            Err(e) => return Outcome::failed(serverdeck_core::IpcError::from(e).message),
        };
        b.row(n, |r| r.transfer = Some(t.clone()));
        let deadline = tokio::time::sleep(Duration::from_secs(seconds.into()));
        tokio::pin!(deadline);
        loop {
            let snapshot = match self.files.transfers.list() {
                Ok(ts) => ts.into_iter().find(|i| i.id == t.id),
                Err(e) => return Outcome::failed(serverdeck_core::IpcError::from(e).message),
            };
            let Some(info) = snapshot else {
                return Outcome::uncertain("传输记录不可用，请在 SFTP 队列核对");
            };
            let done = !info.unfinished();
            let state = info.state.clone();
            let message = info.message.clone();
            b.row(n, |r| r.transfer = Some(info));
            if done {
                return Outcome {
                    state: match state.as_str() {
                        "completed" => "completed",
                        "cancelled" => "cancelled",
                        _ => "failed",
                    },
                    code: None,
                    message,
                };
            }
            let stop = tokio::select! {_=b.running.cancelled()=>Some("已请求取消传输，已完成文件保留；请在 SFTP 队列核对最终状态"),_=&mut deadline=>Some("分发超时并请求取消，提交结果可能未确认，请核对 SFTP 队列及目标文件"),_=tokio::time::sleep(Duration::from_millis(200))=>None};
            if let Some(message) = stop {
                if let Err(e) = self.files.transfers.cancel(&t.id) {
                    return Outcome::uncertain(format!(
                        "{message}；取消请求失败：{}",
                        serverdeck_core::IpcError::from(e).message
                    ));
                }
                b.row(n, |r| {
                    r.message = Some(format!("{message}；等待 SFTP 清理/提交屏障"))
                });
                // Hold the batch/global concurrency slots through cancellation cleanup.
                let drained = tokio::time::timeout(Duration::from_secs(35), async {
                    loop {
                        let tasks = self.files.transfers.list()?;
                        let info = tasks.into_iter().find(|item| item.id == t.id);
                        if let Some(info) = info {
                            let done = !info.unfinished();
                            b.row(n, |r| r.transfer = Some(info));
                            if done {
                                return Ok::<_, Error>(());
                            }
                        }
                        tokio::time::sleep(Duration::from_millis(100)).await;
                    }
                })
                .await;
                if !matches!(drained, Ok(Ok(()))) {
                    return Outcome::uncertain(format!(
                        "{message}；清理尚未确认，请查看 SFTP 队列/恢复路径"
                    ));
                }
                return Outcome::uncertain(message);
            }
        }
    }
    pub fn batch_list(&self) -> Result<Vec<Batch>, Error> {
        let transfers = self.files.transfers.list()?;
        let controls = lock(&self.batches)?.iter().cloned().collect::<Vec<_>>();
        controls
            .into_iter()
            .map(|b| {
                let mut info = lock(&b.info)?;
                let mut changed = false;
                for row in &mut info.rows {
                    if let Some(old) = &row.transfer
                        && let Some(new) = transfers.iter().find(|t| t.id == old.id)
                        && (old.state != new.state
                            || old.transferred_bytes != new.transferred_bytes
                            || old.message != new.message
                            || old.recovery_paths != new.recovery_paths)
                    {
                        row.transfer = Some(new.clone());
                        changed = true;
                    }
                }
                if changed {
                    info.revision += 1;
                }
                Ok(info.clone())
            })
            .collect()
    }
    pub fn batch_cancel(&self, id: &str, running: bool) -> Result<(), Error> {
        let b = lock(&self.batches)?
            .iter()
            .find(|b| b.info.lock().is_ok_and(|i| i.id == id))
            .cloned()
            .ok_or(Error::NotFound)?;
        b.queued.cancel();
        if running {
            b.running.cancel();
        }
        Ok(())
    }
    pub async fn batch_retry_file(
        &self,
        id: &str,
        host: &str,
        session: String,
        confirmed: bool,
    ) -> Result<Batch, Error> {
        let batch = self
            .batch_list()?
            .into_iter()
            .find(|b| b.id == id)
            .ok_or(Error::NotFound)?;
        if !batch.finished {
            return Err(Error::Validation("请等待批量任务结束后重试失败项"));
        }
        if !matches!(batch.input.operation, BatchOperation::File { .. }) {
            return Err(Error::Validation("命令不自动重试；请重新核对并创建新任务"));
        }
        let row = batch
            .rows
            .iter()
            .find(|r| {
                r.host_id == host
                    && matches!(r.state.as_str(), "failed" | "uncertain" | "cancelled")
            })
            .ok_or(Error::Validation("仅可重试失败/取消/未确认的文件目标"))?;
        if row.transfer.as_ref().is_some_and(|t| {
            self.files
                .transfers
                .list()
                .is_ok_and(|ts| ts.iter().any(|i| i.id == t.id && i.unfinished()))
        }) {
            return Err(Error::Validation("原传输尚未结束，不能并发重试"));
        }
        let mut input = batch.input;
        input.targets = vec![Target {
            host_id: host.into(),
            session_id: Some(session),
        }];
        input.confirmed = confirmed;
        self.batch_start(input).await
    }
}
