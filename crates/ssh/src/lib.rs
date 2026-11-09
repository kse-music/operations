mod auth;
pub use auth::import_private_key;
mod connect;
mod forward;
mod monitor;
mod ops;
mod subsystem;
pub use subsystem::SubsystemChannel;
mod proxy;
mod trust;
pub use connect::{ConnectionPlan, Hop};
pub use proxy::ProxyConnection;

use russh::{Channel, ChannelMsg, client};
use serverdeck_core::{
    Error,
    hosts::Host,
    terminal::{TerminalEvent, TerminalSession, TerminalSize},
};
use serverdeck_storage::Database;
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::Duration,
};
use tokio::{
    sync::{mpsc, watch},
    task::JoinHandle,
};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;
use zeroize::Zeroizing;

pub type Sink = Arc<dyn Fn(TerminalEvent) -> bool + Send + Sync>;
pub enum Authentication {
    Password(Zeroizing<String>),
    PrivateKey {
        path: String,
        passphrase: Option<Zeroizing<String>>,
    },
    ImportedKey(Zeroizing<String>),
    Agent,
}

pub(crate) fn failure(code: &'static str, message: &'static str) -> Error {
    Error::Connection {
        code,
        message,
        source: None,
    }
}
pub(crate) fn network(error: russh::Error) -> Error {
    Error::Connection {
        code: "SSH_NETWORK",
        message: "SSH 网络或协议操作失败，连接可能已断开",
        source: Some(Box::new(error)),
    }
}
fn locked<T>(value: &Mutex<T>) -> Result<std::sync::MutexGuard<'_, T>, Error> {
    value
        .lock()
        .map_err(|_| failure("SSH_INTERNAL", "SSH 会话状态不可用"))
}
fn state(sink: &Sink, value: &'static str, error: Option<Error>) {
    let (code, message) = match error {
        Some(error) => {
            let ipc = serverdeck_core::IpcError::from(error);
            (Some(ipc.code), Some(ipc.message))
        }
        None => (None, None),
    };
    if let Some(code) = code {
        tracing::warn!(operation = "ssh_session", code, "SSH session failed");
    }
    sink(TerminalEvent::State {
        state: value,
        code,
        message,
    });
}

struct Transport {
    id: String,
    connection: tokio::sync::Mutex<Option<Arc<connect::Connection>>>,
}
#[derive(Clone, PartialEq, Eq, Hash)]
struct TransportKey {
    host_id: String,
    hostname: String,
    port: u16,
    username: String,
    auth_type: &'static str,
    credential_id: Option<String>,
    auth_revision: u32,
    route_signature: String,
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum SessionKind {
    Terminal,
    Files,
    Monitor,
    Operations,
}
struct Control {
    kind: SessionKind,
    info: TerminalSession,
    cancel: CancellationToken,
    input: mpsc::Sender<Vec<u8>>,
    size: watch::Sender<TerminalSize>,
    acknowledgment: watch::Sender<u64>,
    awaiting: AtomicU64,
    confirmation: Mutex<Option<tokio::sync::oneshot::Sender<bool>>>,
    task: Mutex<Option<JoinHandle<()>>>,
    ready: AtomicBool,
}
#[derive(Default)]
struct Registry {
    transports: HashMap<TransportKey, Arc<Transport>>,
    sessions: HashMap<String, Arc<Control>>,
    stopping: bool,
}
#[derive(Clone)]
pub struct Engine {
    database: Database,
    registry: Arc<Mutex<Registry>>,
    forwards: Arc<Mutex<HashMap<String, Arc<forward::ForwardControl>>>>,
}

impl Engine {
    pub fn connection_status(
        &self,
    ) -> Result<Vec<serverdeck_core::product::ConnectionStatus>, Error> {
        let registry = locked(&self.registry)?;
        registry
            .sessions
            .values()
            .filter(|c| !c.cancel.is_cancelled())
            .map(|c| {
                let (key, _) = registry
                    .transports
                    .iter()
                    .find(|(_, t)| t.id == c.info.transport_id)
                    .ok_or(Error::NotFound)?;
                Ok(serverdeck_core::product::ConnectionStatus {
                    hostname: key.hostname.clone(),
                    port: key.port,
                    username: key.username.clone(),
                    id: c.info.id.clone(),
                    host_id: c.info.host_id.clone(),
                    transport_id: c.info.transport_id.clone(),
                    route_host_ids: c.info.route_host_ids.clone(),
                    kind: match c.kind {
                        SessionKind::Terminal => "terminal",
                        SessionKind::Files => "files",
                        SessionKind::Monitor => "monitor",
                        SessionKind::Operations => "operations",
                    },
                    state: if c.ready.load(Ordering::Acquire) {
                        "connected"
                    } else if locked(&c.confirmation)?.is_some() {
                        "awaiting_trust"
                    } else {
                        "connecting"
                    },
                })
            })
            .collect()
    }
    pub fn new(database: Database) -> Self {
        Self {
            database,
            registry: Arc::default(),
            forwards: Arc::default(),
        }
    }

