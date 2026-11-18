use serverdeck_application::{Application, HostBackupResult};
use serverdeck_core::{Error, IpcError};
use tauri::State;
use tauri_plugin_dialog::DialogExt;

#[derive(Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Action {
    Export,
    Import,
}

#[tauri::command]
pub async fn host_backup<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    application: State<'_, Application>,
    action: Action,
) -> Result<Option<HostBackupResult>, IpcError> {
    let english = application.bootstrap().await?.config.product.language == "en-US";
    let selected = tokio::task::spawn_blocking(move || {
        let picker = app.dialog().file().add_filter("ServerDeck", &["sdhosts"]);
        let selected = match action {
            Action::Export => picker
                .set_title(if english {
                    "Export all hosts including readable passwords and private keys"
                } else {
                    "导出全部主机（文件含可直接读取的密码和私钥）"
                })
                .set_file_name("ServerDeck.sdhosts")
                .blocking_save_file(),
            Action::Import => picker
                .set_title(if english {
                    "Import a trusted ServerDeck host backup"
                } else {
                    "导入可信来源的主机备份"
                })
                .blocking_pick_file(),
        };
        selected
            .map(|file| {
                file.into_path()
                    .map_err(|_| Error::Validation("请选择本地文件"))
            })
            .transpose()
    })
    .await
    .map_err(|e| Error::Worker(Box::new(e)))??;
    let Some(path) = selected else {
        return Ok(None);
    };
    let result = match action {
        Action::Export => application.host_backup_export(path).await?,
        Action::Import => application.host_backup_import(path).await?,
    };
    Ok(Some(result))
}
