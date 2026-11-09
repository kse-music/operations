use serverdeck_plugin_sdk::{
    ApiError,
    backend::{Action, Context, Runtime},
    platform::{Command, Request},
    serde_json::{self, Value, json},
};
mod service;
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Input {
    host_id: String,
    target: service::ServiceTarget,
    config_path: String,
    action: service::NginxAction,
}
fn error(value: String) -> ApiError {
    ApiError::new("INPUT", value)
}
fn dispatch(context: Context, action: String, input: Value) -> Action {
    Box::pin(async move {
        let host = input["hostId"]
            .as_str()
            .ok_or_else(|| ApiError::new("HOST", "请选择主机"))?
            .to_owned();
        match action.as_str() {
            "nginx" => {
                let input: Input = serde_json::from_value(input)
                    .map_err(|_| ApiError::new("INPUT", "Nginx 请求无效"))?;
                let command =
                    service::nginx_command(&input.target, &input.config_path, input.action)
                        .map_err(error)?;
                let result = context
                    .execute(
                        input.host_id,
                        Command::script(format!("{}{command}", service::PRELUDE)),
                    )
                    .await?
                    .checked()?;
                Ok(
                    json!({"success":true,"records":[],"detail":{"output":result.stdout},"message":result.stderr,"code":null}),
                )
            }
            "containers" => {
                let result = context
                    .execute(
                        host,
                        Command::script(format!(
                            "{}d container ls --all --no-trunc --format '{{{{json .}}}}'",
                            service::PRELUDE
                        )),
                    )
                    .await?
                    .checked()?;
                let rows = result
                    .stdout
                    .lines()
                    .filter(|line| !line.trim().is_empty())
                    .map(serde_json::from_str::<Value>)
                    .collect::<std::result::Result<Vec<_>, _>>()
                    .map_err(|_| ApiError::new("FORMAT", "容器列表格式无效"))?;
                Ok(json!({"success":true,"records":rows,"detail":null,"message":null,"code":null}))
            }
            "mounts" => {
                let id = input["id"]
                    .as_str()
                    .ok_or_else(|| ApiError::new("INPUT", "请选择容器"))?;
                service::container_id(id).map_err(error)?;
                let result = context
                    .execute(
                        host,
                        Command::script(format!(
                            "{}d inspect --type container --format '{{{{json .Mounts}}}}' {}",
                            service::PRELUDE,
                            service::quote(id).map_err(error)?
                        )),
                    )
                    .await?
                    .checked()?;
                let mounts: Value = serde_json::from_str(&result.stdout)
                    .map_err(|_| ApiError::new("FORMAT", "挂载信息格式无效"))?;
                if !mounts.is_array() {
                    return Err(ApiError::new("FORMAT", "挂载信息格式无效"));
                }
                Ok(
                    json!({"success":true,"records":[],"detail":{"mounts":mounts},"message":null,"code":null}),
                )
            }
            "logs" => {
                let target: service::ServiceTarget =
                    serde_json::from_value(input["target"].clone())
                        .map_err(|_| ApiError::new("INPUT", "日志目标无效"))?;
                let command = service::log_command(
                    &target,
                    input["path"].as_str().unwrap_or("/var/log/nginx/error.log"),
                )
                .map_err(error)?;
                context
                    .request(Request::StreamOpen {
                        host_id: host,
                        command: Command::script(command),
                    })
                    .await
            }
            _ => Err(ApiError::new("ACTION", "未知 Nginx 动作")),
        }
    })
}
std::thread_local! {static RUNTIME:std::cell::RefCell<Runtime>=std::cell::RefCell::new(Runtime::new(dispatch));}
fn handle(opcode: i32, payload: Value) -> Value {
    RUNTIME.with_borrow_mut(|runtime| runtime.handle(opcode, payload))
}
serverdeck_plugin_sdk::export_plugin!(handle);
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn service_requests_use_only_platform_primitives_and_reject_arbitrary_sql_or_commands() {
        let mut runtime = Runtime::new(dispatch);
        let call=runtime.handle(6,json!({"action":"nginx","input":{"hostId":"owned","target":{"kind":"host"},"configPath":"/etc/nginx/nginx.conf","action":"reload"}}));
        assert_eq!(call["result"]["request"]["operation"]["kind"], "platform");
        let request = &call["result"]["request"]["operation"]["request"];
        assert_eq!(request["kind"], "execute");
        assert_eq!(request["hostId"], "owned");
        assert!(
            request["command"]["args"][1]
                .as_str()
                .unwrap()
                .contains("nginx -t -c")
        );
        assert_eq!(
            runtime.handle(
                6,
                json!({"action":"nginx","input":{"hostId":"owned","command":"unsafe"}})
            )["error"]["code"],
            "INPUT"
        );
    }
    #[test]
    fn command_failures_and_output_limits_are_not_reported_as_success() {
        for (state, code, truncated, expected) in [
            ("failed", 1, false, "REMOTE_COMMAND"),
            ("completed", 0, true, "OUTPUT_LIMIT"),
        ] {
            let mut runtime = Runtime::new(dispatch);
            let call=runtime.handle(6,json!({"action":"nginx","input":{"hostId":"owned","target":{"kind":"host"},"configPath":"/etc/nginx/nginx.conf","action":"test"}}));
            let reply=runtime.handle(7,json!({"hostResponse":{"requestId":call["result"]["request"]["requestId"],"result":{"state":state,"exitCode":code,"truncated":truncated,"stdout":"","stderr":"failed","message":null},"error":null}}));
            assert_eq!(reply["error"]["code"], expected);
        }
    }
}
