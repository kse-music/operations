use super::{
    state::{ActiveToolInput, Call, ToolAiResource, ToolInputResource, failure},
    *,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use serverdeck_core::{ai, tasks};
use serverdeck_plugin_core::{InstalledPlugin, permissions::denied};
use serverdeck_plugin_sdk::{Capability, tools::Operation};
use std::{
    collections::{BTreeSet, HashMap},
    time::{Duration, Instant},
};

/// The trusted Host bridge validates these inputs and obtains native approval when
/// required. Wasm receives an immutable single-use ticket, never a private lease,
/// API key or native IPC name.
#[derive(Deserialize)]
#[serde(
    tag = "operation",
    content = "args",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ToolInput {
    AiResolveHosts {
        input: ai::ResolveHostsInput,
    },
    AiPrepare {
        input: ai::PrepareInput,
    },
    AiSend {
        id: String,
        confirmed: bool,
    },
    AiExecute {
        input: ai::ExecuteInput,
    },
    DiagnosticStart {
        input: tasks::DiagnosticInput,
    },
    DiagnosticList {
        #[serde(default)]
        versions: HashMap<String, u64>,
    },
    DiagnosticCancel {
        id: String,
    },
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use serverdeck_plugin_core::{InstallInput, permissions::GrantInput};
    fn app() -> (tempfile::TempDir, Application) {
        let dir = tempfile::tempdir().unwrap();
        let app =
            Application::initialize(dir.path().join("data"), dir.path().join("logs")).unwrap();
        app.provision_bundled_plugins().unwrap();
        (dir, app)
    }
    async fn ready(app: &Application, id: &str) {
        app.plugin_set_enabled(id.into(), true).await.unwrap();
    }
    async fn invoke(
        app: &Application,
        id: &str,
        ticket: &ToolTicket,
    ) -> serverdeck_plugin_runtime::protocol::Reply {
        use base64::Engine as _;
        let mut reply=app.plugin_call(id, json!({"action":"bridge", "values":{"request":serde_json::to_string(&Capability::ToolInvoke {input_id:ticket.input_id.clone(), operation:ticket.operation}).unwrap()}})).await.unwrap();
        if let Some(descriptor) = reply.result.get("__pluginResult").cloned() {
            let result_id = descriptor["id"].as_str().unwrap();
            let mut bytes = Vec::new();
            for chunk in 0..descriptor["chunks"].as_u64().unwrap() {
                tokio::time::sleep(Duration::from_millis(65)).await;
                let part = app
                    .plugin_capability(
                        id,
                        serverdeck_plugin_sdk::Request {
                            api_version: 1,
                            request_id: uuid::Uuid::new_v4().to_string(),
                            operation: Capability::ResultRead {
                                result_id: result_id.into(),
                                chunk: chunk as u32,
                            },
                        },
                    )
                    .await
                    .unwrap();
                assert!(part.error.is_none(), "{:?}", part.error);
                bytes.extend(
                    base64::engine::general_purpose::STANDARD
                        .decode(part.result["dataBase64"].as_str().unwrap())
                        .unwrap(),
                );
            }
            assert_eq!(bytes.len(), descriptor["bytes"].as_u64().unwrap() as usize);
            app.plugin_capability(
                id,
                serverdeck_plugin_sdk::Request {
                    api_version: 1,
                    request_id: uuid::Uuid::new_v4().to_string(),
                    operation: Capability::ResultClose {
                        result_id: result_id.into(),
                    },
                },
            )
            .await
            .unwrap();
            reply.result = serde_json::from_slice(&bytes).unwrap();
        }
        reply
    }
    #[tokio::test]
    async fn real_wasm_tools_execute_host_services_and_validate_inputs() {
        let (_dir, app) = app();
        for (id, operation) in [("services", "diagnostic_list")] {
            let id = format!("cn.hiboot.plugins.{id}");
            ready(&app, &id).await;
            let ticket = tokio::time::timeout(
                Duration::from_secs(2),
                app.plugin_tool_stage(id.clone(), json!({"operation":operation,"args":{}})),
            )
            .await
            .unwrap()
            .unwrap();
            let reply = invoke(&app, &id, &ticket).await;
            assert!(reply.error.is_none(), "{:?}", reply.error);
            assert!(reply.result.is_array() || reply.result.get("entries").is_some());
            assert!(
                invoke(&app, &id, &ticket).await.error.is_some(),
                "tickets are single-use"
            );
        }
        let id = "cn.hiboot.plugins.assistant";
        ready(&app, id).await;
        assert!(
            app.plugin_tool_stage(
                id.into(),
                json!({"operation":"ai_send","args":{"id":"forged-preview","confirmed":true}})
            )
            .await
            .is_err()
        );
        assert!(
            app.plugin_tool_stage(
                id.into(),
                json!({"operation":"ai_model_save","args":{"apiKey":"must-not-be-accepted"}})
            )
            .await
            .is_err()
        );
        for operation in ["batch_start", "automation_catalog"] {
            assert!(
                app.plugin_tool_stage(
                    "cn.hiboot.plugins.services".into(),
                    json!({"operation":operation,"args":{}})
                )
                .await
                .is_err()
            );
        }
        app.shutdown().await;
    }
    #[tokio::test]
    async fn tickets_bind_owner_revision_generation_operation_expiry_and_quotas() {
        let (dir, app) = app();
        let system = "cn.hiboot.plugins.services";
        ready(&app, system).await;
        let mut package: Value = serde_json::from_slice(include_bytes!(
            "../../../../plugins/system/packages/services.sdplugin"
        ))
        .unwrap();
        package["manifest"]["id"] = json!("dev.upload-network");
        let path = dir.path().join("upload.sdplugin");
        std::fs::write(&path, serde_json::to_vec(&package).unwrap()).unwrap();
        let upload = app
            .plugin_install(InstallInput {
                path,
                development_confirmed: true,
                expected_version: None,
                expected_digest: None,
            })
            .await
            .unwrap();
        assert!(
            app.plugin_permissions(upload.manifest.id.clone())
                .await
                .unwrap()
                .is_none()
        );
        ready(&app, &upload.manifest.id).await;
        app.plugin_grant(
            upload.manifest.id.clone(),
            GrantInput {
                expected_revision: upload.revision,
                permissions: upload.manifest.permissions,
                host_ids: vec![],
                operations: vec!["network.run".into(), "ui.contribute".into()],
                read_roots: vec![],
                write_roots: vec![],
                confirmed: true,
            },
        )
        .await
        .unwrap();
        let input = || json!({"operation":"diagnostic_list","args":{}});
        let ticket = app.plugin_tool_stage(system.into(), input()).await.unwrap();
        assert!(
            invoke(&app, &upload.manifest.id, &ticket)
                .await
                .error
                .is_some()
        );
        let forged = ToolTicket {
            input_id: ticket.input_id.clone(),
            operation: Operation::DiagnosticCancel,
            review: None,
        };
        assert!(invoke(&app, system, &forged).await.error.is_some());
        assert!(invoke(&app, system, &ticket).await.error.is_none());
        let expired = app.plugin_tool_stage(system.into(), input()).await.unwrap();
        app.plugin_host
            .lock()
            .unwrap()
            .tool_inputs
            .get_mut(&expired.input_id)
            .unwrap()
            .at = Instant::now() - Duration::from_secs(61);
        assert!(invoke(&app, system, &expired).await.error.is_some());
        let old = app.plugin_tool_stage(system.into(), input()).await.unwrap();
        app.plugin_clear_context(system.into()).await.unwrap();
        assert_eq!(
            app.plugin_statuses()
                .unwrap()
                .iter()
                .find(|status| status.id == system)
                .unwrap()
                .state,
            serverdeck_plugin_runtime::protocol::State::Stopped,
        );
        app.plugin_activate(system).await.unwrap();
        assert!(invoke(&app, system, &old).await.error.is_some());
        let first = app.plugin_tool_stage(system.into(), input()).await.unwrap();
        app.plugin_tool_stage(system.into(), input()).await.unwrap();
        assert!(matches!(
            app.plugin_tool_stage(system.into(), input()).await,
            Err(Error::Busy)
        ));
        app.plugin_cancel(system).unwrap();
        let replay = app
            .plugin_capability(
                system,
                serverdeck_plugin_sdk::Request {
                    api_version: 1,
                    request_id: "cancelled-input".into(),
                    operation: Capability::ToolInvoke {
                        input_id: first.input_id,
                        operation: first.operation,
                    },
                },
            )
            .await;
        assert!(replay.is_err() || replay.unwrap().error.is_some());
        app.plugin_set_enabled(system.into(), false).await.unwrap();
        assert!(app.plugin_tool_stage(system.into(), input()).await.is_err());
        app.shutdown().await;
    }
    #[tokio::test]
    async fn ai_references_cannot_cross_plugins_and_stop_revokes_only_owned_resources() {
        let (_dir, app) = app();
        let id = "cn.hiboot.plugins.assistant";
        ready(&app, id).await;
        let generation = app.plugin_host.generation(id).unwrap();
        app.register_ai(
            id,
            &generation,
            "request-a",
            ["request-a".into(), "proposal-a".into()],
        )
        .unwrap();
        app.register_ai(
            "another-plugin",
            "another-generation",
            "request-b",
            ["request-b".into()],
        )
        .unwrap();
        assert!(
            app.plugin_ai_owner("another-plugin", "another-generation", "proposal-a")
                .is_err()
        );
        assert!(app.plugin_tool_cancel_request(id, "request-b").is_err());
        app.plugin_set_enabled(id.into(), false).await.unwrap();
        {
            let data = app.plugin_host.lock().unwrap();
            assert!(!data.tool_ai.contains_key("request-a"));
            assert!(!data.tool_ai.contains_key("proposal-a"));
            assert!(data.tool_ai.contains_key("request-b"));
        }
        app.shutdown().await;
    }
    #[tokio::test]
    async fn abort_targets_owned_inputs_and_never_cancels_a_new_call_or_the_vm() {
        let (_dir, app) = app();
        let id = "cn.hiboot.plugins.services";
        ready(&app, id).await;
        let stage = || json!({"operation":"diagnostic_list","args":{}});
        let ticket = app.plugin_tool_stage(id.into(), stage()).await.unwrap();
        assert!(
            app.plugin_tool_abort_input("cn.hiboot.plugins.assistant", &ticket.input_id)
                .is_err()
        );
        app.plugin_tool_abort_input(id, &ticket.input_id).unwrap();
        assert!(invoke(&app, id, &ticket).await.error.is_some());
        let next = app.plugin_tool_stage(id.into(), stage()).await.unwrap();
        assert!(
            invoke(&app, id, &next).await.error.is_none(),
            "abort must leave the WASM VM usable"
        );
        let generation = app.plugin_host.generation(id).unwrap();
        app.plugin_host.lock().unwrap().tool_active.insert(
            id.into(),
            ActiveToolInput {
                input_id: "old".into(),
                generation: generation.clone(),
                ai_request: None,
            },
        );
        app.register_ai(id, &generation, "old-root", ["old-preview".into()])
            .unwrap();
        app.plugin_host.lock().unwrap().tool_active.insert(
            id.into(),
            ActiveToolInput {
                input_id: "new".into(),
                generation: generation.clone(),
                ai_request: None,
            },
        );
        app.register_ai(id, &generation, "new-root", ["new-preview".into()])
            .unwrap();
        let current_call = app.plugin_host.start(id).unwrap();
        app.plugin_tool_abort_input(id, "old").unwrap();
        app.plugin_host.verify(&current_call).unwrap();
        {
            let data = app.plugin_host.lock().unwrap();
            assert!(!data.tool_ai.contains_key("old-preview"));
            assert!(data.tool_ai.contains_key("new-preview"));
            assert_eq!(data.tool_active[id].input_id, "new");
            assert!(super::super::state::Host::current(&data, id, &generation));
        }
        app.plugin_host.cancel(id).unwrap();
        assert!(
            app.plugin_register_ai(
                &current_call,
                "cancelled-root",
                ["cancelled-preview".into()]
            )
            .is_err()
        );
        assert!(
            !app.plugin_host
                .lock()
                .unwrap()
                .tool_ai
                .contains_key("cancelled-preview")
        );
        drop(current_call);
        app.plugin_host.lock().unwrap().tool_active.remove(id);
        app.shutdown().await;
    }
}
impl ToolInput {
    fn operation(&self) -> Operation {
        match self {
            Self::AiResolveHosts { .. } => Operation::AiResolveHosts,
            Self::AiPrepare { .. } => Operation::AiPrepare,
            Self::AiSend { .. } => Operation::AiSend,
            Self::AiExecute { .. } => Operation::AiExecute,
            Self::DiagnosticStart { .. } => Operation::DiagnosticStart,
            Self::DiagnosticList { .. } => Operation::DiagnosticList,
            Self::DiagnosticCancel { .. } => Operation::DiagnosticCancel,
        }
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolTicket {
    pub input_id: String,
    pub operation: Operation,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub review: Option<super::review::ToolReview>,
}
struct ActiveInputGuard {
    host: super::state::Host,
    plugin: String,
    input_id: String,
}
impl Drop for ActiveInputGuard {
    fn drop(&mut self) {
        match self.host.lock() {
            Ok(mut data) => {
                if data
                    .tool_active
                    .get(&self.plugin)
                    .is_some_and(|a| a.input_id == self.input_id)
                {
                    data.tool_active.remove(&self.plugin);
                }
            }
            Err(_) => tracing::error!(
                operation = "plugin_tool_release",
                "plugin state lock poisoned"
            ),
        }
    }
}

impl Application {
    pub async fn plugin_tool_stage(&self, id: String, input: Value) -> Result<ToolTicket, Error> {
        if self.shutting_down.load(Ordering::Acquire) {
            return Err(Error::ShuttingDown);
        }
        let bytes = serde_json::to_vec(&input)
            .map_err(|e| Error::Worker(Box::new(e)))?
            .len();
        if bytes > 1024 * 1024 {
            return Err(Error::Validation("运维工具输入超过 1 MiB"));
        }
        let raw = input.clone();
        let input: ToolInput = serde_json::from_value(input)
            .map_err(|_| Error::Validation("运维工具输入无效或含不支持的字段"))?;
        let operation = input.operation();
        let generation = self.plugin_host.generation(&id)?;
        let plugin = self.plugin_detail(id.clone()).await?;
        let grant = self
            .plugin_permissions(id.clone())
            .await?
            .ok_or_else(denied)?;
        grant.authorize(
            &plugin,
            None,
            &Capability::ToolInvoke {
                input_id: String::new(),
                operation,
            },
        )?;
        grant.authorize(
            &plugin,
            None,
            &Capability::ResultRead {
                result_id: String::new(),
                chunk: 0,
            },
        )?;
        match &input {
            ToolInput::AiSend { id: request, .. } => {
                self.plugin_ai_owner(&id, &generation, request)?;
            }
            ToolInput::AiExecute { input } => {
                self.plugin_ai_owner(&id, &generation, &input.proposal_id)?;
            }
            _ => (),
        }
        let review = self
            .plugin_tool_review(&input, raw, &plugin.manifest.name)
            .await?;
        let ticket = uuid::Uuid::new_v4().to_string();
        let mut data = self.plugin_host.lock()?;
        if !super::state::Host::current(&data, &id, &generation) {
            return Err(denied());
        }
        data.tool_inputs
            .retain(|_, value| value.at.elapsed() < Duration::from_secs(60));
        if data.tool_inputs.len() >= 8
            || data.tool_inputs.values().filter(|v| v.plugin == id).count() >= 2
            || data.tool_inputs.values().map(|v| v.bytes).sum::<usize>() + bytes > 4 * 1024 * 1024
        {
            return Err(Error::Busy);
        }
        data.tool_inputs.insert(
            ticket.clone(),
            ToolInputResource {
                plugin: id,
                generation,
                revision: plugin.revision,
                input,
                bytes,
                at: Instant::now(),
            },
        );
        Ok(ToolTicket {
            input_id: ticket,
            operation,
            review,
        })
    }
    pub(super) async fn plugin_tool_invoke(
        &self,
        call: &Call,
        plugin: &InstalledPlugin,
        input_id: &str,
        operation: Operation,
    ) -> Result<Value, Error> {
        let input = {
            let mut data = self.plugin_host.lock()?;
            let staged = data.tool_inputs.get(input_id).ok_or_else(denied)?;
            if staged.plugin != call.id
                || staged.generation != call.generation
                || staged.revision != plugin.revision
                || staged.at.elapsed() >= Duration::from_secs(60)
                || staged.input.operation() != operation
            {
                return Err(denied());
            }
            let input = data.tool_inputs.remove(input_id).ok_or_else(denied)?.input;
            let ai_request = match &input {
                ToolInput::AiResolveHosts { input } => Some(input.request_id.clone()),
                ToolInput::AiSend { id, .. } => Some(id.clone()),
                _ => None,
            };
            data.tool_active.insert(
                call.id.clone(),
                ActiveToolInput {
                    input_id: input_id.into(),
                    generation: call.generation.clone(),
                    ai_request,
                },
            );
            input
        };
        let _active = ActiveInputGuard {
            host: self.plugin_host.clone(),
            plugin: call.id.clone(),
            input_id: input_id.into(),
        };
        let value = self.plugin_tool_execute(call, input).await?;
        self.plugin_host.verify(call)?;
        self.plugin_result(call, value)
    }
    fn plugin_ai_owner(&self, plugin: &str, generation: &str, id: &str) -> Result<String, Error> {
        let data = self.plugin_host.lock()?;
        let resource = data.tool_ai.get(id).ok_or_else(denied)?;
        if resource.plugin != plugin
            || resource.generation != generation
            || resource.at.elapsed() >= Duration::from_secs(600)
        {
            return Err(denied());
        }
        Ok(resource.root.clone())
    }
    fn plugin_register_ai(
        &self,
        call: &Call,
        root: &str,
        ids: impl IntoIterator<Item = String>,
    ) -> Result<(), Error> {
        self.plugin_host.verify(call)?;
        self.register_ai(&call.id, &call.generation, root, ids)?;
        if let Err(error) = self.plugin_host.verify(call) {
            self.ai_cancel(root)?;
            self.plugin_host.lock()?.tool_ai.retain(|_, resource| {
                resource.plugin != call.id
                    || resource.generation != call.generation
                    || resource.root != root
            });
            return Err(error);
        }
        Ok(())
    }
    fn register_ai(
        &self,
        plugin: &str,
        generation: &str,
        root: &str,
        ids: impl IntoIterator<Item = String>,
    ) -> Result<(), Error> {
        let ids = ids.into_iter().collect::<BTreeSet<_>>();
        let mut data = self.plugin_host.lock()?;
        data.tool_ai
            .retain(|_, r| r.at.elapsed() < Duration::from_secs(600));
        if ids.iter().any(|id| {
            data.tool_ai
                .get(id)
                .is_some_and(|r| r.plugin != plugin || r.generation != generation)
        }) {
            return Err(denied());
        }
        let new = ids
            .iter()
            .filter(|id| !data.tool_ai.contains_key(*id))
            .count();
        if data.tool_ai.len() + new > 256
            || data.tool_ai.values().filter(|r| r.plugin == plugin).count() + new > 128
        {
            return Err(Error::Busy);
        }
        let input_id = data
            .tool_active
            .get(plugin)
            .map(|input| input.input_id.clone())
            .unwrap_or_default();
        for id in ids {
            data.tool_ai.insert(
                id,
                ToolAiResource {
                    plugin: plugin.into(),
                    generation: generation.into(),
                    root: root.into(),
                    at: Instant::now(),
                    input_id: input_id.clone(),
                },
            );
        }
        Ok(())
    }
    pub fn plugin_tool_abort_input(&self, id: &str, input_id: &str) -> Result<(), Error> {
        let generation = self.plugin_host.generation(id)?;
        let (active, roots, staged) = {
            let mut data = self.plugin_host.lock()?;
            let active = data
                .tool_active
                .get(id)
                .filter(|a| a.input_id == input_id && a.generation == generation);
            let mut roots = data
                .tool_ai
                .values()
                .filter(|r| r.plugin == id && r.generation == generation && r.input_id == input_id)
                .map(|r| r.root.clone())
                .collect::<BTreeSet<_>>();
            if let Some(request) = active
                .and_then(|a| a.ai_request.as_ref())
                .and_then(|request| data.tool_ai.get(request))
                .filter(|r| r.plugin == id && r.generation == generation)
            {
                roots.insert(request.root.clone());
            }
            let active = active.is_some();
            let staged = data
                .tool_inputs
                .get(input_id)
                .is_some_and(|r| r.plugin == id && r.generation == generation);
            if staged {
                data.tool_inputs.remove(input_id);
            }
            (active, roots, staged)
        };
        if !active && !staged && roots.is_empty() {
            return Err(Error::NotFound);
        }
        if active {
            self.plugin_host
                .cancel_tool_input(id, input_id, &generation)?;
        }
        for root in &roots {
            self.ai_cancel(root)?;
        }
        self.plugin_host
            .lock()?
            .tool_ai
            .retain(|_, r| r.plugin != id || !roots.contains(&r.root));
        Ok(())
    }
    /// Out-of-band revocation stays usable while a WASM business call awaits HTTP.
    pub fn plugin_tool_cancel_request(&self, id: &str, request: &str) -> Result<(), Error> {
        let generation = self.plugin_host.generation(id)?;
        let root = self.plugin_ai_owner(id, &generation, request)?;
        self.ai_cancel(&root)?;
        self.plugin_host
            .lock()?
            .tool_ai
            .retain(|_, r| r.plugin != id || r.root != root);
        Ok(())
    }
    pub(super) fn plugin_cancel_tool_requests(&self, id: &str) -> Result<(), Error> {
        let roots = self
            .plugin_host
            .lock()?
            .tool_ai
            .values()
            .filter(|r| r.plugin == id)
            .map(|r| r.root.clone())
            .collect::<BTreeSet<_>>();
        for root in roots {
            self.ai_cancel(&root)?;
        }
        let mut data = self.plugin_host.lock()?;
        data.tool_inputs.retain(|_, input| input.plugin != id);
        data.tool_ai.retain(|_, resource| resource.plugin != id);
        Ok(())
    }
    async fn plugin_ai_wait<T>(
        &self,
        call: &Call,
        id: &str,
        work: impl std::future::Future<Output = Result<T, Error>>,
    ) -> Result<T, Error> {
        tokio::pin!(work);
        tokio::select! {
            value = &mut work => value,
            _ = call.cancel.cancelled() => {
                self.ai_cancel(id)?;
                let result = work.await;
                Err(Error::Connection {code: "PLUGIN_CANCELLED", message: "插件请求已取消", source: result.err().map(|e| Box::new(e) as _)})
            }
        }
    }
    async fn plugin_tool_execute(&self, call: &Call, input: ToolInput) -> Result<Value, Error> {
        fn value<T: Serialize>(value: T) -> Result<Value, Error> {
            serde_json::to_value(value).map_err(|e| Error::Worker(Box::new(e)))
        }
        match input {
            ToolInput::AiResolveHosts { mut input } => {
                let public_id = input.request_id.clone();
                uuid::Uuid::parse_str(&public_id)
                    .map_err(|_| Error::Validation("主机匹配请求标识无效"))?;
                let id = uuid::Uuid::new_v4().to_string();
                input.request_id = id.clone();
                self.plugin_register_ai(call, &id, [public_id])?;
                value(
                    self.plugin_ai_wait(call, &id, self.ai_resolve_hosts(input))
                        .await?,
                )
            }
            ToolInput::AiPrepare { input } => {
                let preview = self.ai_prepare(input).await?;
                if call.cancel.is_cancelled() {
                    self.ai_cancel(&preview.id)?;
                    return Err(failure("PLUGIN_CANCELLED", "插件请求已取消"));
                }
                if let Err(error) = self.plugin_register_ai(call, &preview.id, [preview.id.clone()])
                {
                    self.ai_cancel(&preview.id)?;
                    return Err(error);
                }
                value(preview)
            }
            ToolInput::AiSend { id, confirmed } => {
                self.plugin_ai_owner(&call.id, &call.generation, &id)?;
                let answer = self
                    .plugin_ai_wait(call, &id, self.ai_send(id.clone(), confirmed))
                    .await?;
                if call.cancel.is_cancelled() {
                    self.ai_cancel(&id)?;
                    return Err(failure("PLUGIN_CANCELLED", "插件请求已取消"));
                }
                if let Err(error) = self.plugin_register_ai(
                    call,
                    &id,
                    answer.proposals.iter().map(|p| p.id.clone()),
                ) {
                    self.ai_cancel(&id)?;
                    return Err(error);
                }
                value(answer)
            }
            ToolInput::AiExecute { input } => {
                self.plugin_ai_owner(&call.id, &call.generation, &input.proposal_id)?;
                value(self.ai_execute(input).await?)
            }
            ToolInput::DiagnosticStart { input } => value(self.diagnostic_start(input)?),
            ToolInput::DiagnosticList { versions } => value(
                self.diagnostic_list()?
                    .into_iter()
                    .filter(|i| versions.get(&i.id) != Some(&i.revision))
                    .collect::<Vec<_>>(),
            ),
            ToolInput::DiagnosticCancel { id } => {
                self.diagnostic_cancel(&id)?;
                Ok(Value::Null)
            }
        }
    }
}
