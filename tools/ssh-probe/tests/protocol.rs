//! Real SSH over loopback TCP. The fixture is a protocol test server, not an OpenSSH compatibility claim.
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

use anyhow::Result;
use russh::{
    Channel, ChannelId,
    keys::{Algorithm, HashAlg, PrivateKey, PublicKey},
    server::{self, Auth, ChannelOpenHandle, Msg, Session},
};
use russh_sftp::protocol::{File, FileAttributes, Handle, Name, Status, StatusCode};
use serverdeck_ssh_probe::{Connection, TIMEOUT, authenticate_key, check_channels, connect};
use tokio::{net::TcpListener, task::JoinHandle};

struct Fixture {
    channels: HashMap<ChannelId, Channel<Msg>>,
    key: PublicKey,
    directory: PathBuf,
    dimensions: Arc<Mutex<Vec<(u32, u32)>>>,
    auth_attempts: Arc<AtomicUsize>,
    workers: Vec<JoinHandle<()>>,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        for worker in &self.workers {
            worker.abort();
        }
    }
}

impl server::Handler for Fixture {
    type Error = anyhow::Error;

    async fn auth_password(&mut self, user: &str, password: &str) -> Result<Auth> {
        self.auth_attempts.fetch_add(1, Ordering::SeqCst);
        Ok(if user == "probe" && password == "test-only-password" {
            Auth::Accept
        } else {
            Auth::reject()
        })
    }

    async fn auth_publickey(
        &mut self,
        user: &str,
        public: server::VerifiedPublicKey<'_>,
    ) -> Result<Auth> {
        self.auth_attempts.fetch_add(1, Ordering::SeqCst);
        Ok(if user == "probe" && *public.public_key == self.key {
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
    ) -> Result<()> {
        self.channels.insert(channel.id(), channel);
        reply.accept().await;
        Ok(())
    }

    async fn channel_close(&mut self, channel: ChannelId, _: &mut Session) -> Result<()> {
        self.channels.remove(&channel);
        Ok(())
    }

    async fn pty_request(
        &mut self,
        channel: ChannelId,
        _: &str,
        columns: u32,
        rows: u32,
        _: u32,
        _: u32,
        _: &[(russh::Pty, u32)],
        session: &mut Session,
    ) -> Result<()> {
        self.dimensions
            .lock()
            .expect("dimensions")
            .push((columns, rows));
        session.channel_success(channel)?;
        Ok(())
    }

    async fn window_change_request(
        &mut self,
        _: ChannelId,
        columns: u32,
        rows: u32,
        _: u32,
        _: u32,
        _: &mut Session,
    ) -> Result<()> {
        self.dimensions
            .lock()
            .expect("dimensions")
            .push((columns, rows));
        Ok(())
    }

    async fn shell_request(&mut self, channel: ChannelId, session: &mut Session) -> Result<()> {
        session.channel_success(channel)?;
        Ok(())
    }

    async fn exec_request(
        &mut self,
        channel: ChannelId,
        command: &[u8],
        session: &mut Session,
    ) -> Result<()> {
        session.channel_success(channel)?;
        // Protocol fixture only understands the two constant probe commands; no local shell executes.
        let output = match command {
            b"printf serverdeck-probe-a" => b"serverdeck-probe-a".as_slice(),
            b"printf serverdeck-probe-b" => b"serverdeck-probe-b".as_slice(),
            _ => anyhow::bail!("unexpected probe command"),
        };
        session.data(channel, output.to_vec())?;
        session.exit_status_request(channel, 0)?;
        session.eof(channel)?;
        session.close(channel)?;
        Ok(())
    }

    async fn data(&mut self, channel: ChannelId, data: &[u8], session: &mut Session) -> Result<()> {
        if data == b"stty size\n" {
            let (columns, rows) = *self
                .dimensions
                .lock()
                .expect("dimensions")
                .last()
                .expect("PTY dimensions");
            session.data(channel, format!("{rows} {columns}\r\n"))?;
        }
        Ok(())
    }

    async fn subsystem_request(
        &mut self,
        channel: ChannelId,
        name: &str,
        session: &mut Session,
    ) -> Result<()> {
        if name != "sftp" {
            session.channel_failure(channel)?;
            return Ok(());
        }
        let stream = self
            .channels
            .remove(&channel)
            .expect("opened channel")
            .into_stream();
        let handler = Directory {
            directory: self.directory.clone(),
            read: false,
        };
        session.channel_success(channel)?;
        self.workers.push(tokio::spawn(async move {
            russh_sftp::server::run(stream, handler).await;
        }));
        Ok(())
    }
}

struct Directory {
    directory: PathBuf,
    read: bool,
}
impl russh_sftp::server::Handler for Directory {
    type Error = StatusCode;
    fn unimplemented(&self) -> StatusCode {
        StatusCode::OpUnsupported
    }
    async fn opendir(&mut self, id: u32, path: String) -> Result<Handle, StatusCode> {
        if path != "." {
            return Err(StatusCode::PermissionDenied);
        }
        self.read = false;
        Ok(Handle {
            id,
            handle: "root".into(),
        })
    }
    async fn readdir(&mut self, id: u32, handle: String) -> Result<Name, StatusCode> {
        if handle != "root" {
            return Err(StatusCode::PermissionDenied);
        }
        if self.read {
            return Err(StatusCode::Eof);
        }
        self.read = true;
        // Read actual temporary filesystem entries rather than fabricated directory contents.
        let files = std::fs::read_dir(&self.directory)
            .map_err(|_| StatusCode::Failure)?
            .map(|entry| {
                let entry = entry.map_err(|_| StatusCode::Failure)?;
                let metadata = entry.metadata().map_err(|_| StatusCode::Failure)?;
                Ok(File::new(
                    entry.file_name().to_string_lossy().into_owned(),
                    FileAttributes {
                        size: Some(metadata.len()),
                        ..Default::default()
                    },
                ))
            })
            .collect::<Result<Vec<_>, StatusCode>>()?;
        Ok(Name { id, files })
    }
    async fn close(&mut self, id: u32, _: String) -> Result<Status, StatusCode> {
        Ok(Status {
            id,
            status_code: StatusCode::Ok,
            error_message: String::new(),
            language_tag: "en".into(),
        })
    }
}

struct Server {
    port: u16,
    fingerprint: String,
    dimensions: Arc<Mutex<Vec<(u32, u32)>>>,
    auth_attempts: Arc<AtomicUsize>,
    task: JoinHandle<()>,
    _directory: tempfile::TempDir,
}
impl Drop for Server {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl Server {
    async fn start(user_key: &PrivateKey) -> Self {
        let host_key = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).expect("host key");
        let fingerprint = host_key
            .public_key()
            .fingerprint(HashAlg::Sha256)
            .to_string();
        let directory = tempfile::tempdir().expect("tempdir");
        std::fs::write(directory.path().join("中文 file ;$.txt"), b"actual file")
            .expect("fixture file");
        let dimensions = Arc::new(Mutex::new(Vec::new()));
        let auth_attempts = Arc::new(AtomicUsize::new(0));
        let fixture = Fixture {
            channels: HashMap::new(),
            key: user_key.public_key().clone(),
            directory: directory.path().to_owned(),
            dimensions: dimensions.clone(),
            auth_attempts: auth_attempts.clone(),
            workers: Vec::new(),
        };
        let config = Arc::new(server::Config {
            keys: vec![host_key],
            auth_rejection_time: Duration::ZERO,
            auth_rejection_time_initial: Some(Duration::ZERO),
            ..Default::default()
        });
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.expect("listener");
        let port = listener.local_addr().expect("address").port();
        let task = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.expect("accept");
            if let Ok(session) = server::run_stream(config, stream, fixture).await {
                let _ = session.await;
            }
        });
        Self {
            port,
            fingerprint,
            dimensions,
            auth_attempts,
            task,
            _directory: directory,
        }
    }
    async fn connect(&self) -> Connection {
        connect("127.0.0.1", self.port, self.fingerprint.clone())
            .await
            .expect("connect")
    }
}

