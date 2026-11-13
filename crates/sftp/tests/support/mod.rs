use russh::{
    Channel, ChannelId,
    keys::{Algorithm, HashAlg, PrivateKey},
    server::{self, Auth, Session},
};
use russh_sftp::protocol::*;
use serverdeck_core::{
    Error,
    hosts::{AuthType, Host, HostInput},
    terminal::{TerminalEvent, TerminalSession},
};
use serverdeck_ssh::{Authentication, ConnectionPlan, Engine, Hop};
use serverdeck_storage::Database;
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt},
    net::TcpListener,
};
use zeroize::Zeroizing;

// Delay response delivery, not request processing: concurrent requests share the same RTT.
fn delayed_replies<T>(
    stream: T,
    delay: Duration,
) -> (tokio::io::DuplexStream, tokio::task::JoinHandle<()>)
where
    T: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let (server, proxy) = tokio::io::duplex(2 * 1024 * 1024);
    let worker = tokio::spawn(async move {
        let (mut client_read, mut client_write) = tokio::io::split(stream);
        let (mut server_read, mut server_write) = tokio::io::split(proxy);
        let (sender, mut receiver) =
            tokio::sync::mpsc::channel::<(tokio::time::Instant, Vec<u8>)>(64);
        let incoming = tokio::io::copy(&mut client_read, &mut server_write);
        let outgoing = async {
            let produce = async {
                loop {
                    let length = server_read.read_u32().await?;
                    if length > 1024 * 1024 {
                        return Err(std::io::Error::other("fixture packet too large"));
                    }
                    let mut bytes = vec![0; length as usize + 4];
                    bytes[..4].copy_from_slice(&length.to_be_bytes());
                    server_read.read_exact(&mut bytes[4..]).await?;
                    if sender
                        .send((tokio::time::Instant::now() + delay, bytes))
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
                Ok::<_, std::io::Error>(())
            };
            let consume = async {
                while let Some((at, bytes)) = receiver.recv().await {
                    tokio::time::sleep_until(at).await;
                    client_write.write_all(&bytes).await?;
                }
                Ok::<_, std::io::Error>(())
            };
            tokio::try_join!(produce, consume).map(|_| ())
        };
        let _ = tokio::try_join!(incoming, outgoing); // Peer closure is the fixture shutdown path.
    });
    (server, worker)
}

