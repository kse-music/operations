use crate::Error;
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const PRELUDE: &str = "export LC_ALL=C; export PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin; export SYSTEMD_PAGER=cat SYSTEMD_COLORS=0; unset DOCKER_HOST DOCKER_CONTEXT DOCKER_TLS_VERIFY DOCKER_CERT_PATH; sd_uid=$(id -u); sd_socket=/var/run/docker.sock; if test -S /run/user/$sd_uid/docker.sock; then sd_socket=/run/user/$sd_uid/docker.sock; fi; d() { command docker --host unix://$sd_socket \"$@\"; }; ";
const PROCESS_DETAILS: &str = r#"printf 'SDPROC1\000'; cat /proc/sys/kernel/random/boot_id; printf '\000'; cat "/proc/$1/stat" || { printf '进程已退出或无权读取，请刷新进程列表\n' >&2; exit 66; }; printf '\000'; cat "/proc/$1/status" || { printf '进程已退出或无权读取，请刷新进程列表\n' >&2; exit 66; }; printf '\000'; readlink "/proc/$1/exe" || printf '不可用（权限或进程已退出）'"#;
const CONTAINER_DETAILS: &str = r#"d container inspect --format '{{json .}}' -- "$1""#;
const CONTAINER_STATS: &str = r#"d stats --no-stream --format '{{json .}}' -- "$1""#;
const SERVICE_DETAILS: &str = r#"systemctl "$1" --no-ask-password --no-pager show --property=Id,LoadState,ActiveState,SubState,UnitFileState,Description,MainPID,ExecMainStatus,FragmentPath,ActiveEnterTimestamp -- "$2""#;
pub const SYSTEM_JOURNAL: &str = "exec journalctl --system --no-pager --quiet -n 100 -o short-iso";
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
    Diagnostic {
        tool: ReadDiagnostic,
    },
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
    pub fn platform_command(&self) -> Result<serverdeck_plugin_sdk::platform::Command, Error> {
        use serverdeck_plugin_sdk::platform::Command;
        let (script, args) = match self {
            Self::ProcessDetails { pid } => {
                pid_valid(*pid)?;
                (PROCESS_DETAILS, vec![pid.to_string()])
            }
            Self::ContainerDetails {
                id,
                reveal_env: false,
                ..
            } => {
                container_id(id)?;
                (CONTAINER_DETAILS, vec![id.clone()])
            }
            Self::ContainerStats { id } => {
                container_id(id)?;
                (CONTAINER_STATS, vec![id.clone()])
            }
            Self::ServiceDetails { scope, unit } => {
                unit_name(unit)?;
                (SERVICE_DETAILS, vec![scope.flag().into(), unit.clone()])
            }
            _ => return Ok(Command::script(self.command()?)),
        };
        let mut command = Command::script(format!("{PRELUDE}{script}")).arg("serverdeck-read");
        command.args.extend(args);
        Ok(command)
    }
    pub fn command(&self) -> Result<String, Error> {
        let body = match self {
            Self::Diagnostic { tool } => tool.command().into(),
            Self::Capabilities => include_str!("ops_capabilities.sh").replace("\r\n", "\n"),
            Self::Containers => "d container ls --all --no-trunc --format '{{json .}}'".into(),
            Self::Images => "d image ls --all --no-trunc --digests --format '{{json .}}'".into(),
            Self::ContainerDetails {
                id,
                reveal_env,
                confirmed,
            } => {
                container_id(id)?;
                if *reveal_env {
                    confirm(*confirmed)?;
                } else {
                    return self.platform_command()?.shell().map_err(Into::into);
                }
                format!(
                    "d container inspect --format '{{{{json .}}}}' {}",
                    quote(id)?
                )
            }
            Self::ContainerStats { .. } => {
                return self.platform_command()?.shell().map_err(Into::into);
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
            Self::ProcessDetails { .. } => {
                return self.platform_command()?.shell().map_err(Into::into);
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
            Self::ServiceDetails { .. } => {
                return self.platform_command()?.shell().map_err(Into::into);
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
#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ReadDiagnostic {
    Uptime,
    Memory,
    Disk,
}
impl ReadDiagnostic {
    pub fn command(self) -> &'static str {
        match self {
            Self::Uptime => "uptime",
            Self::Memory => "free -m",
            Self::Disk => "df -h",
        }
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

#[cfg(test)]
#[test]
fn task_read_preapproval_manifest_matches_exact_generated_queries() {
    use serverdeck_plugin_sdk::platform::Command;
    let mut commands = vec![];
    for request in [
        Request::Diagnostic {
            tool: ReadDiagnostic::Uptime,
        },
        Request::Diagnostic {
            tool: ReadDiagnostic::Memory,
        },
        Request::Diagnostic {
            tool: ReadDiagnostic::Disk,
        },
        Request::Capabilities,
        Request::Containers,
        Request::Images,
        Request::Processes,
        Request::Ports,
        Request::Services {
            scope: Scope::System,
        },
        Request::Services { scope: Scope::User },
    ] {
        commands.push(Command::script(request.command().unwrap()));
    }
    let metrics = include_str!("metrics.sh").replace("\r\n", "\n");
    commands.push(Command::script(metrics.clone()));
    commands.push(Command::script(format!("sleep 0.25;{metrics}")));
    commands.push(Command::script(format!("{PRELUDE}{SYSTEM_JOURNAL}")));
    for request in [
        Request::ProcessDetails { pid: 835251 },
        Request::ContainerDetails {
            id: "a".repeat(64),
            reveal_env: false,
            confirmed: false,
        },
        Request::ContainerStats { id: "b".repeat(64) },
        Request::ServiceDetails {
            scope: Scope::System,
            unit: "app.service".into(),
        },
        Request::ServiceDetails {
            scope: Scope::User,
            unit: "app.service".into(),
        },
    ] {
        let concrete = request.platform_command().unwrap();
        let mut template = concrete.clone();
        let index = template.args.len() - 1;
        template.args[index] = match request {
            Request::ProcessDetails { .. } => "{{sd:uint:2:2147483647}}".into(),
            Request::ServiceDetails { .. } => "{{sd:identifier:256:.service}}".into(),
            _ => "{{sd:hex:64}}".into(),
        };
        assert!(template.matches_argument_template(&concrete));
        commands.push(template);
    }
    let (mut export, _, _) = crate::image_archive::command(
        &crate::image_archive::Archive::Export {
            id: "a".repeat(64),
            reference: "stock:1.0.0".into(),
            file_name: "image.tar".into(),
            confirmed: true,
        },
        "01234567-89ab-cdef-0123-456789abcdef",
    )
    .unwrap();
    export.args[3..].clone_from_slice(&[
        "{{sd:identifier:36:}}".into(),
        "{{sd:hex:64}}".into(),
        "{{sd:hex:64}}".into(),
        "{{sd:identifier:240:.tar}}".into(),
    ]);
    commands.push(export);
    let manifest: Value = serde_json::from_str(include_str!("../../manifest.json")).unwrap();
    assert_eq!(
        serde_json::to_value(commands).unwrap(),
        manifest["preapprovedCommands"]
    );
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
                remote_absolute(path)?;
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

fn remote_absolute(path: &str) -> Result<(), Error> {
    if !path.starts_with('/')
        || path.len() > 4096
        || path.contains('\0')
        || path.split('/').any(|part| part == "..")
    {
        return Err(Error::Validation("需要明确的远程绝对路径"));
    }
    Ok(())
}
