use super::{
    state::{Call, Pending, failure},
    *,
};
use serde_json::Value;
use serverdeck_plugin_core::{
    InstalledPlugin,
    package::digest,
    permissions::{Grant, GrantInput, denied},
};
use serverdeck_plugin_sdk::{ApiError, Capability, Request, Response};
use std::time::{Duration, Instant};
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
        let call = self.plugin_host.start_scoped(id, owner)?;
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
    async fn plugin_dispatch_inner(&self, call: &Call, request: Request) -> Result<Value, Error> {
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
        let hash = digest(
            &serde_json::to_vec(&(
                plugin.revision.as_str(),
                call.generation.as_str(),
                call.owner.as_str(),
                operation,
                binding,
            ))
            .map_err(|e| Error::Worker(Box::new(e)))?,
        );
        let mut data = self.plugin_host.lock()?;
        data.approvals
            .retain(|_, pending| pending.at.elapsed() <= Duration::from_secs(60));
        if let Some(key) = data
            .approvals
            .iter()
            .find(|(_, pending)| pending.digest == hash && pending.approved)
            .map(|(key, _)| key.clone())
        {
            data.approvals.remove(&key);
            return Ok(None);
        }
        if data.approvals.len() >= 16
            || data
                .approvals
                .values()
                .filter(|pending| pending.public.plugin_id == call.id)
                .count()
                >= 4
        {
            return Err(Error::Busy);
        }
        let Capability::Platform { request, .. } = operation;
        let description = match request {
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
                    "写入 {}，{} 字节，SHA256 {}",
                    doc.path,
                    content.len(),
                    digest(content.as_bytes())
                )
            }
            _ => return Ok(None),
        };
        let host_id = match request {
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
        let public = Approval {
            id: uuid::Uuid::new_v4().to_string(),
            plugin_id: call.id.clone(),
            plugin_name: plugin.manifest.name.clone(),
            plugin_version: plugin.manifest.version.clone(),
            host_id,
            operation: operation.operation().into(),
            description,
            target: target.map(str::to_owned),
        };
        data.approvals.insert(
            public.id.clone(),
            Pending {
                owner: call.owner.clone(),
                public: public.clone(),
                digest: hash,
                at: Instant::now(),
                approved: false,
            },
        );
        Ok(Some(public))
    }
    pub(crate) async fn plugin_stop_resources(&self, id: &str) -> Result<(), Error> {
        self.plugin_host.stop(id).await?;
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
