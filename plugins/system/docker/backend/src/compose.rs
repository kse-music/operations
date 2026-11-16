use serde::Deserialize;
use serverdeck_plugin_sdk::{
    ApiError,
    backend::Context,
    platform::{Command, Request, quote},
    serde_json::{self, Value, json},
};
use std::collections::{BTreeMap, BTreeSet};

use crate::docker::PRELUDE;

pub(crate) fn prelude() -> String {
    format!(
        "{PRELUDE}{}\n",
        include_str!("compose-cli.sh").replace("\r\n", "\n")
    )
}

pub fn projects_command() -> Result<String, ApiError> {
    Ok(format!(
        "{}sd_compose_select || exit; if test \"$sd_compose_legacy\" = true; then printf 'SERVERDECK_COMPOSE_V1\\n'; {}; else dc ls --all --format json; fi",
        prelude(),
        services_body()?
    ))
}
const FORMAT: &str = r#"{"ID":{{json .Id}},"Name":{{json .Name}},"Image":{{json .Config.Image}},"State":{{json .State.Status}},"ExitCode":{{json .State.ExitCode}},"Project":{{json (index .Config.Labels "com.docker.compose.project")}},"Service":{{json (index .Config.Labels "com.docker.compose.service")}},"OneOff":{{json (index .Config.Labels "com.docker.compose.oneoff")}},"WorkingDir":{{json (index .Config.Labels "com.docker.compose.project.working_dir")}},"ConfigFiles":{{json (index .Config.Labels "com.docker.compose.project.config_files")}}}"#;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Action {
    Start,
    Stop,
    Restart,
}

fn error(message: &str) -> ApiError {
    ApiError::new("COMPOSE_INPUT", message)
}

pub fn project_name(name: &str) -> Result<(), ApiError> {
    if name.is_empty()
        || name.len() > 255
        || !name.as_bytes()[0].is_ascii_lowercase() && !name.as_bytes()[0].is_ascii_digit()
        || !name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"_-".contains(&b))
    {
        return Err(error("Compose 项目名称无效，请刷新项目列表"));
    }
    Ok(())
}

pub fn services_command() -> Result<String, ApiError> {
    Ok(format!("{PRELUDE}{}", services_body()?))
}

fn services_body() -> Result<String, ApiError> {
    Ok(format!(
        "sd_ids=$(d container ls --all --quiet --no-trunc --filter label=com.docker.compose.project) || exit; if test -n \"$sd_ids\"; then set -f; d container inspect --format {} -- $sd_ids; fi",
        quote(FORMAT)?
    ))
}

pub fn projects(text: &str) -> Result<Value, ApiError> {
    if let Some(snapshot) = text.strip_prefix("SERVERDECK_COMPOSE_V1\n") {
        return legacy_projects(snapshot);
    }
    let rows: Vec<Value> = serde_json::from_str(text)
        .map_err(|_| ApiError::new("COMPOSE_FORMAT", "Compose 项目列表格式无效"))?;
    for row in &rows {
        project_name(
            row["Name"]
                .as_str()
                .ok_or_else(|| error("缺少 Compose 项目名称"))?,
        )?;
        if !row["Status"].is_string() || !row["ConfigFiles"].is_string() {
            return Err(ApiError::new("COMPOSE_FORMAT", "Compose 项目信息不完整"));
        }
    }
    Ok(json!({"success":true,"records":rows,"detail":null,"message":null,"code":null}))
}

