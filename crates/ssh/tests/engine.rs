//! Generated credentials and real SSH protocol frames over loopback; no local shell is simulated.
use russh::{
    Channel, ChannelId,
    keys::{Algorithm, HashAlg, PrivateKey, PublicKey},
    server::{self, Auth, ChannelOpenHandle, Msg, Session},
};
use serverdeck_core::connection::{ForwardInput, ForwardKind, ProxyKind, ProxySettings};
use serverdeck_core::{
    hosts::{AuthType, Host, HostInput},
    terminal::{TerminalEvent, TerminalSession, TerminalSize},
};
use serverdeck_ssh::{Authentication, Engine};
use serverdeck_ssh::{ConnectionPlan, Hop, ProxyConnection};
use serverdeck_storage::Database;
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::{net::TcpListener, sync::mpsc};
use zeroize::Zeroizing;

struct Echo {
    port: u16,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Echo {
    fn drop(&mut self) {
        self.task.abort();
    }
}
async fn echo_server() -> Echo {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("echo listen");
    let port = listener.local_addr().expect("port").port();
    let task = tokio::spawn(async move {
        let mut tasks = tokio::task::JoinSet::new();
        loop {
            tokio::select! {accepted=listener.accept()=>{let (mut stream,_)=accepted.expect("accept");tasks.spawn(async move{let mut bytes=[0;8192];while let Ok(n)=stream.read(&mut bytes).await{if n==0{break;}
            if stream.write_all(&bytes[..n]).await.is_err(){break;}}});},_=tasks.join_next(),if !tasks.is_empty()=>()}
        }
    });
    Echo { port, task }
}
fn forward_input(kind: ForwardKind, port: u16, target: u16) -> ForwardInput {
    ForwardInput {
        kind,
        bind_address: "127.0.0.1".parse().expect("loopback"),
        listen_port: port,
        target_host: (kind != ForwardKind::Dynamic).then(|| "127.0.0.1".into()),
        target_port: (kind != ForwardKind::Dynamic).then_some(target),
        confirm_public: false,
    }
}
async fn exchange(mut socket: tokio::net::TcpStream) {
    let expected = vec![b'x'; 256 * 1024];
    let (mut read, mut write) = socket.split();
    let mut received = vec![];
    tokio::time::timeout(Duration::from_secs(8), async {
        tokio::try_join!(
            async {
                write.write_all(&expected).await?;
                write.shutdown().await
            },
            async { read.read_to_end(&mut received).await.map(|_| ()) }
        )
    })
    .await
    .expect("copy deadline")
    .expect("copy");
    assert!(
        received == expected,
        "forwarded bytes differed; received {} bytes",
        received.len()
    );
}
async fn free_port() -> u16 {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.expect("listen");
    listener.local_addr().expect("port").port()
}

struct Fixture {
    auth_delay: Duration,
    workers: Vec<tokio::task::JoinHandle<()>>,
    forwards: HashMap<(String, u32), tokio_util::sync::CancellationToken>,
    password: String,
    public: PublicKey,
    signature_algorithm: Option<Algorithm>,
    channels: HashMap<ChannelId, Channel<Msg>>,
    attempts: Arc<AtomicUsize>,
    sizes: Arc<Mutex<Vec<(u32, u32)>>>,
}
impl server::Handler for Fixture {
    type Error = russh::Error;
    async fn channel_open_direct_tcpip(
        &mut self,
        channel: Channel<Msg>,
        host: &str,
        port: u32,
        _origin: &str,
        _origin_port: u32,
        reply: ChannelOpenHandle,
        _: &mut Session,
    ) -> Result<(), Self::Error> {
        match tokio::net::TcpStream::connect((host, port as u16)).await {
            Ok(mut stream) => {
                reply.accept().await;
                self.workers.push(tokio::spawn(async move {
                    let mut channel = channel.into_stream();
                    let _ = tokio::io::copy_bidirectional(&mut channel, &mut stream).await;
                }));
            }
            Err(_) => {
                reply.reject(russh::ChannelOpenFailure::ConnectFailed).await;
            }
        }
        Ok(())
    }
    async fn tcpip_forward(
        &mut self,
        address: &str,
        port: &mut u32,
        session: &mut Session,
    ) -> Result<bool, Self::Error> {
        let Ok(listener) = TcpListener::bind((address, *port as u16)).await else {
            return Ok(false);
        };
        *port = u32::from(listener.local_addr().expect("listener address").port());
        let cancellation = tokio_util::sync::CancellationToken::new();
        self.forwards
            .insert((address.into(), *port), cancellation.clone());
        let address = address.to_owned();
        let port = *port;
        let handle = session.handle();
        self.workers.push(tokio::spawn(async move{let mut clients=tokio::task::JoinSet::new();loop{tokio::select!{_=cancellation.cancelled()=>break,accepted=listener.accept()=>{let Ok((mut socket,peer))=accepted else{break;};let handle=handle.clone();let address=address.clone();clients.spawn(async move{if let Ok(channel)=handle.channel_open_forwarded_tcpip(address,port,peer.ip().to_string(),u32::from(peer.port())).await{let mut channel=channel.into_stream();let _=tokio::io::copy_bidirectional(&mut socket,&mut channel).await;}});},_=clients.join_next(),if !clients.is_empty()=>()}}}));
        Ok(true)
    }
    async fn cancel_tcpip_forward(
        &mut self,
        address: &str,
        port: u32,
        _: &mut Session,
    ) -> Result<bool, Self::Error> {
        if let Some(token) = self.forwards.remove(&(address.into(), port)) {
            token.cancel();
            Ok(true)
        } else {
            Ok(false)
        }
    }
    async fn auth_password(&mut self, user: &str, password: &str) -> Result<Auth, Self::Error> {
        self.attempts.fetch_add(1, Ordering::SeqCst);
        tokio::time::sleep(self.auth_delay).await;
        Ok(if user == "fixture" && password == self.password {
            Auth::Accept
        } else {
            Auth::reject()
        })
    }
    async fn auth_publickey(
        &mut self,
        user: &str,
        key: server::VerifiedPublicKey<'_>,
    ) -> Result<Auth, Self::Error> {
        self.attempts.fetch_add(1, Ordering::SeqCst);
        if let Some(algorithm) = &self.signature_algorithm {
            assert_eq!(key.algorithm, algorithm, "negotiated signature algorithm");
        }
        Ok(if user == "fixture" && *key.public_key == self.public {
            Auth::Accept
        } else {
            Auth::reject()
        })
    }
    async fn channel_open_session(
        &mut self,
        channel: Channel<Msg>,
        reply: ChannelOpenHandle,
        _: &mut Session,
    ) -> Result<(), Self::Error> {
        self.channels.insert(channel.id(), channel);
        reply.accept().await;
        Ok(())
    }
    async fn channel_close(&mut self, id: ChannelId, _: &mut Session) -> Result<(), Self::Error> {
        self.channels.remove(&id);
        Ok(())
    }
    async fn pty_request(
        &mut self,
        id: ChannelId,
        _: &str,
        cols: u32,
        rows: u32,
        _: u32,
        _: u32,
        _: &[(russh::Pty, u32)],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        self.sizes.lock().expect("sizes").push((cols, rows));
        session.channel_success(id)
    }
    async fn window_change_request(
        &mut self,
        _: ChannelId,
        cols: u32,
        rows: u32,
        _: u32,
        _: u32,
        _: &mut Session,
    ) -> Result<(), Self::Error> {
        self.sizes.lock().expect("sizes").push((cols, rows));
        Ok(())
    }
    async fn shell_request(
        &mut self,
        id: ChannelId,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        session.channel_success(id)
    }
    async fn data(
        &mut self,
        id: ChannelId,
        data: &[u8],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        if !self.channels.contains_key(&id) {
            return Ok(());
        }
        match data {
            b"#exit" => {
                session.exit_status_request(id, 0)?;
                session.eof(id)?;
                session.close(id)?;
            }
            b"#interrupt" => {
                session.exit_signal_request(id, russh::Sig::INT, false, "", "en")?;
                session.eof(id)?;
                session.close(id)?;
            }
            b"#disconnect" => session.disconnect(
                russh::Disconnect::ConnectionLost,
                "fixture disconnect",
                "en",
            )?,
            b"#bulk" => {
                for _ in 0..128 {
                    session.data(id, vec![b'x'; 16384])?;
                }
                session.data(id, b"bulk-done".to_vec())?;
            }
            _ => session.data(id, data.to_vec())?,
        }
        Ok(())
    }
}
struct Server {
    port: u16,
    key: String,
    pin: String,
    password: String,
    user_key: PrivateKey,
    attempts: Arc<AtomicUsize>,
    sizes: Arc<Mutex<Vec<(u32, u32)>>>,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Server {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl Server {
    async fn start() -> Self {
        Self::start_with_delay(Duration::ZERO).await
    }
    async fn start_with_delay(auth_delay: Duration) -> Self {
        Self::start_with_options(auth_delay, None, Default::default()).await
    }
    async fn start_with_cipher(cipher: russh::cipher::Name) -> Self {
        Self::start_with_options(Duration::ZERO, Some(cipher), Default::default()).await
    }
    async fn start_with_options(
        auth_delay: Duration,
        cipher: Option<russh::cipher::Name>,
        limits: russh::Limits,
    ) -> Self {
        let user_key = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).expect("user key");
        Self::start_with_auth_options(auth_delay, cipher, limits, user_key, None).await
    }
    async fn start_with_auth_options(
        auth_delay: Duration,
        cipher: Option<russh::cipher::Name>,
        limits: russh::Limits,
        user_key: PrivateKey,
        signature_algorithm: Option<Algorithm>,
    ) -> Self {
        let host_key = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).expect("host key");
        let key = host_key.public_key().to_openssh().expect("public");
        let pin = host_key
            .public_key()
            .fingerprint(HashAlg::Sha256)
            .to_string();
        let password = uuid::Uuid::new_v4().to_string();
        let attempts = Arc::new(AtomicUsize::new(0));
        let sizes = Arc::new(Mutex::new(vec![]));
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.expect("listen");
        let port = listener.local_addr().expect("address").port();
        let mut config = server::Config {
            keys: vec![host_key],
            auth_rejection_time: Duration::ZERO,
            auth_rejection_time_initial: Some(Duration::ZERO),
            limits,
            ..Default::default()
        };
        if let Some(cipher) = cipher {
            config.preferred.cipher = vec![cipher].into();
        }
        if let Some(algorithm) = &signature_algorithm {
            config.preferred.key = vec![Algorithm::Ed25519, algorithm.clone()].into();
        }
        let config = Arc::new(config);
        let (pw, public, attempts2, sizes2) = (
            password.clone(),
            user_key.public_key().clone(),
            attempts.clone(),
            sizes.clone(),
        );
        let task = tokio::spawn(async move {
            let mut tasks = tokio::task::JoinSet::new();
            loop {
                tokio::select! {
                    accepted=listener.accept()=>{let (stream,_)=accepted.expect("accept");let fixture=Fixture{auth_delay,workers:vec![],forwards:HashMap::new(),password:pw.clone(),public:public.clone(),signature_algorithm:signature_algorithm.clone(),channels:HashMap::new(),attempts:attempts2.clone(),sizes:sizes2.clone()};let config=config.clone();tasks.spawn(async move {if let Ok(session)=server::run_stream(config,stream,fixture).await{let _=session.await;}});},
                    _=tasks.join_next(),if !tasks.is_empty()=>(),
                }
            }
        });
        Self {
            port,
            key,
            pin,
            password,
            user_key,
            attempts,
            sizes,
            task,
        }
    }
    fn host(&self, db: &Database) -> Host {
        db.host_create(HostInput {
            ssh: Default::default(),
            name: "fixture".into(),
            hostname: "127.0.0.1".into(),
            port: self.port,
            username: "fixture".into(),
            auth_type: AuthType::Password,
            credential_id: None,
            group_id: None,
            description: String::new(),
            favorite: false,
            connect_timeout_secs: 2,
        })
        .expect("host")
    }
    fn password(&self) -> Authentication {
        Authentication::Password(Zeroizing::new(self.password.clone()))
    }
    fn trust(&self, db: &Database) {
        db.trust_key("127.0.0.1", self.port, &self.key, &self.pin)
            .expect("trusted fixture");
    }
}
struct Shell {
    info: TerminalSession,
    events: mpsc::Receiver<TerminalEvent>,
}
fn open(engine: &Engine, host: Host, auth: Authentication) -> Shell {
    let (tx, events) = mpsc::channel(16);
    let info = engine
        .open(
            host,
            1,
            auth,
            TerminalSize { cols: 80, rows: 24 },
            Arc::new(move |e| tx.try_send(e).is_ok()),
        )
        .expect("open");
    Shell { info, events }
}
async fn event(shell: &mut Shell) -> TerminalEvent {
    tokio::time::timeout(Duration::from_secs(8), shell.events.recv())
        .await
        .expect("event timeout")
        .expect("stream")
}
async fn state(shell: &mut Shell, expected: &str) -> Option<&'static str> {
    loop {
        if let TerminalEvent::State { state, code, .. } = event(shell).await {
            if state == expected {
                return code;
            }
            assert_ne!(state, "failed", "unexpected SSH failure {code:?}");
        }
    }
}
async fn connected_cipher(shell: &mut Shell) -> String {
    let mut cipher = None;
    loop {
        match event(shell).await {
            TerminalEvent::Connection { cipher: value } => cipher = Some(value),
            TerminalEvent::State {
                state: "connected", ..
            } => return cipher.expect("negotiated cipher before connected"),
            TerminalEvent::State {
                state: "failed",
                code,
                ..
            } => panic!("unexpected SSH failure {code:?}"),
            _ => (),
        }
    }
}
fn database() -> (tempfile::TempDir, Database) {
    let dir = tempfile::tempdir().expect("tempdir");
    let db = Database::open(dir.path().join("db")).expect("db");
    (dir, db)
}

