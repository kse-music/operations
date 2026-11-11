use super::*;
use serverdeck_core::hosts::HostKeyFingerprint;
use std::ops::Deref;
pub struct Hop {
    pub host: Host,
    pub revision: u32,
    pub auth: Authentication,
}
pub struct ConnectionPlan {
    pub hops: Vec<Hop>,
    pub proxy: Option<proxy::ProxyConnection>,
}
impl ConnectionPlan {
    pub fn signature(&self) -> Result<String, Error> {
        let hops: Vec<_> = self
            .hops
            .iter()
            .map(|h| {
                (
                    &h.host.id,
                    &h.host.config.hostname,
                    h.host.config.port,
                    &h.host.config.username,
                    h.host.config.auth_type.as_str(),
                    &h.host.config.credential_id,
                    h.revision,
                    h.host.config.connect_timeout_secs,
                    &h.host.config.ssh,
                )
            })
            .collect();
        serde_json::to_string(&(hops, self.proxy.as_ref().map(|p| (&p.settings, p.revision))))
            .map_err(|_| failure("SSH_ROUTE", "连接路径不可序列化"))
    }
}
pub(crate) struct Connection {
    handle: client::Handle<trust::Verifier>,
    parents: Vec<client::Handle<trust::Verifier>>,
    pub alive: CancellationToken,
    pub remotes: forward::RemoteRoutes,
    pub cipher: watch::Receiver<Option<String>>,
}
impl Deref for Connection {
    type Target = client::Handle<trust::Verifier>;
    fn deref(&self) -> &Self::Target {
        &self.handle
    }
}
impl Connection {
    pub fn is_closed(&self) -> bool {
        self.alive.is_cancelled()
            || self.handle.is_closed()
            || self.parents.iter().any(|h| h.is_closed())
    }
    pub async fn disconnect(
        &self,
        reason: russh::Disconnect,
        message: &str,
        lang: &str,
    ) -> Result<(), russh::Error> {
        self.alive.cancel();
        self.handle.disconnect(reason, message, lang).await?;
        for parent in self.parents.iter().rev() {
            let _ = parent
                .disconnect(russh::Disconnect::ByApplication, "", lang)
                .await;
        }
        Ok(())
    }
}

impl Engine {
    /// Use the normal SSH handshake and authentication without opening a session channel.
    pub async fn test_connection(
        &self,
        plan: ConnectionPlan,
        confirmed: Option<HostKeyFingerprint>,
    ) -> Result<Option<HostKeyFingerprint>, Error> {
        let challenge = Arc::new(Mutex::new(None));
        let sink: Sink = Arc::new(|_| true);
        match establish(
            self.database.clone(),
            plan,
            trust::Trust::Test {
                confirmed,
                challenge: challenge.clone(),
            },
            &sink,
        )
        .await
        {
            Ok(connection) => {
                // Dropping the fresh transport also releases its jump connections.
                let _ = tokio::time::timeout(
                    Duration::from_secs(1),
                    connection.disconnect(russh::Disconnect::ByApplication, "", "en"),
                )
                .await;
                Ok(None)
            }
            Err(error) => locked(&challenge)?.take().map(Some).ok_or(error),
        }
    }
}

pub(crate) async fn establish(
    database: Database,
    plan: ConnectionPlan,
    trust: trust::Trust,
    sink: &Sink,
) -> Result<Connection, Error> {
    if plan.hops.is_empty() || plan.hops.len() > 5 {
        return Err(failure("SSH_ROUTE", "跳板链须包含目标，最多 4 个跳板"));
    }
    let mut handles: Vec<client::Handle<trust::Verifier>> = Vec::new();
    let mut proxy = plan.proxy;
    let alive = CancellationToken::new();
    let remotes = forward::RemoteRoutes::default();
    let count = plan.hops.len();
    let mut target_cipher = None;
    for (index, hop) in plan.hops.into_iter().enumerate() {
        let deadline = Duration::from_secs(u64::from(hop.host.config.connect_timeout_secs));
        let options = &hop.host.config.ssh;
        let stream: proxy::Stream = if let Some(parent) = handles.last() {
            let channel = tokio::time::timeout(
                deadline,
                parent.channel_open_direct_tcpip(
                    &hop.host.config.hostname,
                    u32::from(hop.host.config.port),
                    "127.0.0.1",
                    0,
                ),
            )
            .await
            .map_err(|_| failure("SSH_TIMEOUT", "跳板目标连接超时"))?
            .map_err(network)?;
            Box::new(channel.into_stream())
        } else {
            tokio::time::timeout(
                deadline,
                proxy::connect(
                    &hop.host.config.hostname,
                    hop.host.config.port,
                    proxy.take(),
                ),
            )
            .await
            .map_err(|_| failure("SSH_TIMEOUT", "SSH TCP 或代理连接超时"))??
        };
        let reason = Arc::new(Mutex::new(None));
        let (confirming, mut phase) = watch::channel(false);
        let (cipher, negotiated_cipher) = watch::channel(None);
        let verifier = trust::Verifier {
            database: database.clone(),
            hostname: hop.host.config.hostname.clone(),
            port: hop.host.config.port,
            trust: trust.clone(),
            reason: reason.clone(),
            confirming,
            alive: alive.clone(),
            remotes: if index + 1 == count {
                remotes.clone()
            } else {
                Default::default()
            },
            cipher,
        };
        let config = client::Config {
            channel_buffer_size: 16,
            window_size: 64 * 1024,
            maximum_packet_size: 16 * 1024,
            keepalive_interval: Some(Duration::from_secs(u64::from(
                options.keepalive_interval_secs,
            ))),
            keepalive_max: usize::from(options.keepalive_count_max),
            nodelay: true,
            ..Default::default()
        };
        let connecting = client::connect_stream(Arc::new(config), stream, verifier);
        tokio::pin!(connecting);
        let mut expires = tokio::time::Instant::now() + deadline;
        let mut phase_open = true;
        let mut pending = false;
        let result = loop {
            tokio::select! {
                result = &mut connecting => break result,
                changed = phase.changed(), if phase_open => {
                    if changed.is_err() {
                        phase_open = false;
                        pending = false;
                    } else {
                        pending = *phase.borrow_and_update();
                    }
                    expires = tokio::time::Instant::now() + deadline;
                }
                _ = tokio::time::sleep_until(expires), if !pending => {
                    return Err(failure("SSH_TIMEOUT", "SSH 协议握手超时"));
                }
            }
        };
        let mut handle = match result {
            Ok(handle) => handle,
            Err(error) => {
                if let Some((code, message)) = locked(&reason)?.take() {
                    return Err(failure(code, message));
                }
                return Err(network(error));
            }
        };
        state(sink, "authenticating", None);
        tokio::time::timeout(
            Duration::from_secs(u64::from(options.auth_timeout_secs)),
            auth::authenticate(&mut handle, &hop.host.config.username, hop.auth),
        )
        .await
        .map_err(|_| failure("SSH_AUTH_TIMEOUT", "SSH 认证超时"))??;
        handles.push(handle);
        target_cipher = Some(negotiated_cipher);
    }
    let handle = handles
        .pop()
        .ok_or_else(|| failure("SSH_ROUTE", "连接路径为空"))?;
    Ok(Connection {
        handle,
        parents: handles,
        alive,
        remotes,
        cipher: target_cipher.ok_or_else(|| failure("SSH_ROUTE", "连接路径为空"))?,
    })
}