    pub fn open(
        &self,
        host: Host,
        auth_revision: u32,
        auth: Authentication,
        size: TerminalSize,
        sink: Sink,
    ) -> Result<TerminalSession, Error> {
        if host.config.ssh.jump_host_id.is_some() || host.config.ssh.proxy.is_some() {
            return Err(failure("SSH_ROUTE", "代理和跳板连接必须提供完整路径"));
        }
        let plan = ConnectionPlan {
            hops: vec![Hop {
                host: host.clone(),
                revision: auth_revision,
                auth,
            }],
            proxy: None,
        };
        self.open_plan(host, plan, size, sink)
    }
    pub fn open_plan(
        &self,
        host: Host,
        plan: ConnectionPlan,
        size: TerminalSize,
        sink: Sink,
    ) -> Result<TerminalSession, Error> {
        self.open_internal(host, plan, size, sink, SessionKind::Terminal, None)
    }
    pub fn open_file_plan(
        &self,
        host: Host,
        plan: ConnectionPlan,
        sink: Sink,
    ) -> Result<TerminalSession, Error> {
        self.open_internal(
            host,
            plan,
            TerminalSize { cols: 80, rows: 24 },
            sink,
            SessionKind::Files,
            None,
        )
    }
    pub fn open_monitor_plan(
        &self,
        host: Host,
        plan: ConnectionPlan,
        sink: Sink,
    ) -> Result<TerminalSession, Error> {
        self.open_internal(
            host,
            plan,
            TerminalSize { cols: 80, rows: 24 },
            sink,
            SessionKind::Monitor,
            None,
        )
    }
    pub fn open_ops_plan(
        &self,
        host: Host,
        plan: ConnectionPlan,
        sink: Sink,
    ) -> Result<TerminalSession, Error> {
        self.open_internal(
            host,
            plan,
            TerminalSize { cols: 80, rows: 24 },
            sink,
            SessionKind::Operations,
            None,
        )
    }
    pub fn open_container_terminal_plan(
        &self,
        host: Host,
        plan: ConnectionPlan,
        size: TerminalSize,
        sink: Sink,
        shell: serverdeck_core::ops::ContainerShell,
    ) -> Result<TerminalSession, Error> {
        let command = shell.command()?;
        self.open_internal(host, plan, size, sink, SessionKind::Terminal, Some(command))
    }
    pub fn open_command_terminal_plan(
        &self,
        host: Host,
        plan: ConnectionPlan,
        size: TerminalSize,
        sink: Sink,
        command: String,
    ) -> Result<TerminalSession, Error> {
        if command.is_empty() || command.len() > 64 * 1024 || command.contains('\0') {
            return Err(Error::Validation("远程终端命令无效"));
        }
        self.open_internal(host, plan, size, sink, SessionKind::Terminal, Some(command))
    }
    pub fn open_file_terminal_plan(
        &self,
        host: Host,
        plan: ConnectionPlan,
        size: TerminalSize,
        sink: Sink,
        action: serverdeck_core::files::FileTerminalAction,
    ) -> Result<TerminalSession, Error> {
        let command = action.command()?;
        self.open_internal(host, plan, size, sink, SessionKind::Terminal, Some(command))
    }
    fn open_internal(
        &self,
        host: Host,
        mut plan: ConnectionPlan,
        size: TerminalSize,
        sink: Sink,
        kind: SessionKind,
        command: Option<String>,
    ) -> Result<TerminalSession, Error> {
        size.validate()?;
        if plan.hops.last().is_none_or(|hop| hop.host.id != host.id) {
            return Err(failure("SSH_ROUTE", "连接路径目标与主机不一致"));
        }
        for hop in &mut plan.hops {
            hop.host.config = hop.host.config.clone().normalize()?;
        }
        if let Some(proxy) = &mut plan.proxy {
            let mut options = serverdeck_core::connection::SshOptions {
                proxy: Some(proxy.settings.clone()),
                ..Default::default()
            };
            options.normalize()?;
            proxy.settings = options.proxy.ok_or(Error::Validation("代理配置缺失"))?;
        }
        let auth_revision = plan
            .hops
            .last()
            .ok_or_else(|| failure("SSH_ROUTE", "连接路径为空"))?
            .revision;
        let (input, receiver) = mpsc::channel(8); // <=128 KiB input per session.
        let (size, dimensions) = watch::channel(size);
        let (acknowledgment, ack) = watch::channel(0);
        let key = TransportKey {
            host_id: host.id.clone(),
            hostname: host.config.hostname.clone(),
            port: host.config.port,
            username: host.config.username.clone(),
            auth_type: host.config.auth_type.as_str(),
            credential_id: host.config.credential_id.clone(),
            auth_revision,
            route_signature: plan.signature()?,
        };
        let mut registry = locked(&self.registry)?;
        if registry.stopping {
            return Err(Error::ShuttingDown);
        }
        if registry.sessions.len() >= 32 {
            return Err(failure("SSH_LIMIT", "最多同时打开 32 个终端"));
        }
        let transport = registry
            .transports
            .entry(key.clone())
            .or_insert_with(|| {
                Arc::new(Transport {
                    id: Uuid::new_v4().to_string(),
                    connection: tokio::sync::Mutex::new(None),
                })
            })
            .clone();
        if matches!(kind, SessionKind::Files | SessionKind::Operations)
            && let Some(existing) = registry.sessions.values().find(|control| {
                control.kind == kind
                    && control.info.transport_id == transport.id
                    && control.ready.load(Ordering::Acquire)
                    && !control.cancel.is_cancelled()
            })
        {
            state(&sink, "connected", None);
            return Ok(existing.info.clone());
        }
        let info = TerminalSession {
            id: Uuid::new_v4().to_string(),
            transport_id: transport.id.clone(),
            host_id: host.id.clone(),
            route_host_ids: plan.hops.iter().map(|hop| hop.host.id.clone()).collect(),
        };
        let control = Arc::new(Control {
            kind,
            info: info.clone(),
            cancel: CancellationToken::new(),
            input,
            size,
            acknowledgment,
            awaiting: AtomicU64::new(0),
            confirmation: Mutex::new(None),
            task: Mutex::new(None),
            ready: AtomicBool::new(false),
        });
        registry.sessions.insert(info.id.clone(), control.clone());
        let engine = self.clone();
        let running = control.clone();
        let task = tokio::spawn(async move {
            state(&sink, "connecting", None);
            let result = if kind != SessionKind::Terminal {
                engine
                    .run_file_lease(plan, &transport, &running, &sink)
                    .await
            } else {
                engine
                    .run(
                        &host, plan, &transport, &running, receiver, dimensions, ack, &sink,
                        command,
                    )
                    .await
            };
            running.ready.store(false, Ordering::Release);
            engine.stop_session_forwards(&running.info.id).await;
            if running.cancel.is_cancelled() {
                state(&sink, "closed", None);
            } else {
                match result {
                    Ok(()) => state(&sink, "closed", None),
                    Err(error) => state(&sink, "failed", Some(error)),
                }
            }
            running.cancel.cancel();
            // Remove the registry entry before disconnecting the last transport.
            let last = if let Ok(mut registry) = locked(&engine.registry) {
                registry.sessions.remove(&running.info.id);
                let last = !registry
                    .sessions
                    .values()
                    .any(|s| s.info.transport_id == transport.id);
                if last {
                    registry.transports.remove(&key);
                }
                last
            } else {
                false
            };
            if last {
                let mut connection = transport.connection.lock().await;
                if let Some(handle) = connection.take() {
                    let _ = tokio::time::timeout(
                        Duration::from_secs(2),
                        handle.disconnect(russh::Disconnect::ByApplication, "", "en"),
                    )
                    .await;
                }
            }
        });
        *locked(&control.task)? = Some(task);
        Ok(info)
    }

