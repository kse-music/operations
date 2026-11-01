use super::*;
impl Automation {
    pub(crate) fn dispatch(
        &self,
        run: Run,
        payload: Arc<Zeroizing<Vec<u8>>>,
        slot: tokio::sync::OwnedSemaphorePermit,
    ) -> Result<(), Error> {
        let control = Arc::new(Control {
            info: Mutex::new(run.clone()),
            queued: self.stop.child_token(),
            running: self.stop.child_token(),
            join: Mutex::new(None),
        });
        {
            let mut controls = lock(&self.controls)?;
            while controls.len() >= 8 {
                let oldest = controls
                    .iter()
                    .filter(|(_, c)| {
                        c.join
                            .lock()
                            .is_ok_and(|j| j.as_ref().is_some_and(|j| j.is_finished()))
                    })
                    .filter_map(|(id, c)| {
                        c.info
                            .lock()
                            .ok()
                            .filter(|r| terminal(r.state))
                            .map(|r| (id.clone(), r.created_at))
                    })
                    .min_by_key(|(_, at)| *at)
                    .map(|(id, _)| id);
                if let Some(id) = oldest {
                    controls.remove(&id);
                } else {
                    return Err(Error::Busy);
                }
            }
            if controls.contains_key(&run.id) {
                return Err(Error::Busy);
            }
            controls.insert(run.id.clone(), control.clone());
        }
        let service = self.clone();
        let c = control.clone();
        let join = tokio::spawn(async move {
            let _slot = slot;
            let concurrency = Arc::new(Semaphore::new(run.spec.concurrency.into()));
            let mut workers = tokio::task::JoinSet::new();
            for (n, target) in run.spec.targets.iter().cloned().enumerate() {
                let this = service.clone();
                let c = c.clone();
                let payload = payload.clone();
                let sem = concurrency.clone();
                let secret = run.spec.has_secrets;
                let timeout = run.spec.timeout_secs;
                workers.spawn(async move {
                    let permit =
                        tokio::select! {p=sem.acquire()=>p.ok(),_=c.queued.cancelled()=>None};
                    if permit.is_none() || c.queued.is_cancelled() {
                        let _ = c.update(|r| {
                            let row = &mut r.rows[n];
                            row.state = State::Cancelled;
                            row.message = Some("尚未执行，已取消".into());
                            row.finished_at = Some(now());
                        });
                        return;
                    }
                    let global = match this.tasks.script_slot(&c.queued).await {
                        Ok(p) => p,
                        Err(e) => {
                            let state = if c.queued.is_cancelled() {
                                State::Cancelled
                            } else {
                                State::Failed
                            };
                            let message = IpcError::from(e).message;
                            let _ = c.update(|r| {
                                r.rows[n].state = state;
                                r.rows[n].message = Some(message);
                                r.rows[n].finished_at = Some(now());
                            });
                            return;
                        }
                    };
                    let engine = this.engine.clone();
                    let lookup = this
                        .db(move |_| {
                            if engine.profile_signature(&target.host_id)? != target.route_signature
                            {
                                return Err(Error::Validation("目标/跳板/代理/凭据已变更，未执行"));
                            }
                            let session = engine
                                .ops_connections()?
                                .into_iter()
                                .find(|s| s.host_id == target.host_id)
                                .ok_or(Error::Validation(
                                    "目标没有已认证的 SSH 运维连接，未执行；请手动连接",
                                ))?;
                            if engine.ops_profile(&session.id)? != target.route_signature {
                                return Err(Error::Validation(
                                    "现有 SSH 连接对应旧配置，请断开并重新连接",
                                ));
                            }
                            Ok(session.id)
                        })
                        .await;
                    let id = match lookup {
                        Ok(id) => id,
                        Err(e) => {
                            let message = IpcError::from(e).message;
                            let _ = c.update(|r| {
                                let row = &mut r.rows[n];
                                row.state = State::Failed;
                                row.message = Some(message);
                                row.finished_at = Some(now());
                            });
                            return;
                        }
                    };
                    if c.running.is_cancelled() || c.queued.is_cancelled() {
                        let _ = c.update(|r| {
                            r.rows[n].state = State::Cancelled;
                            r.rows[n].finished_at = Some(now());
                        });
                        return;
                    }
                    let checkpoint = c.update(|r| {
                        r.rows[n].state = State::Running;
                        r.rows[n].started_at = Some(now());
                    });
                    let checkpoint = match checkpoint {
                        Ok(r) => r,
                        Err(_) => return,
                    };
                    if let Err(e) = this.db(move |d| d.automation_run_save(&checkpoint)).await {
                        let message = IpcError::from(e).message;
                        let _ = c.update(|r| {
                            r.rows[n].state = State::Failed;
                            r.rows[n].message =
                                Some(format!("开始状态保存失败，未执行：{message}"));
                            r.rows[n].finished_at = Some(now());
                        });
                        return;
                    }
                    let output_control = c.clone();
                    let result = this
                        .tasks
                        .execute_script(
                            &id,
                            &payload,
                            timeout,
                            &c.running,
                            global,
                            move |s, stderr| {
                                if secret || s.is_empty() {
                                    return;
                                }
                                if let Ok(mut run) = output_control.info.lock() {
                                    let row = &mut run.rows[n];
                                    let text = if stderr {
                                        &mut row.stderr
                                    } else {
                                        &mut row.stdout
                                    };
                                    text.push_str(s);
                                    if text.len() > OUTPUT_LIMIT {
                                        let mut drop_bytes = text.len() - OUTPUT_LIMIT;
                                        while !text.is_char_boundary(drop_bytes) {
                                            drop_bytes += 1;
                                        }
                                        text.drain(..drop_bytes);
                                        row.dropped_bytes += drop_bytes as u64;
                                    }
                                    run.revision += 1;
                                }
                            },
                        )
                        .await;
                    let _ = c.update(|r| {
                        let row = &mut r.rows[n];
                        row.state = match result.state {
                            "completed" => State::Success,
                            "failed" => State::Failed,
                            "cancelled" => State::Cancelled,
                            _ => State::Unknown,
                        };
                        row.exit_code = result.code;
                        row.message = result.message;
                        if secret {
                            row.message = Some(format!(
                                "{}含秘密参数，本次不展示或保存输出。",
                                row.message
                                    .as_ref()
                                    .map(|s| format!("{s}；"))
                                    .unwrap_or_default()
                            ));
                        }
                        row.finished_at = Some(now());
                    });
                });
            }
            let mut interval = tokio::time::interval(Duration::from_secs(1));
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            while !workers.is_empty() {
                tokio::select! {r=workers.join_next()=>{if let Some(Err(_))=r{tracing::error!(operation="automation_worker","execution worker failed");}},_=interval.tick()=>{if let Ok(checkpoint)=c.snapshot()&&let Err(e)=service.db(move|d|d.automation_run_save(&checkpoint)).await{service.record_error(format!("任务状态保存失败：{}",IpcError::from(e).message));}}}
            }
            let final_run = c.update(|r| {
                for row in &mut r.rows {
                    if !terminal(row.state) {
                        row.state = State::Unknown;
                        row.message = Some("工作任务异常结束，结果未确认".into());
                        row.finished_at = Some(now());
                    }
                }
                r.finished_at = Some(now());
            });
            if let Ok(final_run) = final_run
                && let Err(e) = service.db(move |d| d.automation_run_save(&final_run)).await
            {
                service.record_error(format!(
                    "最终任务结果保存失败：{}",
                    IpcError::from(e).message
                ));
            }
        });
        *lock(&control.join)? = Some(join);
        Ok(())
    }
}
