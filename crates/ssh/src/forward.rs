use super::*;
use serverdeck_core::connection::{ForwardInfo, ForwardInput, ForwardKind};
use std::{net::SocketAddr, sync::atomic::AtomicUsize};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::oneshot,
    task::JoinSet,
};

pub(crate) struct Incoming(Option<Channel<client::Msg>>);
impl Incoming {
    pub fn new(channel: Channel<client::Msg>) -> Self {
        Self(Some(channel))
    }
    fn take(mut self) -> Option<Channel<client::Msg>> {
        self.0.take()
    }
}
impl Drop for Incoming {
    fn drop(&mut self) {
        if let Some(channel) = self.0.take() {
            drop(channel.into_stream());
        }
    }
}
pub(crate) struct RemoteRoute {
    pub owner: String,
    pub sender: mpsc::Sender<Incoming>,
}
pub(crate) type RemoteRoutes = Arc<Mutex<HashMap<(String, u32), RemoteRoute>>>;
pub(crate) struct ForwardControl {
    info: Mutex<ForwardInfo>,
    cancel: CancellationToken,
    task: Mutex<Option<JoinHandle<()>>>,
    active: AtomicUsize,
    enabled: AtomicBool,
    remote_cleanup_required: AtomicBool,
}
impl ForwardControl {
    fn snapshot(&self) -> Result<ForwardInfo, Error> {
        let mut value = locked(&self.info)?.clone();
        value.active_connections = self.active.load(Ordering::Acquire);
        Ok(value)
    }
    fn status(&self, state: &'static str, message: Option<String>) {
        if let Ok(mut info) = self.info.lock() {
            info.state = state;
            info.message = message;
        }
        self.enabled
            .store(matches!(state, "starting" | "running"), Ordering::Release);
    }
    fn error(&self, error: &Error) {
        if let Ok(mut info) = self.info.lock() {
            info.message = Some(error.to_string());
        }
        tracing::warn!(
            operation = "ssh_forward",
            code =
                serverdeck_core::IpcError::from(failure("SSH_FORWARD_STREAM", "转发流失败")).code,
            "forward stream failed"
        );
    }
}
struct Active(Arc<ForwardControl>);
impl Drop for Active {
    fn drop(&mut self) {
        self.0.active.fetch_sub(1, Ordering::AcqRel);
    }
}

