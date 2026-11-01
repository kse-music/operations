use super::*;
impl Engine {
    /// Non-secret metadata only. Run on a database worker, never loads credentials' secrets.
    pub fn profile_signature(&self, host_id: &str) -> Result<String, Error> {
        let target = self.database.host(host_id)?;
        let mut hosts = Vec::new();
        let mut current = Some(host_id.to_owned());
        let mut seen = std::collections::HashSet::new();
        while let Some(id) = current {
            if hosts.len() >= 5 || !seen.insert(id.clone()) {
                return Err(Error::Validation("跳板链循环或过长"));
            }
            let mut host = self.database.host(&id)?;
            host.config = host.config.normalize()?;
            current = host.config.ssh.jump_host_id.clone();
            hosts.push(host);
        }
        hosts.reverse();
        let mut proxy = target.config.ssh.proxy.clone();
        if let Some(p) = hosts.first().and_then(|h| h.config.ssh.proxy.as_ref()) {
            if proxy.as_ref().is_some_and(|v| v != p) {
                return Err(Error::Validation("代理配置冲突"));
            }
            proxy = Some(p.clone());
        }
        if hosts
            .iter()
            .skip(1)
            .take(hosts.len().saturating_sub(2))
            .any(|h| h.config.ssh.proxy.is_some())
        {
            return Err(Error::Validation("中间跳板不能有独立代理"));
        }
        let proxy = proxy
            .map(|settings| {
                let revision = match &settings.credential_id {
                    Some(id) => self.database.credential_record(id)?.public.revision,
                    None => 0,
                };
                Ok::<_, Error>(ProxyConnection {
                    settings,
                    password: None,
                    revision,
                })
            })
            .transpose()?;
        let hops = hosts
            .into_iter()
            .map(|host| {
                let revision = if host.config.auth_type == serverdeck_core::hosts::AuthType::Agent {
                    0
                } else {
                    self.database
                        .credential_record(
                            host.config
                                .credential_id
                                .as_deref()
                                .ok_or(Error::Validation("主机未关联凭据"))?,
                        )?
                        .public
                        .revision
                };
                Ok(Hop {
                    host,
                    revision,
                    auth: Authentication::Agent,
                })
            })
            .collect::<Result<Vec<_>, Error>>()?;
        ConnectionPlan { hops, proxy }.signature()
    }
    pub fn ops_profile(&self, id: &str) -> Result<String, Error> {
        if !self.ops_ready(id)? {
            return Err(Error::Validation("SSH 运维连接未就绪"));
        }
        let owner = self.control(id)?;
        locked(&self.registry)?
            .transports
            .iter()
            .find(|(_, t)| t.id == owner.info.transport_id)
            .map(|(key, _)| key.route_signature.clone())
            .ok_or(Error::NotFound)
    }
    pub fn ops_connections(&self) -> Result<Vec<TerminalSession>, Error> {
        Ok(locked(&self.registry)?
            .sessions
            .values()
            .filter(|c| {
                c.kind == SessionKind::Operations
                    && c.ready.load(Ordering::Acquire)
                    && !c.cancel.is_cancelled()
            })
            .map(|c| c.info.clone())
            .collect())
    }

    pub fn ops_ready(&self, id: &str) -> Result<bool, Error> {
        let owner = self.control(id)?;
        if owner.kind != SessionKind::Operations || owner.cancel.is_cancelled() {
            return Err(failure("OPS_DISCONNECTED", "运维连接已关闭"));
        }
        Ok(owner.ready.load(Ordering::Acquire))
    }
    pub async fn open_ops_channel(&self, id: &str) -> Result<subsystem::SubsystemChannel, Error> {
        if !self.ops_ready(id)? {
            return Err(failure("OPS_NOT_READY", "运维连接尚未就绪"));
        }
        let owner = self.control(id)?;
        let transport = locked(&self.registry)?
            .transports
            .values()
            .find(|t| t.id == owner.info.transport_id)
            .cloned()
            .ok_or(Error::NotFound)?;
        let connection = transport
            .connection
            .lock()
            .await
            .clone()
            .ok_or(Error::NotFound)?;
        let channel = tokio::select! {result=tokio::time::timeout(Duration::from_secs(5),connection.channel_open_session())=>result.map_err(|_|failure("OPS_TIMEOUT","运维 Channel 创建超时"))?.map_err(network)?,_=owner.cancel.cancelled()=>return Err(failure("OPS_DISCONNECTED","运维连接已关闭")),_=connection.alive.cancelled()=>return Err(failure("OPS_DISCONNECTED","SSH 连接已中断"))};
        Ok(subsystem::SubsystemChannel {
            channel,
            session_closed: owner.cancel.clone(),
            transport_closed: connection.alive.clone(),
        })
    }
}