#[tokio::test]
async fn password_pty_resize_multi_channel_and_real_sftp_listing() {
    tokio::time::timeout(TIMEOUT, async {
        let key = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).expect("key");
        let server = Server::start(&key).await;
        let mut connection = server.connect().await;
        assert!(
            connection
                .authenticate_password("probe", "test-only-password")
                .await
                .expect("auth")
                .success()
        );
        assert_eq!(check_channels(&connection).await.expect("channels"), 1);
        assert_eq!(
            *server.dimensions.lock().expect("dimensions"),
            [(80, 24), (100, 40)]
        );
        connection
            .disconnect(russh::Disconnect::ByApplication, "done", "en")
            .await
            .expect("disconnect");
    })
    .await
    .expect("test deadline");
}

#[tokio::test]
async fn encrypted_openssh_ed25519_and_rsa_keys_authenticate() {
    for algorithm in [
        Algorithm::Ed25519,
        Algorithm::Rsa {
            hash: Some(HashAlg::Sha256),
        },
    ] {
        let key = PrivateKey::random(&mut rand::rng(), algorithm).expect("key");
        let server = Server::start(&key).await;
        let encrypted = key
            .encrypt(&mut rand::rng(), "test-only-passphrase")
            .expect("encrypt");
        let path = server._directory.path().join("key");
        std::fs::write(
            &path,
            encrypted
                .to_openssh(russh::keys::ssh_key::LineEnding::LF)
                .expect("encode")
                .as_bytes(),
        )
        .expect("write key");
        assert!(russh::keys::load_secret_key(&path, Some("wrong-passphrase")).is_err());
        let decoded =
            russh::keys::load_secret_key(&path, Some("test-only-passphrase")).expect("decrypt");
        let mut connection = server.connect().await;
        tokio::time::timeout(TIMEOUT, authenticate_key(&mut connection, "probe", decoded))
            .await
            .expect("deadline")
            .expect("authenticate key");
        connection
            .disconnect(russh::Disconnect::ByApplication, "done", "en")
            .await
            .expect("disconnect");
    }
}

#[tokio::test]
async fn changed_host_key_blocks_before_authentication_and_bad_password_fails() {
    let key = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).expect("key");
    let server = Server::start(&key).await;
    let wrong_pin = format!("SHA256:{}", "A".repeat(43));
    assert!(connect("127.0.0.1", server.port, wrong_pin).await.is_err());
    assert_eq!(server.auth_attempts.load(Ordering::SeqCst), 0);
    let server = Server::start(&key).await;
    let mut connection = server.connect().await;
    assert!(
        !connection
            .authenticate_password("probe", "bad-password")
            .await
            .expect("auth result")
            .success()
    );
    connection
        .disconnect(russh::Disconnect::ByApplication, "done", "en")
        .await
        .expect("disconnect");
}