impl Engine {
    pub async fn forward_start(
        &self,
        session_id: &str,
        mut input: ForwardInput,
    ) -> Result<ForwardInfo, Error> {
        input.validate()?;
        let owner = self.control(session_id)?;
        if !owner.ready.load(Ordering::Acquire) || owner.cancel.is_cancelled() {
            return Err(failure("SSH_NOT_CONNECTED", "请先连接终端再启动转发"));
        }
        let transport = locked(&self.registry)?
            .transports
            .values()
            .find(|t| t.id == owner.info.transport_id)
            .cloned()
            .ok_or(Error::NotFound)?;
        let control = Arc::new(ForwardControl {
            info: Mutex::new(ForwardInfo {
                id: Uuid::new_v4().to_string(),
                session_id: session_id.into(),
                input: input.clone(),
                state: "starting",
                message: None,
                active_connections: 0,
            }),
            cancel: CancellationToken::new(),
            task: Mutex::new(None),
            active: AtomicUsize::new(0),
            enabled: AtomicBool::new(true),
            remote_cleanup_required: AtomicBool::new(false),
        });
        let id = control.snapshot()?.id;
        let (ready, receiver) = oneshot::channel();
        {
            let mut forwards = locked(&self.forwards)?;
            if forwards
                .values()
                .filter(|f| f.enabled.load(Ordering::Acquire))
                .count()
                >= 16
            {
                return Err(failure("SSH_FORWARD_LIMIT", "最多同时运行 16 个转发"));
            }
            if forwards.len() >= 64 {
                forwards.retain(|_, f| f.enabled.load(Ordering::Acquire));
            }
            if owner.cancel.is_cancelled() {
                return Err(Error::NotFound);
            }
            forwards.insert(id, control.clone());
            let running = control.clone();
            let task = tokio::spawn(async move {
                let mut ready = Some(ready);
                let result = run(
                    transport.clone(),
                    owner.clone(),
                    running.clone(),
                    &mut ready,
                )
                .await;
                // Always remove the local route before requesting removal of the remote listener.
                let cleanup = if input.kind == ForwardKind::Remote {
                    cleanup_remote(&transport, &input, &running).await
                } else {
                    Ok(())
                };
                let result = result.and(cleanup);
                match result {
                    Ok(()) => {
                        running.status("stopped", None);
                        if let Some(ready) = ready.take() {
                            let _ =
                                ready.send(Err(failure("SSH_FORWARD_CANCELLED", "转发启动已取消")));
                        }
                    }
                    Err(error) => {
                        running.status("failed", Some(error.to_string()));
                        if let Some(ready) = ready.take() {
                            let _ = ready.send(Err(error));
                        }
                    }
                }
            });
            *locked(&control.task)? = Some(task);
        }
        receiver.await.map_err(|e| Error::Worker(Box::new(e)))?
    }
    pub fn forward_list(&self, session_id: &str) -> Result<Vec<ForwardInfo>, Error> {
        locked(&self.forwards)?
            .values()
            .filter_map(|f| match f.snapshot() {
                Ok(info) if info.session_id == session_id => Some(Ok(info)),
                Ok(_) => None,
                Err(e) => Some(Err(e)),
            })
            .collect()
    }
    pub async fn forward_stop(&self, id: &str) -> Result<(), Error> {
        let control = locked(&self.forwards)?
            .get(id)
            .cloned()
            .ok_or(Error::NotFound)?;
        control.cancel.cancel();
        let task = locked(&control.task)?.take();
        if let Some(mut task) = task {
            match tokio::time::timeout(Duration::from_secs(8), &mut task).await {
                Ok(joined) => joined.map_err(|e| Error::Worker(Box::new(e)))?,
                Err(_) => {
                    task.abort();
                    let _ = task.await;
                    control.status("failed", Some("转发清理超时，请关闭对应主机连接".into()));
                    return Err(failure(
                        "SSH_FORWARD_TIMEOUT",
                        "转发清理超时，请关闭对应主机连接",
                    ));
                }
            }
        }
        let info = control.snapshot()?;
        if info.state == "failed" {
            return Err(failure(
                "SSH_FORWARD_STOP",
                "转发已停止流量，但清理失败；请检查状态并关闭主机连接",
            ));
        }
        Ok(())
    }
    pub(crate) async fn stop_session_forwards(&self, session_id: &str) {
        let controls = if let Ok(forwards) = locked(&self.forwards) {
            forwards
                .values()
                .filter_map(|f| {
                    f.snapshot()
                        .ok()
                        .filter(|i| i.session_id == session_id)
                        .map(|i| (i.id, f.clone()))
                })
                .collect::<Vec<_>>()
        } else {
            return;
        };
        for (_, control) in &controls {
            control.cancel.cancel();
        }
        for (id, _) in controls {
            if self.forward_stop(&id).await.is_err() {
                tracing::warn!(operation = "forward_shutdown", "forward cleanup failed");
            }
        }
        if let Ok(mut forwards) = locked(&self.forwards) {
            forwards.retain(|_, f| f.snapshot().is_ok_and(|i| i.session_id != session_id));
        }
    }
    pub fn forward_count(&self) -> Result<usize, Error> {
        Ok(locked(&self.forwards)?
            .values()
            .filter(|f| f.enabled.load(Ordering::Acquire))
            .count())
    }
}

