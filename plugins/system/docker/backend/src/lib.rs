use serverdeck_plugin_sdk::{
    ApiError,
    backend::{Action, Context, Runtime},
    platform::{Command, Request},
    serde_json::{self, Value, json},
};
mod docker;
std::thread_local! {static RUNTIME:std::cell::RefCell<Runtime>=std::cell::RefCell::new(Runtime::new(dispatch));}
fn dispatch(context: Context, action: String, input: Value) -> Action {
    Box::pin(async move {
        let host = input["hostId"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or_else(|| ApiError::new("HOST", "请选择主机"))?
            .to_owned();
        match action.as_str() {
            "query" => {
                let query: docker::Query = serde_json::from_value(input["request"].clone())
                    .map_err(|_| ApiError::new("INPUT", "Docker 请求无效"))?;
                if let docker::Query::Probe {
                    location,
                    target,
                    port,
                } = &query
                {
                    if location == "local" {
                        docker::target_valid(target, *port)?;
                        let detail = context
                            .request(Request::TcpConnect {
                                target: target.clone(),
                                port: *port,
                            })
                            .await?;
                        Ok(
                            json!({"success":true,"code":null,"message":null,"records":[],"detail":detail}),
                        )
                    } else {
                        execute(&context, &host, &query).await
                    }
                } else {
                    execute(&context, &host, &query).await
                }
            }
            "logs" => {
                let id = input["source"]["id"]
                    .as_str()
                    .ok_or_else(|| ApiError::new("INPUT", "日志容器无效"))?;
                let lines = input["lines"]
                    .as_u64()
                    .and_then(|v| u16::try_from(v).ok())
                    .ok_or_else(|| ApiError::new("INPUT", "日志行数无效"))?;
                let command =
                    docker::log_command(id, lines, input["follow"].as_bool().unwrap_or(false))?;
                context
                    .request(Request::StreamOpen {
                        host_id: host,
                        command: Command::script(command),
                    })
                    .await
            }
            "shell" => {
                let id = input["id"]
                    .as_str()
                    .ok_or_else(|| ApiError::new("INPUT", "终端容器无效"))?;
                context
                    .request(Request::Terminal {
                        host_id: host,
                        command: Command::script(docker::shell_command(
                            id,
                            input["bash"].as_bool().unwrap_or(false),
                        )?),
                    })
                    .await
            }
            _ => Err(ApiError::new("ACTION", "未知 Docker 动作")),
        }
    })
}
async fn execute(context: &Context, host: &str, query: &docker::Query) -> Result<Value, ApiError> {
    let result = context
        .execute(host, Command::script(query.command()?))
        .await?
        .checked()?;
    let mut response = query.response(&result.stdout)?;
    if !result.stderr.is_empty() {
        response["message"] = json!(result.stderr);
    }
    Ok(response)
}
fn handle(opcode: i32, payload: Value) -> Value {
    RUNTIME.with_borrow_mut(|runtime| runtime.handle(opcode, payload))
}
serverdeck_plugin_sdk::export_plugin!(handle);
