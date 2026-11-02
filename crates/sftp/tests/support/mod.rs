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
    pub reject_writes: std::sync::atomic::AtomicBool,
    pub open_handles: std::sync::atomic::AtomicUsize,
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
        Ok(Attrs {
            id,
            attrs: attrs(
                &tokio::fs::symlink_metadata(self.path(&path)?)
                    .await
                    .map_err(io)?,
            ),
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
            self.workers.push(tokio::spawn(async move {
                russh_sftp::server::run(channel.into_stream(), disk).await;
            }));
        }
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
    pub faults: Arc<FileFaults>,
    pub root: tempfile::TempDir,
    pub host: Host,
    pub engine: Engine,
    password: String,
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
        let root = tempfile::tempdir().expect("root");
        let database = tempfile::tempdir().expect("db");
        let db = Database::open(database.path().join("db")).expect("db");
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
                tags: vec![],
                description: String::new(),
                favorite: false,
                connect_timeout_secs: 3,
                ssh: Default::default(),
            })
            .expect("host");
        let engine = Engine::new(db.clone());
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
        let (tx, mut events) = tokio::sync::mpsc::channel(32);
        let info = self
            .engine
            .open_file_plan(
                self.host.clone(),
                ConnectionPlan {
                    hops: vec![Hop {
                        host: self.host.clone(),
                        revision: 1,
                        auth: Authentication::Password(Zeroizing::new(self.password.clone())),
                    }],
                    proxy: None,
                },
                Arc::new(move |event| tx.try_send(event).is_ok()),
            )
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
