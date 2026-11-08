use russh::{
    Channel, ChannelId,
    keys::{Algorithm, HashAlg, PrivateKey},
    server::{self, Auth, Session},
};
use serverdeck_core::{
    hosts::{AuthType, Host, HostInput},
    terminal::{TerminalEvent, TerminalSession, TerminalSize},
};
use serverdeck_monitor::Monitors;
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
fn payload(n: usize, denied: bool) -> Vec<u8> {
    let mut out = b"SDMON1\0".to_vec();
    for (key, value) in [
        ("stat", format!("cpu {} 0 20 {} 0 0 0 0\n", n * 10, n * 20)),
        (
            "memory",
            "MemTotal: 1000 kB\nMemAvailable: 600 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n".into(),
        ),
        ("uptime", format!("{}", 100 + n * 3)),
        ("boot", "abc".into()),
        ("load", "1 2 3".into()),
        (
            "net",
            format!(
                "head\nhead\neth0: {} 0 0 0 0 0 0 0 {} 0 0 0 0 0 0 0",
                100 * n,
                200 * n
            ),
        ),
    ] {
        out.extend_from_slice(
            format!(
                "{key}\0{value}\0{key}_code\0{}\0",
                if denied && key == "stat" { 1 } else { 0 }
            )
            .as_bytes(),
        );
    }
    out.extend_from_slice(b"indices\0eth0 2\0");
    out
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
        assert_eq!(
            command,
            include_str!("../../ssh/src/monitor.sh")
                .replace("\r\n", "\n")
                .as_bytes()
        );
        assert!(
            !command.contains(&b'\r'),
            "the SSH collector must send Unix line endings"
        );
        let n = self.calls.fetch_add(1, Ordering::SeqCst) + 1;
        let mode = self.mode.load(Ordering::SeqCst);
        s.channel_success(id)?;
        if mode == 2 {
            return Ok(());
        }
        if mode == 3 {
            s.data(id, vec![b'x'; 2 * 1024 * 1024 + 1])?;
        } else {
            s.data(id, payload(n, mode == 1))?;
        }
        s.exit_status_request(id, if mode == 4 { 1 } else { 0 })?;
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
    fn open(&self, m: &Monitors) -> TerminalSession {
        m.open(self.host.clone(), self.plan(), 3, Arc::new(|_| true))
            .expect("open")
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
async fn state(
    m: &Monitors,
    host: &str,
    wanted: &str,
) -> serverdeck_core::monitor::MonitorSnapshot {
    tokio::time::timeout(Duration::from_secs(12), async {
        loop {
            let s = m.snapshot(host, None).expect("snapshot").expect("value");
            if s.state == wanted {
                return s;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect(wanted)
}
#[tokio::test]
async fn one_task_per_host_pause_resume_stop_and_terminal_survives() {
    let f = Fixture::start().await;
    let m = Monitors::new(f.engine.clone());
    let a = f.open(&m);
    let b = f.open(&m);
    assert_eq!(a.id, b.id);
    assert_eq!(m.count().expect("count"), 1);
    state(&m, &f.host.id, "partial").await;
    let initial_calls = f.calls.load(Ordering::SeqCst);
    f.open(&m);
    m.visible(&f.host.id, true).expect("already visible");
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(
        f.calls.load(Ordering::SeqCst),
        initial_calls,
        "unchanged visibility must not trigger rapid extra samples"
    );
    m.visible(&f.host.id, false).expect("pause");
    let paused = state(&m, &f.host.id, "paused").await;
    let calls = f.calls.load(Ordering::SeqCst);
    tokio::time::sleep(Duration::from_millis(3200)).await;
    assert_eq!(f.calls.load(Ordering::SeqCst), calls);
    assert!(
        m.snapshot(&f.host.id, Some(paused.revision))
            .expect("unchanged")
            .is_none()
    );
    m.visible(&f.host.id, true).expect("resume");
    let resumed = state(&m, &f.host.id, "partial").await;
    assert_eq!(resumed.sample.expect("sample").cpus[0].usage, None);
    let (tx, mut rx) = tokio::sync::mpsc::channel(32);
    let terminal = f
        .engine
        .open_plan(
            f.host.clone(),
            f.plan(),
            TerminalSize { cols: 80, rows: 24 },
            Arc::new(move |e| tx.try_send(e).is_ok()),
        )
        .expect("terminal");
    assert_eq!(terminal.transport_id, a.transport_id);
    tokio::time::timeout(Duration::from_secs(3), async {
        while let Some(e) = rx.recv().await {
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
    .expect("terminal ready");
    m.stop(&f.host.id).await.expect("stop");
    assert_eq!(m.count().expect("count"), 0);
    assert_eq!(f.engine.counts().expect("counts"), (1, 1));
    f.engine
        .input(&terminal.id, b"still alive".to_vec())
        .expect("input");
    tokio::time::timeout(Duration::from_secs(3), async {
        while let Some(e) = rx.recv().await {
            if let TerminalEvent::Data { data, .. } = e {
                assert_eq!(data, b"still alive");
                return;
            }
        }
        panic!("terminal ended");
    })
    .await
    .expect("echo");
    f.engine.shutdown().await;
    assert_eq!(f.engine.counts().expect("released"), (0, 0));
}
#[tokio::test]
async fn timeout_permissions_output_limit_and_shutdown_release_channels() {
    let f = Fixture::start().await;
    for mode in [1, 2, 3, 4] {
        f.mode.store(mode, Ordering::SeqCst);
        let m = Monitors::new(f.engine.clone());
        f.open(&m);
        let s = state(&m, &f.host.id, if mode == 1 { "partial" } else { "error" }).await;
        if mode == 1 {
            assert!(s.sample.expect("sample").cpus.is_empty());
        } else {
            assert!(s.sample.is_none());
            assert!(s.error.is_some());
        }
        m.shutdown().await;
        assert_eq!(m.count().expect("count"), 0);
        assert_eq!(f.engine.counts().expect("released"), (0, 0));
        assert!(
            m.open(f.host.clone(), f.plan(), 3, Arc::new(|_| true))
                .is_err()
        );
    }
}
#[tokio::test]
async fn disconnect_while_paused_and_inflight_cancellation_are_detected() {
    let f = Fixture::start().await;
    let m = Monitors::new(f.engine.clone());
    f.open(&m);
    state(&m, &f.host.id, "partial").await;
    m.visible(&f.host.id, false).expect("pause");
    state(&m, &f.host.id, "paused").await;
    for socket in f.sockets.lock().expect("sockets").iter() {
        socket
            .shutdown(std::net::Shutdown::Both)
            .expect("hard TCP cut");
    }
    state(&m, &f.host.id, "failed").await;
    m.stop(&f.host.id).await.expect("stop");
    f.mode.store(2, Ordering::SeqCst);
    f.open(&m);
    state(&m, &f.host.id, "sampling").await;
    tokio::time::timeout(Duration::from_secs(3), m.shutdown())
        .await
        .expect("cancel promptly");
    assert_eq!(f.engine.counts().expect("released"), (0, 0));
}
