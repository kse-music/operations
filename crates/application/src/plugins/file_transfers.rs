//! Generic revision-bound file jobs; bytes never enter the plugin bridge or a model request.
use super::{
    state::{self, Call, failure},
    *,
};
use serde_json::Value;
use serverdeck_plugin_core::{
    InstalledPlugin, Permission,
    permissions::{Grant, denied},
};
use serverdeck_plugin_sdk::{
    Capability,
    platform::{
        LocalPath, RemotePath, Request, TransferDestination, TransferPreview, TransferSource,
        TransferState,
    },
};
use serverdeck_sftp::CopyGuard as _;
use std::{
    sync::Arc,
    time::{Duration, Instant},
};

fn paths(
    plugin: &InstalledPlugin,
    grant: &Grant,
    source: &TransferSource,
    destination: &TransferDestination,
) -> Result<(), Error> {
    let source_path = match source {
        TransferSource::Local { path } | TransferSource::Remote { path, .. } => path,
    };
    if source_path.chars().any(char::is_control) || destination.path().chars().any(char::is_control)
    {
        return Err(Error::Validation("插件传输路径不能包含控制字符"));
    }
    if let TransferDestination::Remote(destination) = destination {
        if !plugin.manifest.permissions.contains(&Permission::SftpWrite)
            || !grant.permissions.contains(&Permission::SftpWrite)
            || !grant.operations.iter().any(|v| v == "sftp.write")
        {
            return Err(denied());
        }
        grant.path(&destination.path, true)?;
    }
    if let TransferSource::Remote { path, .. } = source {
        if !plugin.manifest.permissions.contains(&Permission::SftpRead)
            || !grant.permissions.contains(&Permission::SftpRead)
            || !grant.operations.iter().any(|v| v == "sftp.read")
        {
            return Err(denied());
        }
        grant.path(path, false)?;
    }
    Ok(())
}

struct Authorization {
    settings: Value,
    app: Application,
    id: String,
    owner: String,
    generation: String,
    revision: String,
    targets: Vec<state::RevisionTarget>,
    sessions: Vec<(String, String)>,
    source: TransferSource,
    destination: TransferDestination,
}
impl serverdeck_sftp::CopyGuard for Authorization {
    fn check(
        &self,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), Error>> + Send + '_>> {
        Box::pin(async move {
            self.app
                .plugin_host
                .verify_resource(&self.id, &self.generation, &self.owner)?;
            let repo = self.app.plugins.clone();
            let id = self.id.clone();
            let revision = self.revision.clone();
            let source = self.source.clone();
            let destination = self.destination.clone();
            let settings = self.settings.clone();
            let engine = self.app.terminals.clone();
            let sessions = self.sessions.clone();
            self.app
                .blocking(move |_| {
                    let plugin = repo.detail(&id)?;
                    let grant = repo.grant(&id)?.ok_or_else(denied)?;
                    if plugin.revision != revision {
                        return Err(Error::Conflict);
                    }
                    if repo.settings_read(&id)? != settings {
                        return Err(Error::Conflict);
                    }
                    grant.authorize(
                        &plugin,
                        &Capability::Platform {
                            request: Request::TransferStart { id: String::new() },
                            bindings: vec![],
                        },
                    )?;
                    paths(&plugin, &grant, &source, &destination)?;
                    for (session, profile) in sessions {
                        let info = engine.session_info(&session)?;
                        if engine.file_is_elevated(&session)?
                            || engine.lease_profile(&session)? != profile
                            || engine.profile_signature(&info.host_id)? != profile
                        {
                            return Err(Error::Conflict);
                        }
                    }
                    Ok(())
                })
                .await?;
            self.app.plugin_verify_targets(self.targets.clone()).await?;
            self.app
                .plugin_host
                .verify_resource(&self.id, &self.generation, &self.owner)
        })
    }
}