#[tokio::test]
async fn native_binary_transfer_is_exclusive_bounded_and_restores_normal_output_after_return() {
    let server = Server::start().await;
    let (_dir, db) = database();
    server.trust(&db);
    let host = server.host(&db);
    let engine = Engine::new(db);
    let mut shell = open(&engine, host, server.password());
    state(&mut shell, "connected").await;
    let nonce = "a".repeat(32);
    let mut transfer = engine.terminal_transfer(&shell.info.id, &nonce).unwrap();
    assert!(matches!(
        engine.input(&shell.info.id, b"forbidden normal input".to_vec()),
        Err(serverdeck_core::Error::Busy)
    ));
    assert!(matches!(
        engine.terminal_transfer(&shell.info.id, &nonce),
        Err(serverdeck_core::Error::Busy)
    ));
    let bytes: Vec<_> = (0..128 * 1024).map(|n| (n % 256) as u8).collect();
    transfer.send(&bytes).await.unwrap();
    let mut received = vec![];
    while received.len() < bytes.len() {
        received.extend(transfer.recv().await.unwrap());
    }
    assert_eq!(
        received, bytes,
        "native route must preserve every binary/control byte"
    );
    assert!(
        shell.events.try_recv().is_err(),
        "binary data must never enter the WebView or its ACK queue"
    );
    let marker = format!("\x1eSDU:{nonce}:RETURN\x1f");
    transfer.send(&marker.as_bytes()[..13]).await.unwrap();
    transfer
        .send(&[&marker.as_bytes()[13..], b"user@host$ "].concat())
        .await
        .unwrap();
    let returned = transfer.recv().await.unwrap();
    assert_eq!(
        returned,
        marker.as_bytes(),
        "fragmented return marker must reach the native parser intact"
    );
    drop(transfer);
    match event(&mut shell).await {
        TerminalEvent::Data { sequence, data } => {
            assert_eq!(data, b"\r\x1b[2Kuser@host$ ");
            engine.acknowledge(&shell.info.id, sequence).unwrap();
        }
        other => panic!("expected restored prompt: {other:?}"),
    }
    engine
        .input(&shell.info.id, b"after recovery".to_vec())
        .unwrap();
    match event(&mut shell).await {
        TerminalEvent::Data { sequence, data } => {
            assert_eq!(data, b"after recovery");
            engine.acknowledge(&shell.info.id, sequence).unwrap();
        }
        other => panic!("normal terminal must remain usable: {other:?}"),
    }
    engine.shutdown().await;
}

