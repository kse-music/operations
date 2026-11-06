use super::{
    state::{self, Call, failure},
    *,
};
use base64::Engine as _;
use serde_json::{Value, json};
use serverdeck_core::{
    ops,
    terminal::{TerminalSession, TerminalSize},
};
use serverdeck_plugin_core::{
    InstalledPlugin, Permission,
    permissions::{Grant, denied},
};
use serverdeck_plugin_sdk::{Capability, server::Query};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};

const CHUNK: usize = 32 * 1024;
// Keep guest JSON decoding within the standard fuel budget. Large values stay in
// owned host resources; the guest receives only a small opaque descriptor.
const INLINE_RESULT: usize = 1024;
const RESULT_LIMIT: usize = 4 * 1024 * 1024;
#[cfg(test)]
#[path = "server_tests.rs"]
mod tests;

pub(super) fn core_query(request: &Query) -> Result<ops::Request, Error> {
    let mut value = serde_json::to_value(request).map_err(|e| Error::Worker(Box::new(e)))?;
    if (request.sensitive() || matches!(request, Query::ContainerDetails { .. }))
        && let Some(object) = value.as_object_mut()
    {
        object.insert("confirmed".into(), json!(true));
    }
    // The host sets confirmed after applying the plugin authorization and confirmation policy.
    serde_json::from_value(value).map_err(|_| Error::Validation("服务器请求字段无效"))
}
fn host(call: &Call) -> Result<&str, Error> {
    Ok(&call.context.as_ref().ok_or_else(denied)?.input.host_id)
}

