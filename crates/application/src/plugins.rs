use super::*;
use serverdeck_plugin_core::{InstallInput, InstalledPlugin, Manifest, UninstallInput};
mod capabilities;
mod platform;
mod results;
pub(crate) mod state;
pub use state::{Approval, Event};
#[cfg(test)]
mod tests;

impl Application {
    pub fn plugin_frontend_asset(
        &self,
        id: &str,
        revision: &str,
        page: &str,
        path: &str,
    ) -> Result<Vec<u8>, Error> {
        let ui = self.plugins.ui(id, revision)?;
        if !ui.pages.iter().any(|p| p.id == page && p.surface.is_some()) {
            return Err(Error::Validation("插件界面不存在"));
        }
        self.plugins.frontend_asset(id, revision, path)
    }

    pub fn plugin_frontend_document(
        &self,
        id: &str,
        revision: &str,
        page: &str,
    ) -> Result<Vec<u8>, Error> {
        let ui = self.plugins.ui(id, revision)?;
        if !ui.pages.iter().any(|p| p.id == page && p.surface.is_some()) {
            return Err(Error::Validation("插件没有独立界面"));
        }
        let frontend = ui.frontend.ok_or(Error::Validation("插件没有独立界面"))?;
        // Entry names have already passed the strict SDK validation.
        Ok(format!("<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><link rel=\"stylesheet\" href=\"{}\"></head><body><div id=\"app\"></div><script type=\"module\" src=\"{}\"></script></body></html>", frontend.style, frontend.script).into_bytes())
    }
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
    pub async fn plugin_reset(&self, id: String) -> Result<(), Error> {
        self.plugin_detail(id.clone()).await?;
        self.plugin_stop_resources(&id).await?;
        self.plugin_runtime.deactivate(&id).await?;
        self.plugin_host.resume(&id)
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
                    if let Err(recovery) = self.plugin_host.resume(&old.manifest.id) {
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
        self.blocking(move |_| plugins.inventory().map(|inventory| inventory.installed))
            .await
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
            self.plugin_host.resume(&changed.manifest.id)?;
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
        self.plugin_call_scoped(id, "default", payload).await
    }
    pub async fn plugin_call_scoped(
        &self,
        id: &str,
        owner: &str,
        payload: serde_json::Value,
    ) -> Result<serverdeck_plugin_runtime::protocol::Reply, Error> {
        if self.shutting_down.load(Ordering::Acquire) {
            return Err(Error::ShuttingDown);
        }
        self.plugin_detail(id.to_owned()).await?;
        let call = self.plugin_host.start_scoped(id, owner)?;
        {
            let mut data = self.plugin_host.lock()?;
            data.continuations.retain(|_, pending| pending.plugin != id);
            data.approvals
                .retain(|_, pending| pending.public.plugin_id != id);
        }
        let reply = self.plugin_runtime.call(id, payload).await?;
        self.plugin_drive(&call, reply, 96, std::time::Instant::now())
            .await
    }
    pub async fn plugin_continue(
        &self,
        id: &str,
        owner: &str,
        token: &str,
        cancelled: bool,
    ) -> Result<serverdeck_plugin_runtime::protocol::Reply, Error> {
        let plugin = self.plugin_detail(id.to_owned()).await?;
        let call = self.plugin_host.start_scoped(id, owner)?;
        let pending = {
            let mut data = self.plugin_host.lock()?;
            let pending = data.continuations.get(token).ok_or(Error::NotFound)?;
            if pending.plugin != id
                || pending.owner != owner
                || pending.generation != call.generation
                || pending.revision != plugin.revision
                || pending.started.elapsed() > std::time::Duration::from_secs(180)
            {
                return Err(state::failure(
                    "PLUGIN_CONTINUATION_EXPIRED",
                    "插件动作已过期或上下文已变化",
                ));
            }
            data.continuations.remove(token).ok_or(Error::NotFound)?
        };
        let response = if cancelled {
            call.user_cancelled
                .store(true, std::sync::atomic::Ordering::Release);
            serverdeck_plugin_sdk::Response {
                request_id: pending.request.request_id.clone(),
                result: serde_json::Value::Null,
                error: Some(serverdeck_plugin_sdk::ApiError::new(
                    "USER_CANCELLED",
                    "操作已取消；此前完成的步骤不会回滚，请核对实际状态",
                )),
            }
        } else {
            self.plugin_dispatch(&call, pending.request.clone()).await?
        };
        if !response.result["confirmationRequired"].is_null() {
            return self
                .plugin_pending_reply(
                    &call,
                    pending.request,
                    response.result["confirmationRequired"].clone(),
                    pending.remaining,
                    pending.started,
                )
                .await;
        }
        tokio::time::sleep(std::time::Duration::from_millis(65)).await;
        let reply = self
            .plugin_runtime
            .resume(id, serde_json::json!({"hostResponse":response}))
            .await?;
        self.plugin_drive(&call, reply, pending.remaining, pending.started)
            .await
    }
    async fn plugin_pending_reply(
        &self,
        call: &state::Call,
        request: serverdeck_plugin_sdk::Request,
        mut approval: serde_json::Value,
        remaining: usize,
        started: std::time::Instant,
    ) -> Result<serverdeck_plugin_runtime::protocol::Reply, Error> {
        let plugin = self.plugin_detail(call.id.clone()).await?;
        let token = uuid::Uuid::new_v4().to_string();
        let mut data = self.plugin_host.lock()?;
        data.continuations
            .retain(|_, pending| pending.started.elapsed() < std::time::Duration::from_secs(180));
        if data.continuations.len() >= 32 {
            return Err(Error::Busy);
        }
        data.continuations.insert(
            token.clone(),
            state::Continuation {
                owner: call.owner.clone(),
                plugin: call.id.clone(),
                generation: call.generation.clone(),
                revision: plugin.revision,
                request,
                remaining,
                started,
            },
        );
        approval["continuation"] = serde_json::Value::String(token);
        Ok(serverdeck_plugin_runtime::protocol::Reply {
            protocol_version: 1,
            result: approval,
            error: Some(serverdeck_plugin_runtime::protocol::GuestError {
                code: "PLUGIN_CONFIRMATION_REQUIRED".into(),
                message: "此操作需要在 ServerDeck 主界面单独确认".into(),
            }),
        })
    }
    async fn plugin_drive(
        &self,
        call: &state::Call,
        mut reply: serverdeck_plugin_runtime::protocol::Reply,
        remaining: usize,
        started: std::time::Instant,
    ) -> Result<serverdeck_plugin_runtime::protocol::Reply, Error> {
        let mut left = remaining;
        loop {
            self.plugin_host.verify(call)?;
            if started.elapsed() > std::time::Duration::from_secs(180) {
                return Err(state::failure(
                    "PLUGIN_ACTION_TIMEOUT",
                    "插件动作达到三分钟时限",
                ));
            }
            if reply.error.is_some() {
                return Ok(reply);
            }
            match serde_json::from_value::<serverdeck_plugin_sdk::Yield>(reply.result.clone()) {
                Ok(serverdeck_plugin_sdk::Yield::Done { value }) => {
                    reply.result = value;
                    return Ok(reply);
                }
                Ok(serverdeck_plugin_sdk::Yield::HostCall { request }) => {
                    if left == 0 {
                        return Err(state::failure(
                            "PLUGIN_CHAIN_LIMIT",
                            "插件动作的平台调用次数超过九十六次",
                        ));
                    }
                    left -= 1;
                    let response = self.plugin_dispatch(call, request.clone()).await?;
                    if !response.result["confirmationRequired"].is_null() {
                        return self
                            .plugin_pending_reply(
                                call,
                                request,
                                response.result["confirmationRequired"].clone(),
                                left,
                                started,
                            )
                            .await;
                    }
                    // Host continuations use the same VM message rate limit as UI
                    // invocations, including transparent result chunks.
                    tokio::time::sleep(std::time::Duration::from_millis(65)).await;
                    reply = self
                        .plugin_runtime
                        .resume(&call.id, serde_json::json!({"hostResponse":response}))
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
    }
    pub async fn plugin_health(
        &self,
        id: &str,
    ) -> Result<serverdeck_plugin_runtime::protocol::Reply, Error> {
        self.plugin_runtime.health(id).await
    }
    pub fn plugin_cancel(&self, id: &str) -> Result<(), Error> {
        self.plugin_host
            .lock()?
            .continuations
            .retain(|_, pending| pending.plugin != id);
        self.plugin_host.cancel(id)?;
        match self.plugin_runtime.cancel(id) {
            Err(Error::NotFound) => Ok(()),
            other => other,
        }
    }
}