#[tokio::test]
async fn abandoned_binary_transfer_closes_only_its_original_terminal() {
    let server = Server::start().await;
    let (_dir, db) = database();
    server.trust(&db);
    let host = server.host(&db);
    let engine = Engine::new(db);
    let mut first = open(&engine, host.clone(), server.password());
    state(&mut first, "connected").await;
    let mut second = open(&engine, host, server.password());
    state(&mut second, "connected").await;
    let transfer = engine
        .terminal_transfer(&first.info.id, &"a".repeat(32))
        .unwrap();
    transfer.send(b"partial binary frame").await.unwrap();
    drop(transfer);
    state(&mut first, "closed").await;
    engine
        .input(&second.info.id, b"other pane unaffected".to_vec())
        .unwrap();
    loop {
        if let TerminalEvent::Data { sequence, data } = event(&mut second).await {
            assert_eq!(data, b"other pane unaffected");
            engine.acknowledge(&second.info.id, sequence).unwrap();
            break;
        }
    }
    engine.shutdown().await;
}

#[tokio::test]
async fn terminal_metadata_uses_negotiated_cipher_for_new_and_shared_transports() {
    for cipher in [russh::cipher::AES_256_CTR, russh::cipher::AES_256_GCM] {
        let server = Server::start_with_cipher(cipher).await;
        let (_dir, db) = database();
        server.trust(&db);
        let host = server.host(&db);
        let engine = Engine::new(db);
        let mut first = open(&engine, host.clone(), server.password());
        assert_eq!(connected_cipher(&mut first).await, cipher.as_ref());
        let mut second = open(&engine, host, server.password());
        assert_eq!(connected_cipher(&mut second).await, cipher.as_ref());
        assert_eq!(first.info.transport_id, second.info.transport_id);
        assert_eq!(server.attempts.load(Ordering::SeqCst), 1);
        engine.close(&first.info.id).await.expect("close first");
        engine
            .input(&second.info.id, b"metadata-keeps-channel-open".to_vec())
            .expect("input");
        loop {
            if let TerminalEvent::Data { sequence, data } = event(&mut second).await {
                assert_eq!(data, b"metadata-keeps-channel-open");
                engine.acknowledge(&second.info.id, sequence).expect("ack");
                break;
            }
        }
        engine.shutdown().await;
    }
}

#[tokio::test]
async fn rekey_metadata_reaches_a_shared_terminal_after_the_original_terminal_closes() {
    let server = Server::start_with_options(
        Duration::ZERO,
        Some(russh::cipher::AES_256_CTR),
        russh::Limits {
            rekey_read_limit: 1024,
            rekey_write_limit: 1024,
            rekey_time_limit: Duration::from_secs(3600),
        },
    )
    .await;
    let (_dir, db) = database();
    server.trust(&db);
    let host = server.host(&db);
    let engine = Engine::new(db);
    let mut first = open(&engine, host.clone(), server.password());
    assert_eq!(connected_cipher(&mut first).await, "aes256-ctr");
    let mut second = open(&engine, host, server.password());
    assert_eq!(connected_cipher(&mut second).await, "aes256-ctr");
    engine
        .close(&first.info.id)
        .await
        .expect("close original terminal");
    engine
        .input(&second.info.id, vec![b'x'; 4096])
        .expect("trigger rekey");
    loop {
        match event(&mut second).await {
            TerminalEvent::Connection { cipher } => {
                assert_eq!(cipher, "aes256-ctr");
                break;
            }
            TerminalEvent::Data { sequence, .. } => {
                engine.acknowledge(&second.info.id, sequence).expect("ack")
            }
            TerminalEvent::State {
                state: "failed" | "closed",
                code,
                ..
            } => panic!("unexpected session end {code:?}"),
            _ => (),
        }
    }
    engine.shutdown().await;
}

