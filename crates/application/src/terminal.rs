use super::*;
use serverdeck_core::{
    connection::{ForwardInfo, ForwardInput, LocalForwardInput},
    hosts::Host,
};
use serverdeck_core::{
    hosts::AuthType,
    terminal::{TerminalSession, TerminalSize},
};
use serverdeck_ssh::{Authentication, Sink};
use serverdeck_ssh::{ConnectionPlan, Hop, ProxyConnection};
use zeroize::Zeroizing;

fn title_command(command: &str) -> Option<String> {
    if command.len() > 4096
        || command.chars().any(|ch| {
            ch.is_control() || matches!(ch, '\u{2028}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
        })
    {
        return None;
    }
    let mut chars = command.trim().chars();
    let mut preview: String = chars.by_ref().take(80).collect();
    if preview.is_empty() {
        return None;
    }
    if chars.next().is_some() {
        preview.push('…');
    }
    Some(preview)
}

#[cfg(test)]
mod saved_title_tests {
    use super::*;
    use serverdeck_core::terminal::{
        LocalSplitAxis, LocalTerminalLayout, SavedSshTerminal, SshPaneSnapshot, SshPaneState,
    };
    use serverdeck_storage::ssh_sessions::SshSessionRecord;

    struct TestSnapshot(String, Vec<u8>);

    impl SecretStore for TestSnapshot {
        fn read(&self, id: &str) -> Result<Option<Zeroizing<Vec<u8>>>, Error> {
            assert_eq!(id, self.0);
            Ok(Some(Zeroizing::new(self.1.clone())))
        }

        fn write(&self, _: &str, _: &[u8]) -> Result<(), Error> {
            Err(Error::Validation("preview must not write secrets"))
        }

        fn delete(&self, _: &str) -> Result<(), Error> {
            Err(Error::Validation("preview must not delete secrets"))
        }
    }

    #[tokio::test]
    async fn ssh_saved_title_reads_only_the_designated_pane_from_the_protected_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        let mut app =
            Application::initialize(dir.path().join("data"), dir.path().join("logs")).unwrap();
        let host = app
            .database
            .host_create(serverdeck_core::hosts::HostInput {
                ssh: Default::default(),
                name: "QA".into(),
                hostname: "example.test".into(),
                port: 22,
                username: "qa".into(),
                auth_type: AuthType::Agent,
                credential_id: None,
                group_id: None,
                description: String::new(),
                favorite: false,
                connect_timeout_secs: 10,
            })
            .unwrap()
            .id;
        let id = uuid::Uuid::new_v4();
        let bytes =
            serde_json::to_vec(
                &["echo first", "npm run dev"].map(|command| SshPaneSnapshot {
                    identity: "qa".into(),
                    state: Some(SshPaneState {
                        directory: "/tmp".into(),
                        command: command.into(),
                    }),
                }),
            )
            .unwrap();
        let record = SshSessionRecord::new(
            SavedSshTerminal {
                id,
                title: "会话 1".into(),
                title_command_pane: Some(1),
                pane_count: 2,
                layout_only_panes: 0,
                layout: LocalTerminalLayout::Split {
                    axis: LocalSplitAxis::Rows,
                    ratio: 50,
                    first: Box::new(LocalTerminalLayout::Leaf { pane: 0 }),
                    second: Box::new(LocalTerminalLayout::Leaf { pane: 1 }),
                },
            },
            bytes.len(),
        );
        app.secrets = std::sync::Arc::new(TestSnapshot(record.reference(), bytes));
        app.database
            .save_ssh_session(&host, record, false, |_| Ok(()))
            .unwrap();
        assert_eq!(
            app.terminal_saved_title_commands(host.clone())
                .await
                .unwrap(),
            [(id.to_string(), "npm run dev".to_owned())].into()
        );
        assert_eq!(
            app.terminal_ssh_saved_sessions(host.clone()).await.unwrap()[0].title,
            "会话 1"
        );
        app.database
            .rename_ssh_session(&host, id, "会话 1".into(), None)
            .unwrap();
        assert!(
            app.terminal_saved_title_commands(host)
                .await
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn command_preview_is_bounded_and_single_line() {
        assert!(title_command("echo\nnext").is_none());
        assert!(title_command("echo \u{202e}next").is_none());
        assert_eq!(
            title_command(&"中".repeat(81)).unwrap(),
            format!("{}…", "中".repeat(80))
        );
    }
}

#[cfg(windows)]
fn local_title_command(ciphertext: &str) -> Result<Option<String>, ()> {
    use base64::{Engine, engine::general_purpose::STANDARD};
    let bytes = STANDARD.decode(ciphertext).map_err(|_| ())?;
    let command =
        serverdeck_windows_terminal::unprotect_terminal_command(&bytes).map_err(|_| ())?;
    Ok(title_command(
        std::str::from_utf8(&command).map_err(|_| ())?,
    ))
}

fn secret(
    db: &Database,
    secrets: &dyn SecretStore,
    id: &str,
) -> Result<
    (
        serverdeck_storage::hosts::CredentialRecord,
        Option<Zeroizing<String>>,
    ),
    Error,
> {
    let record = db.credential_record(id)?;
    let value = if let Some(reference) = &record.secret_ref {
        let value = secrets
            .read(reference)?
            .ok_or(Error::Validation("系统凭据库没有此秘密，请更新凭据"))?;
        Some(Zeroizing::new(
            std::str::from_utf8(&value)
                .map_err(|_| Error::Validation("安全凭据编码无效"))?
                .to_owned(),
        ))
    } else {
        None
    };
    Ok((record, value))
}
fn authentication(
    db: &Database,
    secrets: &dyn SecretStore,
    host: &Host,
) -> Result<(u32, Authentication), Error> {
    if host.config.auth_type == AuthType::Agent {
        return Ok((0, Authentication::Agent));
    }
    let (record, value) = secret(
        db,
        secrets,
        host.config
            .credential_id
            .as_deref()
            .ok_or(Error::Validation("主机尚未绑定安全凭据"))?,
    )?;
    if record.public.kind != host.config.auth_type {
        return Err(Error::Validation("主机认证与凭据类型不匹配"));
    }
    let auth = match record.public.kind {
        AuthType::Password => {
            Authentication::Password(value.ok_or(Error::Validation("密码凭据未保存秘密"))?)
        }
        AuthType::PrivateKey => match record.public.key_path {
            Some(path) => Authentication::PrivateKey {
                path,
                passphrase: value,
            },
            None => Authentication::ImportedKey(
                value.ok_or(Error::Validation("系统凭据库缺少导入的私钥，请重新导入"))?,
            ),
        },
        AuthType::Agent => Authentication::Agent,
    };
    Ok((record.public.revision, auth))
}
pub(crate) fn connection_plan(
    db: &Database,
    secrets: &dyn SecretStore,
    id: &str,
) -> Result<(Host, ConnectionPlan), Error> {
    let target = db.host(id)?;
    let plan = plan_for_target(db, secrets, target.clone(), None)?;
    Ok((target, plan))
}
pub(crate) fn plan_for_target(
    db: &Database,
    secrets: &dyn SecretStore,
    mut target: Host,
    mut target_auth: Option<Authentication>,
) -> Result<ConnectionPlan, Error> {
    target.config = target.config.normalize()?;
    target.config.ssh.require_proxy_credentials()?;
    let target_id = target.id.clone();
    let mut proxy_settings = target.config.ssh.proxy.clone();
    let mut current = target.config.ssh.jump_host_id.clone();
    let mut seen = std::collections::HashSet::from([target_id.clone()]);
    let mut hosts = vec![target];
    while let Some(id) = current {
        if hosts.len() >= 5 || !seen.insert(id.clone()) {
            return Err(Error::Validation("跳板链循环或超过 4 个跳板"));
        }
        let mut host = db.host(&id)?;
        host.config = host.config.normalize()?;
        host.config.ssh.require_proxy_credentials()?;
        current = host.config.ssh.jump_host_id.clone();
        hosts.push(host);
    }
    hosts.reverse();
    if let Some(first) = hosts.first()
        && let Some(proxy) = &first.config.ssh.proxy
    {
        if proxy_settings.as_ref().is_some_and(|p| p != proxy) {
            return Err(Error::Validation(
                "目标与第一个跳板配置了不同网络代理，请只保留一个",
            ));
        }
        proxy_settings = Some(proxy.clone());
    }
    if hosts
        .iter()
        .skip(1)
        .take(hosts.len().saturating_sub(2))
        .any(|h| h.config.ssh.proxy.is_some())
    {
        return Err(Error::Validation(
            "中间跳板不能单独配置网络代理；代理用于第一个跳板",
        ));
    }
    let proxy = proxy_settings
        .map(|settings| {
            let (revision, password) = if let Some(id) = &settings.credential_id {
                let (record, value) = secret(db, secrets, id)?;
                if record.public.kind != AuthType::Password {
                    return Err(Error::Validation("代理需要安全密码凭据"));
                }
                (
                    record.public.revision,
                    Some(value.ok_or(Error::Validation("代理安全密码不存在"))?),
                )
            } else {
                (0, None)
            };
            Ok(ProxyConnection {
                settings,
                password,
                revision,
            })
        })
        .transpose()?;
    let hops = hosts
        .into_iter()
        .map(|host| {
            let override_auth = (host.id == target_id).then(|| target_auth.take()).flatten();
            let (revision, auth) = match override_auth {
                Some(auth) => (0, auth),
                None => authentication(db, secrets, &host)?,
            };
            Ok(Hop {
                host,
                revision,
                auth,
            })
        })
        .collect::<Result<Vec<_>, Error>>()?;
    Ok(ConnectionPlan { hops, proxy })
}

impl Application {
    pub async fn terminal_saved_title_commands(
        &self,
        host_id: String,
    ) -> Result<std::collections::BTreeMap<String, String>, Error> {
        let secrets = self.secrets.clone();
        self.blocking(move |db| {
            let mut commands = std::collections::BTreeMap::new();
            if host_id.is_empty() {
                #[cfg(windows)]
                for saved in db.local_terminal_sessions()? {
                    let Some(ciphertext) = saved
                        .title_command_pane
                        .and_then(|index| saved.panes.get(index))
                        .and_then(|pane| pane.protected_command.as_deref())
                    else {
                        continue;
                    };
                    match local_title_command(ciphertext) {
                        Ok(Some(command)) => {
                            commands.insert(saved.id, command);
                        }
                        Ok(None) => {}
                        Err(()) => tracing::warn!(
                            operation = "local_saved_title",
                            "could not read terminal title command"
                        ),
                    }
                }
            } else {
                for record in db.ssh_terminal_sessions(&host_id)? {
                    let Some(index) = record.session.title_command_pane else {
                        continue;
                    };
                    let preview = (|| {
                        let blob = secrets
                            .read(&record.reference())?
                            .ok_or(Error::Validation("系统凭据库中缺少 SSH 会话快照"))?;
                        let panes: Vec<serverdeck_core::terminal::SshPaneSnapshot> =
                            serde_json::from_slice(&blob)
                                .map_err(|_| Error::Validation("SSH 会话快照内容无效"))?;
                        if panes.len() != record.session.pane_count {
                            return Err(Error::Validation("保存的会话窗格数量无效"));
                        }
                        let mut selected = None;
                        for (pane_index, pane) in panes.into_iter().enumerate() {
                            if let Some(state) = pane.state {
                                let command = Zeroizing::new(state.command);
                                if pane_index == index {
                                    selected = title_command(&command);
                                }
                            }
                        }
                        Ok::<_, Error>(selected)
                    })();
                    match preview {
                        Ok(Some(command)) => {
                            commands.insert(record.session.id.to_string(), command);
                        }
                        Ok(None) => {}
                        Err(_) => tracing::warn!(
                            operation = "ssh_saved_title",
                            "could not read terminal title command"
                        ),
                    }
                }
            }
            Ok(commands)
        })
        .await
    }

    pub async fn terminal_ssh_saved_sessions(
        &self,
        host_id: String,
    ) -> Result<Vec<serverdeck_core::terminal::SavedSshTerminal>, Error> {
        self.blocking(move |db| {
            Ok(db
                .ssh_terminal_sessions(&host_id)?
                .into_iter()
                .map(|r| r.session)
                .collect())
        })
        .await
    }
    pub async fn terminal_ssh_save(
        &self,
        host_id: String,
        input: serverdeck_core::terminal::SaveTerminalInput,
    ) -> Result<serverdeck_core::terminal::SavedSshTerminal, Error> {
        use serverdeck_core::terminal::{
            SavedSshTerminal, validate_terminal_title, validate_title_command_pane,
        };
        validate_terminal_title(&input.title)?;
        let id = input
            .id
            .as_deref()
            .map(uuid::Uuid::parse_str)
            .transpose()
            .map_err(|_| Error::Validation("SSH 会话标识无效"))?;
        if input.session_ids.is_empty() && input.layout.is_none() {
            let id = id.ok_or(Error::Validation("请先打开 SSH 会话再保存"))?;
            return self
                .blocking(move |db| {
                    db.rename_ssh_session(&host_id, id, input.title, input.title_command_pane)
                })
                .await;
        }
        validate_title_command_pane(input.title_command_pane, input.session_ids.len())?;
        let layout = input
            .layout
            .ok_or(Error::Validation("缺少 SSH 会话分屏布局"))?;
        layout.validate(input.session_ids.len())?;
        let mut seen = std::collections::HashSet::new();
        let mut panes = Vec::new();
        for session in input.session_ids {
            if !seen.insert(session.clone()) {
                return Err(Error::Validation("SSH 会话窗格重复"));
            }
            panes.push(self.terminals.shell_snapshot(&host_id, &session)?);
        }
        let saved = SavedSshTerminal {
            id: id.unwrap_or_else(uuid::Uuid::new_v4),
            title: input.title,
            title_command_pane: input.title_command_pane,
            pane_count: panes.len(),
            layout_only_panes: panes.iter().filter(|p| p.state.is_none()).count(),
            layout,
        };
        let secrets = self.secrets.clone();
        self.blocking(move |db| {
            let blob = zeroize::Zeroizing::new(
                serde_json::to_vec(&panes)
                    .map_err(|_| Error::Validation("SSH 会话快照内容无效"))?,
            );
            let record =
                serverdeck_storage::ssh_sessions::SshSessionRecord::new(saved.clone(), blob.len());
            let result = db.save_ssh_session(&host_id, record, id.is_some(), |reference| {
                secrets.write(reference, &blob)
            });
            super::hosts::retry_session_secret_cleanup(&db, secrets.as_ref());
            result.map(|()| saved)
        })
        .await
    }
    pub async fn terminal_ssh_remove_saved(
        &self,
        host_id: String,
        id: String,
    ) -> Result<(), Error> {
        let secrets = self.secrets.clone();
        self.blocking(move |db| {
            let id =
                uuid::Uuid::parse_str(&id).map_err(|_| Error::Validation("SSH 会话标识无效"))?;
            db.remove_ssh_session(&host_id, id)?;
            super::hosts::retry_session_secret_cleanup(&db, secrets.as_ref());
            Ok(())
        })
        .await
    }
    pub async fn terminal_local_saved_sessions(
        &self,
    ) -> Result<Vec<serverdeck_core::terminal::SavedLocalTerminal>, Error> {
        self.blocking(|db| db.local_terminal_sessions()).await
    }
    pub async fn terminal_local_save(
        &self,
        input: serverdeck_core::terminal::SaveTerminalInput,
    ) -> Result<serverdeck_core::terminal::SavedLocalTerminal, Error> {
        use serverdeck_core::terminal::{SavedLocalTerminal, validate_terminal_title};
        if !cfg!(windows) {
            return Err(Error::Validation(
                "保存本地会话目前仅支持 Windows PowerShell",
            ));
        }
        validate_terminal_title(&input.title)?;
        if input.session_ids.is_empty() {
            let id = input
                .id
                .ok_or(Error::Validation("请先打开本地终端再保存会话"))?;
            if input.layout.is_some() {
                return Err(Error::Validation("未运行的会话只能更新已保存名称"));
            }
            return self
                .blocking(move |db| {
                    db.rename_local_terminal_session(&id, input.title, input.title_command_pane)
                })
                .await;
        }
        let layout = input
            .layout
            .ok_or(Error::Validation("缺少本地会话分屏布局"))?;
        layout.validate(input.session_ids.len())?;
        let mut seen = std::collections::HashSet::new();
        let panes = input
            .session_ids
            .iter()
            .map(|id| {
                if !seen.insert(id) {
                    return Err(Error::Validation("本地会话窗格重复"));
                }
                self.local_terminals.snapshot(id)
            })
            .collect::<Result<Vec<_>, _>>()?;
        let updating = input.id.is_some();
        let saved = SavedLocalTerminal {
            id: input.id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
            title: input.title,
            title_command_pane: input.title_command_pane,
            panes,
            layout,
        };
        saved.validate()?;
        self.blocking(move |db| {
            if updating
                && !db
                    .local_terminal_sessions()?
                    .iter()
                    .any(|entry| entry.id == saved.id)
            {
                return Err(Error::NotFound);
            }
            db.save_local_terminal_session(saved.clone())?;
            Ok(saved)
        })
        .await
    }
    pub async fn terminal_local_remove_saved(&self, id: String) -> Result<(), Error> {
        if uuid::Uuid::parse_str(&id).is_err() {
            return Err(Error::Validation("保存的本地会话标识无效"));
        }
        self.blocking(move |db| db.remove_local_terminal_session(&id))
            .await
    }
    pub async fn terminal_local_open_saved(
        &self,
        id: String,
        pane: usize,
        explicit_restore: bool,
        size: TerminalSize,
        sink: Sink,
    ) -> Result<serverdeck_core::terminal::LocalTerminalSession, Error> {
        size.validate()?;
        let (saved, auto_run) = self
            .blocking(move |db| {
                let saved = db
                    .local_terminal_sessions()?
                    .into_iter()
                    .find(|entry| entry.id == id)
                    .and_then(|entry| entry.panes.get(pane).cloned())
                    .ok_or(Error::NotFound)?;
                let auto_run =
                    explicit_restore && db.load_config()?.terminal.auto_run_saved_command;
                Ok((saved, auto_run))
            })
            .await?;
        if self.shutting_down.load(Ordering::Acquire) {
            return Err(Error::ShuttingDown);
        }
        self.local_terminals
            .open_saved(saved, auto_run, size, sink)
            .await
    }
    pub async fn terminal_reset(&self) -> Result<(), Error> {
        self.terminal_uploads.clear()?;
        self.local_terminals.close_all(false).await?;
        self.operations_host.close_all_logs().await?;
        self.monitors.pause_all();
        self.files.reset_editors();
        self.terminals.close_views().await
    }
    pub async fn forward_open(
        &self,
        host_id: String,
        sink: Sink,
    ) -> Result<TerminalSession, Error> {
        let secrets = self.secrets.clone();
        let (host, plan) = self
            .blocking(move |db| connection_plan(&db, secrets.as_ref(), &host_id))
            .await?;
        if self.shutting_down.load(Ordering::Acquire) {
            return Err(Error::ShuttingDown);
        }
        self.terminals.open_forward_plan(host, plan, sink)
    }
    pub async fn forward_rules(&self, host_id: String) -> Result<Vec<LocalForwardInput>, Error> {
        self.blocking(move |db| db.forward_rules(&host_id)).await
    }
    pub async fn forward_add_rule(
        &self,
        host_id: String,
        rule: LocalForwardInput,
    ) -> Result<LocalForwardInput, Error> {
        self.blocking(move |db| db.add_forward_rule(&host_id, rule))
            .await
    }
    pub async fn forward_remove_rule(
        &self,
        host_id: String,
        listen_port: u16,
    ) -> Result<(), Error> {
        self.blocking(move |db| db.remove_forward_rule(&host_id, listen_port))
            .await
    }
    pub async fn forward_start(&self, id: &str, input: ForwardInput) -> Result<ForwardInfo, Error> {
        if self.shutting_down.load(Ordering::Acquire) {
            return Err(Error::ShuttingDown);
        }
        self.terminals.forward_start(id, input).await
    }
    pub fn forward_list(&self, id: &str) -> Result<Vec<ForwardInfo>, Error> {
        self.terminals.forward_list(id)
    }
    pub async fn forward_stop(&self, id: &str) -> Result<(), Error> {
        self.terminals.forward_stop(id).await
    }
    pub async fn terminal_open(
        &self,
        host_id: String,
        size: TerminalSize,
        sink: Sink,
        saved: Option<serverdeck_core::terminal::SshSavedSource>,
    ) -> Result<TerminalSession, Error> {
        size.validate()?;
        let secrets = self.secrets.clone();
        let (host, plan, restore, auto_run) = self
            .blocking(move |db| {
                let (host, plan) = connection_plan(&db, secrets.as_ref(), &host_id)?;
                let auto_run = saved.as_ref().is_some_and(|source| source.explicit_restore)
                    && db.load_config()?.terminal.auto_run_saved_command;
                let restore = saved
                    .map(|source| {
                        let record = db
                            .ssh_terminal_sessions(&host_id)?
                            .into_iter()
                            .find(|r| r.session.id == source.id)
                            .ok_or(Error::NotFound)?;
                        let blob = secrets
                            .read(&record.reference())?
                            .ok_or(Error::Validation("系统凭据库中缺少 SSH 会话快照"))?;
                        let panes: Vec<serverdeck_core::terminal::SshPaneSnapshot> =
                            serde_json::from_slice(&blob)
                                .map_err(|_| Error::Validation("SSH 会话快照内容无效"))?;
                        if panes.len() != record.session.pane_count
                            || panes.iter().filter(|p| p.state.is_none()).count()
                                != record.session.layout_only_panes
                        {
                            return Err(Error::Validation("SSH 会话快照内容无效"));
                        }
                        panes.into_iter().nth(source.pane).ok_or(Error::NotFound)
                    })
                    .transpose()?;
                Ok((host, plan, restore, auto_run))
            })
            .await?;
        if self.shutting_down.load(Ordering::Acquire) {
            return Err(Error::ShuttingDown);
        }
        self.terminals
            .open_interactive_plan(host, plan, size, sink, restore, auto_run)
    }
    pub fn terminal_input(&self, id: &str, data: Vec<u8>) -> Result<(), Error> {
        if id.starts_with("local:") {
            return self.local_terminals.input(id, data);
        }
        self.terminals.input(id, data)
    }
    pub fn terminal_resize(&self, id: &str, size: TerminalSize) -> Result<(), Error> {
        if id.starts_with("local:") {
            return self.local_terminals.resize(id, size);
        }
        self.terminals.resize(id, size)
    }
    pub fn terminal_ack(&self, id: &str, sequence: u64) -> Result<(), Error> {
        if id.starts_with("local:") {
            return self.local_terminals.ack(id, sequence);
        }
        self.terminals.acknowledge(id, sequence)
    }
    pub fn terminal_trust(&self, id: &str, accept: bool) -> Result<(), Error> {
        self.terminals.confirm(id, accept)
    }
    pub async fn terminal_close(&self, id: &str) -> Result<(), Error> {
        if id.starts_with("local:") {
            return self.local_terminals.close(id).await;
        }
        self.operations_host.close(id).await
    }
    pub async fn terminal_close_host(&self, host_id: &str) -> Result<(), Error> {
        self.operations_host.close_host(host_id).await
    }
    pub async fn terminal_local_open(
        &self,
        size: TerminalSize,
        sink: Sink,
    ) -> Result<serverdeck_core::terminal::LocalTerminalSession, Error> {
        if self.shutting_down.load(Ordering::Acquire) {
            return Err(Error::ShuttingDown);
        }
        size.validate()?;
        self.local_terminals.open(size, sink).await
    }
    pub async fn terminal_local_open_elevated(
        &self,
        size: TerminalSize,
        sink: Sink,
    ) -> Result<serverdeck_core::terminal::LocalTerminalSession, Error> {
        if self.shutting_down.load(Ordering::Acquire) {
            return Err(Error::ShuttingDown);
        }
        size.validate()?;
        self.local_terminals.open_elevated(size, sink).await
    }
}
