use russh::{
    Channel, ChannelId,
    keys::{Algorithm, HashAlg, PrivateKey},
    server::{self, Auth, Session},
};
use serverdeck_core::{
    hosts::{AuthType, Host, HostInput},
    terminal::TerminalSession,
};
use serverdeck_ssh::{Authentication, ConnectionPlan, Engine, Hop};
use serverdeck_storage::Database;
use serverdeck_tasks::Tasks;
use std::{
    collections::HashMap,
    sync::{
        Arc,
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
                if text == "wait" {
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
            servers.push(tokio::spawn(async move{let mut workers=tokio::task::JoinSet::new();loop{tokio::select!{r=listener.accept()=>{let(stream,_)=r.unwrap();let stream=stream.into_std().unwrap();let stream=tokio::net::TcpStream::from_std(stream).unwrap();let config=config.clone();let h=Handler{password:pw.clone(),label:label.clone(),status:if n==2{7}else{0},channels:HashMap::new(),stops:HashMap::new(),metrics:metrics.clone()};workers.spawn(async move{if let Ok(c)=server::run_stream(config,stream,h).await{let _=c.await;}});},_=workers.join_next(),if !workers.is_empty()=>()}}}));
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
    async fn finish(&self) {
        self.tasks.shutdown().await;
        self.engine.shutdown().await;
        assert_eq!(self.engine.counts().unwrap(), (0, 0));
    }
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
    assert_eq!(f.metrics.calls.load(Ordering::SeqCst), 3);
    f.tasks.shutdown().await;
    assert!(
        f.tasks
            .command_slot(&CancellationToken::new())
            .await
            .is_err()
    );
    assert!(f.engine.ops_ready(&good.id).unwrap());
    f.finish().await;
}