#[tokio::test]
async fn silent_server_obeys_handshake_timeout_and_tcp_refusal_is_reported() {
    let fixture = Server::start().await;
    let (_dir, db) = database();
    let mut host = fixture.host(&db);
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("blackhole listener");
    host.config.port = listener.local_addr().expect("port").port();
    host.config.connect_timeout_secs = 1;
    let blackhole = tokio::spawn(async move {
        let (_socket, _) = listener.accept().await.expect("accept");
        std::future::pending::<()>().await;
    });
    let engine = Engine::new(db);
    let started = tokio::time::Instant::now();
    let mut shell = open(&engine, host.clone(), fixture.password());
    assert_eq!(state(&mut shell, "failed").await, Some("SSH_TIMEOUT"));
    assert!(started.elapsed() < Duration::from_secs(4));
    engine.close(&shell.info.id).await.expect("cleanup timeout");
    blackhole.abort();
    let _ = blackhole.await;
    host.config.connect_timeout_secs = 5;
    let mut refused = open(&engine, host, fixture.password());
    assert_eq!(state(&mut refused, "failed").await, Some("SSH_NETWORK"));
    engine.shutdown().await;
    assert_eq!(engine.counts().expect("counts"), (0, 0));
}

#[tokio::test]
async fn abrupt_tcp_loss_fails_all_channels_and_releases_resources() {
    let server = Server::start().await;
    let (_dir, db) = database();
    let mut host = server.host(&db);
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("proxy listener");
    host.config.port = listener.local_addr().expect("proxy port").port();
    db.trust_key("127.0.0.1", host.config.port, &server.key, &server.pin)
        .expect("trusted proxy endpoint");
    let (cut, cut_rx) = tokio::sync::oneshot::channel();
    let port = server.port;
    let proxy = tokio::spawn(async move {
        let (mut client, _) = listener.accept().await.expect("accept");
        let mut target = tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .expect("upstream");
        tokio::select! {_=tokio::io::copy_bidirectional(&mut client,&mut target)=>(),_=cut_rx=>()};
    });
    let engine = Engine::new(db);
    let mut first = open(&engine, host.clone(), server.password());
    state(&mut first, "connected").await;
    let mut second = open(&engine, host, server.password());
    state(&mut second, "connected").await;
    cut.send(()).expect("cut TCP without SSH close");
    proxy.await.expect("proxy dropped sockets");
    assert_eq!(state(&mut first, "failed").await, Some("SSH_DISCONNECTED"));
    assert_eq!(state(&mut second, "failed").await, Some("SSH_DISCONNECTED"));
    engine.shutdown().await;
    assert_eq!(engine.counts().expect("released"), (0, 0));
}

#[tokio::test]
async fn different_hosts_connect_concurrently_and_close_host_is_scoped() {
    let first_server = Server::start().await;
    let second_server = Server::start().await;
    let (_dir, db) = database();
    first_server.trust(&db);
    second_server.trust(&db);
    let first_host = first_server.host(&db);
    let second_host = second_server.host(&db);
    let engine = Engine::new(db);
    let mut first = open(&engine, first_host.clone(), first_server.password());
    let mut second = open(&engine, second_host, second_server.password());
    tokio::join!(
        state(&mut first, "connected"),
        state(&mut second, "connected")
    );
    assert_ne!(first.info.transport_id, second.info.transport_id);
    assert_eq!(engine.counts().expect("counts"), (2, 2));
    engine.close_host(&first_host.id).await.expect("close host");
    assert_eq!(engine.counts().expect("other host survives"), (1, 1));
    engine
        .input(&second.info.id, b"other-host-open".to_vec())
        .expect("input");
    loop {
        if let TerminalEvent::Data { data, sequence } = event(&mut second).await {
            assert_eq!(data, b"other-host-open");
            engine.acknowledge(&second.info.id, sequence).expect("ack");
            break;
        }
    }
    engine.shutdown().await;
}

#[tokio::test]
async fn unknown_key_requires_confirmation_before_any_authentication() {
    let server = Server::start().await;
    let (_dir, db) = database();
    let host = server.host(&db);
    let engine = Engine::new(db.clone());
    let mut shell = open(&engine, host, server.password());
    loop {
        if let TerminalEvent::Trust { fingerprint, .. } = event(&mut shell).await {
            assert_eq!(fingerprint, server.pin);
            break;
        }
    }
    assert_eq!(server.attempts.load(Ordering::SeqCst), 0);
    engine.confirm(&shell.info.id, false).expect("reject");
    assert_eq!(
        state(&mut shell, "failed").await,
        Some("SSH_TRUST_REJECTED")
    );
    assert!(
        db.trusted_key("127.0.0.1", server.port)
            .expect("lookup")
            .is_none()
    );
    engine.shutdown().await;
    assert_eq!(engine.counts().expect("counts"), (0, 0));
}
#[tokio::test]
async fn confirmed_key_is_persisted_and_wrong_password_is_rejected() {
    let server = Server::start().await;
    let (_dir, db) = database();
    let host = server.host(&db);
    let engine = Engine::new(db.clone());
    let mut shell = open(
        &engine,
        host,
        Authentication::Password(Zeroizing::new("wrong".into())),
    );
    loop {
        if matches!(event(&mut shell).await, TerminalEvent::Trust { .. }) {
            break;
        }
    }
    engine.confirm(&shell.info.id, true).expect("confirm");
    assert_eq!(state(&mut shell, "failed").await, Some("SSH_AUTH_REJECTED"));
    assert_eq!(server.attempts.load(Ordering::SeqCst), 1);
    assert_eq!(
        db.trusted_key("127.0.0.1", server.port).expect("lookup"),
        Some(server.key.clone())
    );
    engine.shutdown().await;
}
#[tokio::test]
async fn changed_key_blocks_before_authentication() {
    let server = Server::start().await;
    let (_dir, db) = database();
    let host = server.host(&db);
    db.trust_key("127.0.0.1", server.port, "different-key", "other")
        .expect("old key");
    let engine = Engine::new(db);
    let mut shell = open(&engine, host, server.password());
    assert_eq!(
        state(&mut shell, "failed").await,
        Some("SSH_HOST_KEY_CHANGED")
    );
    assert_eq!(server.attempts.load(Ordering::SeqCst), 0);
    engine.shutdown().await;
}
#[tokio::test]
async fn encrypted_and_plain_private_keys_authenticate_and_bad_passphrase_fails() {
    for encrypted in [false, true] {
        let server = Server::start().await;
        let (dir, db) = database();
        server.trust(&db);
        let host = server.host(&db);
        let path = dir.path().join("identity");
        let passphrase = uuid::Uuid::new_v4().to_string();
        let key = if encrypted {
            server
                .user_key
                .encrypt(&mut rand::rng(), &passphrase)
                .expect("encrypt")
        } else {
            server.user_key.clone()
        };
        key.write_openssh_file(&path, russh::keys::ssh_key::LineEnding::LF)
            .expect("keyfile");
        let engine = Engine::new(db);
        let auth = Authentication::PrivateKey {
            path: path.to_string_lossy().into(),
            passphrase: encrypted.then(|| Zeroizing::new(passphrase.clone())),
        };
        let mut shell = open(&engine, host.clone(), auth);
        state(&mut shell, "connected").await;
        engine.close(&shell.info.id).await.expect("close");
        let contents = key
            .to_openssh(russh::keys::ssh_key::LineEnding::LF)
            .expect("key data");
        let imported =
            serverdeck_ssh::import_private_key(&contents, encrypted.then_some(passphrase.as_str()))
                .expect("import");
        // The imported authentication must succeed with no file path to open.
        let mut imported_shell = open(&engine, host.clone(), Authentication::ImportedKey(imported));
        state(&mut imported_shell, "connected").await;
        engine
            .close(&imported_shell.info.id)
            .await
            .expect("close imported");
        if encrypted {
            let mut bad = open(
                &engine,
                host,
                Authentication::PrivateKey {
                    path: path.to_string_lossy().into(),
                    passphrase: Some(Zeroizing::new("wrong".into())),
                },
            );
            assert_eq!(state(&mut bad, "failed").await, Some("SSH_KEY_UNLOCK"));
        }
        engine.shutdown().await;
        assert_eq!(engine.counts().expect("counts"), (0, 0));
    }
}