async fn cleanup_remote(
    transport: &Transport,
    input: &ForwardInput,
    control: &ForwardControl,
) -> Result<(), Error> {
    let connection = transport.connection.lock().await.clone();
    let Some(connection) = connection else {
        return Ok(());
    };
    {
        let mut routes = locked(&connection.remotes)?;
        let key = (input.bind_address.to_string(), u32::from(input.listen_port));
        if !routes
            .get(&key)
            .is_some_and(|r| control.snapshot().is_ok_and(|c| c.id == r.owner))
        {
            return Ok(());
        }
        routes.remove(&key);
    }
    if !control.remote_cleanup_required.load(Ordering::Acquire) {
        return Ok(());
    }
    if connection.is_closed() {
        return Ok(());
    }
    let result = tokio::time::timeout(
        Duration::from_secs(3),
        connection
            .cancel_tcpip_forward(input.bind_address.to_string(), u32::from(input.listen_port)),
    )
    .await;
    if !matches!(result, Ok(Ok(()))) {
        // No silent orphaned remote listener: ambiguous cancellation closes this transport.
        let _ = tokio::time::timeout(
            Duration::from_secs(2),
            connection.disconnect(russh::Disconnect::ByApplication, "", "en"),
        )
        .await;
        let mut guard = transport.connection.lock().await;
        if guard
            .as_ref()
            .is_some_and(|current| Arc::ptr_eq(current, &connection))
        {
            guard.take();
        }
        return Err(failure(
            "SSH_FORWARD_CANCEL",
            "服务器未确认取消远程转发，已断开此 SSH 连接以释放监听",
        ));
    }
    Ok(())
}
async fn run(
    transport: Arc<Transport>,
    owner: Arc<Control>,
    control: Arc<ForwardControl>,
    ready: &mut Option<oneshot::Sender<Result<ForwardInfo, Error>>>,
) -> Result<(), Error> {
    let input = control.snapshot()?.input;
    let alive = {
        let guard = transport.connection.lock().await;
        let connection = guard
            .as_ref()
            .ok_or_else(|| failure("SSH_NOT_CONNECTED", "SSH 连接已关闭"))?;
        if connection.is_closed() {
            return Err(failure("SSH_NOT_CONNECTED", "SSH 连接已关闭"));
        }
        connection.alive.clone()
    };
    let (sender, mut incoming) = mpsc::channel(32);
    let initializing = async {
        if input.kind == ForwardKind::Remote {
            let connection = transport
                .connection
                .lock()
                .await
                .clone()
                .ok_or(Error::NotFound)?;
            {
                let mut routes = locked(&connection.remotes)?;
                let key = (input.bind_address.to_string(), u32::from(input.listen_port));
                if routes.contains_key(&key) {
                    return Err(failure("SSH_FORWARD_CONFLICT", "此远程监听已存在"));
                }
                routes.insert(
                    key,
                    RemoteRoute {
                        owner: control.snapshot()?.id,
                        sender,
                    },
                );
            }
            control
                .remote_cleanup_required
                .store(true, Ordering::Release);
            let requested = tokio::time::timeout(
                Duration::from_secs(5),
                connection
                    .tcpip_forward(input.bind_address.to_string(), u32::from(input.listen_port)),
            )
            .await
            .map_err(|_| failure("SSH_FORWARD_TIMEOUT", "远程转发请求超时"))?;
            if let Err(error) = requested {
                control
                    .remote_cleanup_required
                    .store(false, Ordering::Release);
                return Err(Error::Connection {
                    code: "SSH_FORWARD_REJECTED",
                    message: "服务器拒绝远程转发；端口可能冲突或策略不允许",
                    source: Some(Box::new(error)),
                });
            }
            Ok(None)
        } else {
            let listener =
                TcpListener::bind(SocketAddr::new(input.bind_address, input.listen_port))
                    .await
                    .map_err(|e| Error::Connection {
                        code: "SSH_FORWARD_BIND",
                        message: "本地监听失败，端口冲突或没有绑定权限",
                        source: Some(Box::new(e)),
                    })?;
            locked(&control.info)?.input.listen_port =
                listener.local_addr().map_err(proxy::io_error)?.port();
            Ok(Some(listener))
        }
    };
    let listener = tokio::select! {
        result = initializing => result?,
        _ = control.cancel.cancelled() => return Ok(()),
        _ = owner.cancel.cancelled() => return Ok(()),
        _ = alive.cancelled() => return Err(failure("SSH_DISCONNECTED", "SSH 断线，转发已停止")),
    };
    if owner.cancel.is_cancelled() || control.cancel.is_cancelled() {
        return Ok(());
    }
    control.status("running", None);
    if let Some(ready) = ready.take() {
        let _ = ready.send(control.snapshot());
    }
    let mut tasks = JoinSet::new();
    let result = loop {
        tokio::select! {
            _ = control.cancel.cancelled() => break Ok(()),
            _ = owner.cancel.cancelled() => break Ok(()),
            _ = alive.cancelled() => break Err(failure("SSH_DISCONNECTED", "SSH 断线，转发监听已关闭")),
            joined = tasks.join_next(), if !tasks.is_empty() => {
                if joined.is_some_and(|result| result.is_err()) {
                    control.error(&failure("SSH_FORWARD_WORKER", "转发子任务异常结束"));
                }
            }
            accepted = async {
                match &listener {
                    Some(listener) => listener.accept().await,
                    None => std::future::pending().await,
                }
            }, if tasks.len() < 32 => {
                let (socket, _) = accepted.map_err(proxy::io_error)?;
                let transport = transport.clone();
                let control = control.clone();
                let input = input.clone();
                control.active.fetch_add(1, Ordering::AcqRel);
                let active = Active(control.clone());
                tasks.spawn(async move {
                    let _active = active;
                    if let Err(error) = local_stream(socket, &transport, &input).await {
                        control.error(&error);
                    }
                });
            }
            value = incoming.recv(), if listener.is_none() && tasks.len() < 32 => {
                let Some(channel) = value.and_then(Incoming::take) else {
                    break Err(failure("SSH_FORWARD_CLOSED", "远程转发通道已关闭"));
                };
                let control = control.clone();
                let input = input.clone();
                control.active.fetch_add(1, Ordering::AcqRel);
                let active = Active(control.clone());
                tasks.spawn(async move {
                    let _active = active;
                    if let Err(error) = remote_stream(channel, &input).await {
                        control.error(&error);
                    }
                });
            }
        }
    };
    incoming.close();
    drop(listener);
    tasks.abort_all();
    while tasks.join_next().await.is_some() {}
    while incoming.try_recv().is_ok() {}
    result
}
async fn direct(
    transport: &Transport,
    host: &str,
    port: u16,
) -> Result<Channel<client::Msg>, Error> {
    tokio::time::timeout(Duration::from_secs(10), async {
        let connection = transport
            .connection
            .lock()
            .await
            .clone()
            .ok_or_else(|| failure("SSH_NOT_CONNECTED", "SSH 连接已关闭"))?;
        connection
            .channel_open_direct_tcpip(host, u32::from(port), "127.0.0.1", 0)
            .await
            .map_err(network)
    })
    .await
    .map_err(|_| failure("SSH_FORWARD_TIMEOUT", "转发目标连接超时"))?
}
async fn local_stream(
    mut socket: TcpStream,
    transport: &Transport,
    input: &ForwardInput,
) -> Result<(), Error> {
    let (host, port) = if input.kind == ForwardKind::Dynamic {
        tokio::time::timeout(Duration::from_secs(10), socks_request(&mut socket))
            .await
            .map_err(|_| failure("SSH_FORWARD_TIMEOUT", "SOCKS 握手超时"))??
    } else {
        (
            input
                .target_host
                .clone()
                .ok_or(Error::Validation("缺少转发目标"))?,
            input
                .target_port
                .ok_or(Error::Validation("缺少转发目标端口"))?,
        )
    };
    let channel = match direct(transport, &host, port).await {
        Ok(channel) => channel,
        Err(error) => {
            if input.kind == ForwardKind::Dynamic {
                let _ = socket.write_all(&[5, 5, 0, 1, 0, 0, 0, 0, 0, 0]).await;
            }
            return Err(error);
        }
    };
    if input.kind == ForwardKind::Dynamic {
        socket
            .write_all(&[5, 0, 0, 1, 0, 0, 0, 0, 0, 0])
            .await
            .map_err(proxy::io_error)?;
    }
    let mut stream = channel.into_stream();
    tokio::io::copy_bidirectional(&mut socket, &mut stream)
        .await
        .map_err(proxy::io_error)?;
    Ok(())
}
async fn remote_stream(channel: Channel<client::Msg>, input: &ForwardInput) -> Result<(), Error> {
    let mut stream = channel.into_stream();
    let host = input
        .target_host
        .as_deref()
        .ok_or(Error::Validation("缺少本地目标"))?;
    let port = input
        .target_port
        .ok_or(Error::Validation("缺少本地目标端口"))?;
    let mut socket =
        tokio::time::timeout(Duration::from_secs(10), TcpStream::connect((host, port)))
            .await
            .map_err(|_| failure("SSH_FORWARD_TIMEOUT", "远程转发的本地目标连接超时"))?
            .map_err(proxy::io_error)?;
    tokio::io::copy_bidirectional(&mut stream, &mut socket)
        .await
        .map_err(proxy::io_error)?;
    Ok(())
}
async fn socks_request(socket: &mut TcpStream) -> Result<(String, u16), Error> {
    let version = socket.read_u8().await.map_err(proxy::io_error)?;
    let count = socket.read_u8().await.map_err(proxy::io_error)?;
    let mut methods = vec![0; usize::from(count)];
    socket
        .read_exact(&mut methods)
        .await
        .map_err(proxy::io_error)?;
    if version != 5 || !methods.contains(&0) {
        let _ = socket.write_all(&[5, 255]).await;
        return Err(failure("SSH_SOCKS", "动态转发只支持 SOCKS5 无密码 CONNECT"));
    }
    socket.write_all(&[5, 0]).await.map_err(proxy::io_error)?;
    let mut head = [0; 4];
    socket
        .read_exact(&mut head)
        .await
        .map_err(proxy::io_error)?;
    if head[0] != 5 || head[1] != 1 || head[2] != 0 {
        let _ = socket.write_all(&[5, 7, 0, 1, 0, 0, 0, 0, 0, 0]).await;
        return Err(failure("SSH_SOCKS", "不支持 SOCKS BIND 或 UDP ASSOCIATE"));
    }
    let (host, port) = proxy::read_address(socket, head[3]).await?;
    let host = serverdeck_core::hosts::normalize_hostname(&host)?;
    if port == 0 {
        return Err(Error::Validation("SOCKS 目标端口为零"));
    }
    Ok((host, port))
}
