use crate::Error;
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const PRELUDE: &str = "export LC_ALL=C; export PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin; export SYSTEMD_PAGER=cat SYSTEMD_COLORS=0; unset DOCKER_HOST DOCKER_CONTEXT DOCKER_TLS_VERIFY DOCKER_CERT_PATH; sd_uid=$(id -u); sd_socket=/var/run/docker.sock; if test -S /run/user/$sd_uid/docker.sock; then sd_socket=/run/user/$sd_uid/docker.sock; fi; d() { command docker --host unix://$sd_socket \"$@\"; }; ";
pub fn quote(value: &str) -> Result<String, Error> {
    if value.is_empty() || value.len() > 4096 || value.contains('\0') {
        return Err(Error::Validation("参数为空、过长或包含 NUL"));
    }
    Ok(format!("'{}'", value.replace('\'', "'\"'\"'")))
}
pub fn container_id(id: &str) -> Result<(), Error> {
    if id.len() != 64 || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(Error::Validation("需要完整的 64 位容器 ID"));
    }
    Ok(())
}
pub fn image_id(id: &str) -> Result<(), Error> {
    container_id(id.strip_prefix("sha256:").unwrap_or(id))
}
pub fn unit_name(unit: &str) -> Result<(), Error> {
    if !unit.ends_with(".service")
        || unit.len() > 256
        || unit.starts_with('-')
        || !unit
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_.@:\\-".contains(&b))
    {
        return Err(Error::Validation("服务名称无效，需要明确的 .service 单元"));
    }
    Ok(())
}
fn confirm(value: bool) -> Result<(), Error> {
    if !value {
        return Err(Error::Validation("此操作需要明确确认主机和目标"));
    }
    Ok(())
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Scope {
    System,
    User,
}
impl Scope {
    pub fn flag(self) -> &'static str {
        match self {
            Self::System => "--system",
            Self::User => "--user",
        }
    }
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ContainerAction {
    Start,
    Stop,
    Restart,
    Remove,
}
impl ContainerAction {
    pub fn name(self) -> &'static str {
        match self {
            Self::Start => "start",
            Self::Stop => "stop",
            Self::Restart => "restart",
            Self::Remove => "rm",
        }
    }
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ServiceAction {
    Start,
    Stop,
    Restart,
    Enable,
    Disable,
}
impl ServiceAction {
    pub fn name(self) -> &'static str {
        match self {
            Self::Start => "start",
            Self::Stop => "stop",
            Self::Restart => "restart",
            Self::Enable => "enable",
            Self::Disable => "disable",
        }
    }
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ProcessSignal {
    Term,
    Kill,
    Int,
    Hup,
}
impl ProcessSignal {
    pub fn name(self) -> &'static str {
        match self {
            Self::Term => "SIGTERM",
            Self::Kill => "SIGKILL",
            Self::Int => "SIGINT",
            Self::Hup => "SIGHUP",
        }
    }
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProbeLocation {
    Local,
    Remote,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Request {
    Capabilities,
    Containers,
    Images,
    ContainerDetails {
        id: String,
        reveal_env: bool,
        confirmed: bool,
    },
    ContainerStats {
        id: String,
    },
    ContainerAction {
        id: String,
        action: ContainerAction,
        confirmed: bool,
    },
    ImageRemove {
        id: String,
        confirmed: bool,
    },
    Processes,
    ProcessDetails {
        pid: u32,
    },
    Signal {
        pid: u32,
        start_ticks: String,
        boot_id: String,
        signal: ProcessSignal,
        confirmed: bool,
    },
    Ports,
    Services {
        scope: Scope,
    },
    ServiceDetails {
        scope: Scope,
        unit: String,
    },
    ServiceAction {
        scope: Scope,
        unit: String,
        action: ServiceAction,
        confirmed: bool,
    },
    Probe {
        location: ProbeLocation,
        target: String,
        port: u16,
    },
}
impl Request {
    pub fn action(&self) -> Option<(String, String)> {
        Some(match self {
            Self::ContainerAction { id, action, .. } => {
                (format!("container_{}", action.name()), id.clone())
            }
            Self::ImageRemove { id, .. } => ("image_remove".into(), id.clone()),
            Self::Signal { pid, signal, .. } => (signal.name().into(), pid.to_string()),
            Self::ServiceAction {
                scope,
                unit,
                action,
                ..
            } => (format!("service_{scope:?}_{}", action.name()), unit.clone()),
            _ => return None,
        })
    }
    pub fn command(&self) -> Result<String, Error> {
        let body = match self {
            Self::Capabilities => include_str!("ops_capabilities.sh").into(),
            Self::Containers => "d container ls --all --no-trunc --format '{{json .}}'".into(),
            Self::Images => "d image ls --no-trunc --digests --format '{{json .}}'".into(),
            Self::ContainerDetails {
                id,
                reveal_env,
                confirmed,
            } => {
                container_id(id)?;
                if *reveal_env {
                    confirm(*confirmed)?;
                }
                format!(
                    "d container inspect --format '{{{{json .}}}}' {}",
                    quote(id)?
                )
            }
            Self::ContainerStats { id } => {
                container_id(id)?;
                format!(
                    "d stats --no-stream --format '{{{{json .}}}}' {}",
                    quote(id)?
                )
            }
            Self::ContainerAction {
                id,
                action,
                confirmed,
            } => {
                container_id(id)?;
                confirm(*confirmed)?;
                format!(
                    "d container {} {} {}",
                    action.name(),
                    if matches!(action, ContainerAction::Stop | ContainerAction::Restart) {
                        "--time 10"
                    } else {
                        ""
                    },
                    quote(id)?
                )
            }
            Self::ImageRemove { id, confirmed } => {
                image_id(id)?;
                confirm(*confirmed)?;
                format!("d image rm {}", quote(id)?)
            }
            Self::Processes => "ps -eo pid=,user=,pcpu=,pmem=,etimes=,comm= --sort=-pcpu".into(),
            Self::ProcessDetails { pid } => {
                pid_valid(*pid)?;
                format!(
                    "printf 'SDPROC1\\000'; cat /proc/sys/kernel/random/boot_id; printf '\\000'; cat /proc/{pid}/stat || {{ printf '进程已退出或无权读取，请刷新进程列表\\n' >&2; exit 66; }}; printf '\\000'; cat /proc/{pid}/status || {{ printf '进程已退出或无权读取，请刷新进程列表\\n' >&2; exit 66; }}; printf '\\000'; readlink /proc/{pid}/exe || printf '不可用（权限或进程已退出）'"
                )
            }
            Self::Signal {
                pid,
                start_ticks,
                boot_id,
                signal,
                confirmed,
            } => {
                pid_valid(*pid)?;
                confirm(*confirmed)?;
                if start_ticks.parse::<u64>().is_err()
                    || boot_id.len() != 36
                    || !boot_id.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-')
                {
                    return Err(Error::Validation("进程启动标识无效，请重新读取详情"));
                }
                format!(
                    "exec python3 -c {} {pid} {} {} {}",
                    quote(include_str!("ops_signal.py").trim())?,
                    quote(start_ticks)?,
                    quote(boot_id)?,
                    signal.name()
                )
            }
            Self::Ports => "ss -H -lntup".into(),
            Self::Services { scope } => {
                format!(
                    "test -d /run/systemd/system || {{ printf '此系统未运行 systemd' >&2; exit 78; }}; systemctl {} --no-ask-password --no-pager --plain --full --no-legend list-units --all --type=service || exit $?; printf '\\000'; systemctl {} --no-ask-password --no-pager --no-legend list-unit-files --type=service",
                    scope.flag(),
                    scope.flag()
                )
            }
            Self::ServiceDetails { scope, unit } => {
                unit_name(unit)?;
                format!(
                    "systemctl {} --no-ask-password --no-pager show --property=Id,LoadState,ActiveState,SubState,UnitFileState,Description,MainPID,ExecMainStatus,FragmentPath,ActiveEnterTimestamp -- {}",
                    scope.flag(),
                    quote(unit)?
                )
            }
            Self::ServiceAction {
                scope,
                unit,
                action,
                confirmed,
            } => {
                unit_name(unit)?;
                confirm(*confirmed)?;
                format!(
                    "systemctl {} --no-ask-password --no-pager {} -- {}",
                    scope.flag(),
                    action.name(),
                    quote(unit)?
                )
            }
            Self::Probe { target, port, .. } => {
                target_valid(target, *port)?;
                format!(
                    "exec python3 -c {} {} {port}",
                    quote(
                        "import socket,sys,time,json; t=time.monotonic(); s=socket.create_connection((sys.argv[1],int(sys.argv[2])),3); s.close(); print(json.dumps({'reachable':True,'milliseconds':round((time.monotonic()-t)*1000,2)}))"
                    )?,
                    quote(target)?
                )
            }
        };
        Ok(format!("{PRELUDE}{body}"))
    }
}
pub fn pid_valid(pid: u32) -> Result<(), Error> {
    if !(2..=i32::MAX as u32).contains(&pid) {
        return Err(Error::Validation(
            "PID 须为 2–2147483647，不接受进程组或 PID 1",
        ));
    }
    Ok(())
}
pub fn target_valid(target: &str, port: u16) -> Result<(), Error> {
    if port == 0
        || target.is_empty()
        || target.len() > 253
        || target.starts_with('-')
        || !target
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b".-:_%".contains(&b))
    {
        return Err(Error::Validation(
            "连通性目标须为明确 IP/域名和 1–65535 端口",
        ));
    }
    Ok(())
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum LogSource {
    Container { id: String },
    File { path: String },
    Service { scope: Scope, unit: String },
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LogInput {
    pub source: LogSource,
    pub lines: u16,
    pub follow: bool,
}
impl LogInput {
    pub fn command(&self) -> Result<String, Error> {
        if !(1..=5000).contains(&self.lines) {
            return Err(Error::Validation("日志读取范围须为 1–5000 行"));
        }
        let body = match &self.source {
            LogSource::Container { id } => {
                container_id(id)?;
                format!(
                    "exec docker --host unix://$sd_socket logs --timestamps --tail {} {} {}",
                    self.lines,
                    if self.follow { "--follow" } else { "" },
                    quote(id)?
                )
            }
            LogSource::File { path } => {
                crate::files::remote_absolute(path)?;
                let p = quote(path)?;
                format!(
                    "test -f {p} && test -r {p} || {{ printf '日志文件不存在、不是普通文件或无读取权限' >&2; exit 77; }}; exec tail -n {} {} -- {p}",
                    self.lines,
                    if self.follow { "-F" } else { "" }
                )
            }
            LogSource::Service { scope, unit } => {
                unit_name(unit)?;
                format!(
                    "exec journalctl {} --no-pager --output=short-iso --lines {} {} --unit {}",
                    scope.flag(),
                    self.lines,
                    if self.follow { "--follow" } else { "" },
                    quote(unit)?
                )
            }
        };
        Ok(format!("{PRELUDE}{body}"))
    }
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Response {
    pub success: bool,
    pub code: Option<String>,
    pub message: Option<String>,
    pub records: Vec<Value>,
    pub detail: Option<Value>,
}
impl Response {
    pub fn records(records: Vec<Value>) -> Self {
        Self {
            success: true,
            code: None,
            message: None,
            records,
            detail: None,
        }
    }
    pub fn detail(detail: Value) -> Self {
        Self {
            detail: Some(detail),
            ..Self::records(vec![])
        }
    }
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Feedback {
    pub at: u64,
    pub host_id: String,
    pub operation: String,
    pub target: String,
    pub outcome: String,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogSession {
    pub id: String,
    pub session_id: String,
    pub host_id: String,
}
#[derive(Serialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum LogEvent {
    State {
        state: &'static str,
        code: Option<&'static str>,
        message: Option<String>,
    },
    Data {
        sequence: u64,
        stream: &'static str,
        data: Vec<u8>,
        at: u64,
    },
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContainerShell {
    pub id: String,
    pub bash: bool,
    pub confirmed: bool,
}
impl ContainerShell {
    pub fn command(&self) -> Result<String, Error> {
        container_id(&self.id)?;
        confirm(self.confirmed)?;
        Ok(format!(
            "{PRELUDE}exec docker --host unix://$sd_socket exec -it {} {}",
            quote(&self.id)?,
            if self.bash { "/bin/bash" } else { "/bin/sh" }
        ))
    }
}
