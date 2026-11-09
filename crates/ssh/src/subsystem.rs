use super::*;

pub struct SubsystemChannel {
    pub channel: Channel<client::Msg>,
    pub session_closed: CancellationToken,
    pub transport_closed: CancellationToken,
}
impl Engine {
    pub fn file_is_elevated(&self, id: &str) -> Result<bool, Error> {
        let owner = self.control(id)?;
        if !matches!(owner.kind, SessionKind::Files | SessionKind::DedicatedFiles) {
            return Err(failure("SFTP_NOT_CONNECTED", "需要文件连接"));
        }
        Ok(owner.file_user.is_some())
    }
    pub fn file_connections(&self) -> Result<Vec<TerminalSession>, Error> {
        self.list_file_connections(false)
    }
    pub fn login_file_connections(&self) -> Result<Vec<TerminalSession>, Error> {
        self.list_file_connections(true)
    }
    fn list_file_connections(&self, login_only: bool) -> Result<Vec<TerminalSession>, Error> {
        Ok(locked(&self.registry)?
            .sessions
            .values()
            .filter(|c| {
                matches!(c.kind, SessionKind::Files | SessionKind::DedicatedFiles)
                    && (!login_only || c.file_user.is_none())
                    && c.ready.load(Ordering::Acquire)
                    && !c.cancel.is_cancelled()
            })
            .map(|c| c.info.clone())
            .collect())
    }
    pub(crate) async fn acquire_connection(
        &self,
        plan: ConnectionPlan,
        transport: &Transport,
        control: &Control,
        sink: &Sink,
    ) -> Result<Arc<connect::Connection>, Error> {
        let mut connection = transport.connection.lock().await;
        if connection.as_ref().is_some_and(|c| c.is_closed()) {
            connection.take();
        }
        if connection.is_none() {
            *connection = Some(Arc::new(
                connect::establish(
                    self.database.clone(),
                    plan,
                    trust::Trust::Interactive {
                        control: self.control(&control.info.id)?,
                        sink: sink.clone(),
                    },
                    sink,
                )
                .await?,
            ));
        }
        connection
            .as_ref()
            .cloned()
            .ok_or_else(|| failure("SSH_INTERNAL", "SSH 连接初始化失败"))
    }
    pub(crate) async fn run_file_lease(
        &self,
        plan: ConnectionPlan,
        transport: &Transport,
        control: &Control,
        sink: &Sink,
    ) -> Result<(), Error> {
        let connection = tokio::select! {
            value = self.acquire_connection(plan, transport, control, sink) => value?,
            _ = control.cancel.cancelled() => return Ok(()),
        };
        control.ready.store(true, Ordering::Release);
        state(sink, "connected", None);
        tokio::select! {
            _ = control.cancel.cancelled() => Ok(()),
            _ = connection.alive.cancelled() => Err(failure("SSH_DISCONNECTED", "SSH 断线，文件会话已关闭")),
        }
    }
    pub fn session_info(&self, id: &str) -> Result<TerminalSession, Error> {
        Ok(self.control(id)?.info.clone())
    }
    pub fn session_closed(&self, id: &str) -> Result<CancellationToken, Error> {
        Ok(self.control(id)?.cancel.clone())
    }
    pub async fn open_sftp_channel(&self, id: &str) -> Result<SubsystemChannel, Error> {
        let owner = self.control(id)?;
        if !matches!(owner.kind, SessionKind::Files | SessionKind::DedicatedFiles)
            || !owner.ready.load(Ordering::Acquire)
            || owner.cancel.is_cancelled()
        {
            return Err(failure("SFTP_NOT_CONNECTED", "文件连接尚未就绪或已关闭"));
        }
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
        let mut channel = tokio::select! {
            result = tokio::time::timeout(Duration::from_secs(15), connection.channel_open_session()) => result.map_err(|_| failure("SFTP_TIMEOUT", "SFTP Channel 建立超时"))?.map_err(network)?,
            _ = owner.cancel.cancelled() => return Err(failure("SFTP_DISCONNECTED", "文件连接已关闭")),
        };
        let startup = async {
            if let Some(user) = &owner.file_user {
                sftp_user::start(&mut channel, user).await
            } else {
                channel
                    .request_subsystem(true, "sftp")
                    .await
                    .map_err(network)?;
                accepted(&mut channel).await
            }
        };
        let result = tokio::select! {
            result = tokio::time::timeout(Duration::from_secs(20), startup) => result.unwrap_or_else(|_| Err(failure("SFTP_TIMEOUT", "SFTP 启动超时，请检查 sudo 策略和服务程序路径"))),
            _ = owner.cancel.cancelled() => Err(failure("SFTP_DISCONNECTED", "文件连接已关闭")),
        };
        if let Err(error) = result {
            let _ = tokio::time::timeout(Duration::from_secs(2), channel.close()).await;
            return Err(error);
        }
        Ok(SubsystemChannel {
            channel,
            session_closed: owner.cancel.clone(),
            transport_closed: connection.alive.clone(),
        })
    }
    // Reload closes view-owned terminals; independent, authenticated file leases keep tasks alive.
    pub async fn close_views(&self) -> Result<(), Error> {
        let ids: Vec<_> = locked(&self.registry)?
            .sessions
            .values()
            .filter(|c| c.kind == SessionKind::Terminal || !c.ready.load(Ordering::Acquire))
            .map(|c| c.info.id.clone())
            .collect();
        for id in &ids {
            if let Ok(control) = self.control(id) {
                control.cancel.cancel();
            }
        }
        for id in ids {
            self.close(&id).await?;
        }
        Ok(())
    }
}