#[tokio::test]
async fn rsa_sha2_plain_and_encrypted_keys_authenticate_from_files_and_imported_credentials() {
    let key = tokio::task::spawn_blocking(|| {
        PrivateKey::random(&mut rand::rng(), Algorithm::Rsa { hash: None })
            .expect("temporary RSA key")
    })
    .await
    .expect("key generation");
    for hash in [HashAlg::Sha256, HashAlg::Sha512] {
        let server = Server::start_with_auth_options(
            Duration::ZERO,
            None,
            Default::default(),
            key.clone(),
            Some(Algorithm::Rsa { hash: Some(hash) }),
        )
        .await;
        let (dir, db) = database();
        server.trust(&db);
        let host = server.host(&db);
        let engine = Engine::new(db);
        for encrypted in [false, true] {
            let passphrase = uuid::Uuid::new_v4().to_string();
            let private_key = if encrypted {
                key.encrypt(&mut rand::rng(), &passphrase).expect("encrypt")
            } else {
                key.clone()
            };
            let path = dir.path().join("rsa_identity");
            private_key
                .write_openssh_file(&path, russh::keys::ssh_key::LineEnding::LF)
                .expect("key file");
            let auth = Authentication::PrivateKey {
                path: path.to_string_lossy().into(),
                passphrase: encrypted.then(|| Zeroizing::new(passphrase.clone())),
            };
            let mut shell = open(&engine, host.clone(), auth);
            state(&mut shell, "connected").await;
            engine.close(&shell.info.id).await.expect("close");

            let contents = private_key
                .to_openssh(russh::keys::ssh_key::LineEnding::LF)
                .expect("key data");
            let imported = serverdeck_ssh::import_private_key(
                &contents,
                encrypted.then_some(passphrase.as_str()),
            )
            .expect("import RSA key");
            // The imported key must authenticate after its original file has been removed.
            std::fs::remove_file(&path).expect("remove original key file");
            let mut shell = open(&engine, host.clone(), Authentication::ImportedKey(imported));
            state(&mut shell, "connected").await;
            engine.close(&shell.info.id).await.expect("close imported");

            if encrypted {
                let attempts = server.attempts.load(Ordering::SeqCst);
                assert!(matches!(
                    serverdeck_ssh::import_private_key(&contents, Some("wrong")),
                    Err(serverdeck_core::Error::Connection {
                        code: "SSH_KEY_UNLOCK",
                        ..
                    })
                ));
                private_key
                    .write_openssh_file(&path, russh::keys::ssh_key::LineEnding::LF)
                    .expect("encrypted key file");
                let mut bad = open(
                    &engine,
                    host.clone(),
                    Authentication::PrivateKey {
                        path: path.to_string_lossy().into(),
                        passphrase: Some(Zeroizing::new("wrong".into())),
                    },
                );
                assert_eq!(state(&mut bad, "failed").await, Some("SSH_KEY_UNLOCK"));
                assert_eq!(server.attempts.load(Ordering::SeqCst), attempts);
            }
        }
        assert_eq!(server.attempts.load(Ordering::SeqCst), 4);
        engine.shutdown().await;
        assert_eq!(engine.counts().expect("counts"), (0, 0));
    }
}

#[tokio::test]
async fn rsa_private_key_rejects_sha1_only_server_before_signing() {
    let key = tokio::task::spawn_blocking(|| {
        PrivateKey::random(&mut rand::rng(), Algorithm::Rsa { hash: None })
            .expect("temporary RSA key")
    })
    .await
    .expect("key generation");
    let server = Server::start_with_auth_options(
        Duration::ZERO,
        None,
        Default::default(),
        key.clone(),
        Some(Algorithm::Rsa { hash: None }),
    )
    .await;
    let (_dir, db) = database();
    server.trust(&db);
    let host = server.host(&db);
    let imported = serverdeck_ssh::import_private_key(
        &key.to_openssh(russh::keys::ssh_key::LineEnding::LF)
            .expect("key data"),
        None,
    )
    .expect("import RSA key");
    let engine = Engine::new(db);
    let mut shell = open(&engine, host, Authentication::ImportedKey(imported));
    assert_eq!(
        state(&mut shell, "failed").await,
        Some("SSH_RSA_SHA2_REQUIRED")
    );
    assert_eq!(server.attempts.load(Ordering::SeqCst), 0);
    engine.shutdown().await;
}

