use serde::Deserialize;
use serverdeck_plugin_sdk::{
    ApiError,
    platform::quote,
    serde_json::{self, Value, json},
};
pub const PRELUDE: &str = "export LC_ALL=C; export PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin; unset DOCKER_HOST DOCKER_CONTEXT DOCKER_TLS_VERIFY DOCKER_CERT_PATH; sd_uid=$(id -u); sd_socket=/var/run/docker.sock; if test -S /run/user/$sd_uid/docker.sock; then sd_socket=/run/user/$sd_uid/docker.sock; fi; d() { command docker --host unix://$sd_socket \"$@\"; }; ";
const CAPABILITIES: &str = "if ! command -v docker >/dev/null 2>&1; then printf '{\"dockerInstalled\":false,\"dockerState\":\"absent\"}'; else sd_version=$(d version --format '{{json .}}') || exit; sd_os=$(d info --format '{{json .OperatingSystem}}') || sd_os=null; printf '{\"dockerVersion\":%s,\"dockerOperatingSystem\":%s}' \"$sd_version\" \"$sd_os\"; fi";
const DETAILS_FORMAT: &str = r#"{"Id":{{json .Id}},"Name":{{json .Name}},"Created":{{json .Created}},"Config":{"Image":{{json .Config.Image}}},"State":{{json .State}},"NetworkSettings":{"Ports":{{json .NetworkSettings.Ports}}},"Mounts":{{json .Mounts}},"HostConfig":{"RestartPolicy":{{json .HostConfig.RestartPolicy}}}}"#;
const ENVIRONMENT_FORMAT: &str = r#"{"Id":{{json .Id}},"Config":{"Env":{{json .Config.Env}}}}"#;

