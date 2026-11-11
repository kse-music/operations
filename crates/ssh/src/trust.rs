use super::*;
use russh::keys::{HashAlg, PublicKeyOrCertificate};
use serverdeck_core::hosts::HostKeyFingerprint;

#[derive(Clone)]
pub(crate) enum Trust {
    Interactive {
        control: Arc<Control>,
        sink: Sink,
    },
    Test {
        confirmed: Option<HostKeyFingerprint>,
        challenge: Arc<Mutex<Option<HostKeyFingerprint>>>,
    },
}

pub(crate) struct Verifier {
    pub database: Database,
    pub hostname: String,
    pub port: u16,
    pub trust: Trust,
    pub reason: Arc<Mutex<Option<(&'static str, &'static str)>>>,
    pub confirming: watch::Sender<bool>,
    pub alive: CancellationToken,
    pub remotes: forward::RemoteRoutes,
    pub cipher: watch::Sender<Option<String>>,
}
impl client::Handler for Verifier {
    type Error = russh::Error;
    async fn kex_done(
        &mut self,
        _shared_secret: Option<&[u8]>,
        names: &russh::Names,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        self.cipher
            .send_replace(Some(names.cipher.as_ref().to_owned()));
        Ok(())
    }
    async fn disconnected(
        &mut self,
        reason: client::DisconnectReason<Self::Error>,
    ) -> Result<(), Self::Error> {
        self.alive.cancel();
        match reason {
            client::DisconnectReason::Error(error) => Err(error),
            _ => Ok(()),
        }
    }
    async fn server_channel_open_forwarded_tcpip(
        &mut self,
        channel: Channel<client::Msg>,
        address: &str,
        port: u32,
        _origin: &str,
        _origin_port: u32,
        reply: client::ChannelOpenHandle,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        let sender = self.remotes.lock().ok().and_then(|routes| {
            routes
                .get(&(address.to_owned(), port))
                .map(|r| r.sender.clone())
        });
        if let Some(sender) = sender
            && let Ok(permit) = sender.try_reserve()
        {
            reply.accept().await;
            permit.send(forward::Incoming::new(channel));
        }
        // Dropping an unaccepted reply rejects unknown or over-capacity server channels.
        Ok(())
    }
    async fn check_server_key(
        &mut self,
        presented: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        let result = self.check(presented).await;
        match result {
            Ok(()) => Ok(true),
            Err(error) => {
                let ipc = serverdeck_core::IpcError::from(error);
                let message = match ipc.code {
                    "SSH_HOST_KEY_CHANGED" => {
                        "主机密钥已变化，连接已阻止。请通过可信渠道核查服务器，不能在此覆盖旧密钥"
                    }
                    "SSH_TRUST_REJECTED" => "未确认主机指纹，连接已取消",
                    "SSH_CERTIFICATE" => "暂不支持主机证书，连接已拒绝",
                    _ => "主机密钥校验失败或确认超时，连接已拒绝",
                };
                if let Ok(mut reason) = self.reason.lock() {
                    *reason = Some((ipc.code, message));
                }
                Ok(false)
            }
        }
    }
}
impl Verifier {
    async fn check(&self, presented: &PublicKeyOrCertificate) -> Result<(), Error> {
        if presented.certificate().is_some() {
            return Err(failure("SSH_CERTIFICATE", "不支持主机证书"));
        }
        let key = presented
            .public_key()
            .to_openssh()
            .map_err(|_| failure("SSH_HOST_KEY", "主机公钥格式无效"))?;
        let fingerprint = presented
            .public_key()
            .fingerprint(HashAlg::Sha256)
            .to_string();
        let db = self.database.clone();
        let hostname = self.hostname.clone();
        let port = self.port;
        let known = tokio::task::spawn_blocking(move || db.trusted_key(&hostname, port))
            .await
            .map_err(|e| Error::Worker(Box::new(e)))??;
        if let Some(known) = known {
            return if known == key {
                Ok(())
            } else {
                Err(failure("SSH_HOST_KEY_CHANGED", "主机密钥已变化"))
            };
        }
        let presented = HostKeyFingerprint {
            hostname: self.hostname.clone(),
            port: self.port,
            algorithm: presented.public_key().algorithm().to_string(),
            fingerprint: fingerprint.clone(),
        };
        match &self.trust {
            Trust::Interactive { control, sink } => self.confirm(control, sink, presented).await?,
            Trust::Test {
                confirmed,
                challenge,
            } => {
                if let Some(confirmed) = confirmed.as_ref().filter(|confirmed| {
                    confirmed.hostname == self.hostname && confirmed.port == self.port
                }) {
                    if confirmed != &presented {
                        return Err(failure("SSH_HOST_KEY_CHANGED", "待确认的主机密钥已变化"));
                    }
                } else {
                    *locked(challenge)? = Some(presented);
                    return Err(failure("SSH_TRUST_REQUIRED", "请先核对主机指纹"));
                }
            }
        }
        let db = self.database.clone();
        let hostname = self.hostname.clone();
        tokio::task::spawn_blocking(move || db.trust_key(&hostname, port, &key, &fingerprint))
            .await
            .map_err(|e| Error::Worker(Box::new(e)))?
    }

    async fn confirm(
        &self,
        control: &Control,
        sink: &Sink,
        key: HostKeyFingerprint,
    ) -> Result<(), Error> {
        let (sender, receiver) = tokio::sync::oneshot::channel();
        self.confirming.send_replace(true);
        *locked(&control.confirmation)? = Some(sender);
        state(sink, "awaiting_trust", None);
        if !sink(TerminalEvent::Trust {
            hostname: key.hostname,
            port: key.port,
            algorithm: key.algorithm,
            fingerprint: key.fingerprint,
        }) {
            return Err(failure("SSH_VIEW_CLOSED", "终端视图已关闭"));
        }
        let accepted = tokio::time::timeout(Duration::from_secs(60), receiver)
            .await
            .ok()
            .and_then(Result::ok)
            .unwrap_or(false);
        self.confirming.send_replace(false);
        locked(&control.confirmation)?.take();
        if !accepted {
            return Err(failure("SSH_TRUST_REJECTED", "未确认主机指纹"));
        }
        Ok(())
    }
}
