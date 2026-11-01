pub mod calendar;
mod templates;
use crate::Error;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};
pub use templates::templates;
use zeroize::Zeroizing;
pub const OUTPUT_LIMIT: usize = 8192;
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum EntryKind {
    Command,
    Script,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Risk {
    Normal,
    Dangerous,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ParameterKind {
    Text,
    Integer,
    Port,
    Path,
    Host,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Parameter {
    pub name: String,
    pub label: String,
    pub kind: ParameterKind,
    pub required: bool,
    pub secret: bool,
    pub default: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EntryInput {
    pub kind: EntryKind,
    pub name: String,
    pub body: String,
    pub description: String,
    pub group_id: Option<String>,
    pub favorite: bool,
    pub risk: Risk,
    pub parameters: Vec<Parameter>,
    pub timeout_secs: u16,
    pub concurrency: u8,
    pub retain_output: bool,
}
impl EntryInput {
    pub fn same_execution(&self, other: &Self) -> bool {
        self.kind == other.kind
            && self.body == other.body
            && self.risk == other.risk
            && self.parameters == other.parameters
            && self.timeout_secs == other.timeout_secs
            && self.concurrency == other.concurrency
            && self.retain_output == other.retain_output
    }
    pub fn validate(&self) -> Result<(), Error> {
        crate::hosts::validate_name(&self.name)?;
        if self.body.trim().is_empty()
            || self.body.len() > 65536
            || self.body.contains('\0')
            || self.description.len() > 8192
            || self.description.contains('\0')
        {
            return Err(Error::Validation(
                "正文为空、超过 64 KiB、描述超过 8 KiB 或包含 NUL",
            ));
        }
        limits(self.concurrency, self.timeout_secs)?;
        if self.parameters.len() > 32
            || self.kind == EntryKind::Command && !self.parameters.is_empty()
        {
            return Err(Error::Validation("脚本最多 32 个参数；命令条目不定义参数"));
        }
        if let Some(id) = &self.group_id {
            uuid_id(id)?;
        }
        let mut names = HashSet::new();
        for p in &self.parameters {
            if p.name.is_empty()
                || p.name.len() > 64
                || !p.name.bytes().enumerate().all(|(i, c)| {
                    c == b'_' || c.is_ascii_alphabetic() || i > 0 && c.is_ascii_digit()
                })
                || !names.insert(&p.name)
            {
                return Err(Error::Validation("参数名须为唯一 ASCII 标识符"));
            }
            crate::hosts::validate_name(&p.label)?;
            if p.secret && p.default.is_some() {
                return Err(Error::Validation("秘密参数不可保存默认值"));
            }
            if let Some(v) = &p.default {
                parameter_value(p, v)?;
            }
        }
        Ok(())
    }
}
pub fn limits(concurrency: u8, timeout: u16) -> Result<(), Error> {
    if !(1..=8).contains(&concurrency) || !(1..=3600).contains(&timeout) {
        return Err(Error::Validation("并发为 1–8，超时为 1–3600 秒"));
    }
    Ok(())
}
pub fn uuid_id(s: &str) -> Result<(), Error> {
    uuid::Uuid::parse_str(s)
        .map(|_| ())
        .map_err(|_| Error::Validation("标识无效"))
}
pub fn parameter_value(p: &Parameter, s: &str) -> Result<(), Error> {
    if s.len() > 4096 || s.contains('\0') {
        return Err(Error::Validation("参数超过 4096 字节或含 NUL"));
    }
    if s.is_empty() {
        return if p.required {
            Err(Error::Validation("必填参数不能为空"))
        } else {
            Ok(())
        };
    }
    match p.kind {
        ParameterKind::Text => (),
        ParameterKind::Integer => {
            s.parse::<i64>()
                .map_err(|_| Error::Validation("参数必须为整数"))?;
        }
        ParameterKind::Port => {
            if s.parse::<u16>().ok().filter(|n| *n > 0).is_none() {
                return Err(Error::Validation("端口须为 1–65535"));
            }
        }
        ParameterKind::Path => crate::files::remote_absolute(s)?,
        ParameterKind::Host => crate::tasks::target(s)?,
    }
    Ok(())
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub id: String,
    pub revision: u32,
    #[serde(flatten)]
    pub input: EntryInput,
    pub updated_at: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Group {
    pub id: String,
    pub name: String,
}
pub type Values = BTreeMap<String, Zeroizing<String>>;
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunInput {
    pub entry_id: String,
    pub expected_revision: u32,
    pub host_ids: Vec<String>,
    pub expected_profiles: BTreeMap<String, String>,
    pub parameters: Values,
    pub concurrency: u8,
    pub timeout_secs: u16,
    pub confirmed: bool,
    pub danger_confirmed: bool,
}
pub type PreparedValues = (Vec<Zeroizing<String>>, BTreeMap<String, String>, bool);
pub fn values(entry: &EntryInput, values: &Values) -> Result<PreparedValues, Error> {
    if values.len() > 32
        || values
            .keys()
            .any(|k| !entry.parameters.iter().any(|p| p.name == *k))
    {
        return Err(Error::Validation("输入了未定义参数"));
    }
    let mut args = Vec::new();
    let mut public = BTreeMap::new();
    let mut bytes = 0;
    let mut secret = false;
    for p in &entry.parameters {
        let value = values
            .get(&p.name)
            .map(|v| v.as_str())
            .or(p.default.as_deref())
            .unwrap_or("");
        parameter_value(p, value)?;
        bytes += value.len();
        if bytes > 65536 {
            return Err(Error::Validation("参数总量超过 64 KiB"));
        }
        args.push(Zeroizing::new(value.to_owned()));
        if p.secret {
            secret = true;
        } else {
            public.insert(p.name.clone(), value.into());
        }
    }
    Ok((args, public, secret))
}
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    pub host_id: String,
    pub name: String,
    pub hostname: String,
    pub port: u16,
    pub username: String,
    pub route_signature: String,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub enum State {
    Pending,
    Running,
    Success,
    Failed,
    Cancelled,
    Unknown,
}
pub fn terminal(s: State) -> bool {
    !matches!(s, State::Pending | State::Running)
}
pub fn aggregate(rows: &[RunRow]) -> State {
    if rows.iter().any(|r| r.state == State::Running) {
        State::Running
    } else if rows.iter().any(|r| r.state == State::Pending) {
        State::Pending
    } else if rows.iter().any(|r| r.state == State::Unknown) {
        State::Unknown
    } else if rows.iter().any(|r| r.state == State::Failed) {
        State::Failed
    } else if rows.iter().any(|r| r.state == State::Cancelled) {
        State::Cancelled
    } else {
        State::Success
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunSpec {
    pub entry: Entry,
    pub targets: Vec<Target>,
    pub parameters: BTreeMap<String, String>,
    pub has_secrets: bool,
    pub concurrency: u8,
    pub timeout_secs: u16,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunRow {
    pub host_id: String,
    pub state: State,
    pub stdout: String,
    pub stderr: String,
    pub dropped_bytes: u64,
    pub exit_code: Option<u32>,
    pub message: Option<String>,
    pub started_at: Option<u64>,
    pub finished_at: Option<u64>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Run {
    pub id: String,
    pub spec: RunSpec,
    pub schedule_id: Option<String>,
    pub scheduled_for: Option<u64>,
    pub trigger: String,
    pub state: State,
    pub approval_required: bool,
    pub message: Option<String>,
    pub created_at: u64,
    pub finished_at: Option<u64>,
    pub revision: u64,
    pub rows: Vec<RunRow>,
}
impl Run {
    pub fn new(spec: RunSpec, now: u64) -> Self {
        let rows = spec
            .targets
            .iter()
            .map(|t| RunRow {
                host_id: t.host_id.clone(),
                state: State::Pending,
                stdout: String::new(),
                stderr: String::new(),
                dropped_bytes: 0,
                exit_code: None,
                message: None,
                started_at: None,
                finished_at: None,
            })
            .collect();
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            spec,
            schedule_id: None,
            scheduled_for: None,
            trigger: "manual".into(),
            state: State::Pending,
            approval_required: false,
            message: None,
            created_at: now,
            finished_at: None,
            revision: 1,
            rows,
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Timing {
    Daily { hour: u8, minute: u8 },
    Weekly { weekday: u8, hour: u8, minute: u8 },
    Cron { expression: String },
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MissedPolicy {
    Skip,
    Ask,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScheduleInput {
    pub name: String,
    pub entry_id: String,
    pub expected_entry_revision: u32,
    pub host_ids: Vec<String>,
    pub expected_profiles: BTreeMap<String, String>,
    pub parameters: BTreeMap<String, String>,
    pub timing: Timing,
    pub offset_minutes: i16,
    pub missed_policy: MissedPolicy,
    pub enabled: bool,
    pub authorized: bool,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Schedule {
    pub id: String,
    pub revision: u32,
    pub name: String,
    pub spec: RunSpec,
    pub timing: Timing,
    pub offset_minutes: i16,
    pub missed_policy: MissedPolicy,
    pub enabled: bool,
    pub next_at: u64,
    pub last_message: Option<String>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunSummary {
    pub id: String,
    pub entry_name: String,
    pub state: State,
    pub approval_required: bool,
    pub trigger: String,
    pub schedule_id: Option<String>,
    pub created_at: u64,
    pub finished_at: Option<u64>,
    pub targets: usize,
    pub message: Option<String>,
}
#[derive(Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoryQuery {
    pub schedule_id: Option<String>,
    pub before: Option<u64>,
    pub before_id: Option<String>,
    pub state: Option<State>,
    pub search: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Catalog {
    pub entries: Vec<Entry>,
    pub groups: Vec<Group>,
    pub schedules: Vec<Schedule>,
    pub templates: Vec<EntryInput>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleStatus {
    pub id: String,
    pub revision: u32,
    pub enabled: bool,
    pub next_at: u64,
    pub last_message: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub active: usize,
    pub awaiting: usize,
    pub latest_failure: Option<RunSummary>,
    pub schedules: Vec<ScheduleStatus>,
    pub scheduler_error: Option<String>,
}
