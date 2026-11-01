use russh::{
    Channel, ChannelId,
    keys::{Algorithm, HashAlg, PrivateKey},
    server::{self, Auth, Session},
};
use serverdeck_core::ops::*;
use serverdeck_core::{
    hosts::{AuthType, Host, HostInput},
    terminal::{TerminalEvent, TerminalSession, TerminalSize},
};
use serverdeck_ops::Operations;
use serverdeck_ssh::{Authentication, ConnectionPlan, Engine, Hop};
use serverdeck_storage::Database;
use std::{
    collections::HashMap,
    sync::{
        Arc,
        atomic::{AtomicU8, AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::net::TcpListener;
use zeroize::Zeroizing;
struct Handler {
    password: String,
    channels: HashMap<ChannelId, Channel<server::Msg>>,
    mode: Arc<AtomicU8>,
    calls: Arc<AtomicUsize>,
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
        c: Channel<server::Msg>,
        reply: server::ChannelOpenHandle,
        _: &mut Session,
    ) -> Result<(), Self::Error> {
        self.channels.insert(c.id(), c);
        reply.accept().await;
        Ok(())
    }
    async fn channel_close(&mut self, id: ChannelId, _: &mut Session) -> Result<(), Self::Error> {
        self.channels.remove(&id);
        Ok(())
    }
    async fn exec_request(
        &mut self,
        id: ChannelId,
        command: &[u8],
        s: &mut Session,
    ) -> Result<(), Self::Error> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        s.channel_success(id)?;
        let command = String::from_utf8_lossy(command);
        if command.contains("tail -n") {
            s.data(id, vec![b'a'; 32768])?;
            s.extended_data(id, 1, b"stderr log\n".to_vec())?;
            return Ok(());
        }
        match self.mode.load(Ordering::SeqCst) {
            1 => {
                s.extended_data(id, 1, b"permission denied".to_vec())?;
                s.exit_status_request(id, 77)?;
            }
            2 => return Ok(()),
            3 => {
                s.data(id, vec![b'x'; 2 * 1024 * 1024 + 1])?;
                s.exit_status_request(id, 0)?;
            }
            _ => {
                s.data(id, b"12 test 2.5 1.0 100 fixture\n".to_vec())?;
                s.exit_status_request(id, 0)?;
            }
        }
        s.close(id)
    }
    async fn signal(
        &mut self,
        id: ChannelId,
        _: russh::Sig,
        s: &mut Session,
    ) -> Result<(), Self::Error> {
        self.calls.fetch_add(100, Ordering::SeqCst);
        s.exit_status_request(id, 0)?;
        s.close(id)
    }
    async fn pty_request(
        &mut self,
        id: ChannelId,
        _: &str,
        _: u32,
        _: u32,
        _: u32,
        _: u32,
        _: &[(russh::Pty, u32)],
        s: &mut Session,
    ) -> Result<(), Self::Error> {
        s.channel_success(id)
    }
    async fn shell_request(&mut self, id: ChannelId, s: &mut Session) -> Result<(), Self::Error> {
        s.channel_success(id)
    }
    async fn data(
        &mut self,
        id: ChannelId,
        data: &[u8],
        s: &mut Session,
    ) -> Result<(), Self::Error> {
        s.data(id, data.to_vec())
    }
}
struct Fixture {
    engine: Engine,
    host: Host,
    password: String,
    mode: Arc<AtomicU8>,
    calls: Arc<AtomicUsize>,
    sockets: Arc<std::sync::Mutex<Vec<std::net::TcpStream>>>,
    task: tokio::task::JoinHandle<()>,
    _directory: tempfile::TempDir,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl Fixture {
    async fn start() -> Self {
        let directory = tempfile::tempdir().expect("directory");
        let db = Database::open(directory.path().join("db")).expect("db");
        let key = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).expect("key");
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.expect("listen");
        let port = listener.local_addr().expect("port").port();
        db.trust_key(
            "127.0.0.1",
            port,
            &key.public_key().to_openssh().expect("public"),
            &key.public_key().fingerprint(HashAlg::Sha256).to_string(),
        )
        .expect("trust");
        let host = db
            .host_create(HostInput {
                name: "Monitor protocol fixture".into(),
                hostname: "127.0.0.1".into(),
                port,
                username: "test".into(),
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
        let config = Arc::new(server::Config {
            keys: vec![key],
            ..Default::default()
        });
        let mode = Arc::new(AtomicU8::new(0));
        let calls = Arc::new(AtomicUsize::new(0));
        let m = mode.clone();
        let count = calls.clone();
        let password = uuid::Uuid::new_v4().to_string();
        let pw = password.clone();
        let sockets = Arc::new(std::sync::Mutex::new(Vec::<std::net::TcpStream>::new()));
        let peers = sockets.clone();
        let task = tokio::spawn(async move {
            let mut workers = tokio::task::JoinSet::new();
            loop {
                tokio::select! {accepted=listener.accept()=>{let(stream,_)=accepted.expect("accept");let stream=stream.into_std().expect("std stream");peers.lock().expect("peers").push(stream.try_clone().expect("clone socket"));let stream=tokio::net::TcpStream::from_std(stream).expect("async stream");let c=config.clone();let h=Handler{password:pw.clone(),channels:HashMap::new(),mode:m.clone(),calls:count.clone()};workers.spawn(async move{if let Ok(handle)=server::run_stream(c,stream,h).await{let _=handle.await;}});},_=workers.join_next(),if !workers.is_empty()=>()}
            }
        });
        Self {
            engine: Engine::new(db),
            host,
            password,
            mode,
            calls,
            sockets,
            task,
            _directory: directory,
        }
    }
    fn open(&self) -> TerminalSession {
        self.engine
            .open_ops_plan(self.host.clone(), self.plan(), Arc::new(|_| true))
            .expect("ops lease")
    }
    fn plan(&self) -> ConnectionPlan {
        ConnectionPlan {
            hops: vec![Hop {
                host: self.host.clone(),
                revision: 0,
                auth: Authentication::Password(Zeroizing::new(self.password.clone())),
            }],
            proxy: None,
        }
    }
}
async fn ready(f: &Fixture, session: &TerminalSession) {
    tokio::time::timeout(Duration::from_secs(3), async {
        while !f.engine.ops_ready(&session.id).expect("session") {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("ready");
}

#[tokio::test]
async fn actual_exec_validates_before_sending_and_reports_permissions_limits_and_timeout() {
    let f = Fixture::start().await;
    let session = f.open();
    ready(&f, &session).await;
    let ops = Operations::new(f.engine.clone());
    assert!(
        ops.query(
            &session.id,
            Request::ContainerAction {
                id: "a".repeat(64),
                action: ContainerAction::Stop,
                confirmed: false
            }
        )
        .await
        .is_err()
    );
    assert_eq!(f.calls.load(Ordering::SeqCst), 0);
    let response = ops
        .query(&session.id, Request::Processes)
        .await
        .expect("query");
    assert_eq!(response.records[0]["pid"], 12);
    f.mode.store(1, Ordering::SeqCst);
    let response = ops
        .query(&session.id, Request::Processes)
        .await
        .expect("permission");
    assert!(!response.success);
    assert!(response.message.expect("message").contains("permission"));
    f.mode.store(3, Ordering::SeqCst);
    assert!(ops.query(&session.id, Request::Processes).await.is_err());
    f.mode.store(2, Ordering::SeqCst);
    let e = ops
        .query(&session.id, Request::Processes)
        .await
        .err()
        .expect("timeout");
    assert_eq!(serverdeck_core::IpcError::from(e).code, "OPS_TIMEOUT");
    ops.shutdown().await;
    f.engine.shutdown().await;
    assert_eq!(f.engine.counts().expect("released"), (0, 0));
}

#[tokio::test]
async fn log_ack_backpressure_pause_resume_cancel_and_shared_terminal_ownership() {
    let f = Fixture::start().await;
    let session = f.open();
    ready(&f, &session).await;
    let ops = Operations::new(f.engine.clone());
    let (tx, mut rx) = tokio::sync::mpsc::channel(32);
    let log = ops
        .log_open(
            &session.id,
            LogInput {
                source: LogSource::File {
                    path: "/fixture.log".into(),
                },
                lines: 10,
                follow: true,
            },
            Arc::new(move |e| tx.try_send(e).is_ok()),
        )
        .expect("log");
    let next = async {
        loop {
            if let Some(LogEvent::Data { sequence, data, .. }) = rx.recv().await {
                assert_eq!(data.len(), 16384);
                break sequence;
            }
        }
    };
    let sequence = tokio::time::timeout(Duration::from_secs(3), next)
        .await
        .expect("first data");
    tokio::time::sleep(Duration::from_millis(80)).await;
    assert!(rx.try_recv().is_err(), "no next output before ACK");
    ops.log_pause(&log.id, true).expect("pause");
    ops.log_ack(&log.id, sequence).expect("ACK");
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if let Some(LogEvent::State {
                state: "paused", ..
            }) = rx.recv().await
            {
                break;
            }
        }
    })
    .await
    .expect("paused");
    assert!(rx.try_recv().is_err());
    ops.log_pause(&log.id, false).expect("resume");
    let mut stderr = false;
    tokio::time::timeout(Duration::from_secs(3), async {
        while let Some(e) = rx.recv().await {
            if let LogEvent::Data {
                sequence, stream, ..
            } = e
            {
                ops.log_ack(&log.id, sequence).expect("ACK");
                if stream == "stderr" {
                    stderr = true;
                    break;
                }
            }
        }
    })
    .await
    .expect("resumed");
    assert!(stderr);
    let (tx, mut terminal) = tokio::sync::mpsc::channel(32);
    let shell = f
        .engine
        .open_plan(
            f.host.clone(),
            f.plan(),
            TerminalSize { cols: 80, rows: 24 },
            Arc::new(move |e| tx.try_send(e).is_ok()),
        )
        .expect("terminal");
    assert_eq!(shell.transport_id, session.transport_id);
    tokio::time::timeout(Duration::from_secs(3), async {
        while let Some(e) = terminal.recv().await {
            if matches!(
                e,
                TerminalEvent::State {
                    state: "connected",
                    ..
                }
            ) {
                break;
            }
        }
    })
    .await
    .expect("connected");
    ops.log_close(&log.id).await.expect("close log");
    assert_eq!(ops.log_count().expect("logs"), 0);
    tokio::time::timeout(Duration::from_secs(3), async {
        while f.calls.load(Ordering::SeqCst) < 100 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("remote TERM requested on log close");
    ops.close(&session.id).await.expect("close ops");
    f.engine
        .input(&shell.id, b"survived".to_vec())
        .expect("input");
    tokio::time::timeout(Duration::from_secs(3), async {
        while let Some(e) = terminal.recv().await {
            if let TerminalEvent::Data { data, .. } = e {
                assert_eq!(data, b"survived");
                break;
            }
        }
    })
    .await
    .expect("survived");
    ops.shutdown().await;
    f.engine.shutdown().await;
    assert_eq!(f.engine.counts().expect("released"), (0, 0));
}

#[tokio::test]
async fn hard_network_cut_and_shutdown_release_waiting_log_workers() {
    let f = Fixture::start().await;
    let session = f.open();
    ready(&f, &session).await;
    let ops = Operations::new(f.engine.clone());
    let (tx, mut rx) = tokio::sync::mpsc::channel(32);
    ops.log_open(
        &session.id,
        LogInput {
            source: LogSource::File {
                path: "/fixture.log".into(),
            },
            lines: 10,
            follow: true,
        },
        Arc::new(move |e| tx.try_send(e).is_ok()),
    )
    .expect("log");
    tokio::time::timeout(Duration::from_secs(3), async {
        while let Some(e) = rx.recv().await {
            if matches!(e, LogEvent::Data { .. }) {
                break;
            }
        }
    })
    .await
    .expect("data");
    for socket in f.sockets.lock().expect("sockets").iter() {
        socket.shutdown(std::net::Shutdown::Both).expect("hard cut");
    }
    tokio::time::timeout(Duration::from_secs(3), async {
        while let Some(e) = rx.recv().await {
            if matches!(
                e,
                LogEvent::State {
                    state: "failed",
                    ..
                }
            ) {
                break;
            }
        }
    })
    .await
    .expect("failed");
    tokio::time::timeout(Duration::from_secs(3), ops.shutdown())
        .await
        .expect("drained");
    f.engine.shutdown().await;
    assert_eq!(ops.log_count().expect("logs"), 0);
    assert_eq!(f.engine.counts().expect("released"), (0, 0));
}
