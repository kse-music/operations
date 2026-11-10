use serverdeck_core::{Error, IpcError};

pub fn http_url(value: &str) -> Result<tauri::Url, Error> {
    let invalid = || Error::Validation("只能打开有效的 HTTP/HTTPS 链接");
    if value.len() > 32 * 1024 || value.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err(invalid());
    }
    let url = tauri::Url::parse(value).map_err(|_| invalid())?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err(invalid());
    }
    Ok(url)
}

#[tauri::command]
pub async fn terminal_open_link(url: String) -> Result<(), IpcError> {
    let url = http_url(&url)?;
    tauri::async_runtime::spawn_blocking(move || {
        tauri_plugin_opener::open_url(url.as_str(), None::<&str>).map_err(|error| {
            Error::Connection {
                code: "BROWSER_OPEN",
                message: "无法打开默认浏览器，请检查系统浏览器设置后重试",
                source: Some(Box::new(error)),
            }
        })
    })
    .await
    .map_err(|error| IpcError::from(Error::Worker(Box::new(error))))?
    .map_err(Into::into)
}
