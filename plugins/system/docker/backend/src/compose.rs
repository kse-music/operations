use serde::Deserialize;
use serverdeck_plugin_sdk::{
    ApiError,
    backend::Context,
    platform::{Command, Request, quote},
    serde_json::{self, Value, json},
};

use crate::docker::PRELUDE;

pub const PROJECTS: &str = "d compose ls --all --format json";
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
    Ok(format!(
        "{PRELUDE}sd_ids=$(d container ls --all --quiet --no-trunc --filter label=com.docker.compose.project) || exit; if test -n \"$sd_ids\"; then set -f; d container inspect --format {} -- $sd_ids; fi",
        quote(FORMAT)?
    ))
}

pub fn projects(text: &str) -> Result<Value, ApiError> {
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
        "{PRELUDE}unset COMPOSE_FILE COMPOSE_PROJECT_NAME COMPOSE_PROFILES COMPOSE_ENV_FILES COMPOSE_DISABLE_ENV_FILE; cd {} || exit; exec docker --host unix://$sd_socket compose --project-name {} --project-directory {} --profile '*'",
        quote(&target.directory)?,
        quote(project)?,
        quote(&target.directory)?
    );
    for file in &target.files {
        body.push_str(&format!(" --file {}", quote(file)?));
    }
    body.push(' ');
    body.push_str(suffix);
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
        assert!(cmd.args[1].contains(
            "--file '/srv/my app/compose.yaml' --file '/srv/my app/override.yaml' start"
        ));
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
}
