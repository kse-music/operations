use super::*;
use serverdeck_plugin_core::{InstallInput, InstalledPlugin, Manifest, UninstallInput};
mod capabilities;
mod server;
mod tools;
pub use tools::{ToolInput, ToolTicket};
pub(crate) mod state;
pub use state::{Approval, ContextInput, Event};
#[cfg(test)]
mod tests;

impl Application {
    pub async fn plugin_preview(&self, path: PathBuf) -> Result<Manifest, Error> {
        let plugins = self.plugins.clone();
        self.blocking(move |_| plugins.preview(&path)).await
    }
    pub async fn plugin_preview_info(
        &self,
        path: PathBuf,
    ) -> Result<serverdeck_plugin_core::repository::PackagePreview, Error> {
        let plugins = self.plugins.clone();
        self.blocking(move |_| plugins.preview_info(&path)).await
    }
    pub async fn plugin_ui(
        &self,
        id: String,
        revision: String,
    ) -> Result<serverdeck_plugin_sdk::ui::Ui, Error> {
        let plugins = self.plugins.clone();
        self.blocking(move |_| plugins.ui(&id, &revision)).await
    }
    pub async fn plugin_clear_context(&self, id: String) -> Result<(), Error> {
        self.plugin_detail(id.clone()).await?;
        self.plugin_stop_resources(&id).await?;
        self.plugin_host.resume(&id, None)
    }
    pub async fn plugin_install(&self, input: InstallInput) -> Result<InstalledPlugin, Error> {
        let manifest = self.plugin_preview(input.path.clone()).await?;
        let old = match self.plugin_detail(manifest.id.clone()).await {
            Ok(old) => Some(old),
            Err(Error::NotFound) => None,
            Err(e) => return Err(e),
        };
        self.plugin_stop_resources(&manifest.id).await?;
        self.plugin_runtime.remove(&manifest.id).await?;
        let plugins = self.plugins.clone();
        match self.blocking(move |_| plugins.install(input)).await {
            Ok(installed) => Ok(installed),
            Err(error) => {
                if let Some(old) = old
                    && old.enabled
                {
                    if let Err(recovery) = self.plugin_host.resume(&old.manifest.id, None) {
                        tracing::warn!(operation = "plugin_upgrade_rollback_host", error = %recovery);
                    } else if old.manifest.entry.backend.is_some()
                        && let Err(restart) = self.plugin_runtime.activate(&old.manifest.id).await
                    {
                        tracing::warn!(operation = "plugin_upgrade_rollback_restart", error = %restart);
                    }
                }
                Err(error)
            }
        }
    }
    pub async fn plugin_list(&self) -> Result<Vec<InstalledPlugin>, Error> {
        let plugins = self.plugins.clone();
        self.blocking(move |_| plugins.list()).await
    }
    pub async fn plugin_detail(&self, id: String) -> Result<InstalledPlugin, Error> {
        let plugins = self.plugins.clone();
        self.blocking(move |_| plugins.detail(&id)).await
    }
    pub async fn plugin_set_enabled(
        &self,
        id: String,
        enabled: bool,
    ) -> Result<InstalledPlugin, Error> {
        let plugins = self.plugins.clone();
        let changed = self
            .blocking(move |_| plugins.set_enabled(&id, enabled))
            .await?;
        if enabled {
            self.plugin_host.resume(&changed.manifest.id, None)?;
        } else {
            self.plugin_stop_resources(&changed.manifest.id).await?;
        }
        if enabled && changed.manifest.entry.backend.is_some() {
            self.plugin_runtime.activate(&changed.manifest.id).await?;
        } else if !enabled {
            self.plugin_runtime.remove(&changed.manifest.id).await?;
        }
        Ok(changed)
    }
    pub async fn plugin_uninstall(&self, input: UninstallInput) -> Result<(), Error> {
        if !input.confirmed {
            return Err(Error::Validation("卸载插件需要明确确认"));
        }
        let id = input.id.clone();
        let plugins = self.plugins.clone();
        self.blocking(move |_| plugins.set_enabled(&id, false))
            .await?;
        self.plugin_stop_resources(&input.id).await?;
        self.plugin_runtime.remove(&input.id).await?;
        let id = input.id.clone();
        let plugins = self.plugins.clone();
        self.blocking(move |_| plugins.uninstall(input)).await?;
        self.plugin_host.forget(&id)
    }
    pub fn plugin_statuses(
        &self,
    ) -> Result<Vec<serverdeck_plugin_runtime::protocol::Status>, Error> {
        self.plugin_runtime.statuses()
    }
    pub async fn plugin_activate(
        &self,
        id: &str,
    ) -> Result<serverdeck_plugin_runtime::protocol::Status, Error> {
        self.plugin_runtime.activate(id).await
    }
    pub async fn plugin_call(
        &self,
        id: &str,
        payload: serde_json::Value,
    ) -> Result<serverdeck_plugin_runtime::protocol::Reply, Error> {
        if self.shutting_down.load(Ordering::Acquire) {
            return Err(Error::ShuttingDown);
        }
        self.plugin_detail(id.to_owned()).await?;
        let call = self.plugin_host.start(id)?;
        let mut reply = self.plugin_runtime.call(id, payload).await?;
        for _ in 0..8 {
            if reply.error.is_some() {
                return Ok(reply);
            }
            match serde_json::from_value::<serverdeck_plugin_sdk::Yield>(reply.result.clone()) {
                Ok(serverdeck_plugin_sdk::Yield::Done { value }) => {
                    reply.result = value;
                    return Ok(reply);
                }
                Ok(serverdeck_plugin_sdk::Yield::HostCall { request }) => {
                    let response = self.plugin_dispatch(&call, request).await?;
                    if !response.result["confirmationRequired"].is_null() {
                        reply.result = response.result["confirmationRequired"].clone();
                        reply.error = Some(serverdeck_plugin_runtime::protocol::GuestError {
                            code: "PLUGIN_CONFIRMATION_REQUIRED".into(),
                            message: "此操作需要在 ServerDeck 主界面单独确认".into(),
                        });
                        return Ok(reply);
                    }
                    reply = self
                        .plugin_runtime
                        .resume(id, serde_json::json!({"hostResponse":response}))
                        .await?;
                }
                Err(_)
                    if reply
                        .result
                        .get("kind")
                        .and_then(|v| v.as_str())
                        .is_some_and(|k| k == "host_call" || k == "done") =>
                {
                    return Err(state::failure("PLUGIN_PROTOCOL", "插件能力请求消息无效"));
                }
                Err(_) => return Ok(reply),
            }
        }
        Err(state::failure(
            "PLUGIN_CHAIN_LIMIT",
            "插件单次调用最多请求八项宿主能力",
        ))
    }
    pub async fn plugin_health(
        &self,
        id: &str,
    ) -> Result<serverdeck_plugin_runtime::protocol::Reply, Error> {
        self.plugin_runtime.health(id).await
    }
    pub fn plugin_cancel(&self, id: &str) -> Result<(), Error> {
        self.plugin_host.cancel(id)?;
        self.plugin_cancel_tool_requests(id)?;
        match self.plugin_runtime.cancel(id) {
            Err(Error::NotFound) => Ok(()),
            other => other,
        }
    }
}
