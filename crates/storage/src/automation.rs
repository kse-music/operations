use super::*;
use serde_json::{from_str, to_string};
use serverdeck_core::automation::*;
fn num(n: u64) -> Result<i64, Error> {
    i64::try_from(n).map_err(|_| Error::Validation("时间或任务版本超过数据库范围"))
}
fn unsigned(n: i64) -> Result<u64, Error> {
    u64::try_from(n).map_err(|_| Error::Validation("数据库时间为负数"))
}
fn opt_num(n: Option<u64>) -> Result<Option<i64>, Error> {
    n.map(num).transpose()
}
fn json<T: serde::Serialize>(v: &T) -> Result<String, Error> {
    to_string(v).map_err(storage_error)
}
fn parse<T: serde::de::DeserializeOwned>(s: String) -> Result<T, Error> {
    from_str(&s).map_err(storage_error)
}
fn entry(c: &Connection, id: &str) -> Result<Entry, Error> {
    let (doc, group): (String, Option<String>) = c
        .query_row(
            "SELECT document,group_id FROM automation_entries WHERE id=?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(storage_error)?
        .ok_or(Error::NotFound)?;
    let mut e: Entry = parse(doc)?;
    e.input.group_id = group;
    Ok(e)
}
impl Database {
    pub fn automation_pending_approval(&self) -> Result<usize, Error> {
        self.connect()?.query_row("SELECT count(*) FROM automation_runs WHERE state='Pending' AND approval_required=1",[],|r|r.get::<_,u32>(0)).map(|n|n as usize).map_err(storage_error)
    }
    pub fn automation_schedule_busy(&self, id: &str) -> Result<bool, Error> {
        self.connect()?.query_row("SELECT EXISTS(SELECT 1 FROM automation_runs WHERE schedule_id=?1 AND state IN ('Pending','Running'))",[id],|r|r.get(0)).map_err(storage_error)
    }
    pub fn automation_entries(&self) -> Result<Vec<Entry>, Error> {
        let c = self.connect()?;
        let mut q = c
            .prepare(
                "SELECT id FROM automation_entries ORDER BY json_extract(document,'$.name'),id",
            )
            .map_err(storage_error)?;
        let ids = q
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(storage_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(storage_error)?;
        ids.iter().map(|id| entry(&c, id)).collect()
    }
    pub fn automation_entry(&self, id: &str) -> Result<Entry, Error> {
        entry(&self.connect()?, id)
    }
    pub fn automation_entry_save(
        &self,
        id: Option<&str>,
        expected: Option<u32>,
        input: EntryInput,
        now: u64,
    ) -> Result<Entry, Error> {
        input.validate()?;
        let mut c = self.connect()?;
        let tx = c
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_error)?;
        let changed = if let Some(id) = id {
            !entry(&tx, id)?.input.same_execution(&input)
        } else {
            false
        };
        let (id, revision) = match id {
            Some(id) => {
                uuid_id(id)?;
                let old = entry(&tx, id)?;
                if expected != Some(old.revision) {
                    return Err(Error::Validation("条目已修改，请刷新后再保存"));
                }
                (
                    id.into(),
                    old.revision
                        .checked_add(1)
                        .ok_or(Error::Validation("条目版本溢出"))?,
                )
            }
            None => {
                let count: u32 = tx
                    .query_row("SELECT count(*) FROM automation_entries", [], |r| r.get(0))
                    .map_err(storage_error)?;
                if count >= 256 {
                    return Err(Error::Validation("命令/脚本库最多 256 条"));
                }
                (uuid::Uuid::new_v4().to_string(), 1)
            }
        };
        let value = Entry {
            id,
            revision,
            input,
            updated_at: now,
        };
        tx.execute("INSERT INTO automation_entries(id,revision,group_id,document) VALUES(?1,?2,?3,?4) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,group_id=excluded.group_id,document=excluded.document",params![value.id,value.revision,value.input.group_id,json(&value)?]).map_err(storage_error)?;
        let mut plans = read_schedules(&tx)?;
        for p in plans
            .iter_mut()
            .filter(|p| changed && p.spec.entry.id == value.id)
        {
            p.enabled = false;
            p.last_message = Some("条目已修改，计划授权失效，请重新预览授权".into());
            p.revision += 1;
            put_schedule(&tx, p)?;
        }
        tx.commit().map_err(storage_error)?;
        Ok(value)
    }
    pub fn automation_entry_delete(&self, id: &str) -> Result<(), Error> {
        if self
            .connect()?
            .execute("DELETE FROM automation_entries WHERE id=?1", [id])
            .map_err(storage_error)?
            == 0
        {
            return Err(Error::NotFound);
        }
        Ok(())
    }
    pub fn automation_groups(&self) -> Result<Vec<Group>, Error> {
        let c = self.connect()?;
        let mut q = c
            .prepare("SELECT id,name FROM automation_groups ORDER BY name COLLATE NOCASE,id")
            .map_err(storage_error)?;
        q.query_map([], |r| {
            Ok(Group {
                id: r.get(0)?,
                name: r.get(1)?,
            })
        })
        .map_err(storage_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(storage_error)
    }
    pub fn automation_group_save(&self, id: Option<&str>, name: &str) -> Result<Group, Error> {
        serverdeck_core::hosts::validate_name(name)?;
        let c = self.connect()?;
        let id = match id {
            Some(id) => {
                uuid_id(id)?;
                if !c
                    .query_row(
                        "SELECT EXISTS(SELECT 1 FROM automation_groups WHERE id=?1)",
                        [id],
                        |r| r.get::<_, bool>(0),
                    )
                    .map_err(storage_error)?
                {
                    return Err(Error::NotFound);
                }
                id.into()
            }
            None => {
                if c.query_row("SELECT count(*) FROM automation_groups", [], |r| {
                    r.get::<_, u32>(0)
                })
                .map_err(storage_error)?
                    >= 64
                {
                    return Err(Error::Validation("最多 64 个命令分组"));
                }
                uuid::Uuid::new_v4().to_string()
            }
        };
        c.execute("INSERT INTO automation_groups(id,name) VALUES(?1,?2) ON CONFLICT(id) DO UPDATE SET name=excluded.name",params![id,name.trim()]).map_err(storage_error)?;
        Ok(Group {
            id,
            name: name.trim().into(),
        })
    }
    pub fn automation_group_delete(&self, id: &str) -> Result<(), Error> {
        if self
            .connect()?
            .execute("DELETE FROM automation_groups WHERE id=?1", [id])
            .map_err(storage_error)?
            == 0
        {
            return Err(Error::NotFound);
        }
        Ok(())
    }
    pub fn automation_schedules(&self) -> Result<Vec<Schedule>, Error> {
        read_schedules(&self.connect()?)
    }
    pub fn automation_schedule_save(
        &self,
        mut plan: Schedule,
        expected: Option<u32>,
    ) -> Result<Schedule, Error> {
        let mut c = self.connect()?;
        let tx = c
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_error)?;
        let old: Option<u32> = tx
            .query_row(
                "SELECT revision FROM automation_schedules WHERE id=?1",
                [&plan.id],
                |r| r.get(0),
            )
            .optional()
            .map_err(storage_error)?;
        if old != expected {
            return Err(Error::Validation("计划已修改，请刷新"));
        }
        if old.is_none()
            && tx
                .query_row("SELECT count(*) FROM automation_schedules", [], |r| {
                    r.get::<_, u32>(0)
                })
                .map_err(storage_error)?
                >= 64
        {
            return Err(Error::Validation("最多 64 个本地计划"));
        }
        let current = entry(&tx, &plan.spec.entry.id)?;
        if current.revision != plan.spec.entry.revision {
            return Err(Error::Validation("条目已修改，请重新预览计划"));
        }
        plan.revision = old.unwrap_or(0) + 1;
        put_schedule(&tx, &plan)?;
        tx.commit().map_err(storage_error)?;
        Ok(plan)
    }
    pub fn automation_schedule_disable(&self, id: &str, message: &str) -> Result<(), Error> {
        let mut plans = self.automation_schedules()?;
        let p = plans
            .iter_mut()
            .find(|p| p.id == id)
            .ok_or(Error::NotFound)?;
        p.enabled = false;
        p.last_message = Some(message.into());
        self.automation_schedule_save(p.clone(), Some(p.revision))?;
        Ok(())
    }
    pub fn automation_schedule_delete(&self, id: &str) -> Result<(), Error> {
        if self
            .connect()?
            .execute("DELETE FROM automation_schedules WHERE id=?1", [id])
            .map_err(storage_error)?
            == 0
        {
            return Err(Error::NotFound);
        }
        Ok(())
    }
    pub fn automation_run_insert(&self, run: &Run) -> Result<(), Error> {
        let mut c = self.connect()?;
        let tx = c
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_error)?;
        insert_run(&tx, run)?;
        tx.commit().map_err(storage_error)
    }
    pub fn automation_run_save(&self, run: &Run) -> Result<(), Error> {
        let run = sanitize(run)?;
        let state = json(&run.state)?;
        self.connect()?.execute("UPDATE automation_runs SET state=?2,approval_required=?3,finished_at=?4,message=?5,revision=?6,document=?7 WHERE id=?1 AND revision<=?6",params![run.id,state.trim_matches('"'),run.approval_required,opt_num(run.finished_at)?,run.message,num(run.revision)?,json(&run)?]).map_err(storage_error)?;
        Ok(())
    }
    pub fn automation_run(&self, id: &str) -> Result<Run, Error> {
        let doc = self
            .connect()?
            .query_row(
                "SELECT document FROM automation_runs WHERE id=?1",
                [id],
                |r| r.get::<_, String>(0),
            )
            .optional()
            .map_err(storage_error)?
            .ok_or(Error::NotFound)?;
        parse(doc)
    }
    pub fn automation_history(&self, query: HistoryQuery) -> Result<Vec<RunSummary>, Error> {
        let c = self.connect()?;
        let state = query
            .state
            .map(|s| json(&s).map(|s| s.trim_matches('"').to_owned()))
            .transpose()?;
        let search = query.search.unwrap_or_default();
        if search.len() > 128 {
            return Err(Error::Validation("历史搜索超过 128 字节"));
        }
        let state_filter = if state.is_some() {
            "state=?3"
        } else {
            "?3 IS NULL"
        };
        let schedule_filter = if query.schedule_id.is_some() {
            "schedule_id=?5"
        } else {
            "?5 IS NULL"
        };
        let mut q=c.prepare(&format!("SELECT id,entry_name,state,approval_required,trigger,schedule_id,created_at,finished_at,targets,message FROM automation_runs WHERE (?1 IS NULL OR created_at<?1 OR (created_at=?1 AND id<?2)) AND ({state_filter}) AND (?4='' OR instr(lower(entry_name),lower(?4))>0) AND ({schedule_filter}) ORDER BY created_at DESC,id DESC LIMIT 50")).map_err(storage_error)?;
        let rows = q
            .query_map(
                params![
                    opt_num(query.before)?,
                    query.before_id.unwrap_or_default(),
                    state,
                    search,
                    query.schedule_id
                ],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, bool>(3)?,
                        r.get::<_, String>(4)?,
                        r.get::<_, Option<String>>(5)?,
                        r.get::<_, i64>(6)?,
                        r.get::<_, Option<i64>>(7)?,
                        r.get::<_, u32>(8)?,
                        r.get::<_, Option<String>>(9)?,
                    ))
                },
            )
            .map_err(storage_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(storage_error)?;
        rows.into_iter()
            .map(|r| {
                Ok(RunSummary {
                    id: r.0,
                    entry_name: r.1,
                    state: from_str(&format!("\"{}\"", r.2)).map_err(storage_error)?,
                    approval_required: r.3,
                    trigger: r.4,
                    schedule_id: r.5,
                    created_at: unsigned(r.6)?,
                    finished_at: r.7.map(unsigned).transpose()?,
                    targets: r.8 as usize,
                    message: r.9,
                })
            })
            .collect()
    }
    pub fn automation_run_delete(&self, id: &str) -> Result<(), Error> {
        let run = self.automation_run(id)?;
        if !terminal(run.state) {
            return Err(Error::Validation("请先取消未结束任务，再删除历史"));
        }
        self.connect()?
            .execute("DELETE FROM automation_runs WHERE id=?1", [id])
            .map_err(storage_error)?;
        Ok(())
    }
    pub fn automation_recover(&self, now: u64) -> Result<(), Error> {
        let c = self.connect()?;
        let mut q=c.prepare("SELECT document FROM automation_runs WHERE state IN ('Pending','Running') AND approval_required=0").map_err(storage_error)?;
        let docs = q
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(storage_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(storage_error)?;
        drop(q);
        drop(c);
        for doc in docs {
            let mut run: Run = parse(doc)?;
            for row in &mut run.rows {
                if row.state == State::Running {
                    row.state = State::Unknown;
                    row.message = Some("应用中断，远端结果未知，不自动重试".into());
                    row.finished_at = Some(now);
                } else if row.state == State::Pending {
                    row.state = State::Cancelled;
                    row.message = Some("应用中断，排队任务未恢复执行".into());
                    row.finished_at = Some(now);
                }
            }
            run.state = aggregate(&run.rows);
            run.message = Some("应用中断后已恢复历史，不重放命令".into());
            run.finished_at = Some(now);
            run.revision += 1;
            self.automation_run_save(&run)?;
        }
        Ok(())
    }
    pub fn automation_claim(
        &self,
        plan: &Schedule,
        expected_due: u64,
        run: &Run,
    ) -> Result<bool, Error> {
        let mut c = self.connect()?;
        let tx = c
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_error)?;
        let matches=tx.query_row("SELECT EXISTS(SELECT 1 FROM automation_schedules WHERE id=?1 AND enabled=1 AND next_at=?2 AND revision=?3)",params![plan.id,num(expected_due)?,plan.revision],|r|r.get::<_,bool>(0)).map_err(storage_error)?;
        if !matches {
            return Ok(false);
        }
        put_schedule(&tx, plan)?;
        insert_run(&tx, run)?;
        tx.commit().map_err(storage_error)?;
        Ok(true)
    }
}
fn read_schedules(c: &Connection) -> Result<Vec<Schedule>, Error> {
    let mut q = c
        .prepare("SELECT document FROM automation_schedules ORDER BY next_at,id")
        .map_err(storage_error)?;
    let docs = q
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(storage_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(storage_error)?;
    docs.into_iter().map(parse).collect()
}
fn put_schedule(c: &Connection, p: &Schedule) -> Result<(), Error> {
    c.execute("INSERT INTO automation_schedules(id,entry_id,revision,enabled,next_at,document) VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(id) DO UPDATE SET entry_id=excluded.entry_id,revision=excluded.revision,enabled=excluded.enabled,next_at=excluded.next_at,document=excluded.document",params![p.id,p.spec.entry.id,p.revision,p.enabled,num(p.next_at)?,json(p)?]).map_err(storage_error)?;
    Ok(())
}
fn sanitize(run: &Run) -> Result<Run, Error> {
    let mut r = run.clone();
    r.spec.entry.input.validate()?;
    let secret = r.spec.entry.input.parameters.iter().any(|p| p.secret);
    r.spec.has_secrets = secret;
    r.spec.parameters.retain(|name, _| {
        r.spec
            .entry
            .input
            .parameters
            .iter()
            .any(|p| p.name == *name && !p.secret)
    });
    if r.rows.len() > 32 || r.spec.targets.len() != r.rows.len() {
        return Err(Error::Validation("任务目标数量无效"));
    }
    for row in &mut r.rows {
        if secret || !r.spec.entry.input.retain_output {
            row.stdout.clear();
            row.stderr.clear();
        } else {
            for s in [&mut row.stdout, &mut row.stderr] {
                if s.len() > OUTPUT_LIMIT {
                    let mut n = s.len() - OUTPUT_LIMIT;
                    while !s.is_char_boundary(n) {
                        n += 1;
                    }
                    s.drain(..n);
                }
            }
        }
    }
    Ok(r)
}
fn insert_run(c: &Connection, r: &Run) -> Result<(), Error> {
    let r = sanitize(r)?;
    if r.approval_required
        && c.query_row(
            "SELECT count(*) FROM automation_runs WHERE approval_required=1 AND state='Pending'",
            [],
            |r| r.get::<_, u32>(0),
        )
        .map_err(storage_error)?
            >= 64
    {
        return Err(Error::Validation("已有 64 个待确认任务，请先处理"));
    }
    let state = json(&r.state)?;
    c.execute("INSERT INTO automation_runs(id,entry_name,state,approval_required,trigger,schedule_id,scheduled_for,created_at,finished_at,targets,message,revision,document) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",params![r.id,r.spec.entry.input.name,state.trim_matches('"'),r.approval_required,r.trigger,r.schedule_id,opt_num(r.scheduled_for)?,num(r.created_at)?,opt_num(r.finished_at)?,r.rows.len() as u32,r.message,num(r.revision)?,json(&r)?]).map_err(storage_error)?;
    Ok(())
}
