use serverdeck_application::Application;
use serverdeck_core::{Error, IpcError};
use tauri::ipc::{InvokeBody, Request, Response};

#[tauri::command]
pub async fn terminal_zmodem_read(
    application: tauri::State<'_, Application>,
    id: String,
    token: String,
    index: usize,
    offset: u64,
) -> Result<Response, IpcError> {
    application
        .terminal_zmodem_read(id, token, index, offset)
        .await
        .map(Response::new)
        .map_err(Into::into)
}

#[tauri::command]
pub async fn terminal_zmodem_write(
    application: tauri::State<'_, Application>,
    request: Request<'_>,
) -> Result<(), IpcError> {
    let InvokeBody::Raw(data) = request.body() else {
        return Err(Error::Validation("ZMODEM 输入必须为二进制数据").into());
    };
    if data.is_empty() || data.len() > 256 * 1024 {
        return Err(Error::Validation("ZMODEM 输入批次须为 1–262144 字节").into());
    }
    let header = |name| -> Result<String, IpcError> {
        request
            .headers()
            .get(name)
            .and_then(|value| value.to_str().ok())
            .filter(|value| !value.is_empty() && value.len() <= 128)
            .map(str::to_owned)
            .ok_or_else(|| Error::Validation("ZMODEM 上传授权无效").into())
    };
    application
        .terminal_zmodem_write(
            header("x-serverdeck-session")?,
            header("x-serverdeck-token")?,
            data.clone(),
        )
        .await
        .map_err(Into::into)
}
