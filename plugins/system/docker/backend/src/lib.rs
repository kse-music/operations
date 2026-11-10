use serverdeck_plugin_sdk::{
    ApiError,
    backend::{Action, Context, Runtime},
    platform::{Command, Request},
    serde_json::{self, Value, json},
};
mod compose;
mod docker;
mod maintenance;
mod startup;
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
                execute(&context, &host, &query).await
            }
            "logs" => {
                if input["source"]["kind"] == "compose" {
                    let project = input["source"]["project"]
                        .as_str()
                        .ok_or_else(|| ApiError::new("INPUT", "Compose 日志项目无效"))?;
                    let lines = input["lines"]
                        .as_u64()
                        .and_then(|v| u16::try_from(v).ok())
                        .ok_or_else(|| ApiError::new("INPUT", "日志行数无效"))?;
                    return compose::logs(
                        &context,
                        &host,
                        project,
                        lines,
                        input["follow"].as_bool().unwrap_or(false),
                    )
                    .await;
                }
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
    if let docker::Query::ContainerStartup {
        id,
        reveal_env,
        inspect_only,
    } = query
    {
        return startup::load(context, host, id, *reveal_env, *inspect_only).await;
    }
    if let docker::Query::ComposeAction {
        project,
        action,
        confirmed,
    } = query
    {
        return compose::execute(context, host, project, action, *confirmed).await;
    }
    let result = context
        .execute(host, Command::script(query.command()?))
        .await?
        .checked()?;
    let mut response = query.response(&result.stdout)?;
    if !result.stderr.is_empty() {
        response["message"] = json!(
            match response["message"].as_str().filter(|s| !s.is_empty()) {
                Some(message) => format!("{message}\n{}", result.stderr),
                None => result.stderr,
            }
        );
    }
    Ok(response)
}
fn handle(opcode: i32, payload: Value) -> Value {
    RUNTIME.with_borrow_mut(|runtime| runtime.handle(opcode, payload))
}
serverdeck_plugin_sdk::export_plugin!(handle);