impl Application {
    pub(super) fn plugin_result(&self, call: &Call, value: Value) -> Result<Value, Error> {
        let bytes = serde_json::to_vec(&value).map_err(|e| Error::Worker(Box::new(e)))?;
        if bytes.len() <= INLINE_RESULT {
            return Ok(value);
        }
        if bytes.len() > RESULT_LIMIT {
            return Err(failure(
                "PLUGIN_OUTPUT_LIMIT",
                "服务器数据超过 4 MiB，请缩小范围",
            ));
        }
        let mut data = self.plugin_host.lock()?;
        data.results
            .retain(|_, result| result.at.elapsed() < Duration::from_secs(60));
        if data.results.len() >= 8
            || data
                .results
                .values()
                .filter(|result| result.plugin == call.id)
                .count()
                >= 2
            || data
                .results
                .values()
                .map(|result| result.bytes.len())
                .sum::<usize>()
                + bytes.len()
                > 8 * 1024 * 1024
        {
            return Err(Error::Busy);
        }
        let id = uuid::Uuid::new_v4().to_string();
        let count = bytes.len().div_ceil(CHUNK);
        let length = bytes.len();
        data.results.insert(
            id.clone(),
            state::ResultData {
                plugin: call.id.clone(),
                generation: call.generation.clone(),
                bytes,
                at: Instant::now(),
            },
        );
        Ok(json!({"__pluginResult":{"id":id,"chunks":count,"bytes":length}}))
    }
    pub(super) async fn plugin_server_capability(
        &self,
        call: &Call,
        operation: Capability,
        plugin: &InstalledPlugin,
        grant: &Grant,
    ) -> Result<Value, Error> {
        let value = match operation {
            Capability::SystemQuery { request } => {
                let session = self.plugin_ops_session(call)?;
                let request = core_query(&request)?;
                request.command()?;
                let result = tokio::select! {
                    result = self.operations_host.query(&session, request) => result?,
                    _ = call.cancel.cancelled() => return Err(failure("PLUGIN_CANCELLED", "插件服务器请求已取消，修改结果可能尚未确认")),
                };
                serde_json::to_value(result).map_err(|e| Error::Worker(Box::new(e)))?
            }
            Capability::SystemFeedback => {
                self.plugin_ops_session(call)?;
                let target = host(call)?;
                json!(
                    self.operations_host
                        .feedback()?
                        .into_iter()
                        .filter(|event| event.host_id == target)
                        .collect::<Vec<_>>()
                )
            }
            Capability::MetricsOpen { interval_secs } => {
                self.plugin_ops_session(call)?;
                if ![3, 5, 10, 30].contains(&interval_secs) {
                    return Err(Error::Validation("采样间隔须为 3、5、10 或 30 秒"));
                }
                let backend = serverdeck_monitor::Monitors::new(self.terminals.clone());
                let id = uuid::Uuid::new_v4().to_string();
                let target = host(call)?.to_owned();
                {
                    let mut data = self.plugin_host.lock()?;
                    if let Some((id, _)) = data.monitors.iter().find(|(_, resource)| {
                        resource.plugin == call.id && resource.generation == call.generation
                    }) {
                        return Ok(json!({"id":id}));
                    }
                    if data.monitors.len() >= 8 {
                        return Err(Error::Busy);
                    }
                    data.monitors.insert(
                        id.clone(),
                        state::Monitor {
                            plugin: call.id.clone(),
                            generation: call.generation.clone(),
                            host: target.clone(),
                            backend: backend.clone(),
                        },
                    );
                }
                let secrets = self.secrets.clone();
                let expected_profile = call.context.as_ref().ok_or_else(denied)?.profile.clone();
                let engine = self.terminals.clone();
                let opened = async {
                    let (host, plan) = self
                        .blocking(move |db| {
                            let result = super::super::terminal::connection_plan(
                                &db,
                                secrets.as_ref(),
                                &target,
                            )?;
                            if engine.profile_signature(&target)? != expected_profile {
                                return Err(Error::Conflict);
                            }
                            Ok(result)
                        })
                        .await?;
                    self.plugin_host.verify(call)?;
                    backend.open(host, plan, interval_secs, Arc::new(|_| true))?;
                    Ok::<_, Error>(())
                }
                .await;
                if let Err(error) = opened {
                    self.plugin_host.lock()?.monitors.remove(&id);
                    backend.shutdown().await;
                    return Err(error);
                }
                json!({"id":id})
            }
            Capability::MetricsSnapshot {
                monitor_id,
                after_revision,
            } => {
                let (backend, target) = self.plugin_monitor(call, &monitor_id)?;
                let snapshot = backend
                    .snapshot(&target, after_revision)?
                    .map(|mut snapshot| {
                        snapshot.session_id = monitor_id;
                        snapshot
                    });
                serde_json::to_value(snapshot).map_err(|e| Error::Worker(Box::new(e)))?
            }
            Capability::MetricsVisible {
                monitor_id,
                visible,
            } => {
                let (backend, target) = self.plugin_monitor(call, &monitor_id)?;
                backend.visible(&target, visible)?;
                Value::Null
            }
            Capability::MetricsClose { monitor_id } => {
                let (backend, _) = self.plugin_monitor(call, &monitor_id)?;
                backend.shutdown().await;
                self.plugin_host.lock()?.monitors.remove(&monitor_id);
                Value::Null
            }
            Capability::SystemLogStart {
                source,
                lines,
                follow,
            } => {
                let session = self.plugin_ops_session(call)?;
                let mut source: ops::LogSource = serde_json::from_value(
                    serde_json::to_value(source).map_err(|e| Error::Worker(Box::new(e)))?,
                )
                .map_err(|_| Error::Validation("日志来源无效"))?;
                let mut path = String::new();
                if let ops::LogSource::File { path: requested } = &mut source {
                    if !grant.permissions.contains(&Permission::SftpRead)
                        || !plugin.manifest.permissions.contains(&Permission::SftpRead)
                    {
                        return Err(denied());
                    }
                    *requested = self
                        .files
                        .canonical_path(&self.plugin_file_session(call)?, requested)
                        .await?;
                    grant.path(requested, false)?;
                    path.clone_from(requested);
                }
                let input = ops::LogInput {
                    source,
                    lines,
                    follow,
                };
                input.command()?;
                if self.plugin_host.lock()?.logs.len() >= 8 {
                    return Err(Error::Busy);
                }
                let (sender, receiver) = tokio::sync::mpsc::channel(8);
                let log = self.operations_host.log_open(&session, input, Arc::new(move |event| {
                    let event = match event {
                        ops::LogEvent::State { state, code, message } => json!({"type":"state","state":state,"code":code,"message":message}),
                        ops::LogEvent::Data { sequence, stream, data, at } => json!({"type":"data","sequence":sequence,"stream":stream,"dataBase64":base64::engine::general_purpose::STANDARD.encode(data),"at":at}),
                    };
                    sender.try_send(event).is_ok()
                }))?;
                self.plugin_host.lock()?.logs.insert(
                    log.id.clone(),
                    state::Log {
                        plugin: call.id.clone(),
                        generation: call.generation.clone(),
                        path,
                        receiver,
                    },
                );
                json!({"id":log.id})
            }
            Capability::SystemLogPoll { log_id } => {
                self.plugin_ops_session(call)?;
                self.plugin_server_log_owner(call, &log_id, grant)?;
                let mut events = Vec::new();
                {
                    let mut data = self.plugin_host.lock()?;
                    let log = data.logs.get_mut(&log_id).ok_or(Error::NotFound)?;
                    while let Ok(event) = log.receiver.try_recv() {
                        events.push(event);
                    }
                }
                for event in &events {
                    if let Some(sequence) = event["sequence"].as_u64() {
                        self.operations_host.log_ack(&log_id, sequence)?;
                    }
                }
                json!({"events":events})
            }
            Capability::SystemLogPause { log_id, paused } => {
                self.plugin_server_log_owner(call, &log_id, grant)?;
                self.operations_host.log_pause(&log_id, paused)?;
                Value::Null
            }
            Capability::SystemLogStop { log_id } => {
                self.plugin_server_log_owner(call, &log_id, grant)?;
                self.operations_host.log_close(&log_id).await?;
                self.plugin_host.lock()?.logs.remove(&log_id);
                Value::Null
            }
            Capability::ContainerShell { id, bash } => {
                self.plugin_ops_session(call)?;
                ops::ContainerShell {
                    id: id.clone(),
                    bash,
                    confirmed: true,
                }
                .command()?;
                let mut data = self.plugin_host.lock()?;
                data.shells
                    .retain(|_, ticket| ticket.at.elapsed() < Duration::from_secs(60));
                if data.shells.len() >= 8 {
                    return Err(Error::Busy);
                }
                let ticket = uuid::Uuid::new_v4().to_string();
                data.shells.insert(
                    ticket.clone(),
                    state::ShellTicket {
                        plugin: call.id.clone(),
                        generation: call.generation.clone(),
                        revision: plugin.revision.clone(),
                        host: host(call)?.into(),
                        container: id,
                        bash,
                        at: Instant::now(),
                    },
                );
                json!({"shellTicket":ticket})
            }
            Capability::ResultRead { result_id, chunk } => {
                let data = self.plugin_host.lock()?;
                let result = data.results.get(&result_id).ok_or(Error::NotFound)?;
                if result.plugin != call.id
                    || result.generation != call.generation
                    || result.at.elapsed() >= Duration::from_secs(60)
                {
                    return Err(denied());
                }
                let offset = (chunk as usize).checked_mul(CHUNK).ok_or_else(denied)?;
                if offset >= result.bytes.len() {
                    return Err(Error::Validation("结果分块超出范围"));
                }
                return Ok(
                    json!({"chunk":chunk,"dataBase64":base64::engine::general_purpose::STANDARD.encode(&result.bytes[offset..(offset+CHUNK).min(result.bytes.len())])}),
                );
            }
            Capability::ResultClose { result_id } => {
                let mut data = self.plugin_host.lock()?;
                if let Some(result) = data.results.get(&result_id) {
                    if result.plugin != call.id || result.generation != call.generation {
                        return Err(denied());
                    }
                    data.results.remove(&result_id);
                }
                return Ok(Value::Null);
            }
            _ => return Err(Error::Validation("此服务器能力未实现")),
        };
        self.plugin_result(call, value)
    }
    fn plugin_monitor(
        &self,
        call: &Call,
        id: &str,
    ) -> Result<(serverdeck_monitor::Monitors, String), Error> {
        self.plugin_ops_session(call)?;
        let data = self.plugin_host.lock()?;
        let resource = data.monitors.get(id).ok_or(Error::NotFound)?;
        if resource.plugin != call.id || resource.generation != call.generation {
            return Err(denied());
        }
        Ok((resource.backend.clone(), resource.host.clone()))
    }
    pub(crate) fn latest_monitor_snapshot(
        &self,
        target: &str,
    ) -> Result<Option<serverdeck_core::monitor::MonitorSnapshot>, Error> {
        let mut backends = vec![self.monitors.clone()];
        backends.extend(
            self.plugin_host
                .lock()?
                .monitors
                .values()
                .filter(|resource| resource.host == target)
                .map(|resource| resource.backend.clone()),
        );
        let mut snapshots = Vec::new();
        for backend in backends {
            match backend.snapshot(target, None) {
                Ok(Some(snapshot)) => snapshots.push(snapshot),
                Ok(None) | Err(Error::NotFound) => (),
                Err(error) => return Err(error),
            }
        }
        Ok(snapshots.into_iter().max_by_key(|snapshot| {
            snapshot
                .sample
                .as_ref()
                .map(|sample| sample.sampled_at)
                .unwrap_or_default()
        }))
    }
    pub(crate) fn configure_monitors(&self, interval: u8) -> Result<(), Error> {
        self.monitors.configure(interval);
        for backend in self.plugin_monitor_backends()? {
            backend.configure(interval);
        }
        Ok(())
    }
    pub(crate) fn plugin_monitor_backends(
        &self,
    ) -> Result<Vec<serverdeck_monitor::Monitors>, Error> {
        Ok(self
            .plugin_host
            .lock()?
            .monitors
            .values()
            .map(|resource| resource.backend.clone())
            .collect())
    }
    fn plugin_server_log_owner(&self, call: &Call, id: &str, grant: &Grant) -> Result<(), Error> {
        self.plugin_ops_session(call)?;
        let data = self.plugin_host.lock()?;
        let resource = data.logs.get(id).ok_or(Error::NotFound)?;
        if resource.plugin != call.id || resource.generation != call.generation {
            return Err(denied());
        }
        if !resource.path.is_empty() {
            grant.path(&resource.path, false)?;
        }
        Ok(())
    }
    fn plugin_claim_shell(
        &self,
        call: &Call,
        revision: &str,
        ticket: &str,
        expected_host: &str,
        expected: &ops::ContainerShell,
    ) -> Result<String, Error> {
        let mut data = self.plugin_host.lock()?;
        let value = data.shells.get(ticket).ok_or(Error::NotFound)?;
        if value.plugin != call.id
            || value.generation != call.generation
            || value.revision != revision
            || value.host != expected_host
            || value.host != host(call)?
            || value.container != expected.id
            || value.bash != expected.bash
            || value.at.elapsed() >= Duration::from_secs(60)
        {
            return Err(denied());
        }
        Ok(data.shells.remove(ticket).ok_or(Error::NotFound)?.host)
    }
    #[allow(clippy::too_many_arguments)] // IPC validates each independently supplied launch binding.
    pub async fn plugin_terminal_open(
        &self,
        id: String,
        ticket: String,
        expected_host: String,
        expected: ops::ContainerShell,
        size: TerminalSize,
        sink: serverdeck_ssh::Sink,
    ) -> Result<TerminalSession, Error> {
        size.validate()?;
        expected.command()?;
        let call = self.plugin_host.start(&id)?;
        let capability = Capability::ContainerShell {
            id: expected.id.clone(),
            bash: expected.bash,
        };
        let (plugin, _) = self.plugin_authorize(&call, &capability).await?;
        self.plugin_ops_session(&call)?;
        let target =
            self.plugin_claim_shell(&call, &plugin.revision, &ticket, &expected_host, &expected)?;
        let expected_profile = call.context.as_ref().ok_or_else(denied)?.profile.clone();
        let engine = self.terminals.clone();
        let secrets = self.secrets.clone();
        let (target, plan) = self
            .blocking(move |db| {
                let result =
                    super::super::terminal::connection_plan(&db, secrets.as_ref(), &target)?;
                if engine.profile_signature(&target)? != expected_profile {
                    return Err(Error::Conflict);
                }
                Ok(result)
            })
            .await?;
        self.plugin_host.verify(&call)?;
        let session = self.terminals.open_container_terminal_plan(
            target,
            plan,
            size,
            sink,
            ops::ContainerShell {
                confirmed: true,
                ..expected
            },
        )?;
        if let Err(error) = self.plugin_host.verify(&call) {
            self.terminals.close(&session.id).await?;
            return Err(error);
        }
        Ok(session)
    }
}
