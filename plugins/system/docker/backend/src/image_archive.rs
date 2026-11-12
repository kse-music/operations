use serverdeck_plugin_sdk::{
    ApiError,
    backend::Context,
    platform::Request,
    serde_json::{self, Value, json},
};
#[path = "../../../image_archive.rs"]
mod archive;
use archive::{Archive, command};
fn invalid(message: &str) -> ApiError {
    ApiError::new("DOCKER_INPUT", message)
}

pub async fn open(context: &Context, host: &str, input: Value) -> Result<Value, ApiError> {
    let archive: Archive =
        serde_json::from_value(input).map_err(|_| invalid("镜像导入导出请求无效"))?;
    let info = context.info().await?;
    let nonce = info["nonce"]
        .as_str()
        .ok_or_else(|| invalid("平台任务标识无效"))?;
    let (command, directory, path) = command(&archive, nonce)?;
    let target = context
        .request(Request::Host {
            host_id: host.into(),
        })
        .await?;
    let binding = target["binding"]
        .as_str()
        .ok_or_else(|| invalid("主机绑定无效"))?;
    let stream = context
        .with_bindings(vec![binding.into()])
        .request(Request::StreamOpen {
            host_id: host.into(),
            command,
        })
        .await?;
    Ok(json!({"streamId":stream["id"],"directory":directory,"path":path,"nonce":nonce}))
}