impl Application {
    pub(super) async fn plugin_open_file_connection(
        &self,
        call: &Call,
        host: &str,
    ) -> Result<serverdeck_core::terminal::TerminalSession, Error> {
        // Only an already verified, unchanged SSH route may bootstrap a login SFTP lease.
        self.plugin_platform_session(call, host).await?;
        for session in self
            .terminals
            .file_connections()?
            .iter()
            .filter(|s| s.host_id == host)
        {
            if self.terminals.file_is_elevated(&session.id)? {
                return Err(failure(
                    "PLUGIN_SFTP_IDENTITY",
                    "请先在文件页切回原登录用户",
                ));
            }
        }
        let (sender, mut events) = tokio::sync::mpsc::channel(16);
        let session = self
            .files_open(
                host.to_owned(),
                Arc::new(move |event| sender.try_send(event).is_ok()),
            )
            .await?;
        let result = tokio::select! {
            _=call.cancel.cancelled()=>Err(failure("USER_CANCELLED","文件连接已取消")),
            result=tokio::time::timeout(Duration::from_secs(30),async {
                while let Some(event)=events.recv().await {
                    match event {
                        serverdeck_core::terminal::TerminalEvent::State {state:"connected",..}=>return Ok(()),
                        serverdeck_core::terminal::TerminalEvent::State {state:"failed"|"closed",..}|serverdeck_core::terminal::TerminalEvent::Trust {..}=>return Err(failure("PLUGIN_SFTP_CONNECT","文件连接失败或需要重新核验主机指纹，请在文件页连接")),
                        _=>(),
                    }
                }
                Err(failure("PLUGIN_SFTP_CONNECT","文件连接已关闭"))
            })=>result.map_err(|_|failure("PLUGIN_SFTP_CONNECT","文件连接超时")).and_then(|result|result),
        };
        if let Err(error) = result {
            if let Err(cleanup) = self.files.close(&session.id, false).await {
                tracing::error!(operation="plugin_file_connect_cleanup",error=%cleanup,"failed to close candidate file lease");
                return Err(Error::Connection {
                    code: "PLUGIN_SFTP_CLEANUP",
                    message: "文件连接失败且候选连接清理失败",
                    source: Some(Box::new(error)),
                });
            }
            return Err(error);
        }
        Ok(session)
    }

    fn plugin_copy(&self, call: &Call, id: &str) -> Result<state::Copy, Error> {
        let data = self.plugin_host.lock()?;
        let copy = data.copies.get(id).ok_or(Error::NotFound)?;
        if copy.plugin != call.id || copy.owner != call.owner || copy.generation != call.generation
        {
            return Err(denied());
        }
        Ok(copy.clone())
    }
    fn copy_state(id: &str, copy: &state::Copy) -> Result<TransferState, Error> {
        let info = copy.job.as_ref().map(|job| job.info()).transpose()?;
        let state = if let Some(info) = &info {
            if info.state != "completed" && !info.unfinished() && copy.plan.may_have_committed() {
                "unverified".to_owned()
            } else {
                info.state.clone()
            }
        } else if copy.cancelled {
            "cancelled".into()
        } else if copy.at.elapsed() > Duration::from_secs(300) {
            "expired".into()
        } else {
            "prepared".into()
        };
        Ok(TransferState {
            id: id.into(),
            sha256: if state == "completed" {
                copy.plan.sha256()?
            } else {
                None
            },
            state,
            total_bytes: copy.preview.bytes,
            transferred_bytes: info.as_ref().map_or(0, |i| i.transferred_bytes),
            bytes_per_second: info.as_ref().map_or(0, |i| i.bytes_per_second),
            message: info.as_ref().and_then(|i| i.message.clone()),
            recovery_paths: info.map_or_else(Vec::new, |i| i.recovery_paths),
        })
    }

