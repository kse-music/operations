use russh::{
    Channel, ChannelId,
    keys::{Algorithm, HashAlg, PrivateKey},
    server::{self, Auth, Session},
};
use serverdeck_automation::Automation;
use serverdeck_core::{
    automation::*,
    hosts::{AuthType, Host, HostInput},
};
use serverdeck_ssh::{Authentication, ConnectionPlan, Engine, Hop};
use serverdeck_storage::Database;
use serverdeck_tasks::Tasks;
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU8, AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio_util::sync::CancellationToken;
use zeroize::Zeroizing;
#[derive(Default)]
struct Metrics {
    commands: Mutex<Vec<String>>,
    inputs: Mutex<Vec<serde_json::Value>>,
    active: AtomicUsize,
    max: AtomicUsize,
    calls: AtomicUsize,
    mode: AtomicU8,
}
struct Active(Arc<Metrics>);
impl Drop for Active {
    fn drop(&mut self) {
        self.0.active.fetch_sub(1, Ordering::SeqCst);
    }
}
struct Handler {
    password: String,
    index: usize,
    channels: HashMap<ChannelId, Channel<server::Msg>>,
    input: HashMap<ChannelId, Vec<u8>>,
    stop: HashMap<ChannelId, CancellationToken>,
    metrics: Arc<Metrics>,
}
impl Drop for Handler {
    fn drop(&mut self) {
        for stop in self.stop.values() {
            stop.cancel();
        }
    }
}
impl server::Handler for Handler {
    type Error = russh::Error;
    async fn auth_password(&mut self, _: &str, password: &str) -> Result<Auth, Self::Error> {
        Ok(if self.password == password {
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
        self.input.remove(&id);
        if let Some(stop) = self.stop.remove(&id) {
            stop.cancel();
        }
        Ok(())
    }
    async fn exec_request(
        &mut self,
        id: ChannelId,
        command: &[u8],
        s: &mut Session,
    ) -> Result<(), Self::Error> {
        self.metrics
            .commands
            .lock()
            .unwrap()
            .push(String::from_utf8_lossy(command).into_owned());
        s.channel_success(id)?;
        if self.metrics.mode.load(Ordering::SeqCst) == 1 {
            s.extended_data(id, 1, b"python3: not found".to_vec())?;
            s.exit_status_request(id, 127)?;
            s.close(id)?;
        } else {
            self.input.insert(id, Vec::new());
        }
        Ok(())
    }
    async fn data(
        &mut self,
        id: ChannelId,
        data: &[u8],
        _: &mut Session,
    ) -> Result<(), Self::Error> {
        if let Some(input) = self.input.get_mut(&id) {
            assert!(input.len() + data.len() <= 262144);
            input.extend_from_slice(data);
        }
        Ok(())
    }
    async fn channel_eof(&mut self, id: ChannelId, s: &mut Session) -> Result<(), Self::Error> {
        let Some(input) = self.input.remove(&id) else {
            return Ok(());
        };
        let value: serde_json::Value = serde_json::from_slice(&input).unwrap();
        self.metrics.inputs.lock().unwrap().push(value.clone());
        self.metrics.calls.fetch_add(1, Ordering::SeqCst);
        let count = self.metrics.active.fetch_add(1, Ordering::SeqCst) + 1;
        self.metrics.max.fetch_max(count, Ordering::SeqCst);
        let active = Active(self.metrics.clone());
        let stop = CancellationToken::new();
        self.stop.insert(id, stop.clone());
        let handle = s.handle();
        let index = self.index;
        tokio::spawn(async move {
            let _active = active;
            let job = async {
                let body = value["script"].as_str().unwrap();
                if body == "wait" {
                    let _ = handle.data(id, b"started\n".to_vec()).await;
                    tokio::time::sleep(Duration::from_secs(30)).await;
                } else {
                    tokio::time::sleep(Duration::from_millis(90)).await;
                }
                let mut out = format!("server-{index} 中文 ");
                out += &serde_json::to_string(&value["args"]).unwrap();
                let _ = handle.data(id, out.into_bytes()).await;
                if body == "huge" {
                    let _ = handle.data(id, vec![b'x'; 131072]).await;
                }
                let code = if body == "partial" && index == 1 {
                    7
                } else {
                    0
                };
                if code != 0 {
                    let _ = handle
                        .extended_data(id, 1, b"permission denied fixture".to_vec())
                        .await;
                }
                let _ = handle.exit_status_request(id, code).await;
                let _ = handle.close(id).await;
            };
            tokio::select! {_=job=>(),_=stop.cancelled()=>()}
        });
        Ok(())
    }
    async fn signal(
        &mut self,
        id: ChannelId,
        _: russh::Sig,
        s: &mut Session,
    ) -> Result<(), Self::Error> {
        if let Some(stop) = self.stop.remove(&id) {
            stop.cancel();
        }
        s.exit_status_request(id, 143)?;
        s.close(id)
    }
}
struct Fixture {
    dir: tempfile::TempDir,
    db: Database,
    engine: Engine,
    tasks: Tasks,
    automation: Automation,
    hosts: Vec<Host>,
    password: String,
    metrics: Arc<Metrics>,
    servers: Vec<tokio::task::JoinHandle<()>>,
    sockets: Arc<Mutex<Vec<std::net::TcpStream>>>,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        for server in &self.servers {
            server.abort();
        }
    }
}
impl Fixture {
    async fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(dir.path().join("db")).unwrap();
        let password = uuid::Uuid::new_v4().to_string();
        let credential = uuid::Uuid::new_v4().to_string();
        db.credential_save(
            &credential,
            None,
            "protocol credential",
            AuthType::Password,
            None,
            Some(&uuid::Uuid::new_v4().to_string()),
        )
        .unwrap();
        let metrics = Arc::new(Metrics::default());
        let sockets = Arc::new(Mutex::new(vec![]));
        let mut hosts = Vec::new();
        let mut servers = Vec::new();
        for index in 0..2 {
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
            hosts.push(
                db.host_create(HostInput {
                    name: format!("Protocol {index}"),
                    hostname: "127.0.0.1".into(),
                    port,
                    username: "test".into(),
                    auth_type: AuthType::Password,
                    credential_id: Some(credential.clone()),
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
            let peers = sockets.clone();
            let metrics = metrics.clone();
            let pw = password.clone();
            servers.push(tokio::spawn(async move{let mut children=tokio::task::JoinSet::new();loop{tokio::select!{accepted=listener.accept()=>{let(stream,_)=accepted.unwrap();let stream=stream.into_std().unwrap();peers.lock().unwrap().push(stream.try_clone().unwrap());let stream=tokio::net::TcpStream::from_std(stream).unwrap();let h=Handler{password:pw.clone(),index,channels:HashMap::new(),input:HashMap::new(),stop:HashMap::new(),metrics:metrics.clone()};let config=config.clone();children.spawn(async move{if let Ok(handle)=server::run_stream(config,stream,h).await{let _=handle.await;}});},_=children.join_next(),if !children.is_empty()=>()}}}));
        }
        let engine = Engine::new(db.clone());
        let files = serverdeck_sftp::Files::new(engine.clone(), 3);
        let tasks = Tasks::new(engine.clone(), files);
        let automation = Automation::new(db.clone(), engine.clone(), tasks.clone()).unwrap();
        Self {
            dir,
            db,
            engine,
            tasks,
            automation,
            hosts,
            password,
            metrics,
            servers,
            sockets,
        }
    }
    async fn connect(&self, n: usize) {
        let host = self.hosts[n].clone();
        let s = self
            .engine
            .open_ops_plan(
                host.clone(),
                ConnectionPlan {
                    hops: vec![Hop {
                        host,
                        revision: 1,
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
        assert_eq!(
            self.engine.profile_signature(&s.host_id).unwrap(),
            self.engine.ops_profile(&s.id).unwrap()
        );
    }
    async fn entry(&self, body: &str, secret: bool) -> Entry {
        let mut e = templates()[0].clone();
        e.kind = EntryKind::Script;
        e.body = body.into();
        e.parameters = vec![Parameter {
            name: "arg".into(),
            label: "Argument".into(),
            kind: ParameterKind::Text,
            required: true,
            secret,
            default: None,
        }];
        e.retain_output = true;
        self.automation.entry_save(None, None, e).await.unwrap()
    }
    async fn input(&self, e: &Entry, targets: usize, value: &str) -> RunInput {
        let ids = self
            .hosts
            .iter()
            .take(targets)
            .map(|h| h.id.clone())
            .collect::<Vec<_>>();
        let (_, ts) = self
            .automation
            .prepare(e.id.clone(), e.revision, ids.clone())
            .await
            .unwrap();
        RunInput {
            entry_id: e.id.clone(),
            expected_revision: e.revision,
            host_ids: ids,
            expected_profiles: ts
                .into_iter()
                .map(|t| (t.host_id, t.route_signature))
                .collect(),
            parameters: [("arg".into(), Zeroizing::new(value.into()))]
                .into_iter()
                .collect(),
            concurrency: 2,
            timeout_secs: 3,
            confirmed: true,
            danger_confirmed: false,
        }
    }
    async fn done(&self, id: &str) -> Run {
        tokio::time::timeout(Duration::from_secs(7), async {
            loop {
                let r = self.automation.run(id.into()).await.unwrap();
                if terminal(r.state)
                    && r.finished_at.is_some()
                    && self.db.automation_run(id).unwrap().finished_at.is_some()
                {
                    return r;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap()
    }
    async fn close(&self) {
        self.automation.shutdown().await;
        self.tasks.shutdown().await;
        self.engine.shutdown().await;
        assert_eq!(self.engine.counts().unwrap(), (0, 0));
    }
    async fn plan(&self, e: &Entry, policy: MissedPolicy) -> Schedule {
        let ids = self.hosts.iter().map(|h| h.id.clone()).collect::<Vec<_>>();
        let (_, targets) = self
            .automation
            .prepare(e.id.clone(), e.revision, ids.clone())
            .await
            .unwrap();
        self.automation
            .schedule_save(
                None,
                None,
                ScheduleInput {
                    name: "Protocol schedule".into(),
                    entry_id: e.id.clone(),
                    expected_entry_revision: e.revision,
                    host_ids: ids,
                    expected_profiles: targets
                        .into_iter()
                        .map(|t| (t.host_id, t.route_signature))
                        .collect(),
                    parameters: [("arg".into(), "scheduled".into())].into_iter().collect(),
                    timing: Timing::Cron {
                        expression: "* * * * *".into(),
                    },
                    offset_minutes: 0,
                    missed_policy: policy,
                    enabled: true,
                    authorized: true,
                },
            )
            .await
            .unwrap()
    }
}
#[tokio::test]
async fn multi_host_partial_results_stdin_parameters_and_output_persistence() {
    let f = Fixture::new().await;
    for n in 0..2 {
        f.connect(n).await;
    }
    let entry = f.entry("partial", false).await;
    let literal = "中文 ; $(touch /data/never) ' \"\n";
    let run = f
        .automation
        .start(f.input(&entry, 2, literal).await)
        .await
        .unwrap();
    let done = f.done(&run.id).await;
    assert_eq!(done.state, State::Failed);
    assert_eq!(done.rows[0].state, State::Success);
    assert_eq!(done.rows[1].exit_code, Some(7));
    assert!(done.rows[0].stdout.contains("server-0"));
    assert!(done.rows[1].stdout.contains("server-1"));
    assert!(f.metrics.max.load(Ordering::SeqCst) <= 2);
    assert!(
        f.metrics
            .commands
            .lock()
            .unwrap()
            .iter()
            .all(|s| !s.contains(literal) && !s.contains("partial"))
    );
    assert_eq!(f.metrics.inputs.lock().unwrap()[0]["args"][0], literal);
    let saved = f.db.automation_run(&run.id).unwrap();
    assert_eq!(saved.rows[0].stdout, done.rows[0].stdout);
    f.close().await;
}
#[tokio::test]
async fn secret_echo_is_not_cached_returned_or_persisted() {
    let f = Fixture::new().await;
    f.connect(0).await;
    let entry = f.entry("echo", true).await;
    let secret = uuid::Uuid::new_v4().to_string();
    let run = f
        .automation
        .start(f.input(&entry, 1, &secret).await)
        .await
        .unwrap();
    let done = f.done(&run.id).await;
    assert_eq!(done.state, State::Success);
    assert!(done.rows[0].stdout.is_empty());
    assert!(done.spec.parameters.is_empty());
    assert!(!serde_json::to_string(&done).unwrap().contains(&secret));
    assert!(
        !std::fs::read(f.dir.path().join("db"))
            .unwrap()
            .windows(secret.len())
            .any(|b| b == secret.as_bytes())
    );
    assert!(
        f.metrics
            .commands
            .lock()
            .unwrap()
            .iter()
            .all(|s| !s.contains(&secret))
    );
    let input = ScheduleInput {
        name: "Rejected secret schedule".into(),
        entry_id: entry.id.clone(),
        expected_entry_revision: entry.revision,
        host_ids: vec![f.hosts[0].id.clone()],
        expected_profiles: done
            .spec
            .targets
            .iter()
            .map(|t| (t.host_id.clone(), t.route_signature.clone()))
            .collect(),
        parameters: [("arg".into(), secret.clone())].into_iter().collect(),
        timing: Timing::Cron {
            expression: "* * * * *".into(),
        },
        offset_minutes: 0,
        missed_policy: MissedPolicy::Skip,
        enabled: true,
        authorized: true,
    };
    assert!(f.automation.schedule_save(None, None, input).await.is_err());
    assert!(f.db.automation_schedules().unwrap().is_empty());
    f.close().await;
}
#[tokio::test]
async fn timeout_cancel_queued_and_disconnect_remain_unknown() {
    let f = Fixture::new().await;
    for n in 0..2 {
        f.connect(n).await;
    }
    let entry = f.entry("wait", false).await;
    let mut input = f.input(&entry, 2, "literal").await;
    input.concurrency = 1;
    input.timeout_secs = 1;
    let run = f.automation.start(input).await.unwrap();
    tokio::time::timeout(Duration::from_secs(3), async {
        while f.metrics.calls.load(Ordering::SeqCst) == 0 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    f.automation.cancel(run.id.clone(), false).await.unwrap();
    let done = f.done(&run.id).await;
    assert_eq!(done.state, State::Unknown);
    assert_eq!(
        done.rows
            .iter()
            .filter(|r| r.state == State::Cancelled)
            .count(),
        1
    );
    assert_eq!(f.metrics.calls.load(Ordering::SeqCst), 1);
    let run = f
        .automation
        .start(f.input(&entry, 1, "again").await)
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(3), async {
        while f.metrics.calls.load(Ordering::SeqCst) < 2 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    for socket in f.sockets.lock().unwrap().iter() {
        let _ = socket.shutdown(std::net::Shutdown::Both);
    }
    assert_eq!(f.done(&run.id).await.state, State::Unknown);
    f.close().await;
}
#[tokio::test]
async fn profiles_and_confirmation_checked_before_any_exec_and_missing_python_is_failure() {
    let f = Fixture::new().await;
    f.connect(0).await;
    let entry = f.entry("huge", false).await;
    let mut unconfirmed = f.input(&entry, 1, "arg").await;
    unconfirmed.confirmed = false;
    assert!(f.automation.start(unconfirmed).await.is_err());
    let run = f
        .automation
        .start(f.input(&entry, 1, "arg").await)
        .await
        .unwrap();
    let done = f.done(&run.id).await;
    assert!(done.rows[0].stdout.len() <= OUTPUT_LIMIT);
    assert!(done.rows[0].dropped_bytes > 0);
    f.metrics.mode.store(1, Ordering::SeqCst);
    let run = f
        .automation
        .start(f.input(&entry, 1, "arg").await)
        .await
        .unwrap();
    assert_eq!(f.done(&run.id).await.rows[0].exit_code, Some(127));
    let input = f.input(&entry, 1, "arg").await;
    let mut host = f.hosts[0].config.clone();
    host.username = "changed".into();
    f.db.host_update(&f.hosts[0].id, host).unwrap();
    assert!(f.automation.start(input).await.is_err());
    f.close().await;
}
#[tokio::test]
async fn schedule_once_danger_approval_missed_policy_and_no_automatic_catchup() {
    let f = Fixture::new().await;
    for n in 0..2 {
        f.connect(n).await;
    }
    let entry = f.entry("echo", false).await;
    let normal = f.plan(&entry, MissedPolicy::Skip).await;
    f.automation.tick_at(normal.next_at, false).await.unwrap();
    let h = f.automation.history(HistoryQuery::default()).await.unwrap();
    let id = h[0].id.clone();
    assert_eq!(f.done(&id).await.state, State::Success);
    let calls = f.metrics.calls.load(Ordering::SeqCst);
    f.automation.tick_at(normal.next_at, false).await.unwrap();
    assert_eq!(f.metrics.calls.load(Ordering::SeqCst), calls);
    f.automation.schedule_disable(normal.id).await.unwrap();
    let mut changed = entry.input.clone();
    changed.risk = Risk::Dangerous;
    let dangerous = f
        .automation
        .entry_save(Some(entry.id.clone()), Some(entry.revision), changed)
        .await
        .unwrap();
    let p = f.plan(&dangerous, MissedPolicy::Ask).await;
    f.automation.tick_at(p.next_at, false).await.unwrap();
    let h = f.automation.history(HistoryQuery::default()).await.unwrap();
    let pending = h.iter().find(|r| r.approval_required).unwrap();
    assert_eq!(f.metrics.calls.load(Ordering::SeqCst), calls);
    assert!(
        f.automation
            .approve(pending.id.clone(), true, false)
            .await
            .is_err()
    );
    let r = f
        .automation
        .approve(pending.id.clone(), true, true)
        .await
        .unwrap();
    assert_eq!(f.done(&r.id).await.state, State::Success);
    f.automation.schedule_disable(p.id).await.unwrap();
    let p = f.plan(&dangerous, MissedPolicy::Ask).await;
    let before = f.metrics.calls.load(Ordering::SeqCst);
    f.automation
        .tick_at(p.next_at + 120000, true)
        .await
        .unwrap();
    let h = f.automation.history(HistoryQuery::default()).await.unwrap();
    assert!(
        h.iter()
            .any(|r| r.trigger == "missed" && r.approval_required)
    );
    assert_eq!(f.metrics.calls.load(Ordering::SeqCst), before);
    f.close().await;
}
#[tokio::test]
async fn offline_target_failure_and_shutdown_resources_leave_shared_ssh() {
    let f = Fixture::new().await;
    f.connect(0).await;
    let entry = f.entry("echo", false).await;
    let r = f
        .automation
        .start(f.input(&entry, 2, "arg").await)
        .await
        .unwrap();
    let done = f.done(&r.id).await;
    assert_eq!(done.rows[0].state, State::Success);
    assert_eq!(done.rows[1].state, State::Failed);
    let wait = f.entry("wait", false).await;
    let r = f
        .automation
        .start(f.input(&wait, 1, "arg").await)
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(3), async {
        while f.automation.run(r.id.clone()).await.unwrap().state != State::Running {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    f.automation.shutdown().await;
    assert_eq!(f.automation.pending().unwrap(), 0);
    assert!(!f.engine.ops_connections().unwrap().is_empty());
    f.tasks.shutdown().await;
    f.engine.shutdown().await;
    assert_eq!(f.engine.counts().unwrap(), (0, 0));
}
