use serde::Deserialize;
use serverdeck_plugin_sdk::{
    ApiError,
    platform::quote,
    serde_json::{self, Value, json},
};
pub const PRELUDE: &str = "export LC_ALL=C; export PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin; unset DOCKER_HOST DOCKER_CONTEXT DOCKER_TLS_VERIFY DOCKER_CERT_PATH; sd_uid=$(id -u); sd_socket=/var/run/docker.sock; if test -S /run/user/$sd_uid/docker.sock; then sd_socket=/run/user/$sd_uid/docker.sock; fi; d() { command docker --host unix://$sd_socket \"$@\"; }; ";
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
        action: Action,
        confirmed: bool,
    },
    ImageRemove {
        id: String,
        confirmed: bool,
    },
    Probe {
        location: String,
        target: String,
        port: u16,
    },
}
fn confirm(value: bool) -> Result<(), ApiError> {
    if !value {
        return Err(invalid("此操作需要明确确认目标"));
    }
    Ok(())
}
pub fn target_valid(target: &str, port: u16) -> Result<(), ApiError> {
    if port == 0
        || target.is_empty()
        || target.len() > 253
        || target.starts_with('-')
        || !target
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b".-:_%".contains(&b))
    {
        return Err(invalid("目标须为 IP/域名和 1–65535 端口"));
    }
    Ok(())
}
impl Query {
    pub fn command(&self) -> Result<String, ApiError> {
        let body=match self{
   Self::Capabilities=>"if ! command -v docker >/dev/null 2>&1; then printf '{\"dockerInstalled\":false,\"dockerState\":\"absent\"}'; else d version --format '{{json .}}'; fi".into(),
   Self::Containers=>"d container ls --all --no-trunc --format '{{json .}}'".into(),
   Self::Images=>"d image ls --all --no-trunc --digests --format '{{json .}}'".into(),
   Self::ContainerDetails{id,reveal_env,confirmed}=>{container_id(id)?;if *reveal_env{confirm(*confirmed)?;}format!("d container inspect --format '{{{{json .}}}}' {}",quote(id)?)},
   Self::ContainerStats{id}=>{container_id(id)?;format!("d stats --no-stream --format '{{{{json .}}}}' {}",quote(id)?)},
   Self::ContainerAction{id,action,confirmed}=>{container_id(id)?;confirm(*confirmed)?;let name=match action{Action::Start=>"start",Action::Stop=>"stop --time 10",Action::Restart=>"restart --time 10",Action::Remove=>"rm"};format!("d container {name} {}",quote(id)?)},
   Self::ImageRemove{id,confirmed}=>{image_id(id)?;confirm(*confirmed)?;format!("d image rm {}",quote(id)?)},
   Self::Probe{location,target,port}=>{target_valid(target,*port)?;if location!="remote"{return Err(invalid("远程命令只能从远端检测"));}format!("exec python3 -c {} {} {port}",quote("import socket,sys,time,json; t=time.monotonic(); s=socket.create_connection((sys.argv[1],int(sys.argv[2])),3); s.close(); print(json.dumps({'reachable':True,'milliseconds':round((time.monotonic()-t)*1000,2)}))")?,quote(target)?)},
  };
        Ok(format!("{PRELUDE}{body}"))
    }
    pub fn response(&self, text: &str) -> Result<Value, ApiError> {
        let format = || ApiError::new("DOCKER_FORMAT", "远端 Docker 输出格式无效");
        let mut rows = vec![];
        let mut detail = Value::Null;
        match self {
            Self::Containers | Self::Images | Self::ContainerStats { .. } => {
                for line in text.lines().filter(|l| !l.trim().is_empty()) {
                    if rows.len() >= 10000 {
                        return Err(format());
                    }
                    rows.push(serde_json::from_str::<Value>(line).map_err(|_| format())?);
                }
            }
            Self::Capabilities => {
                let v: Value = serde_json::from_str(text.trim()).map_err(|_| format())?;
                detail = if v.get("dockerInstalled").is_some() {
                    v
                } else {
                    json!({"dockerInstalled":true,"dockerState":if v["Server"].is_object(){"running"}else{"unavailable"},"dockerVersion":v})
                };
            }
            Self::ContainerDetails { reveal_env, .. } => {
                let v: Value = serde_json::from_str(text.trim()).map_err(|_| format())?;
                if !v.is_object() {
                    return Err(format());
                }
                let env = v["Config"]["Env"]
                    .as_array()
                    .map(|items| {
                        items
                            .iter()
                            .map(|item| {
                                let text = item.as_str().unwrap_or("");
                                if *reveal_env {
                                    text.to_owned()
                                } else {
                                    format!(
                                        "{}=••••••",
                                        text.split_once('=').map(|(name, _)| name).unwrap_or(text)
                                    )
                                }
                            })
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default();
                detail = json!({"id":v["Id"],"name":v["Name"],"image":v["Config"]["Image"],"created":v["Created"],"state":v["State"],"environment":env,"environmentRevealed":reveal_env,"ports":v["NetworkSettings"]["Ports"],"mounts":v["Mounts"],"restartPolicy":v["HostConfig"]["RestartPolicy"]});
            }
            Self::Probe { .. } => {
                detail = serde_json::from_str(text.trim()).map_err(|_| format())?
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
    fn package_preapproves_only_the_three_fixed_page_queries() {
        let manifest: Value = serde_json::from_str(include_str!("../../manifest.json")).unwrap();
        let commands: Vec<serverdeck_plugin_sdk::platform::Command> =
            serde_json::from_value(manifest["preapprovedCommands"].clone()).unwrap();
        let expected = [Query::Capabilities, Query::Containers, Query::Images]
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
                id,
                confirmed: true,
            },
        ] {
            assert!(
                !commands.contains(&serverdeck_plugin_sdk::platform::Command::script(
                    query.command().unwrap()
                ))
            );
        }
    }
    #[test]
    fn targets_and_confirmation_are_enforced() {
        for id in ["short", "-x", "a; rm -rf /"] {
            assert!(container_id(id).is_err());
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
    fn environment_is_redacted_in_the_plugin() {
        let q = Query::ContainerDetails {
            id: "a".repeat(64),
            reveal_env: false,
            confirmed: false,
        };
        let v = q
            .response(r#"{"Id":"x","Config":{"Env":["KEY=secret"]}}"#)
            .unwrap();
        assert!(!v.to_string().contains("secret"));
        assert_eq!(v["detail"]["environment"][0], "KEY=••••••");
        assert!(q.response("bad json").is_err());
    }
}