    pub(super) async fn plugin_transfer(
        &self,
        call: &Call,
        plugin: &InstalledPlugin,
        grant: &Grant,
        request: Request,
        bindings: Vec<String>,
    ) -> Result<Value, Error> {
        let operation = Capability::Platform {
            request: request.clone(),
            bindings: bindings.clone(),
        };
        match request {
            request @ (Request::TransferPrepare { .. }
            | Request::TransferDownloadPrepare { .. }) => {
                let (source, destination, overwrite) = match request {
                    Request::TransferPrepare {
                        source,
                        destination,
                        overwrite,
                    } => (source, TransferDestination::Remote(destination), overwrite),
                    Request::TransferDownloadPrepare {
                        source,
                        destination,
                    } => (
                        TransferSource::Remote {
                            host_id: source.host_id,
                            path: source.path,
                        },
                        TransferDestination::Local(LocalPath {
                            local_path: destination,
                        }),
                        false,
                    ),
                    _ => return Err(Error::Validation("传输准备请求无效")),
                };
                if !self.plugin_scope_available(call)? {
                    return Err(failure("PLUGIN_UI_HIDDEN", "请返回页面准备文件传输"));
                }
                paths(plugin, grant, &source, &destination)?;
                let target_host = match (&destination, &source) {
                    (TransferDestination::Remote(remote), _) => &remote.host_id,
                    (TransferDestination::Local(_), TransferSource::Remote { host_id, .. }) => {
                        host_id
                    }
                    _ => return Err(Error::Validation("下载需要远程源")),
                };
                let target_session = self.plugin_platform_file_session(call, target_host).await?;
                let mut sessions = vec![(
                    target_session.clone(),
                    self.terminals.lease_profile(&target_session)?,
                )];
                let target = self.plugin_session_target(&target_session)?;
                let (core_source, source_target) = match &source {
                    TransferSource::Local { path } => {
                        serverdeck_core::files::valid_path(path)?;
                        (
                            serverdeck_sftp::CopySource::Local { path: path.clone() },
                            "本机".to_owned(),
                        )
                    }
                    TransferSource::Remote { host_id, path } => {
                        let session = if destination.remote().is_none() {
                            target_session.clone()
                        } else {
                            self.plugin_platform_file_session(call, host_id).await?
                        };
                        if destination.remote().is_some() {
                            sessions
                                .push((session.clone(), self.terminals.lease_profile(&session)?));
                        }
                        let label = self.plugin_session_target(&session)?;
                        (
                            serverdeck_sftp::CopySource::Remote {
                                session,
                                path: path.clone(),
                            },
                            label,
                        )
                    }
                };
                let profile =
                    serde_json::to_string(&sessions).map_err(|e| Error::Worker(Box::new(e)))?;
                let target = if destination.remote().is_some() {
                    format!("{source_target} → {target}")
                } else {
                    format!("{source_target} → 本机")
                };
                if (call.collecting
                    || call.has_batch()?
                    || !(grant.preapproves(plugin, &operation)
                        || self.plugin_mode_preapproves(call, plugin, grant, &operation)?))
                    && let Some(approval) = self.plugin_confirmation_bound(
                        call,
                        plugin,
                        &operation,
                        Some(&profile),
                        Some(&target),
                    )?
                {
                    return Ok(serde_json::json!({"confirmationRequired":approval}));
                }
                let plan = match &destination {
                    TransferDestination::Remote(remote) => {
                        self.files
                            .transfers
                            .prepare_copy(core_source, &target_session, &remote.path, overwrite)
                            .await?
                    }
                    TransferDestination::Local(local) => {
                        let TransferSource::Remote { path, .. } = &source else {
                            return Err(Error::Validation("下载需要远程源"));
                        };
                        self.files
                            .transfers
                            .prepare_download_copy(&target_session, path, &local.local_path)
                            .await?
                    }
                };
                let source = match (&source, &plan.source) {
                    (TransferSource::Local { .. }, serverdeck_sftp::CopySource::Local { path }) => {
                        TransferSource::Local { path: path.clone() }
                    }
                    (
                        TransferSource::Remote { host_id, .. },
                        serverdeck_sftp::CopySource::Remote { path, .. },
                    ) => TransferSource::Remote {
                        host_id: host_id.clone(),
                        path: path.clone(),
                    },
                    _ => return Err(Error::Conflict),
                };
                let preview = TransferPreview {
                    id: uuid::Uuid::new_v4().to_string(),
                    source,
                    destination: match destination {
                        TransferDestination::Remote(remote) => {
                            TransferDestination::Remote(RemotePath {
                                host_id: remote.host_id,
                                path: plan.destination.clone(),
                            })
                        }
                        TransferDestination::Local(_) => TransferDestination::Local(LocalPath {
                            local_path: plan.destination.clone(),
                        }),
                    },
                    bytes: plan.bytes,
                    overwrite,
                    target_exists: plan.target_exists,
                };
                paths(plugin, grant, &preview.source, &preview.destination)?;
                let targets = self.plugin_binding_targets(call, &bindings)?;
                self.plugin_verify_targets(targets.clone()).await?;
                self.plugin_host.verify(call)?;
                let repo = self.plugins.clone();
                let plugin_id = call.id.clone();
                let settings = self
                    .blocking(move |_| repo.settings_read(&plugin_id))
                    .await?;
                let mut data = self.plugin_host.lock()?;
                data.copies
                    .retain(|_, c| c.job.is_some() || c.at.elapsed() < Duration::from_secs(300));
                if data.copies.len() >= 32
                    || data
                        .copies
                        .values()
                        .filter(|c| c.plugin == call.id && c.owner == call.owner)
                        .count()
                        >= 8
                {
                    return Err(Error::Busy);
                }
                data.copies.insert(
                    preview.id.clone(),
                    state::Copy {
                        settings,
                        plugin: call.id.clone(),
                        owner: call.owner.clone(),
                        generation: call.generation.clone(),
                        revision: plugin.revision.clone(),
                        preview: preview.clone(),
                        plan,
                        job: None,
                        cancelled: false,
                        at: Instant::now(),
                        targets,
                        sessions,
                    },
                );
                Ok(serde_json::json!(preview))
            }
            Request::TransferStart { id } => {
                if !self.plugin_scope_available(call)? {
                    return Err(failure("PLUGIN_UI_HIDDEN", "请返回页面确认文件传输"));
                }
                let copy = self.plugin_copy(call, &id)?;
                {
                    let repo = self.plugins.clone();
                    let id = call.id.clone();
                    let expected = copy.settings.clone();
                    self.blocking(move |_| {
                        if repo.settings_read(&id)? == expected {
                            Ok(())
                        } else {
                            Err(Error::Conflict)
                        }
                    })
                    .await?;
                }
                if copy.job.is_some()
                    || copy.cancelled
                    || copy.at.elapsed() > Duration::from_secs(300)
                {
                    return Err(failure(
                        "TRANSFER_CONSUMED",
                        "传输预览已使用、取消或过期，请重新准备",
                    ));
                }
                paths(
                    plugin,
                    grant,
                    &copy.preview.source,
                    &copy.preview.destination,
                )?;
                self.plugin_verify_targets(copy.targets.clone()).await?;
                let mut labels = Vec::new();
                for (session, profile) in &copy.sessions {
                    if self.terminals.lease_profile(session)? != *profile {
                        return Err(Error::Conflict);
                    }
                    labels.push(self.plugin_session_target(session)?);
                }
                let profile = serde_json::to_string(&copy.sessions)
                    .map_err(|e| Error::Worker(Box::new(e)))?;
                let target = if copy.preview.destination.remote().is_none() {
                    format!("{} → 本机", labels.first().ok_or(Error::Conflict)?)
                } else {
                    format!(
                        "{} → {}",
                        labels.get(1).map(String::as_str).unwrap_or("本机"),
                        labels.first().ok_or(Error::Conflict)?
                    )
                };
                if (call.collecting
                    || call.has_batch()?
                    || !(grant.preapproves(plugin, &operation)
                        || self.plugin_mode_preapproves(call, plugin, grant, &operation)?))
                    && let Some(approval) = self.plugin_confirmation_bound(
                        call,
                        plugin,
                        &operation,
                        Some(&profile),
                        Some(&target),
                    )?
                {
                    return Ok(serde_json::json!({"confirmationRequired":approval}));
                }
                let guard = Arc::new(Authorization {
                    settings: copy.settings.clone(),
                    app: self.clone(),
                    id: call.id.clone(),
                    owner: call.owner.clone(),
                    generation: call.generation.clone(),
                    revision: copy.revision.clone(),
                    targets: copy.targets.clone(),
                    sessions: copy.sessions.clone(),
                    source: copy.preview.source.clone(),
                    destination: copy.preview.destination.clone(),
                });
                guard.check().await?;
                let job = self.files.transfers.start_copy(copy.plan.clone(), guard)?;
                self.plugin_host
                    .lock()?
                    .copies
                    .get_mut(&id)
                    .ok_or(Error::NotFound)?
                    .job = Some(job.clone());
                if let Err(error) = self.plugin_host.verify(call) {
                    job.cancel_and_wait().await?;
                    return Err(error);
                }
                Self::copy_state(&id, &self.plugin_copy(call, &id)?).map(|v| serde_json::json!(v))
            }
            Request::TransferStatus { id } => {
                Self::copy_state(&id, &self.plugin_copy(call, &id)?).map(|v| serde_json::json!(v))
            }
            Request::TransferCancel { id } => {
                let copy = self.plugin_copy(call, &id)?;
                if let Some(job) = &copy.job {
                    job.cancel()?;
                }
                self.plugin_host
                    .lock()?
                    .copies
                    .get_mut(&id)
                    .ok_or(Error::NotFound)?
                    .cancelled = true;
                Self::copy_state(&id, &self.plugin_copy(call, &id)?).map(|v| serde_json::json!(v))
            }
            Request::TransferClose { id } => {
                let copy = self.plugin_copy(call, &id)?;
                if let Some(job) = copy.job {
                    job.cancel_and_wait().await?;
                }
                self.plugin_host.lock()?.copies.remove(&id);
                Ok(Value::Null)
            }
            _ => Err(Error::Validation("不是文件传输请求")),
        }
    }
    pub(super) async fn plugin_close_copies(
        &self,
        id: &str,
        owner: Option<&str>,
    ) -> Result<(), Error> {
        let copies = self
            .plugin_host
            .lock()?
            .copies
            .iter()
            .filter(|(_, c)| c.plugin == id && owner.is_none_or(|owner| c.owner == owner))
            .map(|(id, c)| (id.clone(), c.job.clone()))
            .collect::<Vec<_>>();
        for (_, job) in &copies {
            if let Some(job) = job {
                job.cancel()?;
            }
        }
        for (key, job) in copies {
            if let Some(job) = job {
                job.cancel_and_wait().await?;
            }
            self.plugin_host.lock()?.copies.remove(&key);
        }
        Ok(())
    }
}
