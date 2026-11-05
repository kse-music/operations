use super::state::{self, Call, Document, Log, Pending, failure};
use super::*;
use serde_json::{Value, json};
use serverdeck_core::{
    files::SaveText,
    ops::{LogEvent, LogInput, LogSource},
};
use serverdeck_plugin_core::{
    package::digest,
    permissions::{Grant, GrantInput, denied},
};
use serverdeck_plugin_sdk::{ApiError, Capability, Request, Response};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};

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
        self.plugin_host.resume(&grant.plugin_id, None)?;
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
    pub async fn plugin_context(&self, id: String, input: ContextInput) -> Result<(), Error> {
        self.plugin_detail(id.clone()).await?;
        self.plugin_stop_resources(&id).await?;
        let host_id = input.host_id.clone();
        let engine = self.terminals.clone();
        let profile = self
            .blocking(move |db| {
                db.host(&host_id)?;
                engine.profile_signature(&host_id)
            })
            .await?;
        for (session, operations) in [(&input.ops_session, true), (&input.file_session, false)] {
            if let Some(session) = session {
                let info = self.terminals.session_info(session)?;
                let connections = if operations {
                    self.terminals.ops_connections()?
                } else {
                    self.terminals.file_connections()?
                };
                if info.host_id != input.host_id
                    || !connections.iter().any(|c| &c.id == session)
                    || self.terminals.lease_profile(session)? != profile
                {
                    return Err(denied());
                }
            }
        }
        self.plugin_host.resume(&id, Some((input, profile)))
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
        if self.shutting_down.load(Ordering::Acquire) {
            return Err(Error::ShuttingDown);
        }
        self.plugin_detail(id.to_owned()).await?;
        let call = self.plugin_host.start(id)?;
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
        let recheck = request.operation.clone();
        let (plugin, grant) = self.plugin_authorize(call, &request.operation).await?;
        match &request.operation {
            Capability::SystemQuery { request } => {
                super::server::core_query(request)?.command()?;
                self.plugin_ops_session(call)?;
            }
            Capability::ContainerShell { id, bash } => {
                serverdeck_core::ops::ContainerShell {
                    id: id.clone(),
                    bash: *bash,
                    confirmed: true,
                }
                .command()?;
                self.plugin_ops_session(call)?;
            }
            Capability::Execute {
                command,
                timeout_secs,
            } => {
                validate_command(command, *timeout_secs)?;
                self.plugin_ops_session(call)?;
            }
            Capability::SaveFile {
                document_id,
                content,
            } => {
                if content.len() > 32 * 1024 {
                    return Err(failure("PLUGIN_FILE_LIMIT", "插件文本保存超过 32 KiB"));
                }
                let (_, path) = self.plugin_document(call, document_id)?;
                grant.path(&path, true)?;
                self.plugin_file_session(call)?;
            }
            _ => (),
        }
        if request.operation.needs_confirmation()
            && let Some(approval) = self.plugin_confirmation(call, &plugin, &request.operation)?
        {
            return Ok(json!({"confirmationRequired":approval}));
        }
        let value = match request.operation {
            Capability::ToolInvoke {
                input_id,
                operation,
            } => {
                self.plugin_tool_invoke(call, &plugin, &input_id, operation)
                    .await?
            }
            Capability::HostsRead => {
                let host_id = context(call)?.input.host_id.clone();
                self.blocking(move |db| { let host=db.host(&host_id)?; Ok(json!({"id":host.id,"name":host.config.name,"hostname":host.config.hostname,"port":host.config.port,"username":host.config.username})) }).await?
            }
            Capability::Execute {
                command,
                timeout_secs,
            } => self.plugin_execute(call, command, timeout_secs).await?,
            Capability::ReadFile { path } => {
                let session = self.plugin_file_session(call)?;
                let path = self.files.canonical_path(&session, &path).await?;
                grant.path(&path, false)?;
                self.plugin_host.verify(call)?;
                let properties = self.files.properties(&session, &path).await?;
                if properties.size.is_none_or(|n| n > 32 * 1024) {
                    return Err(failure(
                        "PLUGIN_FILE_LIMIT",
                        "插件只可读取不超过 32 KiB 的文本文件",
                    ));
                }
                if self.plugin_host.lock()?.documents.len() >= 8 {
                    return Err(Error::Busy);
                }
                let document = self.files.read_text(&session, &path).await?;
                let id = uuid::Uuid::new_v4().to_string();
                let public = json!({"id":id,"path":document.path,"content":document.content,"sha256":document.sha256,"atomicSave":document.atomic_save,"permissions":document.permissions});
                if call.cancel.is_cancelled()
                    || serde_json::to_vec(&public)
                        .map_err(|e| Error::Worker(Box::new(e)))?
                        .len()
                        > 60 * 1024
                {
                    self.files.close_editor(&document.token, true)?;
                    return Err(failure(
                        "PLUGIN_FILE_LIMIT",
                        "插件读取已取消或文本超出消息配额",
                    ));
                }
                self.plugin_host.lock()?.documents.insert(
                    id,
                    Document {
                        plugin: call.id.clone(),
                        generation: call.generation.clone(),
                        internal_token: document.token,
                        path,
                    },
                );
                public
            }
            Capability::SaveFile {
                document_id,
                content,
            } => {
                if content.len() > 32 * 1024 {
                    return Err(failure("PLUGIN_FILE_LIMIT", "插件文本保存超过 32 KiB"));
                }
                self.plugin_file_session(call)?;
                let (token, path) = self.plugin_document(call, &document_id)?;
                grant.path(&path, true)?;
                // Once the confirmed atomic editor transaction starts, drain it instead of dropping a write future.
                let result = self
                    .files
                    .save_text(SaveText {
                        token,
                        content,
                        confirm_replace: true,
                    })
                    .await?;
                if call.cancel.is_cancelled() {
                    return Err(failure(
                        "PLUGIN_SAVE_CANCELLED",
                        "插件已停止；已开始的保存已安全收尾，请重新读取文件核对结果",
                    ));
                }
                if let Some(document) = result.document {
                    json!({"saved":true,"document":{"id":document_id,"path":document.path,"sha256":document.sha256,"atomicSave":document.atomic_save,"permissions":document.permissions},"recoveryPath":null,"message":null})
                } else {
                    json!({"saved":false,"document":null,"recoveryPath":result.recovery_path,"message":result.message})
                }
            }
            Capability::CloseFile {
                document_id,
                discard,
            } => {
                let (token, _) = self.plugin_document(call, &document_id)?;
                self.files.close_editor(&token, discard)?;
                self.plugin_host.lock()?.documents.remove(&document_id);
                Value::Null
            }
            Capability::FileDirty { document_id, dirty } => {
                let (token, path) = self.plugin_document(call, &document_id)?;
                grant.path(&path, true)?;
                self.files.editor_dirty(&token, dirty)?;
                Value::Null
            }
            Capability::SettingsRead => {
                let repo = self.plugins.clone();
                let id = call.id.clone();
                self.blocking(move |_| repo.settings_read(&id)).await?
            }
            Capability::SettingsWrite { value } => {
                let repo = self.plugins.clone();
                let id = call.id.clone();
                if super::review::builtin_assistant(&plugin) {
                    let previous = self
                        .blocking({
                            let repo = repo.clone();
                            let id = id.clone();
                            move |_| repo.settings_read(&id)
                        })
                        .await?;
                    let model_id = super::tools::assistant_model_id(&value)?.map(str::to_owned);
                    if let Some(model_id) = model_id {
                        self.blocking(move |db| db.ai_model(&model_id).map(|_| ()))
                            .await?;
                    }
                    if previous.get("modelId") != value.get("modelId") {
                        self.plugin_cancel_tool_requests(&id)?;
                    }
                }
                self.blocking(move |_| repo.settings_write(&id, &value))
                    .await?;
                Value::Null
            }
            Capability::Notify { message } => {
                if message.is_empty() || message.len() > 1024 {
                    return Err(Error::Validation("插件通知须为 1–1024 字节"));
                }
                self.plugin_host.event(Event {
                    plugin_id: call.id.clone(),
                    kind: "notification".into(),
                    operation: "ui.notify".into(),
                    message,
                })?;
                Value::Null
            }
            Capability::LogStart { path, lines } => {
                if !(1..=200).contains(&lines) {
                    return Err(Error::Validation("插件日志行数须为 1–200"));
                }
                let file_session = self.plugin_file_session(call)?;
                let path = self.files.canonical_path(&file_session, &path).await?;
                grant.path(&path, false)?;
                let session = self.plugin_ops_session(call)?;
                {
                    let data = self.plugin_host.lock()?;
                    if data.logs.len() >= 8
                        || data.logs.values().filter(|l| l.plugin == call.id).count() >= 2
                    {
                        return Err(Error::Busy);
                    }
                }
                let (sender, receiver) = tokio::sync::mpsc::channel(8);
                let log=self.operations_host.log_open(&session,LogInput {source:LogSource::File {path:path.clone()},lines,follow:true},Arc::new(move|event|{
                    let value=match event {
                        LogEvent::State {state,code,message}=>json!({"type":"state","state":state,"code":code,"message":message}),
                        LogEvent::Data {sequence,stream,data,at}=> {use base64::Engine as _;json!({"type":"data","sequence":sequence,"stream":stream,"dataBase64":base64::engine::general_purpose::STANDARD.encode(data),"at":at})}
                    }; sender.try_send(value).is_ok()
                }))?;
                self.plugin_host.lock()?.logs.insert(
                    log.id.clone(),
                    Log {
                        plugin: call.id.clone(),
                        generation: call.generation.clone(),
                        path,
                        receiver,
                    },
                );
                json!({"id":log.id})
            }
            Capability::LogPoll { log_id } => {
                self.plugin_ops_session(call)?;
                let mut values = Vec::new();
                {
                    let mut data = self.plugin_host.lock()?;
                    let log = data.logs.get_mut(&log_id).ok_or(Error::NotFound)?;
                    if log.plugin != call.id || log.generation != call.generation {
                        return Err(denied());
                    }
                    grant.path(&log.path, false)?;
                    while let Ok(value) = log.receiver.try_recv() {
                        values.push(value);
                    }
                }
                for value in &values {
                    if let Some(sequence) = value["sequence"].as_u64() {
                        self.operations_host.log_ack(&log_id, sequence)?;
                    }
                }
                json!({"events":values})
            }
            Capability::LogPause { log_id, paused } => {
                self.plugin_log_owner(call, &log_id, &grant)?;
                self.operations_host.log_pause(&log_id, paused)?;
                Value::Null
            }
            Capability::LogStop { log_id } => {
                self.plugin_log_owner(call, &log_id, &grant)?;
                self.operations_host.log_close(&log_id).await?;
                self.plugin_host.lock()?.logs.remove(&log_id);
                Value::Null
            }
            operation => {
                self.plugin_server_capability(call, operation, &plugin, &grant)
                    .await?
            }
        };
        self.plugin_host.verify(call)?;
        self.plugin_authorize(call, &recheck).await?;
        Ok(value)
    }
    pub(super) async fn plugin_authorize(
        &self,
        call: &Call,
        operation: &Capability,
    ) -> Result<(InstalledPlugin, Grant), Error> {
        self.plugin_host.verify(call)?;
        let repo = self.plugins.clone();
        let id = call.id.clone();
        let host = call.context.as_ref().map(|c| c.input.host_id.clone());
        let context = call.context.clone();
        let operation = operation.clone();
        let engine = self.terminals.clone();
        self.blocking(move |_| {
            let plugin = repo.detail(&id)?;
            let grant = repo.grant(&id)?.ok_or_else(denied)?;
            grant.authorize(&plugin, host.as_deref(), &operation)?;
            if operation.uses_host() {
                let context = context.ok_or_else(denied)?;
                if engine.profile_signature(&context.input.host_id)? != context.profile {
                    return Err(Error::Conflict);
                }
            }
            Ok((plugin, grant))
        })
        .await
    }
    pub(super) fn plugin_confirmation(
        &self,
        call: &Call,
        plugin: &InstalledPlugin,
        operation: &Capability,
    ) -> Result<Option<Approval>, Error> {
        let bytes = serde_json::to_vec(&(
            plugin.revision.as_str(),
            call.generation.as_str(),
            operation,
        ))
        .map_err(|e| Error::Worker(Box::new(e)))?;
        let hash = digest(&bytes);
        let mut data = self.plugin_host.lock()?;
        data.approvals
            .retain(|_, p| p.at.elapsed() <= Duration::from_secs(60));
        if let Some((id, pending)) = data.approvals.iter().find(|(_, p)| {
            p.digest == hash && p.generation == call.generation && p.revision == plugin.revision
        }) {
            if pending.approved {
                let id = id.clone();
                data.approvals.remove(&id);
                return Ok(None);
            }
            return Ok(Some(pending.public.clone()));
        }
        if data.approvals.len() >= 32
            || data
                .approvals
                .values()
                .filter(|p| p.public.plugin_id == call.id)
                .count()
                >= 4
        {
            return Err(Error::Busy);
        }
        let description = match operation {
            Capability::SystemQuery { request } => format!(
                "服务器操作：{}",
                serde_json::to_string(request).map_err(|e| Error::Worker(Box::new(e)))?
            ),
            Capability::ContainerShell { id, bash } => format!(
                "打开容器 {id} 的 {} 终端",
                if *bash { "bash" } else { "sh" }
            ),
            Capability::Execute { command, .. } => command.clone(),
            Capability::SaveFile {
                document_id,
                content,
            } => {
                let doc = data.documents.get(document_id).ok_or(Error::NotFound)?;
                if doc.plugin != call.id || doc.generation != call.generation {
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
        let public = Approval {
            id: uuid::Uuid::new_v4().to_string(),
            plugin_id: call.id.clone(),
            plugin_name: plugin.manifest.name.clone(),
            plugin_version: plugin.manifest.version.clone(),
            host_id: context(call)?.input.host_id.clone(),
            operation: operation.operation().into(),
            description,
        };
        data.approvals.insert(
            public.id.clone(),
            Pending {
                public: public.clone(),
                digest: hash,
                generation: call.generation.clone(),
                revision: plugin.revision.clone(),
                at: Instant::now(),
                approved: false,
            },
        );
        Ok(Some(public))
    }
    pub(super) fn plugin_ops_session(&self, call: &Call) -> Result<String, Error> {
        let ctx = context(call)?;
        let id = ctx
            .input
            .ops_session
            .as_ref()
            .ok_or_else(|| failure("PLUGIN_SESSION_CLOSED", "当前主机没有已验证的运维连接"))?;
        let ready = match self.terminals.ops_ready(id) {
            Err(Error::NotFound) => {
                return Err(failure("PLUGIN_SESSION_CLOSED", "插件绑定的运维连接已关闭"));
            }
            other => other?,
        };
        if !ready
            || self.terminals.session_info(id)?.host_id != ctx.input.host_id
            || self.terminals.lease_profile(id)? != ctx.profile
        {
            return Err(denied());
        }
        Ok(id.clone())
    }
    pub(super) fn plugin_file_session(&self, call: &Call) -> Result<String, Error> {
        let ctx = context(call)?;
        let id =
            ctx.input.file_session.as_ref().ok_or_else(|| {
                failure("PLUGIN_SESSION_CLOSED", "当前主机没有已验证的 SFTP 连接")
            })?;
        if !self
            .terminals
            .file_connections()?
            .iter()
            .any(|s| &s.id == id && s.host_id == ctx.input.host_id)
        {
            return Err(failure(
                "PLUGIN_SESSION_CLOSED",
                "插件绑定的 SFTP 连接已关闭",
            ));
        }
        if self.terminals.lease_profile(id)? != ctx.profile {
            return Err(denied());
        }
        Ok(id.clone())
    }
    fn plugin_document(&self, call: &Call, id: &str) -> Result<(String, String), Error> {
        let data = self.plugin_host.lock()?;
        let d = data.documents.get(id).ok_or(Error::NotFound)?;
        if d.plugin != call.id || d.generation != call.generation {
            return Err(denied());
        }
        Ok((d.internal_token.clone(), d.path.clone()))
    }
    fn plugin_log_owner(&self, call: &Call, id: &str, grant: &Grant) -> Result<(), Error> {
        let data = self.plugin_host.lock()?;
        let log = data.logs.get(id).ok_or(Error::NotFound)?;
        if log.plugin != call.id || log.generation != call.generation {
            return Err(denied());
        }
        grant.path(&log.path, false)
    }
    async fn plugin_execute(
        &self,
        call: &Call,
        command: String,
        timeout_secs: u16,
    ) -> Result<Value, Error> {
        validate_command(&command, timeout_secs)?;
        let session = self.plugin_ops_session(call)?;
        let cancel = call.cancel.child_token();
        let slot = self.tasks.command_slot(&cancel).await?;
        let mut stdout = String::new();
        let mut stderr = String::new();
        let mut truncated = false;
        let outcome = self
            .tasks
            .execute_command(
                &session,
                &command,
                timeout_secs,
                &cancel,
                slot,
                |chunk, error| {
                    let target = if error { &mut stderr } else { &mut stdout };
                    let remaining = 4096_usize.saturating_sub(target.len());
                    let part = prefix(chunk, remaining);
                    target.push_str(part);
                    if part.len() != chunk.len() {
                        truncated = true;
                        cancel.cancel();
                    }
                },
            )
            .await;
        Ok(
            json!({"state":outcome.state,"exitCode":outcome.code,"message":outcome.message,"stdout":stdout,"stderr":stderr,"truncated":truncated}),
        )
    }
    pub(crate) async fn plugin_stop_resources(&self, id: &str) -> Result<(), Error> {
        self.plugin_cancel_tool_requests(id)?;
        self.plugin_host.stop(id).await?;
        // Drain may finish creating an AI preview after the initial revocation.
        self.plugin_cancel_tool_requests(id)?;
        let monitors = {
            let mut data = self.plugin_host.lock()?;
            let keys: Vec<_> = data
                .monitors
                .iter()
                .filter(|(_, m)| m.plugin == id)
                .map(|(key, _)| key.clone())
                .collect();
            let monitors: Vec<_> = keys
                .iter()
                .filter_map(|key| data.monitors.remove(key))
                .collect();
            data.results.retain(|_, result| result.plugin != id);
            data.shells.retain(|_, ticket| ticket.plugin != id);
            monitors
        };
        for monitor in monitors {
            monitor.backend.shutdown().await;
        }
        let (documents, logs) = {
            let mut data = self.plugin_host.lock()?;
            let docs = data
                .documents
                .iter()
                .filter(|(_, d)| d.plugin == id)
                .map(|(k, d)| (k.clone(), d.internal_token.clone()))
                .collect::<Vec<_>>();
            let logs = data
                .logs
                .iter()
                .filter(|(_, l)| l.plugin == id)
                .map(|(k, _)| k.clone())
                .collect::<Vec<_>>();
            for (key, _) in &docs {
                data.documents.remove(key);
            }
            for key in &logs {
                data.logs.remove(key);
            }
            data.approvals.retain(|_, p| p.public.plugin_id != id);
            (docs, logs)
        };
        let mut errors = Vec::new();
        for (_, token) in documents {
            if let Err(e) = self.files.close_editor(&token, true) {
                errors.push(e);
            }
        }
        for log in logs {
            if let Err(e) = self.operations_host.log_close(&log).await {
                errors.push(e);
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
fn context(call: &Call) -> Result<&state::Context, Error> {
    call.context
        .as_ref()
        .ok_or_else(|| failure("PLUGIN_CONTEXT_REQUIRED", "请先选择并绑定插件工作区主机"))
}
fn validate_command(command: &str, seconds: u16) -> Result<(), Error> {
    if command.is_empty()
        || command.len() > 8192
        || command.contains('\0')
        || !(1..=30).contains(&seconds)
    {
        return Err(Error::Validation("插件命令须为 1–8192 字节，超时 1–30 秒"));
    }
    Ok(())
}
fn prefix(value: &str, limit: usize) -> &str {
    let mut end = value.len().min(limit);
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    &value[..end]
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
        self.0.first().map(|e| e as &dyn std::error::Error)
    }
}