    #[allow(clippy::too_many_arguments)]
    async fn run(
        &self,
        host: &Host,
        plan: ConnectionPlan,
        transport: &Transport,
        control: &Control,
        input: mpsc::Receiver<Vec<u8>>,
        size: watch::Receiver<TerminalSize>,
        ack: watch::Receiver<u64>,
        sink: &Sink,
        command: Option<String>,
    ) -> Result<(), Error> {
        let deadline = Duration::from_secs(u64::from(host.config.connect_timeout_secs));
        // This async lock serializes only handshake/authentication/channel creation on ONE transport.
        // Terminal input/output never acquires it.
        let setup = async {
            let handle = self
                .acquire_connection(plan, transport, control, sink)
                .await?;
            let mut channel = tokio::time::timeout(deadline, handle.channel_open_session())
                .await
                .map_err(|_| failure("SSH_TIMEOUT", "创建 SSH Channel 超时"))?
                .map_err(network)?;
            let alive = handle.alive.clone();
            let dimensions = *size.borrow();
            tokio::time::timeout(deadline, async {
                channel
                    .request_pty(
                        true,
                        "xterm-256color",
                        dimensions.cols,
                        dimensions.rows,
                        0,
                        0,
                        &[],
                    )
                    .await
                    .map_err(network)?;
                accepted(&mut channel).await?;
                if let Some(command) = command {
                    channel.exec(true, command).await.map_err(network)?;
                } else {
                    channel.request_shell(true).await.map_err(network)?;
                }
                accepted(&mut channel).await
            })
            .await
            .map_err(|_| failure("SSH_TIMEOUT", "PTY 或 Shell 请求超时"))??;
            Ok::<_, Error>((channel, alive))
        };
        let (channel, alive) =
            tokio::select! { result=setup => result?, _=control.cancel.cancelled()=>return Ok(()) };
        control.ready.store(true, Ordering::Release);
        state(sink, "connected", None);
        let (mut reader, writer) = channel.split();
        let reading = async {
            let mut sequence = 0;
            let mut ack = ack;
            let mut status = None;
            let mut exited_by_signal = false;
            loop {
                match reader.wait().await {
                    Some(ChannelMsg::Data { data })
                    | Some(ChannelMsg::ExtendedData { data, .. }) => {
                        for chunk in data.chunks(16 * 1024) {
                            sequence += 1;
                            control.awaiting.store(sequence, Ordering::Release);
                            if !sink(TerminalEvent::Data {
                                sequence,
                                data: chunk.to_vec(),
                            }) {
                                return Err(failure("SSH_VIEW_CLOSED", "终端视图已关闭"));
                            }
                            // At most one 16 KiB chunk may be queued in the WebView/xterm parser.
                            ack.wait_for(|value| *value == sequence)
                                .await
                                .map_err(|_| failure("SSH_VIEW_CLOSED", "终端已关闭"))?;
                        }
                    }
                    Some(ChannelMsg::ExitStatus { exit_status }) => status = Some(exit_status),
                    Some(ChannelMsg::ExitSignal { .. }) => exited_by_signal = true,
                    Some(ChannelMsg::Close) | None => {
                        sink(TerminalEvent::Exit { status });
                        return if status.is_some() || exited_by_signal {
                            Ok(())
                        } else {
                            Err(failure(
                                "SSH_DISCONNECTED",
                                "SSH 会话已断开（未收到退出状态）",
                            ))
                        };
                    }
                    _ => (),
                }
            }
        };
        let writing = async {
            let mut input = input;
            let mut size = size;
            loop {
                tokio::select! {
                    value = input.recv() => match value { Some(data) => writer.data_bytes(data).await.map_err(network)?, None => return Ok(()) },
                    value = size.changed() => {
                        if value.is_err() { return Ok(()); }
                        let value = *size.borrow_and_update();
                        writer.window_change(value.cols,value.rows,0,0).await.map_err(network)?;
                    }
                }
            }
        };
        let result = tokio::select! { result = reading => result, result = writing => result, _ = control.cancel.cancelled() => Ok(()), _=alive.cancelled()=>Err(failure("SSH_DISCONNECTED","SSH 连接已断开")) };
        let _ = tokio::time::timeout(Duration::from_secs(2), writer.close()).await;
        result
    }