#[tokio::test]
async fn unauthorized_rsa_private_key_is_rejected_by_server() {
    let server = Server::start().await;
    let (dir, db) = database();
    server.trust(&db);
    let host = server.host(&db);
    let key = PrivateKey::random(
        &mut rand::rng(),
        Algorithm::Rsa {
            hash: Some(HashAlg::Sha256),
        },
    )
    .expect("temporary RSA key");
    let path = dir.path().join("rsa_identity");
    key.write_openssh_file(&path, russh::keys::ssh_key::LineEnding::LF)
        .expect("key file");
    let engine = Engine::new(db);
    let mut shell = open(
        &engine,
        host,
        Authentication::PrivateKey {
            path: path.to_string_lossy().into(),
            passphrase: None,
        },
    );
    assert_eq!(state(&mut shell, "failed").await, Some("SSH_AUTH_REJECTED"));
    assert_eq!(server.attempts.load(Ordering::SeqCst), 1);
    engine.shutdown().await;
}
#[tokio::test]
async fn pty_resize_shared_transport_independent_channels_and_reconnect() {
    let server = Server::start().await;
    let (_dir, db) = database();
    server.trust(&db);
    let host = server.host(&db);
    let engine = Engine::new(db);
    let mut first = open(&engine, host.clone(), server.password());
    state(&mut first, "connected").await;
    let mut second = open(&engine, host.clone(), server.password());
    state(&mut second, "connected").await;
    assert_eq!(first.info.transport_id, second.info.transport_id);
    engine
        .resize(
            &second.info.id,
            TerminalSize {
                cols: 120,
                rows: 50,
            },
        )
        .expect("resize");
    engine.close(&first.info.id).await.expect("close first");
    assert_eq!(engine.counts().expect("counts"), (1, 1));
    engine
        .input(&second.info.id, b"still-open".to_vec())
        .expect("input");
    loop {
        if let TerminalEvent::Data { sequence, data } = event(&mut second).await {
            assert_eq!(data, b"still-open");
            engine.acknowledge(&second.info.id, sequence).expect("ack");
            break;
        }
    }
    assert!(server.sizes.lock().expect("sizes").contains(&(120, 50)));
    engine
        .input(&second.info.id, b"#exit".to_vec())
        .expect("exit");
    state(&mut second, "closed").await;
    engine.close(&second.info.id).await.expect("close");
    let mut third = open(&engine, host, server.password());
    state(&mut third, "connected").await;
    assert_ne!(third.info.id, second.info.id);
    engine.shutdown().await;
    assert_eq!(engine.counts().expect("counts"), (0, 0));
}
#[tokio::test]
async fn output_waits_for_ack_and_large_output_is_lossless() {
    let server = Server::start().await;
    let (_dir, db) = database();
    server.trust(&db);
    let host = server.host(&db);
    let engine = Engine::new(db);
    let mut shell = open(&engine, host, server.password());
    state(&mut shell, "connected").await;
    engine
        .input(&shell.info.id, b"#bulk".to_vec())
        .expect("bulk");
    let (first, size) = loop {
        if let TerminalEvent::Data { sequence, data } = event(&mut shell).await {
            break (sequence, data.len());
        }
    };
    assert!(
        tokio::time::timeout(Duration::from_millis(100), shell.events.recv())
            .await
            .is_err(),
        "no second chunk before parser acknowledgement"
    );
    assert!(engine.acknowledge(&shell.info.id, first + 1).is_err());
    engine.acknowledge(&shell.info.id, first).expect("ack");
    let mut bytes = size;
    loop {
        if let TerminalEvent::Data { sequence, data } = event(&mut shell).await {
            engine.acknowledge(&shell.info.id, sequence).expect("ack");
            bytes += data.len();
            if data == b"bulk-done" {
                break;
            }
        }
    }
    assert_eq!(bytes, 2 * 1024 * 1024 + 9);
    engine.shutdown().await;
    assert_eq!(engine.counts().expect("counts"), (0, 0));
}

#[tokio::test]
async fn zmodem_batches_preserve_binary_order_and_do_not_relax_ordinary_input_limits() {
    let server = Server::start().await;
    let (_dir, db) = database();
    server.trust(&db);
    let engine = Engine::new(db.clone());
    let mut shell = open(&engine, server.host(&db), server.password());
    state(&mut shell, "connected").await;
    assert!(engine.input(&shell.info.id, vec![1; 16385]).is_err());
    assert!(
        engine
            .terminal_upload_input(&shell.info.id, &[])
            .await
            .is_err()
    );
    assert!(
        engine
            .terminal_upload_input(&shell.info.id, &vec![1; 256 * 1024 + 1])
            .await
            .is_err()
    );
    let expected: Vec<u8> = (0..256 * 1024).map(|i| i as u8).collect();
    let id = shell.info.id.clone();
    let send = engine.terminal_upload_input(&id, &expected);
    let receive = async {
        let mut actual = vec![];
        while actual.len() < expected.len() {
            if let TerminalEvent::Data { sequence, data } = event(&mut shell).await {
                engine.acknowledge(&shell.info.id, sequence).expect("ack");
                actual.extend(data);
            }
        }
        actual
    };
    let (sent, actual) = tokio::join!(send, receive);
    sent.expect("batch");
    assert_eq!(actual, expected);
    engine.shutdown().await;
    assert!(
        engine
            .terminal_upload_input(&shell.info.id, &[1])
            .await
            .is_err()
    );
}
#[tokio::test]
async fn transport_disconnect_closes_all_sessions_and_cancel_during_trust_releases_resources() {
    let server = Server::start().await;
    let (_dir, db) = database();
    server.trust(&db);
    let host = server.host(&db);
    let engine = Engine::new(db);
    let mut first = open(&engine, host.clone(), server.password());
    state(&mut first, "connected").await;
    let mut second = open(&engine, host, server.password());
    state(&mut second, "connected").await;
    let local = engine
        .forward_start(&first.info.id, forward_input(ForwardKind::Local, 0, 22))
        .await
        .expect("local listener");
    let dynamic = engine
        .forward_start(&second.info.id, forward_input(ForwardKind::Dynamic, 0, 0))
        .await
        .expect("dynamic listener");
    engine
        .input(&first.info.id, b"#disconnect".to_vec())
        .expect("disconnect");
    assert_eq!(state(&mut first, "failed").await, Some("SSH_DISCONNECTED"));
    assert_eq!(state(&mut second, "failed").await, Some("SSH_DISCONNECTED"));
    assert!(
        tokio::net::TcpStream::connect(("127.0.0.1", local.input.listen_port))
            .await
            .is_err()
    );
    assert!(
        tokio::net::TcpStream::connect(("127.0.0.1", dynamic.input.listen_port))
            .await
            .is_err()
    );
    assert_eq!(engine.forward_count().expect("forwards released"), 0);
    engine.shutdown().await;
    assert_eq!(engine.counts().expect("counts"), (0, 0));
    let (_dir, db) = database();
    let host = server.host(&db);
    let engine = Engine::new(db);
    let mut shell = open(&engine, host, server.password());
    loop {
        if matches!(event(&mut shell).await, TerminalEvent::Trust { .. }) {
            break;
        }
    }
    engine.close(&shell.info.id).await.expect("cancel trust");
    assert_eq!(server.attempts.load(Ordering::SeqCst), 1);
    assert_eq!(engine.counts().expect("counts"), (0, 0));
}

impl Drop for Fixture {
    fn drop(&mut self) {
        for worker in &self.workers {
            worker.abort();
        }
    }
}