fn legacy_projects(snapshot: &str) -> Result<Value, ApiError> {
    #[derive(Default)]
    struct Project {
        states: BTreeMap<String, usize>,
        files: BTreeSet<String>,
    }
    let mut projects = BTreeMap::<String, Project>::new();
    for (index, row) in serde_json::Deserializer::from_str(snapshot)
        .into_iter::<Value>()
        .enumerate()
    {
        if index >= 10000 {
            return Err(error("Compose 项目快照超过容器数量限制"));
        }
        let row = row.map_err(|_| error("Compose V1 项目快照格式无效"))?;
        if row["OneOff"]
            .as_str()
            .is_some_and(|s| s.eq_ignore_ascii_case("true"))
        {
            continue;
        }
        crate::docker::container_id(row["ID"].as_str().unwrap_or_default())?;
        let name = row["Project"]
            .as_str()
            .ok_or_else(|| error("缺少 Compose 项目名称"))?;
        project_name(name)?;
        let state = row["State"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or_else(|| error("Compose 容器状态无效"))?;
        let project = projects.entry(name.into()).or_default();
        *project.states.entry(state.into()).or_default() += 1;
        if let Some(files) = row["ConfigFiles"].as_str().filter(|s| !s.is_empty()) {
            project.files.insert(files.into());
        }
    }
    let rows = projects.into_iter().map(|(name, project)| {
        let status = project.states.into_iter().map(|(state, count)| format!("{state}({count})")).collect::<Vec<_>>().join(", ");
        json!({"Name":name,"Status":status,"ConfigFiles":project.files.into_iter().collect::<Vec<_>>().join("\n")})
    }).collect::<Vec<_>>();
    Ok(json!({"success":true,"records":rows,"detail":null,"message":null,"code":null}))
}

pub fn services(text: &str, project: &str) -> Result<Vec<Value>, ApiError> {
    project_name(project)?;
    let mut rows = Vec::new();
    for line in text.lines().filter(|line| !line.trim().is_empty()) {
        let row: Value = serde_json::from_str(line)
            .map_err(|_| ApiError::new("COMPOSE_FORMAT", "Compose 服务快照格式无效"))?;
        if !row.is_object() {
            return Err(ApiError::new("COMPOSE_FORMAT", "Compose 服务快照格式无效"));
        }
        if row["Project"].as_str() != Some(project)
            || row["OneOff"]
                .as_str()
                .is_some_and(|v| v.eq_ignore_ascii_case("true"))
        {
            continue;
        }
        crate::docker::container_id(row["ID"].as_str().unwrap_or_default())?;
        if !row["Service"].is_string() || !row["State"].is_string() {
            return Err(ApiError::new("COMPOSE_FORMAT", "Compose 服务信息不完整"));
        }
        rows.push(row);
    }
    Ok(rows)
}

#[derive(Debug, PartialEq)]
pub(crate) struct Target {
    directory: String,
    files: Vec<String>,
}

fn path(value: &str) -> Result<String, ApiError> {
    if !value.starts_with('/') || value.len() > 4096 || value.chars().any(char::is_control) {
        return Err(error(
            "项目缺少有效的远端绝对路径，无法恢复原始 Compose 配置",
        ));
    }
    Ok(value.into())
}

pub(crate) fn target(rows: &[Value]) -> Result<Target, ApiError> {
    let mut selected = None;
    for row in rows {
        let directory = path(row["WorkingDir"].as_str().unwrap_or_default())?;
        let files = row["ConfigFiles"]
            .as_str()
            .unwrap_or_default()
            .split(',')
            .map(path)
            .collect::<Result<Vec<_>, _>>()?;
        if files.len() > 16 {
            return Err(error("Compose 配置文件超过 16 个，无法安全执行"));
        }
        let candidate = Target { directory, files };
        if selected.as_ref().is_some_and(|old| old != &candidate) {
            return Err(error(
                "同名项目的原始目录或配置文件不一致，请在终端核对后操作",
            ));
        }
        selected = Some(candidate);
    }
    selected.ok_or_else(|| ApiError::new("COMPOSE_NOT_FOUND", "项目已无普通服务容器，请刷新列表"))
}

pub(crate) fn command(project: &str, rows: &[Value], suffix: &str) -> Result<Command, ApiError> {
    project_name(project)?;
    let target = target(rows)?;
    let mut body = format!(
        "{}unset COMPOSE_FILE COMPOSE_PROJECT_NAME COMPOSE_PROFILES COMPOSE_ENV_FILES COMPOSE_DISABLE_ENV_FILE; cd {} || exit; set -- --project-name {} --project-directory {}; sd_compose_select || exit; if test \"$sd_compose_legacy\" = false; then set -- \"$@\" --profile '*'; fi",
        prelude(),
        quote(&target.directory)?,
        quote(project)?,
        quote(&target.directory)?
    );
    for file in &target.files {
        body.push_str(&format!("; set -- \"$@\" --file {}", quote(file)?));
    }
    let mut services = BTreeSet::new();
    let mut option_service = false;
    for row in rows {
        let service = row["Service"]
            .as_str()
            .filter(|s| {
                !s.is_empty()
                    && s.len() <= 255
                    && s.bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
            })
            .ok_or_else(|| error("Compose service 名称无效"))?;
        option_service |= service.starts_with('-');
        services.insert(quote(service)?);
    }
    let separator = if suffix == "start" { "" } else { " --" };
    let legacy = if suffix == "start" && option_service {
        "printf '%s\\n' 'Compose V1 无法安全启动以 - 开头的服务名，请在终端核对。' >&2; exit 2"
            .into()
    } else {
        format!(
            "sd_compose_exec \"$@\" {suffix}{separator} {}",
            services.into_iter().collect::<Vec<_>>().join(" ")
        )
    };
    body.push_str(&format!("; if test \"$sd_compose_legacy\" = true; then {legacy}; else sd_compose_exec \"$@\" {suffix}; fi"));
    Ok(Command::script(body))
}

async fn prepare(
    context: &Context,
    host: &str,
    project: &str,
) -> Result<(Context, Vec<Value>), ApiError> {
    project_name(project)?;
    let bound = context
        .request(Request::Host {
            host_id: host.into(),
        })
        .await?;
    let binding = bound["binding"]
        .as_str()
        .ok_or_else(|| ApiError::new("COMPOSE_BINDING", "无法绑定当前 SSH 主机配置"))?;
    let context = context.with_bindings(vec![binding.into()]);
    let result = context
        .execute(host, Command::script(services_command()?))
        .await?
        .checked()?;
    let rows = services(&result.stdout, project)?;
    Ok((context, rows))
}

pub async fn execute(
    context: &Context,
    host: &str,
    project: &str,
    action: &Action,
    confirmed: bool,
) -> Result<Value, ApiError> {
    if !confirmed {
        return Err(error("Compose 变更需要明确确认目标"));
    }
    let (context, rows) = prepare(context, host, project).await?;
    let suffix = match action {
        Action::Start => "start",
        Action::Stop => "stop --timeout 5",
        Action::Restart => "restart --timeout 5",
    };
    let result = context
        .execute(host, command(project, &rows, suffix)?)
        .await?
        .checked()?;
    Ok(json!({"success":true,"records":[],"detail":null,"code":null,"message":result.stderr}))
}

pub async fn logs(
    context: &Context,
    host: &str,
    project: &str,
    lines: u16,
    follow: bool,
) -> Result<Value, ApiError> {
    if !(1..=5000).contains(&lines) {
        return Err(error("日志范围须为 1–5000 行"));
    }
    let (context, rows) = prepare(context, host, project).await?;
    let suffix = format!(
        "logs --no-color --timestamps --tail {lines} {}",
        if follow { "--follow" } else { "" }
    );
    context
        .request(Request::StreamOpen {
            host_id: host.into(),
            command: crate::log_stream::command(command(project, &rows, &suffix)?)?,
        })
        .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore = "requires local WSL Python/sh; all Docker and Compose operations use isolated executables"]
    fn shell_cli_selection_covers_queries_config_actions_and_logs_without_retries() {
        use std::{
            io::Write,
            process::{Command as Process, Stdio},
        };
        let mut worker = row("shop");
        worker["ID"] = json!("b".repeat(64));
        worker["Service"] = json!("worker");
        let rows = [row("shop"), worker];
        let mut option_service = row("shop");
        option_service["Service"] = json!("--help");
        let scripts = json!({
            "prelude": PRELUDE,
            "projects": projects_command().unwrap(),
            "config": crate::startup::compose_command(false).args[1],
            "configRevealed": crate::startup::compose_command(true).args[1],
            "start": command("shop", &rows, "start").unwrap().args[1],
            "stop": command("shop", &rows, "stop --timeout 5").unwrap().args[1],
            "restart": command("shop", &rows, "restart --timeout 5").unwrap().args[1],
            "logs": command("shop", &rows, "logs --no-color --timestamps --tail 100 --follow").unwrap().args[1],
            "optionService": command("shop", &[option_service], "start").unwrap().args[1],
        });
        let mut process = Process::new("wsl")
            .args([
                "--exec",
                "python3",
                "-c",
                include_str!("compose-cli-fixture.py"),
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        process
            .stdin
            .take()
            .unwrap()
            .write_all(&serde_json::to_vec(&scripts).unwrap())
            .unwrap();
        let output = process.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn row(project: &str) -> Value {
        json!({"ID":"a".repeat(64),"Project":project,"Service":"web","State":"running","WorkingDir":"/srv/my app","ConfigFiles":"/srv/my app/compose.yaml,/srv/my app/override.yaml"})
    }
    #[test]
    fn snapshots_validate_and_isolate_projects_and_one_off_containers() {
        let a = row("shop");
        let mut oneoff = a.clone();
        oneoff["OneOff"] = json!("True");
        let text = format!("{}\n{}\n{}", a, row("other"), oneoff);
        assert_eq!(services(&text, "shop").unwrap(), vec![a]);
        assert!(services("broken", "shop").is_err());
        assert!(services("[]", "shop").is_err());
        assert!(services(&json!({"Project":"shop"}).to_string(), "shop").is_err());
        assert_eq!(projects("[]").unwrap()["records"], json!([]));
        assert!(projects("{}").is_err());
        assert!(projects(r#"[{"Name":"shop"}]"#).is_err());
    }
    #[test]
    fn commands_use_original_directory_ordered_files_and_quoted_paths() {
        let mut a = row("shop");
        a["WorkingDir"] = json!("/srv/app'$(touch injected)");
        let cmd = command("shop", &[a], "start").unwrap();
        assert!(cmd.args[1].contains("cd '/srv/app'\"'\"'$(touch injected)' || exit"));
        assert!(
            cmd.args[1]
                .find("--file '/srv/my app/compose.yaml'")
                .unwrap()
                < cmd.args[1]
                    .find("--file '/srv/my app/override.yaml'")
                    .unwrap()
        );
        assert!(cmd.args[1].contains("start 'web'"));
        assert!(!cmd.args[1].contains("up -d"));
        assert!(command("-shop", &[row("shop")], "start").is_err());
        assert!(command("shop;id", &[row("shop")], "start").is_err());
        assert!(command("shop", &[], "start").is_err());
        let mut b = row("shop");
        b["WorkingDir"] = json!("/other");
        assert!(command("shop", &[row("shop"), b], "stop").is_err());
        let mut b = row("shop");
        b["ConfigFiles"] = json!("relative.yaml");
        assert!(command("shop", &[b], "start").is_err());
        let mut b = row("shop");
        b["Service"] = json!("--help");
        assert!(command("shop", &[b], "start").is_ok());
    }

    #[test]
    fn no_project_mutations_are_preapproved() {
        let manifest: Value = serde_json::from_str(include_str!("../../manifest.json")).unwrap();
        let approved = manifest["preapprovedCommands"].as_array().unwrap();
        for suffix in ["start", "stop --timeout 5", "restart --timeout 5"] {
            let value =
                serde_json::to_value(command("shop", &[row("shop")], suffix).unwrap()).unwrap();
            assert!(!approved.contains(&value));
        }
    }

    #[test]
    fn v1_projects_aggregate_real_container_labels_and_exclude_one_offs() {
        let mut a = row("shop");
        a["ConfigFiles"] = json!("/srv/compose.yaml");
        let mut b = a.clone();
        b["ID"] = json!("b".repeat(64));
        b["State"] = json!("exited");
        let mut oneoff = row("temporary");
        oneoff["OneOff"] = json!("True");
        let value = projects(&format!("SERVERDECK_COMPOSE_V1\n{a}\n{b}\n{oneoff}\n")).unwrap();
        assert_eq!(
            value["records"],
            json!([{"Name":"shop","Status":"exited(1), running(1)","ConfigFiles":"/srv/compose.yaml"}])
        );
        assert_eq!(
            projects("SERVERDECK_COMPOSE_V1\n").unwrap()["records"],
            json!([])
        );
        assert!(projects("SERVERDECK_COMPOSE_V1\nbad json").is_err());
        a["Project"] = json!("bad;name");
        assert!(projects(&format!("SERVERDECK_COMPOSE_V1\n{a}")).is_err());
    }
}