    fn control(&self, id: &str) -> Result<Arc<Control>, Error> {
        locked(&self.registry)?
            .sessions
            .get(id)
            .cloned()
            .ok_or(Error::NotFound)
    }
    pub fn terminal_connected(&self, id: &str) -> Result<CancellationToken, Error> {
        let control = self.control(id)?;
        if control.kind != SessionKind::Terminal
            || !control.ready.load(Ordering::Acquire)
            || control.cancel.is_cancelled()
        {
            return Err(Error::NotFound);
        }
        Ok(control.cancel.clone())
    }
    pub fn input(&self, id: &str, data: Vec<u8>) -> Result<(), Error> {
        if data.is_empty() || data.len() > 16 * 1024 {
            return Err(Error::Validation("终端输入每次须为 1–16384 字节"));
        }
        self.control(id)?
            .input
            .try_send(data)
            .map_err(|error| match error {
                mpsc::error::TrySendError::Full(_) => Error::Busy,
                _ => Error::NotFound,
            })
    }
    pub fn resize(&self, id: &str, size: TerminalSize) -> Result<(), Error> {
        self.control(id)?.size.send_replace(size.validate()?);
        Ok(())
    }
    pub fn acknowledge(&self, id: &str, sequence: u64) -> Result<(), Error> {
        let control = self.control(id)?;
        if sequence == 0 || control.awaiting.load(Ordering::Acquire) != sequence {
            return Err(Error::Validation("终端输出确认序号无效"));
        }
        control.acknowledgment.send_replace(sequence);
        Ok(())
    }
    pub fn confirm(&self, id: &str, accept: bool) -> Result<(), Error> {
        locked(&self.control(id)?.confirmation)?
            .take()
            .ok_or(Error::NotFound)?
            .send(accept)
            .map_err(|_| Error::NotFound)
    }
    pub async fn close(&self, id: &str) -> Result<(), Error> {
        let control = match self.control(id) {
            Ok(control) => control,
            Err(Error::NotFound) => return Ok(()),
            Err(error) => return Err(error),
        };
        control.cancel.cancel();
        let task = locked(&control.task)?.take();
        if let Some(mut task) = task {
            let joined = match tokio::time::timeout(Duration::from_secs(12), &mut task).await {
                Ok(joined) => joined,
                Err(_) => {
                    task.abort();
                    task.await
                }
            };
            if let Err(error) = joined {
                let mut registry = locked(&self.registry)?;
                registry.sessions.remove(id);
                if !registry
                    .sessions
                    .values()
                    .any(|s| s.info.transport_id == control.info.transport_id)
                {
                    registry
                        .transports
                        .retain(|_, transport| transport.id != control.info.transport_id);
                }
                return Err(Error::Worker(Box::new(error)));
            }
        }
        Ok(())
    }
    pub async fn close_host(&self, host_id: &str) -> Result<(), Error> {
        let ids: Vec<_> = locked(&self.registry)?
            .sessions
            .values()
            .filter(|c| c.info.route_host_ids.iter().any(|id| id == host_id))
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
    pub fn counts(&self) -> Result<(usize, usize), Error> {
        let registry = locked(&self.registry)?;
        Ok((registry.transports.len(), registry.sessions.len()))
    }
    pub async fn close_all(&self) -> Result<(), Error> {
        let ids: Vec<_> = locked(&self.registry)?.sessions.keys().cloned().collect();
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
    pub async fn shutdown(&self) {
        let ids = if let Ok(mut registry) = locked(&self.registry) {
            registry.stopping = true;
            registry.sessions.keys().cloned().collect::<Vec<_>>()
        } else {
            return;
        };
        for id in &ids {
            if let Ok(control) = self.control(id) {
                control.cancel.cancel();
            }
        }
        for id in ids {
            let _ = self.close(&id).await;
        }
    }
}

async fn accepted(channel: &mut Channel<client::Msg>) -> Result<(), Error> {
    loop {
        match channel.wait().await {
            Some(ChannelMsg::Success) => return Ok(()),
            Some(ChannelMsg::Failure | ChannelMsg::Close) | None => {
                return Err(failure(
                    "SSH_CHANNEL_REJECTED",
                    "服务器拒绝 PTY、Shell 或 SFTP 子系统请求",
                ));
            }
            _ => (),
        }
    }
}
