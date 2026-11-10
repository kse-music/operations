use super::{
    state::{Call, failure},
    *,
};
use serde_json::Value;
use serverdeck_plugin_core::{
    InstalledPlugin,
    permissions::{Grant, GrantInput, denied},
};
use serverdeck_plugin_sdk::{ApiError, Capability, Request, Response};
use std::time::Duration;
impl Application {
    pub async fn plugin_grant(&self, id: String, input: GrantInput) -> Result<Grant, Error> {
        if self.plugin_detail(id.clone()).await?.source
            == serverdeck_plugin_core::repository::PluginSource::System
        {
            return Err(Error::Validation("内置插件权限由系统预置，不能修改"));
        }
        self.plugin_stop_resources(&id).await?;
        let repository = self.plugins.clone();
        let grant = self
            .blocking(move |_| repository.set_grant(&id, input))
            .await?;
        self.plugin_host.resume(&grant.plugin_id)?;
        Ok(grant)
    }
    pub async fn plugin_permissions(&self, id: String) -> Result<Option<Grant>, Error> {
        let repository = self.plugins.clone();
        self.blocking(move |_| repository.grant(&id)).await
    }
    pub async fn plugin_revoke(&self, id: String) -> Result<(), Error> {
        if self.plugin_detail(id.clone()).await?.source
            == serverdeck_plugin_core::repository::PluginSource::System
        {
            return Err(Error::Validation(
                "内置插件权限由系统预置，不能撤销；可禁用插件",
            ));
        }
        self.plugin_stop_resources(&id).await?;
        let repository = self.plugins.clone();
        self.blocking(move |_| repository.revoke_grant(&id)).await
    }
    pub fn plugin_events(&self) -> Result<Vec<Event>, Error> {
        Ok(self.plugin_host.lock()?.events.iter().cloned().collect())
    }
    pub fn plugin_approve(&self, id: &str, confirmed: bool) -> Result<(), Error> {
        let mut data = self.plugin_host.lock()?;
        if !confirmed {
            data.approvals.remove(id);
            return Ok(());
        }
        let expired = || {
            failure(
                "PLUGIN_CONFIRMATION_EXPIRED",
                "本次确认已过期或失效，请重新点击原操作并在 60 秒内再次确认",
            )
        };
        let pending = data.approvals.get_mut(id).ok_or_else(expired)?;
        if pending.at.elapsed() > Duration::from_secs(60) {
            data.approvals.remove(id);
            return Err(expired());
        }
        pending.approved = true;
        Ok(())
    }
    pub async fn plugin_capability(&self, id: &str, request: Request) -> Result<Response, Error> {
        self.plugin_capability_scoped(id, "default", request).await
    }
    pub async fn plugin_capability_scoped(
        &self,
        id: &str,
        owner: &str,
        request: Request,
    ) -> Result<Response, Error> {
        if self.shutting_down.load(Ordering::Acquire) {
            return Err(Error::ShuttingDown);
        }
        self.plugin_detail(id.to_owned()).await?;
        let call = if matches!(
            &request.operation,
            Capability::Platform {
                request: serverdeck_plugin_sdk::platform::Request::TransferCancel { .. },
                ..
            }
        ) {
            self.plugin_host.start_control_scoped(id, owner)?
        } else {
            self.plugin_host.start_scoped(id, owner)?
        };
        self.plugin_dispatch(&call, request).await
    }
    pub(super) async fn plugin_dispatch(
        &self,
        call: &Call,
        request: Request,
    ) -> Result<Response, Error> {
        let request_id = request.request_id.clone();
        let operation_name = request.operation.operation().to_owned();
        let result = self.plugin_dispatch_inner(call, request).await;
        match result {
            Ok(value) => {
                if serde_json::to_vec(&value)
                    .map_err(|e| Error::Worker(Box::new(e)))?
                    .len()
                    > 60 * 1024
                {
                    return Err(failure("PLUGIN_OUTPUT_LIMIT", "插件能力输出超过消息配额"));
                }
                let error = if value.get("confirmationRequired").is_some() {
                    Some(ApiError {
                        code: "PLUGIN_CONFIRMATION_REQUIRED".into(),
                        message: "此操作需要在 ServerDeck 主界面单独确认".into(),
                    })
                } else {
                    None
                };
                Ok(Response {
                    request_id,
                    result: value,
                    error,
                })
            }
            Err(error) => {
                if let Some(batch) = call.batch.lock().map_err(|_| Error::Busy)?.as_mut() {
                    batch.operations.clear();
                }
                let ipc = serverdeck_core::IpcError::from(error);
                self.plugin_host.event(Event {
                    plugin_id: call.id.clone(),
                    kind: if ipc.code == "PLUGIN_PERMISSION_DENIED" {
                        "permission_denied"
                    } else {
                        "error"
                    }
                    .into(),
                    operation: operation_name,
                    message: ipc.message.clone(),
                })?;
                Ok(Response {
                    request_id,
                    result: Value::Null,
                    error: Some(ApiError {
                        code: ipc.code.into(),
                        message: ipc.message,
                    }),
                })
            }
        }
    }
    pub(super) async fn plugin_dispatch_inner(
        &self,
        call: &Call,
        request: Request,
    ) -> Result<Value, Error> {
        if request.api_version != 1
            || request.request_id.is_empty()
            || request.request_id.len() > 80
            || serde_json::to_vec(&request)
                .map_err(|e| Error::Worker(Box::new(e)))?
                .len()
                > 60 * 1024
        {
            return Err(failure(
                "PLUGIN_API_VERSION",
                "插件能力协议版本、标识或消息大小无效",
            ));
        }
        self.plugin_host.verify(call)?;

        let (plugin, grant) = self.plugin_authorize(call, &request.operation).await?;
        let Capability::Platform { request, bindings } = request.operation;
        self.plugin_platform_capability(call, &plugin, &grant, request, bindings)
            .await
    }
    pub(super) async fn plugin_authorize(
        &self,
        call: &Call,
        operation: &Capability,
    ) -> Result<(InstalledPlugin, Grant), Error> {
        self.plugin_host.verify(call)?;
        let repo = self.plugins.clone();
        let id = call.id.clone();
        let operation = operation.clone();
        self.blocking(move |_| {
            let plugin = repo.detail(&id)?;
            let grant = repo.grant(&id)?.ok_or_else(denied)?;
            grant.authorize(&plugin, &operation)?;
            Ok((plugin, grant))
        })
        .await
    }
    pub(super) fn plugin_confirmation_bound(
        &self,
        call: &Call,
        plugin: &InstalledPlugin,
        operation: &Capability,
        binding: Option<&str>,
        target: Option<&str>,
    ) -> Result<Option<Approval>, Error> {
        if !operation.needs_confirmation() {
            return Ok(None);
        }
        let data = self.plugin_host.lock()?;
        let Capability::Platform { request, .. } = operation;
        let description = match request {
            serverdeck_plugin_sdk::platform::Request::ReadFile { path, .. } => format!(
                "读取远程文本文件：{path}（最多 32 KiB）；插件可使用已授予的模型能力处理内容"
            ),
            serverdeck_plugin_sdk::platform::Request::TransferPrepare {
                source,
                destination,
                overwrite,
            } => format!(
                "检查传输来源与目标，冻结文件大小及属性；尚不传输内容。\n来源：{}\n目标目录：{}\n覆盖：{}",
                match source {
                    serverdeck_plugin_sdk::platform::TransferSource::Local { path } =>
                        format!("本机 {path}"),
                    serverdeck_plugin_sdk::platform::TransferSource::Remote { host_id, path } =>
                        format!("{host_id}:{path}"),
                },
                destination.path,
                overwrite
            ),
            serverdeck_plugin_sdk::platform::Request::TransferStart { id } => {
                let copy = data.copies.get(id).ok_or(Error::NotFound)?;
                if copy.plugin != call.id
                    || copy.owner != call.owner
                    || copy.generation != call.generation
                {
                    return Err(denied());
                }
                format!(
                    "传输单个普通文件，{} 字节；校验后提交。\n来源：{}\n目标：{}\n{}",
                    copy.preview.bytes,
                    match &copy.preview.source {
                        serverdeck_plugin_sdk::platform::TransferSource::Local { path } =>
                            format!("本机 {path}"),
                        serverdeck_plugin_sdk::platform::TransferSource::Remote {
                            host_id,
                            path,
                        } => format!("{host_id}:{path}"),
                    },
                    copy.preview.destination.path,
                    if copy.preview.target_exists {
                        "将原子覆盖现有目标文件"
                    } else {
                        "不覆盖已有文件"
                    }
                )
            }
            serverdeck_plugin_sdk::platform::Request::Execute { command, .. }
            | serverdeck_plugin_sdk::platform::Request::StreamOpen { command, .. }
            | serverdeck_plugin_sdk::platform::Request::Terminal { command, .. } => command
                .shell()
                .map_err(|_| Error::Validation("远程命令参数无效"))?,
            serverdeck_plugin_sdk::platform::Request::TcpConnect { target, port } => {
                format!("从本机建立 TCP 连接：{target}:{port}（超时 3 秒）")
            }
            serverdeck_plugin_sdk::platform::Request::SaveFile {
                document_id,
                content,
            } => {
                let doc = data.documents.get(document_id).ok_or(Error::NotFound)?;
                if doc.plugin != call.id
                    || doc.generation != call.generation
                    || doc.owner != call.owner
                {
                    return Err(denied());
                }
                format!(
                    "写入 {}，{} 字节，SHA256 {}\n{}",
                    doc.path,
                    content.len(),
                    serverdeck_plugin_core::package::digest(content.as_bytes()),
                    self.files.preview_text(&doc.internal_token, content)?
                )
            }
            _ => return Ok(None),
        };
        let host_id = match request {
            serverdeck_plugin_sdk::platform::Request::ReadFile { host_id, .. } => host_id.clone(),
            serverdeck_plugin_sdk::platform::Request::TransferPrepare { destination, .. } => {
                destination.host_id.clone()
            }
            serverdeck_plugin_sdk::platform::Request::TransferStart { id } => data
                .copies
                .get(id)
                .map(|copy| copy.preview.destination.host_id.clone())
                .ok_or(Error::NotFound)?,
            serverdeck_plugin_sdk::platform::Request::SaveFile { document_id, .. } => data
                .documents
                .get(document_id)
                .map(|doc| doc.host.clone())
                .unwrap_or_default(),
            _ => request.host().map(str::to_owned).unwrap_or_default(),
        };
        let description = if let Some(target) = target {
            format!("目标：{target}\n{description}")
        } else {
            description
        };
        drop(data);
        self.plugin_confirm_details(
            call,
            plugin,
            operation,
            super::approvals::ConfirmationDetails {
                host_id,
                binding: binding.map(str::to_owned),
                target: target.map(str::to_owned),
                description,
            },
        )
    }
    pub(crate) async fn plugin_stop_resources(&self, id: &str) -> Result<(), Error> {
        self.plugin_host.stop(id).await?;
        self.plugin_close_copies(id, None).await?;
        let (documents, streams, terminals) = {
            let mut data = self.plugin_host.lock()?;
            data.continuations.retain(|_, p| p.plugin != id);
            data.approvals.retain(|_, p| p.public.plugin_id != id);
            data.results.retain(|_, r| r.plugin != id);
            data.outputs.retain(|_, r| r.plugin != id);
            data.bindings.retain(|_, r| r.plugin != id);
            data.platform_terminals.retain(|_, r| r.plugin != id);
            data.visible_owners.retain(|(plugin, _), _| plugin != id);
            (
                data.documents
                    .iter()
                    .filter(|(_, r)| r.plugin == id)
                    .map(|(key, r)| (key.clone(), r.internal_token.clone()))
                    .collect::<Vec<_>>(),
                data.logs
                    .iter()
                    .filter(|(_, r)| r.plugin == id)
                    .map(|(key, _)| key.clone())
                    .collect::<Vec<_>>(),
                data.open_terminals
                    .iter()
                    .filter(|(_, r)| r.plugin == id)
                    .map(|(key, _)| key.clone())
                    .collect::<Vec<_>>(),
            )
        };
        let mut errors = vec![];
        for (key, token) in documents {
            match self.files.close_editor(&token, true) {
                Ok(()) => {
                    self.plugin_host.lock()?.documents.remove(&key);
                }
                Err(error) => errors.push(error),
            }
        }
        for key in streams {
            match self.operations_host.log_close(&key).await {
                Ok(()) => {
                    self.plugin_host.lock()?.logs.remove(&key);
                }
                Err(error) => errors.push(error),
            }
        }
        for key in terminals {
            match self.terminals.close(&key).await {
                Ok(()) => {
                    self.plugin_host.lock()?.open_terminals.remove(&key);
                }
                Err(error) => errors.push(error),
            }
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(Error::Connection {
                code: "PLUGIN_CLEANUP",
                message: "插件资源清理失败，请检查诊断信息",
                source: Some(Box::new(CleanupErrors(errors))),
            })
        }
    }
}
#[derive(Debug)]
struct CleanupErrors(Vec<Error>);
impl std::fmt::Display for CleanupErrors {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} plugin cleanup operations failed", self.0.len())
    }
}
impl std::error::Error for CleanupErrors {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        self.0.first().map(|error| error as &dyn std::error::Error)
    }
}
