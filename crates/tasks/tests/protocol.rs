use russh::{
    Channel, ChannelId,
    keys::{Algorithm, HashAlg, PrivateKey},
    server::{self, Auth, Session},
};
use serverdeck_core::{
    hosts::{AuthType, Host, HostInput},
    tasks::*,
    terminal::TerminalSession,
};
use serverdeck_ssh::{Authentication, ConnectionPlan, Engine, Hop};
use serverdeck_storage::Database;
use serverdeck_tasks::Tasks;
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio_util::sync::CancellationToken;
use zeroize::Zeroizing;
#[derive(Default)]
struct Metrics {
    calls: AtomicUsize,
    active: AtomicUsize,
    max: AtomicUsize,
}
struct Active(Arc<Metrics>);
impl Drop for Active {
    fn drop(&mut self) {
        self.0.active.fetch_sub(1, Ordering::SeqCst);
    }
}
struct Handler {
    password: String,
    label: String,
    status: u32,
    channels: HashMap<ChannelId, Channel<server::Msg>>,
    stops: HashMap<ChannelId, CancellationToken>,
    metrics: Arc<Metrics>,
}
impl Drop for Handler {
    fn drop(&mut self) {
        for t in self.stops.values() {
            t.cancel();
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
        if let Some(t) = self.stops.remove(&id) {
            t.cancel();
        }
        Ok(())
    }
    async fn signal(
        &mut self,
        id: ChannelId,
        _: russh::Sig,
        s: &mut Session,
    ) -> Result<(), Self::Error> {
        if let Some(t) = self.stops.remove(&id) {
            t.cancel();
        }
        s.exit_status_request(id, 143)?;
        s.close(id)
    }
    async fn exec_request(
        &mut self,
        id: ChannelId,
        command: &[u8],
        s: &mut Session,
    ) -> Result<(), Self::Error> {
        self.metrics.calls.fetch_add(1, Ordering::SeqCst);
        s.channel_success(id)?;
        let text = String::from_utf8_lossy(command).to_string();
        if text.contains("exec mtr ") {
            s.extended_data(id, 1, b"mtr: not found".to_vec())?;
            s.exit_status_request(id, 127)?;
            return s.close(id);
        }
        if text == "printf '__SERVERDECK_LATENCY__'" {
            s.data(id, b"__SERVERDECK_LATENCY__".to_vec())?;
            s.exit_status_request(id, 0)?;
            return s.close(id);
        }
        let stop = CancellationToken::new();
        self.stops.insert(id, stop.clone());
        let h = s.handle();
        let label = self.label.clone();
        let code = self.status;
        let metrics = self.metrics.clone();
        let active = metrics.active.fetch_add(1, Ordering::SeqCst) + 1;
        metrics.max.fetch_max(active, Ordering::SeqCst);
        let guard = Active(metrics);
        tokio::spawn(async move {
            let _guard = guard;
            let job = async {
                let _ = h
                    .data(id, format!("{label} 中文😀 live\n").into_bytes())
                    .await;
                if text == "wait" || text.contains("-c 100") {
                    tokio::time::sleep(Duration::from_secs(20)).await;
                } else {
                    tokio::time::sleep(Duration::from_millis(120)).await;
                }
                if text == "huge" {
                    let _ = h.data(id, vec![b'x'; 512 * 1024]).await;
                }
                if code != 0 {
                    let _ = h
                        .extended_data(id, 1, b"permission denied by fixture".to_vec())
                        .await;
                }
                let _ = h.exit_status_request(id, code).await;
                let _ = h.close(id).await;
            };
            tokio::select! {_=job=>(),_=stop.cancelled()=>()}
        });
        Ok(())
    }
}
struct Fixture {
    engine: Engine,
    tasks: Tasks,
    hosts: Vec<Host>,
    password: String,
    metrics: Arc<Metrics>,
    servers: Vec<tokio::task::JoinHandle<()>>,
    sockets: Arc<Mutex<Vec<std::net::TcpStream>>>,
    _dir: tempfile::TempDir,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        for s in &self.servers {
            s.abort();
        }
    }
}
impl Fixture {
    async fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(dir.path().join("db")).unwrap();
        let metrics = Arc::new(Metrics::default());
        let password = uuid::Uuid::new_v4().to_string();
        let mut hosts = vec![];
        let mut servers = vec![];
        let sockets = Arc::new(Mutex::new(vec![]));
        for n in 0..3 {
            let key = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).unwrap();
            let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
                .await
                .unwrap();
            let port = listener.local_addr().unwrap().port();
            db.trust_key(
                "127.0.0.1",
                port,
                &key.public_key().to_openssh().unwrap(),
                &key.public_key().fingerprint(HashAlg::Sha256).to_string(),
            )
            .unwrap();
            let label = format!("server-{n}");
            hosts.push(
                db.host_create(HostInput {
                    name: label.clone(),
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
                .unwrap(),
            );
            let config = Arc::new(server::Config {
                keys: vec![key],
                ..Default::default()
            });
            let metrics = metrics.clone();
            let pw = password.clone();
            let peers = sockets.clone();
            servers.push(tokio::spawn(async move{let mut workers=tokio::task::JoinSet::new();loop{tokio::select!{r=listener.accept()=>{let(stream,_)=r.unwrap();let stream=stream.into_std().unwrap();peers.lock().unwrap().push(stream.try_clone().unwrap());let stream=tokio::net::TcpStream::from_std(stream).unwrap();let config=config.clone();let h=Handler{password:pw.clone(),label:label.clone(),status:if n==2{7}else{0},channels:HashMap::new(),stops:HashMap::new(),metrics:metrics.clone()};workers.spawn(async move{if let Ok(c)=server::run_stream(config,stream,h).await{let _=c.await;}});},_=workers.join_next(),if !workers.is_empty()=>()}}}));
        }
        let engine = Engine::new(db);
        let tasks = Tasks::new(engine.clone());
        Self {
            engine,
            tasks,
            hosts,
            password,
            metrics,
            servers,
            sockets,
            _dir: dir,
        }
    }
    async fn open(&self, n: usize) -> TerminalSession {
        let host = self.hosts[n].clone();
        let s = self
            .engine
            .open_ops_plan(
                host.clone(),
                ConnectionPlan {
                    hops: vec![Hop {
                        host,
                        revision: 0,
                        auth: Authentication::Password(Zeroizing::new(self.password.clone())),
                    }],
                    proxy: None,
                },
                Arc::new(|_| true),
            )
            .unwrap();
        tokio::time::timeout(Duration::from_secs(4), async {
            while !self.engine.ops_ready(&s.id).unwrap() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        s
    }
    async fn diag_done(&self, id: &str) -> Diagnostic {
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let d = self
                    .tasks
                    .diagnostic_list()
                    .unwrap()
                    .into_iter()
                    .find(|d| d.id == id)
                    .unwrap();
                if !active(&d.state) {
                    return d;
                }
                tokio::time::sleep(Duration::from_millis(15)).await;
            }
        })
        .await
        .unwrap()
    }
    async fn finish(&self) {
        self.tasks.shutdown().await;
        self.engine.shutdown().await;
        assert_eq!(self.engine.counts().unwrap(), (0, 0));
    }
}
#[tokio::test]
async fn independent_diagnostics_cancel_and_tcp_disconnect_release_resources() {
    let f = Fixture::new().await;
    let s = f.open(0).await;
    let input = DiagnosticInput {
        tool: Tool::Ping,
        origin: Origin::Remote {
            host_id: s.host_id.clone(),
            session_id: s.id.clone(),
        },
        target: "127.0.0.1".into(),
        port: 22,
        count: 100,
        timeout_secs: 10,
    };
    let a = f.tasks.diagnostic_start(input.clone()).unwrap();
    let b = f.tasks.diagnostic_start(input).unwrap();
    let missing = f
        .tasks
        .diagnostic_start(DiagnosticInput {
            tool: Tool::Mtr,
            origin: Origin::Remote {
                host_id: s.host_id.clone(),
                session_id: s.id.clone(),
            },
            target: "127.0.0.1".into(),
            port: 22,
            count: 1,
            timeout_secs: 3,
        })
        .unwrap();
    let missing = f.diag_done(&missing.id).await;
    assert_eq!(missing.state, "failed");
    assert_eq!(missing.exit_code, Some(127));
    assert!(missing.output.contains("not found"));
    assert!(missing.message.unwrap().contains("工具不存在"));
    tokio::time::timeout(Duration::from_secs(2), async {
        while f
            .tasks
            .diagnostic_list()
            .unwrap()
            .iter()
            .any(|d| d.output.is_empty())
        {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    f.tasks.diagnostic_cancel(&a.id).unwrap();
    assert_eq!(f.diag_done(&a.id).await.state, "uncertain");
    assert!(
        f.tasks
            .diagnostic_list()
            .unwrap()
            .iter()
            .any(|d| d.id == b.id && active(&d.state))
    );
    for socket in f.sockets.lock().unwrap().iter() {
        let _ = socket.shutdown(std::net::Shutdown::Both);
    }
    assert_eq!(f.diag_done(&b.id).await.state, "uncertain");
    f.finish().await;
}
#[tokio::test]
async fn local_dns_tcp_and_cancel_use_real_network_without_ssh() {
    let f = Fixture::new().await;
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let input = DiagnosticInput {
        tool: Tool::Tcp,
        origin: Origin::Local,
        target: "127.0.0.1".into(),
        port: listener.local_addr().unwrap().port(),
        count: 1,
        timeout_secs: 2,
    };
    let t = f.tasks.diagnostic_start(input.clone()).unwrap();
    let d = f.diag_done(&t.id).await;
    assert_eq!(d.state, "completed");
    assert!(d.output.contains("connected"));
    let mut i = input.clone();
    i.tool = Tool::Dns;
    i.target = "localhost".into();
    let t = f.tasks.diagnostic_start(i).unwrap();
    assert!(
        f.diag_done(&t.id).await.output.contains("127.0.0.1")
            || f.tasks
                .diagnostic_list()
                .unwrap()
                .iter()
                .any(|d| d.id == t.id && d.output.contains("::1"))
    );
    let mut i = input;
    i.count = 100;
    let t = f.tasks.diagnostic_start(i).unwrap();
    tokio::time::sleep(Duration::from_millis(50)).await;
    f.tasks.diagnostic_cancel(&t.id).unwrap();
    assert_eq!(f.diag_done(&t.id).await.state, "cancelled");
    assert_eq!(f.metrics.calls.load(Ordering::SeqCst), 0);
    f.finish().await;
}

#[tokio::test]
async fn shutdown_cancels_active_and_queued_jobs_without_closing_shared_ssh() {
    let f = Fixture::new().await;
    let mut sessions = Vec::new();
    for n in 0..3 {
        sessions.push(f.open(n).await);
    }
    let d = f
        .tasks
        .diagnostic_start(DiagnosticInput {
            tool: Tool::Ping,
            origin: Origin::Remote {
                host_id: sessions[0].host_id.clone(),
                session_id: sessions[0].id.clone(),
            },
            target: "127.0.0.1".into(),
            port: 22,
            count: 100,
            timeout_secs: 30,
        })
        .unwrap();
    tokio::time::timeout(Duration::from_secs(3), async {
        while f.metrics.active.load(Ordering::SeqCst) < 1 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    tokio::time::timeout(Duration::from_secs(3), f.tasks.shutdown())
        .await
        .expect("all workers joined");
    assert_eq!(f.tasks.pending().unwrap(), 0);
    assert!(!active(
        &f.tasks
            .diagnostic_list()
            .unwrap()
            .iter()
            .find(|x| x.id == d.id)
            .unwrap()
            .state
    ));
    assert!(
        f.engine.ops_ready(&sessions[0].id).unwrap(),
        "task shutdown must not close shared SSH"
    );
    f.engine.shutdown().await;
    assert_eq!(f.engine.counts().unwrap(), (0, 0));
}

#[tokio::test]
async fn direct_command_execution_retains_exit_status_deadline_and_bounded_admission() {
    let f = Fixture::new().await;
    let good = f.open(0).await;
    let bad = f.open(2).await;
    for (session, expected) in [(&good, 0), (&bad, 7)] {
        let cancel = CancellationToken::new();
        let slot = f.tasks.command_slot(&cancel).await.unwrap();
        let mut stdout = String::new();
        let mut stderr = String::new();
        let result = f
            .tasks
            .execute_command(&session.id, "normal", 3, &cancel, slot, |text, error| {
                if error {
                    stderr.push_str(text);
                } else {
                    stdout.push_str(text);
                }
            })
            .await;
        assert_eq!(result.code, Some(expected));
        assert!(stdout.contains("中文"));
        if expected != 0 {
            assert!(stderr.contains("permission denied"));
        }
    }
    let cancel = CancellationToken::new();
    let slot = f.tasks.command_slot(&cancel).await.unwrap();
    let deadline = f
        .tasks
        .execute_command(&good.id, "wait", 1, &cancel, slot, |_, _| {})
        .await;
    assert_eq!(deadline.state, "uncertain");
    let mut permits = Vec::new();
    for _ in 0..8 {
        permits.push(f.tasks.command_slot(&cancel).await.unwrap());
    }
    assert!(
        tokio::time::timeout(Duration::from_millis(50), f.tasks.command_slot(&cancel))
            .await
            .is_err()
    );
    cancel.cancel();
    assert!(f.tasks.command_slot(&cancel).await.is_err());
    drop(permits);
    assert!(f.engine.ops_ready(&good.id).unwrap());
    f.finish().await;
}
