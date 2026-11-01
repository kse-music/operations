use super::*;
use serverdeck_core::{
    connection::{ForwardInfo, ForwardInput},
    hosts::Host,
    workspace::WorkspaceLayout,
};
use serverdeck_core::{
    hosts::AuthType,
    terminal::{TerminalSession, TerminalSize},
};
use serverdeck_ssh::{Authentication, Sink};
use serverdeck_ssh::{ConnectionPlan, Hop, ProxyConnection};
use zeroize::Zeroizing;

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
        AuthType::PrivateKey => Authentication::PrivateKey {
            path: record
                .public
                .key_path
                .ok_or(Error::Validation("私钥路径未配置"))?,
            passphrase: value,
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
    let mut hosts = vec![];
    let mut current = Some(id.to_owned());
    let mut seen = std::collections::HashSet::new();
    while let Some(id) = current {
        if hosts.len() >= 5 || !seen.insert(id.clone()) {
            return Err(Error::Validation("跳板链循环或超过 4 个跳板"));
        }
        let mut host = db.host(&id)?;
        host.config = host.config.normalize()?;
        current = host.config.ssh.jump_host_id.clone();
        hosts.push(host);
    }
    hosts.reverse();
    let mut proxy_settings = target.config.ssh.proxy.clone();
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
            let (revision, auth) = authentication(db, secrets, &host)?;
            Ok(Hop {
                host,
                revision,
                auth,
            })
        })
        .collect::<Result<Vec<_>, Error>>()?;
    Ok((target, ConnectionPlan { hops, proxy }))
}

impl Application {
    pub async fn terminal_reset(&self) -> Result<(), Error> {
        self.operations_host.close_all_logs().await?;
        self.monitors.pause_all();
        self.files.reset_editors();
        self.terminals.close_views().await
    }
    pub async fn workspace_load(&self) -> Result<Option<WorkspaceLayout>, Error> {
        self.blocking(|db| db.load_workspace()).await
    }
    pub async fn workspace_save(&self, layout: WorkspaceLayout) -> Result<(), Error> {
        self.blocking(move |db| db.save_workspace(&layout)).await
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
    ) -> Result<TerminalSession, Error> {
        size.validate()?;
        let secrets = self.secrets.clone();
        let (host, plan) = self
            .blocking(move |db| connection_plan(&db, secrets.as_ref(), &host_id))
            .await?;
        if self.shutting_down.load(Ordering::Acquire) {
            return Err(Error::ShuttingDown);
        }
        self.terminals.open_plan(host, plan, size, sink)
    }
    pub fn terminal_input(&self, id: &str, data: Vec<u8>) -> Result<(), Error> {
        self.terminals.input(id, data)
    }
    pub fn terminal_resize(&self, id: &str, size: TerminalSize) -> Result<(), Error> {
        self.terminals.resize(id, size)
    }
    pub fn terminal_ack(&self, id: &str, sequence: u64) -> Result<(), Error> {
        self.terminals.acknowledge(id, sequence)
    }
    pub fn terminal_trust(&self, id: &str, accept: bool) -> Result<(), Error> {
        self.terminals.confirm(id, accept)
    }
    pub async fn terminal_close(&self, id: &str) -> Result<(), Error> {
        self.terminals.close(id).await
    }
    pub async fn terminal_close_host(&self, host_id: &str) -> Result<(), Error> {
        self.terminals.close_host(host_id).await
    }
}