fn status(id: u32) -> Status {
    Status {
        id,
        status_code: StatusCode::Ok,
        error_message: String::new(),
        language_tag: "en".into(),
    }
}
fn io(e: std::io::Error) -> StatusCode {
    match e.kind() {
        std::io::ErrorKind::NotFound => StatusCode::NoSuchFile,
        std::io::ErrorKind::PermissionDenied => StatusCode::PermissionDenied,
        _ => StatusCode::Failure,
    }
}
fn attrs(m: &std::fs::Metadata) -> FileAttributes {
    let mut a = FileAttributes::from(m);
    a.uid = Some(1000);
    a.user = Some("sftp-owner".into());
    a.gid = Some(1000);
    a.permissions = Some(if m.is_dir() {
        0o040700
    } else if m.permissions().readonly() {
        0o100400
    } else {
        0o100600
    });
    a
}
#[derive(Default)]
pub struct FileFaults {
    pub wire_delay_ms: std::sync::atomic::AtomicU64,
    pub close_delay_ms: std::sync::atomic::AtomicU64,
    pub corrupt_reads: std::sync::atomic::AtomicBool,
    pub reject_writes: std::sync::atomic::AtomicBool,
    pub ignore_times: std::sync::atomic::AtomicBool,
    pub open_handles: std::sync::atomic::AtomicUsize,
    pub links: Mutex<HashMap<String, String>>,
    pub reported_sizes: Mutex<HashMap<String, u64>>,
    pub sudo_password: Mutex<Option<String>>,
    pub sudo_commands: Mutex<Vec<String>>,
    pub reject_sudo: std::sync::atomic::AtomicBool,
}
enum HandleValue {
    File(tokio::fs::File),
    Dir(Vec<File>, bool),
}
struct Disk {
    faults: Arc<FileFaults>,
    root: PathBuf,
    handles: HashMap<String, HandleValue>,
    atomic: bool,
    delay: Duration,
}
impl Drop for Disk {
    fn drop(&mut self) {
        self.faults
            .open_handles
            .fetch_sub(self.handles.len(), std::sync::atomic::Ordering::SeqCst);
    }
}
impl Disk {
    fn path(&self, path: &str) -> Result<PathBuf, StatusCode> {
        if path == "." {
            return Ok(self.root.clone());
        }
        if !path.starts_with('/') || path.split('/').any(|s| s == ".." || s == ".") {
            return Err(StatusCode::PermissionDenied);
        }
        Ok(self.root.join(path.trim_start_matches('/')))
    }
    fn link_target(&self, path: &str) -> Option<String> {
        self.faults
            .links
            .lock()
            .expect("fixture links")
            .get(path)
            .cloned()
    }
}
impl russh_sftp::server::Handler for Disk {
    type Error = StatusCode;
    fn unimplemented(&self) -> StatusCode {
        StatusCode::OpUnsupported
    }
    async fn init(&mut self, _: u32, _: HashMap<String, String>) -> Result<Version, StatusCode> {
        let mut v = Version::new();
        if self.atomic {
            v.extensions
                .insert("posix-rename@openssh.com".into(), "1".into());
        }
        Ok(v)
    }
    async fn realpath(&mut self, id: u32, path: String) -> Result<Name, StatusCode> {
        let path = self.link_target(&path).unwrap_or(path);
        let p = self.path(&path)?;
        tokio::fs::metadata(p).await.map_err(io)?;
        Ok(Name {
            id,
            files: vec![File::new(
                if path == "." { "/".into() } else { path },
                FileAttributes::default(),
            )],
        })
    }
    async fn lstat(&mut self, id: u32, path: String) -> Result<Attrs, StatusCode> {
        if let Some(target) = self.link_target(&path) {
            return Ok(Attrs {
                id,
                attrs: FileAttributes {
                    permissions: Some(0o120777),
                    size: Some(target.len() as u64),
                    ..Default::default()
                },
            });
        }
        let mut attributes = attrs(
            &tokio::fs::symlink_metadata(self.path(&path)?)
                .await
                .map_err(io)?,
        );
        if let Some(size) = self.faults.reported_sizes.lock().unwrap().get(&path) {
            attributes.size = Some(*size);
        }
        Ok(Attrs {
            id,
            attrs: attributes,
        })
    }
    async fn stat(&mut self, id: u32, path: String) -> Result<Attrs, StatusCode> {
        self.lstat(id, path).await
    }
    async fn opendir(&mut self, id: u32, path: String) -> Result<Handle, StatusCode> {
        let mut dir = tokio::fs::read_dir(self.path(&path)?).await.map_err(io)?;
        let mut files = vec![];
        while let Some(entry) = dir.next_entry().await.map_err(io)? {
            files.push(File::new(
                entry
                    .file_name()
                    .to_str()
                    .ok_or(StatusCode::Failure)?
                    .to_owned(),
                attrs(&entry.metadata().await.map_err(io)?),
            ));
        }
        let handle = uuid::Uuid::new_v4().to_string();
        self.handles
            .insert(handle.clone(), HandleValue::Dir(files, false));
        self.faults
            .open_handles
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Ok(Handle { id, handle })
    }
    async fn readdir(&mut self, id: u32, handle: String) -> Result<Name, StatusCode> {
        match self.handles.get_mut(&handle) {
            Some(HandleValue::Dir(files, read)) => {
                if *read {
                    return Err(StatusCode::Eof);
                }
                *read = true;
                Ok(Name {
                    id,
                    files: files.clone(),
                })
            }
            _ => Err(StatusCode::Failure),
        }
    }
    async fn open(
        &mut self,
        id: u32,
        path: String,
        flags: OpenFlags,
        _: FileAttributes,
    ) -> Result<Handle, StatusCode> {
        let path = self.path(&path)?;
        if flags.contains(OpenFlags::WRITE)
            && tokio::fs::metadata(&path)
                .await
                .is_ok_and(|m| m.permissions().readonly())
        {
            return Err(StatusCode::PermissionDenied);
        }
        let options: std::fs::OpenOptions = flags.into();
        let file = tokio::fs::OpenOptions::from(options)
            .open(&path)
            .await
            .map_err(io)?;
        let handle = uuid::Uuid::new_v4().to_string();
        self.handles.insert(handle.clone(), HandleValue::File(file));
        self.faults
            .open_handles
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Ok(Handle { id, handle })
    }
    async fn close(&mut self, id: u32, handle: String) -> Result<Status, StatusCode> {
        let delay = self
            .faults
            .close_delay_ms
            .load(std::sync::atomic::Ordering::SeqCst);
        if delay > 0 {
            tokio::time::sleep(Duration::from_millis(delay)).await;
        }
        if self.handles.remove(&handle).is_some() {
            self.faults
                .open_handles
                .fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
        }
        Ok(status(id))
    }
    async fn read(
        &mut self,
        id: u32,
        handle: String,
        offset: u64,
        len: u32,
    ) -> Result<Data, StatusCode> {
        let Some(HandleValue::File(file)) = self.handles.get_mut(&handle) else {
            return Err(StatusCode::Failure);
        };
        file.seek(std::io::SeekFrom::Start(offset))
            .await
            .map_err(io)?;
        let mut bytes = vec![0; len.min(65536) as usize];
        let n = file.read(&mut bytes).await.map_err(io)?;
        if n == 0 {
            return Err(StatusCode::Eof);
        }
        bytes.truncate(n);
        if self
            .faults
            .corrupt_reads
            .load(std::sync::atomic::Ordering::SeqCst)
        {
            bytes[0] ^= 1;
        }
        Ok(Data { id, data: bytes })
    }
    async fn write(
        &mut self,
        id: u32,
        handle: String,
        offset: u64,
        data: Vec<u8>,
    ) -> Result<Status, StatusCode> {
        if self
            .faults
            .reject_writes
            .load(std::sync::atomic::Ordering::SeqCst)
        {
            return Err(StatusCode::PermissionDenied);
        }
        if !self.delay.is_zero() {
            tokio::time::sleep(self.delay).await;
        }
        let Some(HandleValue::File(file)) = self.handles.get_mut(&handle) else {
            return Err(StatusCode::Failure);
        };
        file.seek(std::io::SeekFrom::Start(offset))
            .await
            .map_err(io)?;
        file.write_all(&data).await.map_err(io)?;
        Ok(status(id))
    }
    async fn fstat(&mut self, id: u32, handle: String) -> Result<Attrs, StatusCode> {
        let Some(HandleValue::File(file)) = self.handles.get(&handle) else {
            return Err(StatusCode::Failure);
        };
        Ok(Attrs {
            id,
            attrs: attrs(&file.metadata().await.map_err(io)?),
        })
    }
    async fn setstat(
        &mut self,
        id: u32,
        path: String,
        value: FileAttributes,
    ) -> Result<Status, StatusCode> {
        let path = self.path(&path)?;
        if let Some(modified) = value.mtime
            && !self
                .faults
                .ignore_times
                .load(std::sync::atomic::Ordering::SeqCst)
        {
            let file = tokio::fs::OpenOptions::new()
                .write(true)
                .open(&path)
                .await
                .map_err(io)?;
            file.into_std()
                .await
                .set_modified(
                    std::time::SystemTime::UNIX_EPOCH + Duration::from_secs(u64::from(modified)),
                )
                .map_err(io)?;
        }
        if let Some(mode) = value.permissions {
            let mut permissions = tokio::fs::metadata(&path).await.map_err(io)?.permissions();
            permissions.set_readonly(mode & 0o200 == 0);
            tokio::fs::set_permissions(&path, permissions)
                .await
                .map_err(io)?;
        }
        Ok(status(id))
    }
    async fn mkdir(
        &mut self,
        id: u32,
        path: String,
        _: FileAttributes,
    ) -> Result<Status, StatusCode> {
        tokio::fs::create_dir(self.path(&path)?).await.map_err(io)?;
        Ok(status(id))
    }
    async fn rmdir(&mut self, id: u32, path: String) -> Result<Status, StatusCode> {
        tokio::fs::remove_dir(self.path(&path)?).await.map_err(io)?;
        Ok(status(id))
    }
    async fn remove(&mut self, id: u32, path: String) -> Result<Status, StatusCode> {
        tokio::fs::remove_file(self.path(&path)?)
            .await
            .map_err(io)?;
        Ok(status(id))
    }
    async fn rename(&mut self, id: u32, old: String, new: String) -> Result<Status, StatusCode> {
        let old = self.path(&old)?;
        let new = self.path(&new)?;
        if new.exists() {
            return Err(StatusCode::Failure);
        }
        tokio::fs::rename(old, new).await.map_err(io)?;
        Ok(status(id))
    }
    async fn extended(
        &mut self,
        id: u32,
        request: String,
        data: Vec<u8>,
    ) -> Result<Packet, StatusCode> {
        if request != "posix-rename@openssh.com" {
            return Err(StatusCode::OpUnsupported);
        }
        let mut cursor = 0;
        let mut paths = vec![];
        for _ in 0..2 {
            if data.len() < cursor + 4 {
                return Err(StatusCode::BadMessage);
            }
            let len = u32::from_be_bytes(
                data[cursor..cursor + 4]
                    .try_into()
                    .map_err(|_| StatusCode::BadMessage)?,
            ) as usize;
            cursor += 4;
            if data.len() < cursor + len {
                return Err(StatusCode::BadMessage);
            }
            paths.push(
                std::str::from_utf8(&data[cursor..cursor + len])
                    .map_err(|_| StatusCode::BadMessage)?,
            );
            cursor += len;
        }
        tokio::fs::rename(self.path(paths[0])?, self.path(paths[1])?)
            .await
            .map_err(io)?;
        Ok(Packet::Status(status(id)))
    }
}
struct Handler {
    faults: Arc<FileFaults>,
    password: String,
    root: PathBuf,
    channels: HashMap<ChannelId, Channel<server::Msg>>,
    workers: Vec<tokio::task::JoinHandle<()>>,
    atomic: bool,
    delay: Duration,
}
impl Drop for Handler {
    fn drop(&mut self) {
        for worker in &self.workers {
            worker.abort();
        }
    }
}
impl server::Handler for Handler {
    type Error = russh::Error;
    async fn auth_password(&mut self, _: &str, password: &str) -> Result<Auth, Self::Error> {
        Ok(if password == self.password {
            Auth::Accept
        } else {
            Auth::reject()
        })
    }
    async fn channel_open_session(
        &mut self,
        channel: Channel<server::Msg>,
        reply: server::ChannelOpenHandle,
        _: &mut Session,
    ) -> Result<(), Self::Error> {
        self.channels.insert(channel.id(), channel);
        reply.accept().await;
        Ok(())
    }
    async fn subsystem_request(
        &mut self,
        channel: ChannelId,
        name: &str,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        if name != "sftp" {
            session.channel_failure(channel)?;
            return Ok(());
        }
        session.channel_success(channel)?;
        if let Some(channel) = self.channels.remove(&channel) {
            let disk = Disk {
                faults: self.faults.clone(),
                root: self.root.clone(),
                handles: HashMap::new(),
                atomic: self.atomic,
                delay: self.delay,
            };
            let wire_delay = self
                .faults
                .wire_delay_ms
                .load(std::sync::atomic::Ordering::SeqCst);
            self.workers.push(tokio::spawn(async move {
                if wire_delay == 0 {
                    russh_sftp::server::run(channel.into_stream(), disk).await;
                } else {
                    let (server, proxy) =
                        delayed_replies(channel.into_stream(), Duration::from_millis(wire_delay));
                    russh_sftp::server::run(server, disk).await;
                    proxy.await.expect("SFTP latency proxy");
                }
            }));
        }
        Ok(())
    }
    async fn exec_request(
        &mut self,
        id: ChannelId,
        command: &[u8],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        let command = String::from_utf8_lossy(command).to_string();
        self.faults
            .sudo_commands
            .lock()
            .unwrap()
            .push(command.clone());
        session.channel_success(id)?;
        if self
            .faults
            .reject_sudo
            .load(std::sync::atomic::Ordering::SeqCst)
        {
            session.exit_status_request(id, 1)?;
            session.close(id)?;
            return Ok(());
        }
        fn marker(command: &str, prefix: &str) -> String {
            let start = command.find(prefix).expect("startup marker");
            command[start..start + prefix.len() + 34].into()
        }
        let ready = marker(&command, "__SD_SFTP_");
        let expected = self.faults.sudo_password.lock().unwrap().clone();
        if expected.is_some() && command.contains("sudo -n") {
            session.exit_status_request(id, 1)?;
            session.close(id)?;
            return Ok(());
        }
        let prompt = expected.as_ref().map(|_| marker(&command, "__SD_SUDO_"));
        let mut channel = self.channels.remove(&id).expect("channel");
        let disk = Disk {
            faults: self.faults.clone(),
            root: self.root.clone(),
            handles: HashMap::new(),
            atomic: self.atomic,
            delay: self.delay,
        };
        self.workers.push(tokio::spawn(async move {
            if let Some(prompt) = prompt {
                for part in prompt.as_bytes().chunks(7) {
                    channel.extended_data(1, part).await.unwrap();
                }
                let mut input = Vec::new();
                loop {
                    match channel.wait().await {
                        Some(russh::ChannelMsg::Data { data }) => {
                            input.extend_from_slice(&data);
                            if input.ends_with(b"\n") {
                                break;
                            }
                        }
                        Some(russh::ChannelMsg::Close) | None => return,
                        _ => (),
                    }
                }
                if input != format!("{}\n", expected.unwrap()).as_bytes() {
                    channel.extended_data(1, prompt.as_bytes()).await.unwrap();
                    let _ = channel.close().await;
                    return;
                }
            }
            for part in ready.as_bytes().chunks(7) {
                channel.data(part).await.unwrap();
            }
            russh_sftp::server::run(channel.into_stream(), disk).await;
        }));
        Ok(())
    }
    async fn pty_request(
        &mut self,
        channel: ChannelId,
        _: &str,
        _: u32,
        _: u32,
        _: u32,
        _: u32,
        _: &[(russh::Pty, u32)],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        session.channel_success(channel)?;
        Ok(())
    }
    async fn shell_request(
        &mut self,
        channel: ChannelId,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        session.channel_success(channel)?;
        Ok(())
    }
}
pub struct Server {
    // Used only by integration suites that connect two servers to one engine.
    #[allow(dead_code)]
    pub database: Database,
    pub faults: Arc<FileFaults>,
    pub root: tempfile::TempDir,
    pub host: Host,
    pub engine: Engine,
    pub password: String,
    sockets: Arc<Mutex<Vec<std::net::TcpStream>>>,
    task: tokio::task::JoinHandle<()>,
    _database: tempfile::TempDir,
}
impl Drop for Server {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl Server {
    pub async fn start(atomic: bool, delay: Duration) -> Self {
        Self::start_shared(atomic, delay, None).await
    }
    pub async fn start_shared(
        atomic: bool,
        delay: Duration,
        shared: Option<(Database, Engine)>,
    ) -> Self {
        let root = tempfile::tempdir().expect("root");
        let database = tempfile::tempdir().expect("db");
        let db = shared
            .as_ref()
            .map(|(db, _)| db.clone())
            .unwrap_or_else(|| Database::open(database.path().join("db")).expect("db"));
        let password = uuid::Uuid::new_v4().to_string();
        let key = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).expect("key");
        let pin = key.public_key().fingerprint(HashAlg::Sha256).to_string();
        let public = key.public_key().to_openssh().expect("public");
        let config = Arc::new(server::Config {
            keys: vec![key],
            auth_rejection_time: Duration::ZERO,
            auth_rejection_time_initial: Some(Duration::ZERO),
            ..Default::default()
        });
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.expect("listen");
        let port = listener.local_addr().expect("port").port();
        db.trust_key("127.0.0.1", port, &public, &pin)
            .expect("trust");
        let host = db
            .host_create(HostInput {
                name: "SFTP fixture".into(),
                hostname: "127.0.0.1".into(),
                port,
                username: "fixture".into(),
                auth_type: AuthType::Password,
                credential_id: None,
                group_id: None,
                description: String::new(),
                favorite: false,
                connect_timeout_secs: 3,
                ssh: Default::default(),
            })
            .expect("host");
        let engine = shared
            .map(|(_, engine)| engine)
            .unwrap_or_else(|| Engine::new(db.clone()));
        let sockets = Arc::new(Mutex::new(Vec::<std::net::TcpStream>::new()));
        let peers = sockets.clone();
        let pw = password.clone();
        let path = root.path().to_owned();
        let faults = Arc::new(FileFaults::default());
        let failures = faults.clone();
        let task = tokio::spawn(async move {
            let mut workers = tokio::task::JoinSet::new();
            loop {
                tokio::select! {accepted=listener.accept()=>{let (stream,_)=accepted.expect("accept");let stream=stream.into_std().expect("std stream");peers.lock().expect("peers").push(stream.try_clone().expect("clone"));let stream=tokio::net::TcpStream::from_std(stream).expect("async stream");let handler=Handler{faults:failures.clone(),password:pw.clone(),root:path.clone(),channels:HashMap::new(),workers:vec![],atomic,delay};let config=config.clone();workers.spawn(async move{if let Ok(running)=server::run_stream(config,stream,handler).await{let _=running.await;}});},_=workers.join_next(),if !workers.is_empty()=>()}
            }
        });
        Self {
            database: db,
            faults,
            root,
            host,
            engine,
            password,
            sockets,
            task,
            _database: database,
        }
    }
    pub async fn open(&self) -> TerminalSession {
        self.open_identity(None, false).await
    }
    pub async fn open_as(&self, user: Option<serverdeck_core::files::SftpUser>) -> TerminalSession {
        self.open_identity(user, true).await
    }
    async fn open_identity(
        &self,
        user: Option<serverdeck_core::files::SftpUser>,
        dedicated: bool,
    ) -> TerminalSession {
        let (tx, mut events) = tokio::sync::mpsc::channel(32);
        let plan = ConnectionPlan {
            hops: vec![Hop {
                host: self.host.clone(),
                revision: 1,
                auth: Authentication::Password(Zeroizing::new(self.password.clone())),
            }],
            proxy: None,
        };
        let sink: serverdeck_ssh::Sink = Arc::new(move |event| tx.try_send(event).is_ok());
        let info = if dedicated {
            self.engine
                .open_file_user_plan(self.host.clone(), plan, sink, user)
        } else {
            self.engine.open_file_plan(self.host.clone(), plan, sink)
        }
        .expect("open");
        tokio::time::timeout(Duration::from_secs(8), async {
            while let Some(event) = events.recv().await {
                if let TerminalEvent::State { state, code, .. } = event {
                    assert_ne!(state, "failed", "{code:?}");
                    if state == "connected" {
                        break;
                    }
                }
            }
        })
        .await
        .expect("connected");
        info
    }
    pub fn cut_network(&self) {
        for socket in self.sockets.lock().expect("peers").drain(..) {
            let _ = socket.shutdown(std::net::Shutdown::Both);
        }
    }
    pub fn terminal(&self) -> Result<TerminalSession, Error> {
        self.engine.open(
            self.host.clone(),
            1,
            Authentication::Password(Zeroizing::new(self.password.clone())),
            serverdeck_core::terminal::TerminalSize { cols: 80, rows: 24 },
            Arc::new(|_| true),
        )
    }
}
