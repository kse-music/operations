//! The plugin platform executes primitives only; it never interprets service commands or prompts.
use super::{
    state::{self, Call, failure},
    *,
};
use base64::Engine as _;
use serde_json::{Value, json};
use serverdeck_core::Error;
use serverdeck_plugin_core::{
    InstalledPlugin,
    permissions::{Grant, denied},
};
use serverdeck_plugin_sdk::{
    Capability,
    platform::{Command, Request},
};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

fn command_line(command: &Command) -> Result<String, Error> {
    let value = command
        .shell()
        .map_err(|_| Error::Validation("远程程序、参数或超时无效"))?;
    Ok(format!(
        "export LC_ALL=C; export PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin; {value}"
    ))
}
impl Application {
    pub fn plugin_cancel_scope(&self, id: &str, owner: &str) -> Result<(), Error> {
        self.plugin_host.cancel_scope(id, owner)
    }
    pub async fn plugin_scope_visibility(
        &self,
        id: &str,
        owner: &str,
        visible: bool,
    ) -> Result<(), Error> {
        if owner.is_empty() || owner.len() > 512 {
            return Err(Error::Validation("插件页面标识无效"));
        }
        self.plugin_host
            .lock()?
            .visible_owners
            .insert((id.to_owned(), owner.to_owned()), visible);
        if visible {
            self.plugin_host
                .lock()?
                .closed_owners
                .remove(&(id.to_owned(), owner.to_owned()));
        }
        if !visible {
            let streams = self
                .plugin_host
                .lock()?
                .logs
                .iter()
                .filter(|(_, stream)| stream.plugin == id && stream.owner == owner)
                .map(|(id, _)| id.clone())
                .collect::<Vec<_>>();
            for stream in streams {
                self.operations_host.log_close(&stream).await?;
                self.plugin_host.lock()?.logs.remove(&stream);
            }
            let terminals = self
                .plugin_host
                .lock()?
                .open_terminals
                .iter()
                .filter(|(_, terminal)| terminal.plugin == id && terminal.owner == owner)
                .map(|(id, _)| id.clone())
                .collect::<Vec<_>>();
            for terminal in terminals {
                self.terminals.close(&terminal).await?;
                self.plugin_host.lock()?.open_terminals.remove(&terminal);
            }
        }
        Ok(())
    }
    pub(super) fn plugin_scope_visible(&self, call: &Call) -> Result<bool, Error> {
        Ok(self
            .plugin_host
            .lock()?
            .visible_owners
            .get(&(call.id.clone(), call.owner.clone()))
            .copied()
            .unwrap_or(true))
    }
    pub async fn plugin_close_scope(&self, id: &str, owner: &str) -> Result<(), Error> {
        if owner.is_empty() || owner.len() > 512 {
            return Err(Error::Validation("插件页面标识无效"));
        }
        self.plugin_host
            .lock()?
            .closed_owners
            .insert((id.to_owned(), owner.to_owned()));
        self.plugin_host.stop_scope(id, owner).await?;
        self.plugin_close_copies(id, Some(owner)).await?;
        let (documents, streams, terminals) = {
            let mut data = self.plugin_host.lock()?;
            data.continuations
                .retain(|_, pending| pending.plugin != id || pending.owner != owner);
            data.approvals
                .retain(|_, pending| pending.public.plugin_id != id || pending.owner != owner);
            data.results
                .retain(|_, result| result.plugin != id || result.owner != owner);
            data.bindings
                .retain(|_, binding| binding.plugin != id || binding.owner != owner);
            data.outputs
                .retain(|_, result| result.plugin != id || result.owner != owner);
            data.platform_terminals
                .retain(|_, ticket| ticket.plugin != id || ticket.owner != owner);
            (
                data.documents
                    .iter()
                    .filter(|(_, document)| document.plugin == id && document.owner == owner)
                    .map(|(key, document)| (key.clone(), document.internal_token.clone()))
                    .collect::<Vec<_>>(),
                data.logs
                    .iter()
                    .filter(|(_, stream)| stream.plugin == id && stream.owner == owner)
                    .map(|(key, _)| key.clone())
                    .collect::<Vec<_>>(),
                data.open_terminals
                    .iter()
                    .filter(|(_, terminal)| terminal.plugin == id && terminal.owner == owner)
                    .map(|(key, _)| key.clone())
                    .collect::<Vec<_>>(),
            )
        };
        for (key, token) in documents {
            self.files.close_editor(&token, true)?;
            self.plugin_host.lock()?.documents.remove(&key);
        }
        for stream in streams {
            self.operations_host.log_close(&stream).await?;
            self.plugin_host.lock()?.logs.remove(&stream);
        }
        for terminal in terminals {
            self.terminals.close(&terminal).await?;
            self.plugin_host.lock()?.open_terminals.remove(&terminal);
        }
        self.plugin_host
            .lock()?
            .visible_owners
            .remove(&(id.to_owned(), owner.to_owned()));
        self.plugin_host
            .lock()?
            .closed_owners
            .insert((id.to_owned(), owner.to_owned()));
        Ok(())
    }
    pub(super) async fn plugin_platform_session(
        &self,
        call: &Call,
        host: &str,
    ) -> Result<String, Error> {
        if host.is_empty() || host.len() > 128 {
            return Err(Error::Validation("请选择已登记主机"));
        }
        self.plugin_host.verify(call)?;
        let session = self
            .terminals
            .ops_connections()?
            .into_iter()
            .find(|session| session.host_id == host)
            .ok_or_else(|| failure("PLUGIN_SESSION_CLOSED", "目标主机没有已验证的运维连接"))?;
        let engine = self.terminals.clone();
        let target = host.to_owned();
        let lease = session.id.clone();
        self.blocking(move |_| {
            if engine.profile_signature(&target)? != engine.ops_profile(&lease)? {
                return Err(Error::Conflict);
            }
            Ok(())
        })
        .await?;
        self.plugin_host.verify(call)?;
        Ok(session.id)
    }
    pub(super) async fn plugin_platform_capability(
        &self,
        call: &Call,
        plugin: &InstalledPlugin,
        grant: &Grant,
        request: Request,
        bindings: Vec<String>,
    ) -> Result<Value, Error> {
        let cancelled = call
            .user_cancelled
            .load(std::sync::atomic::Ordering::Acquire);
        if cancelled && !request.allowed_after_cancel() {
            return Err(failure("USER_CANCELLED", "动作已取消，未启动新的平台操作"));
        }
        if !cancelled
            && !matches!(
                request,
                Request::ResultRead { .. }
                    | Request::ResultClose { .. }
                    | Request::OutputOpen { .. }
                    | Request::OutputPart { .. }
                    | Request::OutputFinish { .. }
                    | Request::TransferStatus { .. }
                    | Request::TransferCancel { .. }
                    | Request::TransferClose { .. }
            )
        {
            self.plugin_check_bindings(call, &bindings).await?;
        }
        if matches!(
            request,
            Request::TransferPrepare { .. }
                | Request::TransferStart { .. }
                | Request::TransferStatus { .. }
                | Request::TransferCancel { .. }
                | Request::TransferClose { .. }
        ) {
            return self
                .plugin_transfer(call, plugin, grant, request, bindings)
                .await;
        }
        match request {
            Request::ApprovalMode { mode } => {
                let binding =
                    self.plugin_revision_binding(call, state::RevisionTarget::ApprovalMode(mode))?;
                return Ok(json!({"binding":binding,"mode":mode}));
            }
            Request::ConfirmOperations { operations } => {
                return self
                    .plugin_confirm_operations(call, plugin, operations, bindings)
                    .await;
            }
            _ => (),
        }
        let mut binding = None;
        let mut target = None;
        if let Some(host) = request.host() {
            if matches!(request, Request::ReadFile { .. }) {
                if !self.plugin_scope_visible(call)? {
                    return Err(failure("PLUGIN_UI_HIDDEN", "请返回页面读取文件"));
                }
                let session = self.plugin_platform_file_session(call, host).await?;
                binding = Some(self.terminals.lease_profile(&session)?);
                target = Some(self.plugin_session_target(&session)?);
            } else {
                let session = self.plugin_platform_session(call, host).await?;
                binding = Some(self.terminals.ops_profile(&session)?);
                target = Some(self.plugin_session_target(&session)?);
            }
        }
        match &request {
            Request::TcpConnect { target, port } => {
                if *port == 0
                    || target.is_empty()
                    || target.len() > 253
                    || !target
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b".-:_%".contains(&b))
                {
                    return Err(Error::Validation("TCP 目标或端口无效"));
                }
            }
            Request::Execute { command, .. }
            | Request::StreamOpen { command, .. }
            | Request::Terminal { command, .. } => {
                command
                    .validate()
                    .map_err(|_| Error::Validation("远程命令参数无效"))?;
            }
            Request::ReadFile { host_id, path } => {
                if path.chars().any(char::is_control) {
                    return Err(Error::Validation("插件文件路径不能包含控制字符"));
                }
                grant.path(path, false)?;
                let session = self.plugin_platform_file_session(call, host_id).await?;
                let canonical = self.files.canonical_path(&session, path).await?;
                grant.path(&canonical, false)?;
                if canonical != *path {
                    return Err(Error::Validation("插件文件须使用无链接的规范绝对路径"));
                }
            }
            Request::SaveFile {
                document_id,
                content,
            } => {
                if content.len() > 32768 {
                    return Err(failure("PLUGIN_FILE_LIMIT", "插件文本保存超过 32 KiB"));
                }
                let (_, path, host, profile) = self.plugin_platform_document(call, document_id)?;
                self.plugin_file_settings(call, document_id).await?;
                grant.path(&path, true)?;
                let session = self.plugin_platform_file_session(call, &host).await?;
                if self.terminals.lease_profile(&session)? != profile {
                    return Err(Error::Conflict);
                }
                binding = Some(self.terminals.lease_profile(&session)?);
                target = Some(self.plugin_session_target(&session)?);
            }
            _ => (),
        }
        let operation = Capability::Platform {
            request: request.clone(),
            bindings: bindings.clone(),
        };
        if request.needs_confirmation()
            && (call.collecting
                || call.has_batch()?
                || !(grant.preapproves(plugin, &operation)
                    || self.plugin_auto_read(call, plugin, grant, &operation)?))
            && let Some(approval) = self.plugin_confirmation_bound(
                call,
                plugin,
                &operation,
                binding.as_deref(),
                target.as_deref(),
            )?
        {
            if !self.plugin_scope_visible(call)? {
                return Err(failure(
                    "PLUGIN_UI_HIDDEN",
                    "页面已隐藏，不能发起新的操作审批",
                ));
            }
            return Ok(json!({"confirmationRequired":approval}));
        }
        let value=match request {
            Request::TcpConnect {target,port}=>{
                let at=std::time::Instant::now();
                let connection=tokio::select!{_=call.cancel.cancelled()=>return Err(failure("USER_CANCELLED","TCP 连接已取消")),result=tokio::time::timeout(Duration::from_secs(3),tokio::net::TcpStream::connect((target.as_str(),port)))=>result};
                match connection{Ok(Ok(stream))=>{drop(stream);json!({"reachable":true,"milliseconds":at.elapsed().as_secs_f64()*1000.0})},Ok(Err(error))=>return Err(Error::Worker(Box::new(error))),Err(error)=>return Err(Error::Worker(Box::new(error)))}
            }
            Request::Info=>{
                let scope=format!("{}:{}",call.generation,call.owner);
                let mut active=self.plugin_host.lock()?.visible_owners.keys().filter(|(id,_)|id==&call.id).map(|(_,owner)|format!("{}:{}",call.generation,owner)).collect::<Vec<_>>();
                if !active.contains(&scope) {active.push(scope.clone());}
                json!({"unixMs":SystemTime::now().duration_since(UNIX_EPOCH).map_err(|e|Error::Worker(Box::new(e)))?.as_millis() as u64,"nonce":uuid::Uuid::new_v4().to_string(),"pluginId":call.id,"revision":plugin.revision,"scope":scope,"activeScopes":active})
            },
            Request::Hosts=>self.blocking(|db| {
                let catalog=db.catalog()?;
                Ok(json!({"hosts":catalog.hosts.iter().map(|host| json!({"id":host.id,"name":host.config.name,"hostname":host.config.hostname,"port":host.config.port,"username":host.config.username,"description":host.config.description,"groupId":host.config.group_id})).collect::<Vec<_>>(),"groups":catalog.groups}))
            }).await?,
            Request::Host {host_id}=>{
                let engine=self.terminals.clone();let id=host_id.clone();
                let (host,profile)=self.blocking(move|db|{let host=db.host(&id)?;let profile=engine.profile_signature(&id)?;Ok((json!({"id":host.id,"name":host.config.name,"hostname":host.config.hostname,"port":host.config.port,"username":host.config.username}),profile))}).await?;
                let binding=self.plugin_revision_binding(call,state::RevisionTarget::Host {id:host_id,profile})?;
                json!({"host":host,"binding":binding})
            }
            Request::Models=>{
                let mut models=self.ai_models().await?;
                let codex=self.ai_local_codex_status().await?;let claude=self.ai_local_claude_code_status().await?;
                if let Some(model)=codex.model.clone(){models.push(model);}
                if let Some(model)=claude.model.clone(){models.push(model);}
                json!({"models":models,"sources":[{"id":"local-codex","name":"本地 Codex","status":codex},{"id":"local-claude-code","name":"本地 Claude Code","status":claude}]})
            }
            Request::Model {model_id}=>{
                let (record,_)=self.ai_credentials(model_id.clone()).await?;
                let binding=self.plugin_model_binding(call,&model_id,&record.revision)?;
                json!({"model":record.public(),"binding":binding})
            }
            Request::Execute {host_id,command}=>self.plugin_platform_execute(call,&host_id,command,&bindings,binding.as_deref().ok_or(Error::Conflict)?).await?,
            Request::ReadFile {host_id,path}=>{
                if !self.plugin_scope_visible(call)?{return Err(failure("PLUGIN_UI_HIDDEN","页面已隐藏，不能打开新的文件"));}
                let session=self.plugin_platform_file_session(call,&host_id).await?;
                let profile=self.terminals.lease_profile(&session)?;
                let path=self.files.canonical_path(&session,&path).await?;
                grant.path(&path,false)?;
                if self.files.properties(&session,&path).await?.size.is_none_or(|size|size>32768) {return Err(failure("PLUGIN_FILE_LIMIT","插件只可读取不超过 32 KiB 的文本文件"));}
                let expired=self.plugin_host.lock()?.documents.iter().filter(|(_,doc)|!doc.dirty && doc.at.elapsed()>Duration::from_secs(300)).map(|(id,doc)|(id.clone(),doc.internal_token.clone())).collect::<Vec<_>>();
                for (id,token) in expired {self.files.close_editor(&token,true)?;self.plugin_host.lock()?.documents.remove(&id);}
                if self.plugin_host.lock()?.documents.len()>=8 {return Err(Error::Busy);}
                let repo=self.plugins.clone();let plugin_id=call.id.clone();let settings=self.blocking(move |_|repo.settings_read(&plugin_id)).await?;
                let document=self.files.read_text(&session,&path).await?;
                if document.content.len()>32768 {self.files.close_editor(&document.token,true)?;return Err(failure("PLUGIN_FILE_LIMIT","文件在读取期间已超过 32 KiB"));}
                let verified=async{let current=self.plugin_platform_file_session(call,&host_id).await?;if self.terminals.lease_profile(&current)?!=profile{return Err(Error::Conflict);}Ok(())}.await;
                if let Err(error)=verified{self.files.close_editor(&document.token,true)?;return Err(error);}
                if !self.plugin_scope_visible(call)?{self.files.close_editor(&document.token,true)?;return Err(failure("PLUGIN_UI_HIDDEN","页面已隐藏，文件读取已释放"));}
                if let Err(error)=self.plugin_host.verify(call) {self.files.close_editor(&document.token,true)?;return Err(error);}
                let id=uuid::Uuid::new_v4().to_string();
                let value=json!({"id":id,"path":document.path,"content":document.content,"sha256":document.sha256,"atomicSave":document.atomic_save,"permissions":document.permissions});
                if call.user_cancelled.load(std::sync::atomic::Ordering::Acquire) {self.files.close_editor(&document.token,true)?;return Err(failure("USER_CANCELLED","读取已取消，文件句柄已释放"));}
                self.plugin_host.lock()?.documents.insert(id,state::Document {settings,at:Instant::now(),dirty:false,profile,owner:call.owner.clone(),plugin:call.id.clone(),generation:call.generation.clone(),internal_token:document.token,path,host:host_id});
                value
            }
            Request::SaveFile {document_id,content}=>{
                self.plugin_file_settings(call,&document_id).await?;
                let (token,path,host,profile)=self.plugin_platform_document(call,&document_id)?;
                grant.path(&path,true)?;
                let session=self.plugin_platform_file_session(call,&host).await?;
                if self.terminals.lease_profile(&session)?!=profile{return Err(Error::Conflict);}
                let result=self.files.save_text(serverdeck_core::files::SaveText {token:token.clone(),content,confirm_replace:true}).await?;
                if result.document.is_some() {self.files.verify_saved(&token).await?;}
                if result.document.is_some() && let Some(doc)=self.plugin_host.lock()?.documents.get_mut(&document_id) {doc.at=Instant::now();doc.dirty=false;}
                if call.cancel.is_cancelled() {return Err(failure("PLUGIN_SAVE_CANCELLED","已开始的文件保存已安全收尾，请重新读取核对结果"));}
                let current=async{let session=self.plugin_platform_file_session(call,&host).await?;if self.terminals.lease_profile(&session)?!=profile{return Err(Error::Conflict);}Ok(())}.await;
                if let Err(error)=current{return Err(Error::Connection{code:"PLUGIN_TARGET_CHANGED",message:"文件保存已安全收尾，但连接或目标配置已变化，请独立核对保存结果",source:Some(Box::new(error))});}
                match result.document {
                    Some(document)=>json!({"saved":true,"document":{"id":document_id,"path":document.path,"sha256":document.sha256,"atomicSave":document.atomic_save,"permissions":document.permissions},"recoveryPath":null,"message":null}),
                    None=>json!({"saved":false,"document":null,"recoveryPath":result.recovery_path,"message":result.message}),
                }
            }
            Request::CloseFile {document_id,discard}=>{
                let (token,_,_,_)=self.plugin_platform_document(call,&document_id)?;
                self.files.close_editor(&token,discard)?;
                self.plugin_host.lock()?.documents.remove(&document_id);Value::Null
            }
            Request::FileDirty {document_id,dirty}=>{
                let (token,path,_,_)=self.plugin_platform_document(call,&document_id)?;
                grant.path(&path,true)?;
                self.files.editor_dirty(&token,dirty)?;
                if let Some(doc)=self.plugin_host.lock()?.documents.get_mut(&document_id) {doc.at=Instant::now();doc.dirty=dirty;}
                Value::Null
            }
            Request::StreamOpen {host_id,command}=>{
                if !self.plugin_scope_visible(call)?{return Err(failure("PLUGIN_UI_HIDDEN","页面已隐藏，不能打开新的输出流"));}
                let session=self.plugin_platform_session(call,&host_id).await?;
                if self.plugin_host.lock()?.logs.len()>=8 {return Err(Error::Busy);}
                let profile=self.terminals.ops_profile(&session)?;
                if binding.as_deref()!=Some(profile.as_str()){return Err(Error::Conflict);}
                let (sender,receiver)=tokio::sync::mpsc::channel(8);
                let log=self.operations_host.command_stream(&session,command_line(&command)?,Arc::new(move|event|{
                    use serverdeck_core::ops::LogEvent;
                    let value=match event {
                        LogEvent::State {state,code,message}=>json!({"type":"state","state":state,"code":code,"message":message}),
                        LogEvent::Data {sequence,stream,data,at}=>json!({"type":"data","sequence":sequence,"stream":stream,"dataBase64":base64::engine::general_purpose::STANDARD.encode(data),"at":at}),
                    };
                    sender.try_send(value).is_ok()
                }))?;
                if let Err(error)=self.plugin_host.verify(call){self.operations_host.log_close(&log.id).await?;return Err(error);}
                if !self.plugin_scope_visible(call)?{self.operations_host.log_close(&log.id).await?;return Err(failure("PLUGIN_UI_HIDDEN","页面已隐藏，输出流已释放"));}
                self.plugin_host.lock()?.logs.insert(log.id.clone(),state::Log {profile,owner:call.owner.clone(),plugin:call.id.clone(),generation:call.generation.clone(),host:host_id,receiver});
                json!({"id":log.id})
            }
            Request::Terminal {host_id,command}=>{
                if !self.plugin_scope_visible(call)?{return Err(failure("PLUGIN_UI_HIDDEN","页面已隐藏，不能打开新的终端"));}
                let session=self.plugin_platform_session(call,&host_id).await?;
                let profile=self.terminals.ops_profile(&session)?;
                if binding.as_deref()!=Some(profile.as_str()){return Err(Error::Conflict);}
                let mut data=self.plugin_host.lock()?;
                data.platform_terminals.retain(|_,ticket|ticket.at.elapsed()<Duration::from_secs(60));
                if data.platform_terminals.len()>=32 {return Err(Error::Busy);}
                let ticket=uuid::Uuid::new_v4().to_string();
                data.platform_terminals.insert(ticket.clone(),state::PlatformTerminalTicket {plugin:call.id.clone(),owner:call.owner.clone(),generation:call.generation.clone(),revision:plugin.revision.clone(),host:host_id.clone(),profile,command,bindings,at:std::time::Instant::now()});
                json!({"ticket":ticket,"hostId":host_id})
            }
            Request::StreamPoll {stream_id}=>{
                self.plugin_platform_stream_owner(call,&stream_id)?;
                self.plugin_platform_stream_session(call,&stream_id).await?;
                let mut events=Vec::new();
                {let mut data=self.plugin_host.lock()?;let stream=data.logs.get_mut(&stream_id).ok_or(Error::NotFound)?;while let Ok(event)=stream.receiver.try_recv(){events.push(event);}}
                for event in &events {if let Some(sequence)=event["sequence"].as_u64(){self.operations_host.log_ack(&stream_id,sequence)?;}}
                json!({"events":events})
            }
            Request::StreamPause {stream_id,paused}=>{self.plugin_platform_stream_session(call,&stream_id).await?;self.operations_host.log_pause(&stream_id,paused)?;Value::Null}
            Request::StreamStop {stream_id}=>{
                self.plugin_platform_stream_owner(call,&stream_id)?;
                self.operations_host.log_close(&stream_id).await?;
                self.plugin_host.lock()?.logs.remove(&stream_id);Value::Null
            }
            Request::ModelComplete {model_id,expected_revision,mut messages}=>{
                if messages.is_empty() || messages.len()>64 || messages.iter().any(|message|message.content.len()>48*1024)
                    || serde_json::to_vec(&messages).map_err(|e|Error::Worker(Box::new(e)))?.len()>48*1024 {return Err(Error::Validation("模型消息超过平台限制"));}
                let (record,key)=self.ai_credentials(model_id.clone()).await?;
                if expected_revision.as_ref().is_some_and(|revision|revision!=&record.revision) {return Err(Error::Conflict);}
                let model_call=self.models_runtime.begin(&model_id)?;
                let (current,_)=self.ai_credentials(model_id.clone()).await?;
                if current.revision!=record.revision{return Err(Error::Conflict);}
                if record.config.provider==serverdeck_core::ai::Provider::OpenaiCompatible&&let Ok(secret)=std::str::from_utf8(&key)&&!secret.is_empty(){for message in &mut messages{message.content=message.content.replace(secret,"[REDACTED]");}}
                let body=json!({"model":record.config.model,"messages":messages,"max_completion_tokens":record.config.max_output_tokens,"stream":false,"store":false});
                let work=serverdeck_ai::provider::complete(&record.config,&key,&body);
                let completion=tokio::select! {
                    _=model_call.cancel.cancelled()=>return Err(Error::Conflict),
                    result=tokio::time::timeout(Duration::from_secs(150),work)=>result.map_err(|_|failure("MODEL_TIMEOUT","模型调用超时"))??,
                    _=call.cancel.cancelled()=>return Err(if call.user_cancelled.load(std::sync::atomic::Ordering::Acquire){failure("USER_CANCELLED","模型调用已取消")}else{failure("PLUGIN_CANCELLED","模型调用已停止")}),
                };
                let (current,_)=self.ai_credentials(model_id).await?;
                if current.revision!=record.revision {return Err(Error::Conflict);}
                let binding=self.plugin_model_binding(call,&record.id,&record.revision)?;
                json!({"text":completion.text,"usage":completion.usage,"incomplete":completion.incomplete,"binding":binding})
            }
            Request::SettingsRead=>{let repo=self.plugins.clone();let id=call.id.clone();self.blocking(move|_|repo.settings_read(&id)).await?},
            Request::SettingsWrite {value}=>{let repo=self.plugins.clone();let id=call.id.clone();self.blocking(move|_|repo.settings_write(&id,&value)).await?;Value::Null}
            Request::Notify {message}=>{
                if message.len()>2048 {return Err(Error::Validation("插件提示超过长度限制"));}
                self.plugin_host.event(state::Event {plugin_id:call.id.clone(),kind:"notification".into(),operation:"ui.notify".into(),message})?;Value::Null
            }
            Request::ResultRead {result_id,chunk}=>self.plugin_result_read(call,&result_id,chunk)?,
            Request::ResultClose {result_id}=>{
                {
                    let mut data=self.plugin_host.lock()?;
                    if let Some(output)=data.outputs.get(&result_id){if output.plugin!=call.id||output.owner!=call.owner||output.generation!=call.generation{return Err(denied());}data.outputs.remove(&result_id);}
                }
                self.plugin_result_close(call,&result_id)?
            }
            Request::OutputOpen {bytes}=>{
                if bytes==0||bytes>1024*1024{return Err(Error::Validation("插件输出须为 1 字节至 1 MiB"));}
                let mut data=self.plugin_host.lock()?;
                data.outputs.retain(|_,output|output.at.elapsed()<Duration::from_secs(60));
                if data.outputs.len()>=8||data.outputs.values().map(|output|output.expected).sum::<usize>()+bytes as usize>8*1024*1024{return Err(Error::Busy);}
                let id=uuid::Uuid::new_v4().to_string();
                data.outputs.insert(id.clone(),state::OutputData {plugin:call.id.clone(),owner:call.owner.clone(),generation:call.generation.clone(),expected:bytes as usize,bytes:Vec::new(),at:std::time::Instant::now()});
                json!({"id":id})
            }
            Request::OutputPart {result_id,offset,data_base64}=>{
                if data_base64.len()>43700{return Err(Error::Validation("插件输出分块超过限制"));}
                let bytes=base64::engine::general_purpose::STANDARD.decode(data_base64).map_err(|_|Error::Validation("插件输出分块编码无效"))?;
                if bytes.is_empty()||bytes.len()>32768{return Err(Error::Validation("插件输出分块大小无效"));}
                let mut data=self.plugin_host.lock()?;let output=data.outputs.get_mut(&result_id).ok_or(Error::NotFound)?;
                if output.plugin!=call.id||output.owner!=call.owner||output.generation!=call.generation||output.at.elapsed()>Duration::from_secs(60){return Err(denied());}
                if offset as usize!=output.bytes.len()||output.bytes.len()+bytes.len()>output.expected{return Err(Error::Validation("插件输出分块顺序或长度无效"));}
                output.bytes.extend_from_slice(&bytes);Value::Null
            }
            Request::OutputFinish {result_id}=>{
                let mut data=self.plugin_host.lock()?;
                let output=data.outputs.get(&result_id).ok_or(Error::NotFound)?;
                if output.plugin!=call.id||output.owner!=call.owner||output.generation!=call.generation||output.at.elapsed()>Duration::from_secs(60){return Err(denied());}
                if output.bytes.len()!=output.expected||serde_json::from_slice::<Value>(&output.bytes).is_err(){return Err(Error::Validation("插件输出不完整或不是有效 JSON"));}
                if data.results.len()>=8{return Err(Error::Busy);}
                let output=data.outputs.remove(&result_id).ok_or(Error::NotFound)?;
                let bytes=output.bytes.len();let chunks=bytes.div_ceil(32768);
                data.results.insert(result_id.clone(),state::ResultData {owner:call.owner.clone(),plugin:call.id.clone(),generation:call.generation.clone(),bytes:output.bytes,at:std::time::Instant::now()});
                json!({"__pluginResult":{"id":result_id,"bytes":bytes,"chunks":chunks}})
            }
            Request::ApprovalMode {..}|Request::ConfirmOperations {..}|Request::TransferPrepare {..}|Request::TransferStart {..}|Request::TransferStatus {..}|Request::TransferCancel {..}|Request::TransferClose {..}=>return Err(Error::Validation("传输请求未进入任务路由")),
        };
        self.plugin_host.verify(call)?;
        self.plugin_authorize(call, &operation).await?;
        if matches!(
            operation,
            Capability::Platform {
                request: Request::ResultRead { .. }
                    | Request::ResultClose { .. }
                    | Request::OutputOpen { .. }
                    | Request::OutputPart { .. }
                    | Request::OutputFinish { .. },
                ..
            }
        ) {
            Ok(value)
        } else {
            self.plugin_result(call, value)
        }
    }
    async fn plugin_platform_execute(
        &self,
        call: &Call,
        host: &str,
        command: Command,
        bindings: &[String],
        expected_profile: &str,
    ) -> Result<Value, Error> {
        let session = self.plugin_platform_session(call, host).await?;
        if self.terminals.ops_profile(&session)? != expected_profile {
            return Err(Error::Conflict);
        }
        let line = command_line(&command)?;
        let cancel = call.cancel.child_token();
        let slot = self.tasks.command_slot(&cancel).await?;
        self.plugin_check_bindings(call, bindings).await?;
        let current = self.plugin_platform_session(call, host).await?;
        if self.terminals.ops_profile(&current)? != expected_profile {
            return Err(Error::Conflict);
        }
        let mut stdout = String::new();
        let mut stderr = String::new();
        let mut truncated = false;
        let outcome = self
            .tasks
            .execute_command(
                &session,
                &line,
                command.timeout_secs,
                &cancel,
                slot,
                |chunk, error| {
                    let output = if error { &mut stderr } else { &mut stdout };
                    let remaining = (256 * 1024_usize).saturating_sub(output.len());
                    let mut end = remaining.min(chunk.len());
                    while !chunk.is_char_boundary(end) {
                        end -= 1;
                    }
                    output.push_str(&chunk[..end]);
                    if end < chunk.len() {
                        truncated = true;
                        cancel.cancel();
                    }
                },
            )
            .await;
        if call
            .user_cancelled
            .load(std::sync::atomic::Ordering::Acquire)
        {
            return Err(failure(
                "USER_CANCELLED",
                "动作已取消；远端命令可能已经执行，请核对实际状态",
            ));
        }
        let current = async {
            let session = self.plugin_platform_session(call, host).await?;
            if self.terminals.ops_profile(&session)? != expected_profile {
                return Err(Error::Conflict);
            }
            Ok(())
        }
        .await;
        if let Err(error) = current {
            return Err(Error::Connection {
                code: "PLUGIN_TARGET_CHANGED",
                message: "连接或目标配置在执行期间变化，命令可能已执行，请独立核对实际状态",
                source: Some(Box::new(error)),
            });
        }
        Ok(
            json!({"state":outcome.state,"exitCode":outcome.code,"message":outcome.message,"stdout":stdout,"stderr":stderr,"truncated":truncated}),
        )
    }
    pub(super) fn plugin_session_target(&self, id: &str) -> Result<String, Error> {
        let endpoint = self
            .terminals
            .connection_status()?
            .into_iter()
            .find(|status| status.id == id)
            .ok_or(Error::NotFound)?;
        let hostname = if endpoint.hostname.contains(':') {
            format!("[{}]", endpoint.hostname)
        } else {
            endpoint.hostname
        };
        Ok(format!(
            "{}@{hostname}:{}",
            endpoint.username, endpoint.port
        ))
    }
    pub(super) async fn plugin_platform_file_session(
        &self,
        call: &Call,
        host: &str,
    ) -> Result<String, Error> {
        let session = self
            .terminals
            .login_file_connections()?
            .into_iter()
            .find(|session| session.host_id == host);
        let session = match session {
            Some(session) => session,
            None => self.plugin_open_file_connection(call, host).await?,
        };
        let engine = self.terminals.clone();
        let host = host.to_owned();
        let id = session.id.clone();
        self.blocking(move |_| {
            if engine.profile_signature(&host)? != engine.lease_profile(&id)? {
                return Err(Error::Conflict);
            }
            Ok(())
        })
        .await?;
        self.plugin_host.verify(call)?;
        Ok(session.id)
    }
    fn plugin_platform_document(
        &self,
        call: &Call,
        id: &str,
    ) -> Result<(String, String, String, String), Error> {
        let data = self.plugin_host.lock()?;
        let document = data.documents.get(id).ok_or(Error::NotFound)?;
        if document.plugin != call.id
            || document.generation != call.generation
            || document.owner != call.owner
        {
            return Err(denied());
        }
        Ok((
            document.internal_token.clone(),
            document.path.clone(),
            document.host.clone(),
            document.profile.clone(),
        ))
    }
    async fn plugin_file_settings(&self, call: &Call, id: &str) -> Result<(), Error> {
        self.plugin_platform_document(call, id)?;
        let expected = self
            .plugin_host
            .lock()?
            .documents
            .get(id)
            .ok_or(Error::NotFound)?
            .settings
            .clone();
        let repo = self.plugins.clone();
        let plugin_id = call.id.clone();
        if self
            .blocking(move |_| repo.settings_read(&plugin_id))
            .await?
            != expected
        {
            return Err(Error::Conflict);
        }
        Ok(())
    }
    fn plugin_platform_stream_owner(&self, call: &Call, id: &str) -> Result<(), Error> {
        let data = self.plugin_host.lock()?;
        let stream = data.logs.get(id).ok_or(Error::NotFound)?;
        if stream.plugin != call.id
            || stream.generation != call.generation
            || stream.owner != call.owner
        {
            return Err(denied());
        }
        Ok(())
    }
    async fn plugin_platform_stream_session(&self, call: &Call, id: &str) -> Result<(), Error> {
        self.plugin_platform_stream_owner(call, id)?;
        let (host, profile) = {
            let data = self.plugin_host.lock()?;
            let stream = data.logs.get(id).ok_or(Error::NotFound)?;
            (stream.host.clone(), stream.profile.clone())
        };
        let session = self.plugin_platform_session(call, &host).await?;
        if self.terminals.ops_profile(&session)? != profile {
            self.operations_host.log_close(id).await?;
            self.plugin_host.lock()?.logs.remove(id);
            return Err(Error::Conflict);
        }
        Ok(())
    }
    pub async fn plugin_platform_terminal_open(
        &self,
        id: &str,
        owner: &str,
        ticket: &str,
        expected_host: &str,
        size: serverdeck_core::terminal::TerminalSize,
        sink: serverdeck_ssh::Sink,
    ) -> Result<serverdeck_core::terminal::TerminalSession, Error> {
        size.validate()?;
        let call = self.plugin_host.start_scoped(id, owner)?;
        let plugin = self.plugin_detail(id.to_owned()).await?;
        let pending = {
            let mut data = self.plugin_host.lock()?;
            let value = data.platform_terminals.get(ticket).ok_or(Error::NotFound)?;
            if value.plugin != id
                || value.owner != owner
                || value.generation != call.generation
                || value.revision != plugin.revision
                || value.host != expected_host
                || value.at.elapsed() > Duration::from_secs(60)
            {
                return Err(denied());
            }
            data.platform_terminals
                .remove(ticket)
                .ok_or(Error::NotFound)?
        };
        let operation = Capability::Platform {
            request: Request::Terminal {
                host_id: pending.host.clone(),
                command: pending.command.clone(),
            },
            bindings: Vec::new(),
        };
        self.plugin_authorize(&call, &operation).await?;
        self.plugin_check_bindings(&call, &pending.bindings).await?;
        if !self.plugin_scope_visible(&call)? {
            return Err(failure("PLUGIN_UI_HIDDEN", "页面已隐藏，终端票据已失效"));
        }
        let current = self.plugin_platform_session(&call, &pending.host).await?;
        if self.terminals.ops_profile(&current)? != pending.profile {
            return Err(Error::Conflict);
        }
        let secrets = self.secrets.clone();
        let engine = self.terminals.clone();
        let host_id = pending.host.clone();
        let expected_profile = pending.profile;
        let (host, plan) = self
            .blocking(move |db| {
                let result =
                    super::super::terminal::connection_plan(&db, secrets.as_ref(), &host_id)?;
                if engine.profile_signature(&host_id)? != expected_profile {
                    return Err(Error::Conflict);
                }
                Ok(result)
            })
            .await?;
        let session = self.terminals.open_command_terminal_plan(
            host,
            plan,
            size,
            sink,
            command_line(&pending.command)?,
        )?;
        if let Err(error) = self.plugin_host.verify(&call) {
            self.terminals.close(&session.id).await?;
            return Err(error);
        }
        if !self.plugin_scope_visible(&call)? {
            self.terminals.close(&session.id).await?;
            return Err(failure("PLUGIN_UI_HIDDEN", "页面已隐藏，终端已释放"));
        }
        let mut data = self.plugin_host.lock()?;
        data.open_terminals
            .retain(|key, _| self.terminals.session_info(key).is_ok());
        data.open_terminals.insert(
            session.id.clone(),
            state::PlatformTerminalOwner {
                plugin: id.to_owned(),
                owner: owner.to_owned(),
            },
        );
        Ok(session)
    }

    fn plugin_model_binding(
        &self,
        call: &Call,
        model: &str,
        revision: &str,
    ) -> Result<String, Error> {
        self.plugin_revision_binding(
            call,
            state::RevisionTarget::Model {
                id: model.to_owned(),
                revision: revision.to_owned(),
            },
        )
    }
    fn plugin_revision_binding(
        &self,
        call: &Call,
        target: state::RevisionTarget,
    ) -> Result<String, Error> {
        let mut data = self.plugin_host.lock()?;
        data.bindings
            .retain(|_, binding| binding.at.elapsed() < Duration::from_secs(600));
        if let Some((id, binding)) = data.bindings.iter_mut().find(|(_, binding)| {
            binding.plugin == call.id
                && binding.owner == call.owner
                && binding.generation == call.generation
                && binding.target == target
        }) {
            binding.at = std::time::Instant::now();
            return Ok(id.clone());
        }
        if data.bindings.len() >= 256 {
            return Err(Error::Busy);
        }
        let id = uuid::Uuid::new_v4().to_string();
        data.bindings.insert(
            id.clone(),
            state::RevisionBinding {
                plugin: call.id.clone(),
                owner: call.owner.clone(),
                generation: call.generation.clone(),
                target,
                at: std::time::Instant::now(),
            },
        );
        Ok(id)
    }
    async fn plugin_check_bindings(&self, call: &Call, bindings: &[String]) -> Result<(), Error> {
        let expected = self.plugin_binding_targets(call, bindings)?;
        self.plugin_verify_targets(expected).await?;
        self.plugin_host.verify(call)
    }
    pub(super) fn plugin_binding_targets(
        &self,
        call: &Call,
        bindings: &[String],
    ) -> Result<Vec<state::RevisionTarget>, Error> {
        if bindings.len() > 16 {
            return Err(Error::Validation("平台修订绑定超过限制"));
        }
        let expected = {
            let data = self.plugin_host.lock()?;
            bindings
                .iter()
                .map(|id| {
                    let binding = data.bindings.get(id).ok_or(Error::NotFound)?;
                    if binding.plugin != call.id
                        || binding.owner != call.owner
                        || binding.generation != call.generation
                        || binding.at.elapsed() > Duration::from_secs(600)
                    {
                        return Err(denied());
                    }
                    Ok(binding.target.clone())
                })
                .collect::<Result<Vec<_>, Error>>()?
        };
        Ok(expected)
    }
    pub(super) async fn plugin_verify_targets(
        &self,
        expected: Vec<state::RevisionTarget>,
    ) -> Result<(), Error> {
        for target in expected {
            match target {
                state::RevisionTarget::ApprovalMode(_) => (),
                state::RevisionTarget::Model { id, revision } => {
                    let (record, _) = self.ai_credentials(id).await?;
                    if record.revision != revision {
                        return Err(Error::Conflict);
                    }
                }
                state::RevisionTarget::Host { id, profile } => {
                    let engine = self.terminals.clone();
                    self.blocking(move |_| {
                        if engine.profile_signature(&id)? != profile {
                            return Err(Error::Conflict);
                        }
                        Ok(())
                    })
                    .await?;
                }
            }
        }
        Ok(())
    }
}
