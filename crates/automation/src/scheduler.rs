use super::*;
impl Automation {
    pub async fn schedule_save(
        &self,
        id: Option<String>,
        expected: Option<u32>,
        input: ScheduleInput,
    ) -> Result<Schedule, Error> {
        if self.stop.is_cancelled() {
            return Err(Error::ShuttingDown);
        }
        if input.enabled && !input.authorized {
            return Err(Error::Validation(
                "启用计划必须授权当前正文、参数、目标和时间；错过计划不会自动补跑",
            ));
        }
        serverdeck_core::hosts::validate_name(&input.name)?;
        let engine = self.engine.clone();
        self.db(move |d| {
            let entry = d.automation_entry(&input.entry_id)?;
            if entry.revision != input.expected_entry_revision {
                return Err(Error::Validation("条目已修改，请重新预览计划"));
            }
            if entry.input.parameters.iter().any(|p| p.secret) {
                return Err(Error::Validation(
                    "本地计划不保存秘密参数，请手动执行此脚本",
                ));
            }
            let values = input
                .parameters
                .into_iter()
                .map(|(k, v)| (k, Zeroizing::new(v)))
                .collect();
            let (_, parameters, has_secrets) = values_for_schedule(&entry, &values)?;
            let targets = targets(&d, &engine, input.host_ids)?;
            guard_targets(&targets, &input.expected_profiles)?;
            let spec = RunSpec {
                targets,
                concurrency: entry.input.concurrency,
                timeout_secs: entry.input.timeout_secs,
                entry,
                parameters,
                has_secrets,
            };
            let _ = spec_payload(&spec)?;
            let next_at = calendar::next(&input.timing, input.offset_minutes, now())?;
            let plan = Schedule {
                id: id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
                revision: 0,
                name: input.name,
                spec,
                timing: input.timing,
                offset_minutes: input.offset_minutes,
                missed_policy: input.missed_policy,
                enabled: input.enabled,
                next_at,
                last_message: Some("计划只使用已有可信 SSH 连接；错过时跳过或待手动确认".into()),
            };
            d.automation_schedule_save(plan, expected)
        })
        .await
    }
    pub async fn schedule_disable(&self, id: String) -> Result<(), Error> {
        self.db(move |d| d.automation_schedule_disable(&id, "用户已停用计划；在途任务需另行停止"))
            .await
    }
    pub async fn schedule_delete(&self, id: String, confirmed: bool) -> Result<(), Error> {
        if !confirmed {
            return Err(Error::Validation("删除计划必须确认"));
        }
        self.db(move |d| d.automation_schedule_delete(&id)).await
    }
    pub fn start_scheduler(&self) -> Result<(), Error> {
        let mut scheduler = lock(&self.scheduler)?;
        if scheduler.is_some() {
            return Ok(());
        }
        tokio::runtime::Handle::try_current()
            .map_err(|_| Error::Validation("调度必须从异步运行时启动"))?;
        let service = self.clone();
        *scheduler = Some(tokio::spawn(async move {
            let mut previous = None;
            let mut interval = tokio::time::interval(Duration::from_secs(1));
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                tokio::select! {_=service.stop.cancelled()=>break,_=interval.tick()=>{let current=now();let missed=previous.is_none_or(|last|current.saturating_sub(last)>75000);previous=Some(current);if let Err(e)=service.tick_at(current,missed).await{service.record_error(format!("本地调度失败：{}",IpcError::from(e).message));}}}
            }
        }));
        Ok(())
    }
    /// Deterministic clock boundary for tests. Not exposed as a desktop IPC command.
    pub async fn tick_at(&self, current: u64, gap: bool) -> Result<(), Error> {
        let _gate = self.launch.lock().await;
        if self.stop.is_cancelled() {
            return Err(Error::ShuttingDown);
        }
        let plans = self.db(|d| d.automation_schedules()).await?;
        for mut plan in plans
            .into_iter()
            .filter(|p| p.enabled && p.next_at <= current)
        {
            let due = plan.next_at;
            let missed = gap || current.saturating_sub(due) > 60000;
            let engine = self.engine.clone();
            let spec = plan.spec.clone();
            let plan_id = plan.id.clone();
            let check = self
                .db(move |d| {
                    validate_spec(&d, &engine, &spec)?;
                    d.automation_schedule_busy(&plan_id)
                })
                .await;
            let mut run = Run::new(plan.spec.clone(), current);
            run.schedule_id = Some(plan.id.clone());
            run.scheduled_for = Some(due);
            run.trigger = if missed { "missed" } else { "schedule" }.into();
            let mut dispatch = false;
            let mut slot = None;
            match check {
                Err(e) => {
                    plan.enabled = false;
                    run.message = Some(format!(
                        "计划授权失效，已停用：{}",
                        IpcError::from(e).message
                    ));
                    for r in &mut run.rows {
                        r.state = State::Failed;
                    }
                }
                Ok(true) => {
                    run.message = Some("上次任务仍在执行或待确认，本次跳过，不积压自动运行".into());
                    for r in &mut run.rows {
                        r.state = State::Cancelled;
                    }
                }
                Ok(false) if missed => {
                    if plan.missed_policy == MissedPolicy::Ask {
                        run.approval_required = true;
                        run.message = Some("错过执行窗口，等待手动预览确认；未自动补跑".into());
                    } else {
                        run.message = Some("错过执行窗口，按策略跳过；未自动补跑".into());
                        for r in &mut run.rows {
                            r.state = State::Cancelled;
                        }
                    }
                }
                Ok(false) if plan.spec.entry.input.risk == Risk::Dangerous => {
                    run.approval_required = true;
                    run.message = Some("危险计划到期，仅生成待确认任务，未执行".into());
                }
                Ok(false) => match self.run_slots.clone().try_acquire_owned() {
                    Ok(p) => {
                        slot = Some(p);
                        dispatch = true;
                    }
                    Err(_) => {
                        run.message = Some("活动任务已达上限，本次未执行；不自动重试".into());
                        for r in &mut run.rows {
                            r.state = State::Failed;
                        }
                    }
                },
            }
            run.state = aggregate(&run.rows);
            if terminal(run.state) {
                run.finished_at = Some(current);
                for row in &mut run.rows {
                    row.finished_at = Some(current);
                    row.message = run.message.clone();
                }
            }
            match calendar::next(&plan.timing, plan.offset_minutes, current) {
                Ok(n) => plan.next_at = n,
                Err(e) => {
                    plan.enabled = false;
                    run.message = Some(IpcError::from(e).message);
                    dispatch = false;
                    for r in &mut run.rows {
                        r.state = State::Failed;
                    }
                    run.state = State::Failed;
                    run.finished_at = Some(current);
                }
            }
            plan.last_message = run
                .message
                .clone()
                .or_else(|| Some("已按授权发起；请在历史查看结果".into()));
            let prepared = if dispatch {
                match spec_payload(&run.spec) {
                    Ok(p) => Some(p),
                    Err(e) => {
                        dispatch = false;
                        plan.enabled = false;
                        run.state = State::Failed;
                        run.message = Some(IpcError::from(e).message);
                        run.finished_at = Some(current);
                        for row in &mut run.rows {
                            row.state = State::Failed;
                            row.message = run.message.clone();
                            row.finished_at = Some(current);
                        }
                        plan.last_message = run.message.clone();
                        None
                    }
                }
            } else {
                None
            };
            let p = plan.clone();
            let r = run.clone();
            let claim = self.db(move |d| d.automation_claim(&p, due, &r)).await;
            match claim {
                Ok(true) if dispatch => {
                    self.dispatch(
                        run,
                        Arc::new(prepared.ok_or(Error::Busy)?),
                        slot.ok_or(Error::Busy)?,
                    )?;
                }
                Ok(_) => (),
                Err(e) => {
                    let id = plan.id.clone();
                    let message = IpcError::from(e).message;
                    self.db(move |d| {
                        d.automation_schedule_disable(
                            &id,
                            &format!("调度记录失败，已停用：{message}"),
                        )
                    })
                    .await?;
                }
            }
        }
        Ok(())
    }
}
fn values_for_schedule(entry: &Entry, input: &Values) -> Result<PreparedValues, Error> {
    values(&entry.input, input)
}