fn inspect_command(format: &str) -> Result<String, ApiError> {
    // A fixed snapshot keeps preapproval exact; select the requested ID in the plugin.
    Ok(format!(
        "sd_ids=$(d container ls --all --quiet --no-trunc) || exit; if test -n \"$sd_ids\"; then set -f; d container inspect --format {} -- $sd_ids; fi",
        quote(format)?
    ))
}
fn invalid(message: &str) -> ApiError {
    ApiError::new("DOCKER_INPUT", message)
}
pub fn container_id(id: &str) -> Result<(), ApiError> {
    if id.len() != 64 || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(invalid("需要完整的 64 位容器 ID"));
    }
    Ok(())
}
pub fn image_id(id: &str) -> Result<(), ApiError> {
    container_id(id.strip_prefix("sha256:").unwrap_or(id))
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Action {
    Start,
    Stop,
    Restart,
    Remove,
}
#[derive(Clone, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Query {
    Capabilities,
    Containers,
    Images,
    ComposeProjects,
    ComposeServices {
        project: String,
    },
    ComposeAction {
        project: String,
        action: crate::compose::Action,
        confirmed: bool,
    },
    ContainerDetails {
        id: String,
        reveal_env: bool,
    },
    ContainerStats {
        id: String,
    },
    ContainerAction {
        id: String,
        action: Action,
        confirmed: bool,
    },
    ContainerMaintenance {
        action: crate::maintenance::Action,
        confirmed: bool,
    },
    ImageRemove {
        id: String,
        confirmed: bool,
    },
}
fn confirm(value: bool) -> Result<(), ApiError> {
    if !value {
        return Err(invalid("此操作需要明确确认目标"));
    }
    Ok(())
}
impl Query {
    pub fn command(&self) -> Result<String, ApiError> {
        let body = match self {
            Self::Capabilities => CAPABILITIES.into(),
            Self::Containers => "d container ls --all --no-trunc --format '{{json .}}'".into(),
            Self::Images => "d image ls --all --no-trunc --digests --format '{{json .}}'".into(),
            Self::ComposeProjects => crate::compose::PROJECTS.into(),
            Self::ComposeServices { project } => {
                crate::compose::project_name(project)?;
                return crate::compose::services_command();
            }
            Self::ComposeAction { .. } => {
                return Err(invalid("Compose 变更必须先重新查询真实项目配置"));
            }
            Self::ContainerDetails { id, reveal_env } => {
                container_id(id)?;
                inspect_command(if *reveal_env {
                    ENVIRONMENT_FORMAT
                } else {
                    DETAILS_FORMAT
                })?
            }
            Self::ContainerStats { id } => {
                container_id(id)?;
                "d stats --all --no-stream --no-trunc --format '{{json .}}'".into()
            }
            Self::ContainerAction {
                id,
                action,
                confirmed,
            } => {
                container_id(id)?;
                confirm(*confirmed)?;
                let name = match action {
                    Action::Start => "start",
                    Action::Stop => "stop --time 10",
                    Action::Restart => "restart --time 10",
                    Action::Remove => "rm",
                };
                format!("d container {name} {}", quote(id)?)
            }
            Self::ContainerMaintenance { action, confirmed } => {
                confirm(*confirmed)?;
                return Ok(crate::maintenance::command(action));
            }
            Self::ImageRemove { id, confirmed } => {
                image_id(id)?;
                confirm(*confirmed)?;
                format!("d image rm {}", quote(id)?)
            }
        };
        Ok(format!("{PRELUDE}{body}"))
    }
    pub fn response(&self, text: &str) -> Result<Value, ApiError> {
        if let Self::ContainerMaintenance { action, .. } = self {
            return crate::maintenance::response(action, text);
        }
        if matches!(self, Self::ComposeProjects) {
            return crate::compose::projects(text);
        }
        if let Self::ComposeServices { project } = self {
            let services = crate::compose::services(text, project)?;
            return Ok(
                json!({"success":true,"records":[],"detail":{"composeProject":project,"services":services},"message":null,"code":null}),
            );
        }
        let format = || ApiError::new("DOCKER_FORMAT", "远端 Docker 输出格式无效");
        let mut rows = vec![];
        let mut detail = Value::Null;
        match self {
            Self::Containers
            | Self::Images
            | Self::ContainerStats { .. }
            | Self::ContainerDetails { .. } => {
                for line in text.lines().filter(|l| !l.trim().is_empty()) {
                    if rows.len() >= 10000 {
                        return Err(format());
                    }
                    let row: Value = serde_json::from_str(line).map_err(|_| format())?;
                    if !row.is_object() {
                        return Err(format());
                    }
                    rows.push(row);
                }
                match self {
                    Self::ContainerDetails { id, reveal_env } => {
                        let v = rows
                            .iter()
                            .find(|row| row["Id"].as_str() == Some(id))
                            .ok_or_else(|| {
                                ApiError::new("DOCKER_NOT_FOUND", "容器已不存在，请刷新列表")
                            })?;
                        let env = if *reveal_env {
                            v["Config"]["Env"].as_array().cloned().unwrap_or_default()
                        } else {
                            vec![]
                        };
                        detail = json!({"id":v["Id"],"name":v["Name"],"image":v["Config"]["Image"],"created":v["Created"],"state":v["State"],"environment":env,"environmentRevealed":reveal_env,"ports":v["NetworkSettings"]["Ports"],"mounts":v["Mounts"],"restartPolicy":v["HostConfig"]["RestartPolicy"]});
                        rows.clear();
                    }
                    Self::ContainerStats { id } => {
                        rows.retain(|row| row["ID"].as_str() == Some(id))
                    }
                    _ => (),
                }
            }
            Self::Capabilities => {
                let v: Value = serde_json::from_str(text.trim()).map_err(|_| format())?;
                detail = if v.get("dockerInstalled").is_some() {
                    v
                } else {
                    let version = v
                        .get("dockerVersion")
                        .filter(|value| value.is_object())
                        .ok_or_else(format)?;
                    let os = &v["dockerOperatingSystem"];
                    if !os.is_null() && !os.is_string() {
                        return Err(format());
                    }
                    json!({"dockerInstalled":true,"dockerState":if version["Server"].is_object(){"running"}else{"unavailable"},"dockerVersion":version,"dockerOperatingSystem":os})
                };
            }
            _ => (),
        }
        Ok(json!({"success":true,"code":null,"message":null,"records":rows,"detail":detail}))
    }
}
pub fn log_command(id: &str, lines: u16, follow: bool) -> Result<String, ApiError> {
    container_id(id)?;
    if !(1..=5000).contains(&lines) {
        return Err(invalid("日志范围须为 1–5000 行"));
    }
    Ok(format!(
        "{PRELUDE}exec docker --host unix://$sd_socket logs --timestamps --tail {lines} {} {}",
        if follow { "--follow" } else { "" },
        quote(id)?
    ))
}
pub fn shell_command(id: &str, bash: bool) -> Result<String, ApiError> {
    container_id(id)?;
    Ok(format!(
        "{PRELUDE}exec docker --host unix://$sd_socket exec -it {} {}",
        quote(id)?,
        if bash { "/bin/bash" } else { "/bin/sh" }
    ))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn capabilities_include_daemon_operating_system_and_reject_malformed_output() {
        let response = Query::Capabilities.response(&json!({"dockerVersion":{"Server":{"Version":"27.5.1","Os":"linux","Arch":"amd64"},"Client":{"Version":"28.5.1"}},"dockerOperatingSystem":"Ubuntu 24.04.3 LTS"}).to_string()).unwrap();
        assert_eq!(
            response["detail"]["dockerOperatingSystem"],
            "Ubuntu 24.04.3 LTS"
        );
        assert_eq!(response["detail"]["dockerState"], "running");
        let missing = Query::Capabilities
            .response(r#"{"dockerVersion":{"Server":null},"dockerOperatingSystem":null}"#)
            .unwrap();
        assert!(missing["detail"]["dockerOperatingSystem"].is_null());
        assert_eq!(missing["detail"]["dockerState"], "unavailable");
        assert_eq!(
            Query::Capabilities
                .response(r#"{"dockerInstalled":false,"dockerState":"absent"}"#)
                .unwrap()["detail"]["dockerInstalled"],
            false
        );
        for text in [
            "[]",
            "{}",
            r#"{"dockerVersion":{},"dockerOperatingSystem":{}}"#,
        ] {
            assert!(Query::Capabilities.response(text).is_err());
        }
        assert!(
            serde_json::from_value::<Query>(
                json!({"kind":"container_maintenance","action":"restart_all","confirmed":true})
            )
            .is_err()
        );
    }
    #[test]
    fn removed_tcp_queries_are_rejected_without_network_permission() {
        for location in ["local", "remote"] {
            assert!(
                serde_json::from_value::<Query>(json!({
                    "kind": "probe", "location": location, "target": "127.0.0.1", "port": 80
                }))
                .is_err()
            );
        }
        let manifest: Value = serde_json::from_str(include_str!("../../manifest.json")).unwrap();
        assert!(
            !manifest["permissions"]
                .as_array()
                .unwrap()
                .iter()
                .any(|permission| permission == "network.connect")
        );
    }
    #[test]
    fn package_preapproves_fixed_reads_without_approving_mutations() {
        let manifest: Value = serde_json::from_str(include_str!("../../manifest.json")).unwrap();
        let commands: Vec<serverdeck_plugin_sdk::platform::Command> =
            serde_json::from_value(manifest["preapprovedCommands"].clone()).unwrap();
        let expected = [
            Query::Capabilities,
            Query::Containers,
            Query::Images,
            Query::ContainerDetails {
                id: "a".repeat(64),
                reveal_env: false,
            },
            Query::ContainerDetails {
                id: "a".repeat(64),
                reveal_env: true,
            },
            Query::ContainerStats { id: "a".repeat(64) },
            Query::ComposeProjects,
            Query::ComposeServices {
                project: "shop".into(),
            },
        ]
        .iter()
        .map(|query| serverdeck_plugin_sdk::platform::Command::script(query.command().unwrap()))
        .collect::<Vec<_>>();
        assert_eq!(commands, expected);
        let id = "a".repeat(64);
        for query in [
            Query::ContainerAction {
                id: id.clone(),
                action: Action::Stop,
                confirmed: true,
            },
            Query::ImageRemove {
                id: id.clone(),
                confirmed: true,
            },
        ] {
            assert!(
                !commands.contains(&serverdeck_plugin_sdk::platform::Command::script(
                    query.command().unwrap()
                ))
            );
        }
        for reveal_env in [false, true] {
            assert!(
                commands.contains(&serverdeck_plugin_sdk::platform::Command::script(
                    Query::ContainerDetails {
                        id: "b".repeat(64),
                        reveal_env
                    }
                    .command()
                    .unwrap()
                ))
            );
        }
        assert!(
            commands.contains(&serverdeck_plugin_sdk::platform::Command::script(
                Query::ContainerStats { id: "b".repeat(64) }
                    .command()
                    .unwrap()
            ))
        );
        for command in [
            log_command(&id, 200, true).unwrap(),
            shell_command(&id, false).unwrap(),
        ] {
            assert!(!commands.contains(&serverdeck_plugin_sdk::platform::Command::script(command)));
        }
        for action in [
            crate::maintenance::Action::RestartExited,
            crate::maintenance::Action::ClearLogs,
        ] {
            assert!(
                Query::ContainerMaintenance {
                    action: action.clone(),
                    confirmed: false
                }
                .command()
                .is_err()
            );
            let command = Query::ContainerMaintenance {
                action,
                confirmed: true,
            }
            .command()
            .unwrap();
            assert!(!commands.contains(&serverdeck_plugin_sdk::platform::Command::script(command)));
        }
    }
    #[test]
    fn targets_and_confirmation_are_enforced() {
        for id in ["short", "-x", "a; rm -rf /"] {
            assert!(container_id(id).is_err());
            assert!(
                Query::ContainerDetails {
                    id: id.into(),
                    reveal_env: false
                }
                .command()
                .is_err()
            );
            assert!(Query::ContainerStats { id: id.into() }.command().is_err());
        }
        let id = "a".repeat(64);
        assert!(
            Query::ImageRemove {
                id: id.clone(),
                confirmed: false
            }
            .command()
            .is_err()
        );
        let cmd = Query::ContainerAction {
            id,
            action: Action::Remove,
            confirmed: true,
        }
        .command()
        .unwrap();
        assert!(cmd.contains("d container rm"));
        assert!(!cmd.contains("--force"));
        assert!(!cmd.contains("--volumes"));
    }
    #[test]
    fn detail_snapshots_select_only_the_requested_container_and_load_environment_on_demand() {
        let id = "a".repeat(64);
        let other = "b".repeat(64);
        let output = format!(
            "{}\n{}\n",
            json!({"Id":other,"Config":{"Env":["OTHER=private"]}}),
            json!({"Id":id,"Name":"/selected","Config":{"Image":"selected-image","Env":["KEY=secret"]}})
        );
        let q = Query::ContainerDetails {
            id: id.clone(),
            reveal_env: false,
        };
        let v = q.response(&output).unwrap();
        assert_eq!(v["detail"]["id"], id);
        assert_eq!(v["detail"]["name"], "/selected");
        assert_eq!(v["records"], json!([]));
        assert!(!v.to_string().contains("secret"));
        assert!(!v.to_string().contains("private"));
        assert_eq!(v["detail"]["environment"], json!([]));
        assert!(!q.command().unwrap().contains(".Config.Env"));
        let reveal = Query::ContainerDetails {
            id,
            reveal_env: true,
        };
        assert!(reveal.command().unwrap().contains(".Config.Env"));
        let v = reveal.response(&output).unwrap();
        assert_eq!(v["detail"]["environment"], json!(["KEY=secret"]));
        assert_eq!(v["detail"]["environmentRevealed"], true);
        assert!(!v.to_string().contains("private"));
        assert!(q.response("bad json").is_err());
        assert!(q.response("[]").is_err());
        assert_eq!(q.response("").unwrap_err().code, "DOCKER_NOT_FOUND");
        assert_eq!(
            q.response(&json!({"Id":other}).to_string())
                .unwrap_err()
                .code,
            "DOCKER_NOT_FOUND"
        );
    }
    #[test]
    fn resource_snapshots_match_full_container_ids() {
        let id = "a".repeat(64);
        let output = format!(
            "{}\n{}",
            json!({"ID":"b".repeat(64),"CPUPerc":"99%"}),
            json!({"ID":id,"CPUPerc":"12.34%"})
        );
        let q = Query::ContainerStats { id };
        let value = q.response(&output).unwrap();
        assert_eq!(value["records"].as_array().unwrap().len(), 1);
        assert_eq!(value["records"][0]["CPUPerc"], "12.34%");
        assert!(
            q.response("").unwrap()["records"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        assert!(q.response("broken").is_err());
    }
}