#[tokio::test]
async fn local_remote_dynamic_forward_transfer_conflicts_stop_and_session_cleanup() {
    let server = Server::start().await;
    let echo = echo_server().await;
    let (_dir, db) = database();
    server.trust(&db);
    let host = server.host(&db);
    let engine = Engine::new(db);
    let mut shell = open(&engine, host, server.password());
    state(&mut shell, "connected").await;
    let local = engine
        .forward_start(
            &shell.info.id,
            forward_input(ForwardKind::Local, 0, echo.port),
        )
        .await
        .expect("local forward");
    exchange(
        tokio::net::TcpStream::connect(("127.0.0.1", local.input.listen_port))
            .await
            .expect("local connection"),
    )
    .await;
    let conflict = engine
        .forward_start(
            &shell.info.id,
            forward_input(ForwardKind::Local, local.input.listen_port, echo.port),
        )
        .await;
    assert!(conflict.is_err());
    let port = free_port().await;
    let remote = engine
        .forward_start(
            &shell.info.id,
            forward_input(ForwardKind::Remote, port, echo.port),
        )
        .await
        .expect("remote forward");
    exchange(
        tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .expect("remote connection"),
    )
    .await;
    assert!(
        engine
            .forward_start(
                &shell.info.id,
                forward_input(ForwardKind::Remote, port, echo.port)
            )
            .await
            .is_err()
    );
    exchange(
        tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .expect("existing remote survives duplicate request"),
    )
    .await;
    let dynamic = engine
        .forward_start(&shell.info.id, forward_input(ForwardKind::Dynamic, 0, 0))
        .await
        .expect("dynamic forward");
    let mut socket = tokio::net::TcpStream::connect(("127.0.0.1", dynamic.input.listen_port))
        .await
        .expect("socks connect");
    socket.write_all(&[5, 1, 0]).await.expect("greeting");
    let mut reply = [0; 2];
    socket.read_exact(&mut reply).await.expect("method");
    assert_eq!(reply, [5, 0]);
    let mut request = vec![5, 1, 0, 3, 9];
    request.extend_from_slice(b"localhost");
    request.extend_from_slice(&echo.port.to_be_bytes());
    socket.write_all(&request).await.expect("CONNECT");
    let mut response = [0; 10];
    socket.read_exact(&mut response).await.expect("reply");
    assert_eq!(&response[..2], &[5, 0]);
    exchange(socket).await;
    let mut public = forward_input(ForwardKind::Local, 0, echo.port);
    public.bind_address = "0.0.0.0".parse().expect("public");
    assert!(engine.forward_start(&shell.info.id, public).await.is_err());
    engine.forward_stop(&remote.id).await.expect("remote stop");
    assert!(
        tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .is_err()
    );
    engine.forward_stop(&local.id).await.expect("local stop");
    assert!(
        tokio::net::TcpStream::connect(("127.0.0.1", local.input.listen_port))
            .await
            .is_err()
    );
    engine.close(&shell.info.id).await.expect("session close");
    assert!(
        tokio::net::TcpStream::connect(("127.0.0.1", dynamic.input.listen_port))
            .await
            .is_err()
    );
    assert_eq!(engine.forward_count().expect("forwards released"), 0);
    assert_eq!(engine.counts().expect("SSH released"), (0, 0));
}

#[tokio::test]
async fn proxyjump_verifies_both_hosts_and_closes_entire_chain() {
    let jump = Server::start_with_cipher(russh::cipher::AES_256_GCM).await;
    let target = Server::start_with_cipher(russh::cipher::AES_256_CTR).await;
    let (_dir, db) = database();
    jump.trust(&db);
    target.trust(&db);
    let first = jump.host(&db);
    let last = target.host(&db);
    let engine = Engine::new(db);
    let (tx, events) = mpsc::channel(16);
    let info = engine
        .open_plan(
            last.clone(),
            ConnectionPlan {
                hops: vec![
                    Hop {
                        host: first,
                        revision: 1,
                        auth: jump.password(),
                    },
                    Hop {
                        host: last,
                        revision: 1,
                        auth: target.password(),
                    },
                ],
                proxy: None,
            },
            TerminalSize { cols: 80, rows: 24 },
            Arc::new(move |e| tx.try_send(e).is_ok()),
        )
        .expect("jump plan");
    let mut shell = Shell { info, events };
    assert_eq!(connected_cipher(&mut shell).await, "aes256-ctr");
    assert_eq!(jump.attempts.load(Ordering::SeqCst), 1);
    assert_eq!(target.attempts.load(Ordering::SeqCst), 1);
    engine
        .input(&shell.info.id, b"through-jump".to_vec())
        .expect("input");
    loop {
        if let TerminalEvent::Data { data, sequence } = event(&mut shell).await {
            assert_eq!(data, b"through-jump");
            engine.acknowledge(&shell.info.id, sequence).expect("ack");
            break;
        }
    }
    engine.shutdown().await;
    assert_eq!(engine.counts().expect("released"), (0, 0));
}

async fn proxy_fixture(kind: ProxyKind, target_port: u16, password: Option<String>) -> Echo {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("proxy listen");
    let port = listener.local_addr().expect("proxy port").port();
    let task = tokio::spawn(async move {
        let mut tasks = tokio::task::JoinSet::new();
        loop {
            let (mut client, _) = listener.accept().await.expect("proxy accept");
            let password = password.clone();
            tasks.spawn(async move {
                match kind {
                    ProxyKind::Socks5 => {
                        let mut head = [0; 3];
                        client.read_exact(&mut head).await.expect("greeting");
                        assert_eq!(head, [5, 1, if password.is_some() { 2 } else { 0 }]);
                        client.write_all(&[5, head[2]]).await.expect("method");
                        if let Some(password) = password {
                            assert_eq!(client.read_u8().await.expect("version"), 1);
                            let len = client.read_u8().await.expect("user len");
                            let mut user = vec![0; usize::from(len)];
                            client.read_exact(&mut user).await.expect("user");
                            assert_eq!(user, b"proxy-user");
                            let len = client.read_u8().await.expect("password len");
                            let mut supplied = vec![0; usize::from(len)];
                            client.read_exact(&mut supplied).await.expect("password");
                            if supplied != password.as_bytes() {
                                client.write_all(&[1, 1]).await.expect("reject");
                                return;
                            }
                            client.write_all(&[1, 0]).await.expect("auth");
                        }
                        let mut connect = [0; 10];
                        client.read_exact(&mut connect).await.expect("target");
                        assert_eq!(&connect[..8], &[5, 1, 0, 1, 127, 0, 0, 1]);
                        assert_eq!(u16::from_be_bytes([connect[8], connect[9]]), target_port);
                        client
                            .write_all(&[5, 0, 0, 1, 127, 0, 0, 1, 0, 0])
                            .await
                            .expect("success");
                    }
                    ProxyKind::HttpConnect => {
                        let mut header = vec![];
                        while !header.ends_with(b"\r\n\r\n") {
                            header.push(client.read_u8().await.expect("header"));
                            assert!(header.len() < 8192);
                        }
                        let header = String::from_utf8(header).expect("UTF8");
                        assert!(
                            header
                                .starts_with(&format!("CONNECT 127.0.0.1:{target_port} HTTP/1.1"))
                        );
                        if password.is_some() {
                            assert!(header.contains("Proxy-Authorization: Basic "));
                        }
                        client
                            .write_all(b"HTTP/1.1 200 Connection established\r\n\r\n")
                            .await
                            .expect("CONNECT success");
                    }
                }
                let mut target = tokio::net::TcpStream::connect(("127.0.0.1", target_port))
                    .await
                    .expect("target TCP");
                let _ = tokio::io::copy_bidirectional(&mut client, &mut target).await;
            });
        }
    });
    Echo { port, task }
}
#[tokio::test]
async fn socks5_and_http_connect_carry_real_ssh_with_and_without_proxy_auth() {
    for kind in [ProxyKind::Socks5, ProxyKind::HttpConnect] {
        for authenticated in [false, true] {
            let server = Server::start().await;
            let (_dir, db) = database();
            server.trust(&db);
            let host = server.host(&db);
            let password = authenticated.then(|| uuid::Uuid::new_v4().to_string());
            let proxy = proxy_fixture(kind, server.port, password.clone()).await;
            let engine = Engine::new(db);
            let (tx, events) = mpsc::channel(16);
            let settings = ProxySettings {
                kind,
                hostname: "127.0.0.1".into(),
                port: proxy.port,
                username: authenticated.then(|| "proxy-user".into()),
                credential_id: authenticated.then(|| uuid::Uuid::new_v4().to_string()),
            };
            let info = engine
                .open_plan(
                    host.clone(),
                    ConnectionPlan {
                        hops: vec![Hop {
                            host,
                            revision: 1,
                            auth: server.password(),
                        }],
                        proxy: Some(ProxyConnection {
                            settings,
                            password: password.map(Zeroizing::new),
                            revision: 1,
                        }),
                    },
                    TerminalSize { cols: 80, rows: 24 },
                    Arc::new(move |e| tx.try_send(e).is_ok()),
                )
                .expect("proxy plan");
            let mut shell = Shell { info, events };
            state(&mut shell, "connected").await;
            engine.shutdown().await;
            assert_eq!(engine.counts().expect("released"), (0, 0));
        }
    }
}

#[tokio::test]
async fn authentication_timeout_is_independent_of_tcp_timeout() {
    let server = Server::start_with_delay(Duration::from_secs(3)).await;
    let (_dir, db) = database();
    server.trust(&db);
    let mut host = server.host(&db);
    host.config.connect_timeout_secs = 5;
    host.config.ssh.auth_timeout_secs = 1;
    let engine = Engine::new(db);
    let now = tokio::time::Instant::now();
    let mut shell = open(&engine, host, server.password());
    assert_eq!(state(&mut shell, "failed").await, Some("SSH_AUTH_TIMEOUT"));
    assert!(now.elapsed() < Duration::from_secs(3));
    engine.shutdown().await;
    assert_eq!(engine.counts().expect("released"), (0, 0));
}
#[tokio::test]
async fn ssh_keepalive_detects_silent_established_tcp_blackhole() {
    let server = Server::start().await;
    let (_dir, db) = database();
    let mut host = server.host(&db);
    host.config.ssh.keepalive_interval_secs = 1;
    host.config.ssh.keepalive_count_max = 2;
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("blackhole proxy");
    host.config.port = listener.local_addr().expect("port").port();
    db.trust_key("127.0.0.1", host.config.port, &server.key, &server.pin)
        .expect("trust");
    let (freeze, freeze_rx) = tokio::sync::oneshot::channel();
    let port = server.port;
    let proxy = tokio::spawn(async move {
        let (mut client, _) = listener.accept().await.expect("accept");
        let mut target = tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .expect("upstream");
        tokio::select! {_=tokio::io::copy_bidirectional(&mut client,&mut target)=>(),_=freeze_rx=>()};
        let sockets = (client, target);
        std::future::pending::<()>().await;
        drop(sockets);
    });
    let engine = Engine::new(db);
    let mut shell = open(&engine, host, server.password());
    state(&mut shell, "connected").await;
    let now = tokio::time::Instant::now();
    freeze.send(()).expect("freeze without closing TCP");
    assert_eq!(state(&mut shell, "failed").await, Some("SSH_DISCONNECTED"));
    assert!(now.elapsed() >= Duration::from_secs(1));
    engine.shutdown().await;
    proxy.abort();
    assert_eq!(engine.counts().expect("released"), (0, 0));
}

#[tokio::test]
async fn process_exit_signal_is_a_closed_channel_not_a_broken_transport() {
    let server = Server::start().await;
    let (_dir, db) = database();
    server.trust(&db);
    let host = server.host(&db);
    let engine = Engine::new(db);
    let mut interrupted = open(&engine, host.clone(), server.password());
    state(&mut interrupted, "connected").await;
    let mut survivor = open(&engine, host, server.password());
    state(&mut survivor, "connected").await;
    engine
        .input(&interrupted.info.id, b"#interrupt".to_vec())
        .expect("interrupt");
    assert_eq!(state(&mut interrupted, "closed").await, None);
    engine
        .input(&survivor.info.id, b"survives".to_vec())
        .expect("other channel");
    loop {
        if let TerminalEvent::Data { data, sequence } = event(&mut survivor).await {
            assert_eq!(data, b"survives");
            engine
                .acknowledge(&survivor.info.id, sequence)
                .expect("ack");
            break;
        }
    }
    engine.shutdown().await;
    assert_eq!(engine.counts().expect("counts"), (0, 0));
}

#[tokio::test]
async fn twenty_concurrent_pty_channels_keep_results_scoped_and_release_transport() {
    let server = Server::start().await;
    let (_dir, db) = database();
    server.trust(&db);
    let host = server.host(&db);
    let engine = Engine::new(db);
    let mut shells = Vec::new();
    for _ in 0..20 {
        shells.push(open(&engine, host.clone(), server.password()));
    }
    for shell in &mut shells {
        state(shell, "connected").await;
    }
    assert_eq!(engine.counts().expect("counts"), (1, 20));
    let ids: std::collections::HashSet<_> = shells.iter().map(|s| &s.info.id).collect();
    assert_eq!(ids.len(), 20);
    for (index, shell) in shells.iter().enumerate() {
        engine
            .input(&shell.info.id, format!("session-{index}").into_bytes())
            .expect("input");
    }
    for (index, shell) in shells.iter_mut().enumerate() {
        loop {
            if let TerminalEvent::Data { sequence, data } = event(shell).await {
                assert_eq!(data, format!("session-{index}").as_bytes());
                engine.acknowledge(&shell.info.id, sequence).expect("ack");
                break;
            }
        }
    }
    for shell in &shells[..10] {
        engine.close(&shell.info.id).await.expect("close half");
    }
    assert_eq!(engine.counts().expect("counts"), (1, 10));
    engine
        .input(&shells[19].info.id, b"survivor".to_vec())
        .expect("survivor input");
    loop {
        if let TerminalEvent::Data { sequence, data } = event(&mut shells[19]).await {
            assert_eq!(data, b"survivor");
            engine
                .acknowledge(&shells[19].info.id, sequence)
                .expect("survivor ack");
            break;
        }
    }
    engine.shutdown().await;
    assert_eq!(
        engine
            .counts()
            .expect("released all channels and transport"),
        (0, 0)
    );
}
