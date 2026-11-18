use super::*;
use russh::{
    keys::{
        Algorithm, PrivateKey, PublicKey,
        ssh_key::{LineEnding, private::RsaKeypair},
    },
    server,
};
use serverdeck_security::NativeStore;
use std::sync::{Arc, Mutex};

#[derive(Default)]
struct NativeEntries(Mutex<Vec<String>>);
impl SecretStore for NativeEntries {
    fn write(&self, reference: &str, secret: &[u8]) -> Result<(), Error> {
        self.0.lock().unwrap().push(reference.into());
        NativeStore.write(reference, secret)
    }
    fn read(&self, reference: &str) -> Result<Option<Zeroizing<Vec<u8>>>, Error> {
        NativeStore.read(reference)
    }
    fn delete(&self, reference: &str) -> Result<(), Error> {
        NativeStore.delete(reference)
    }
}
impl Drop for NativeEntries {
    fn drop(&mut self) {
        for reference in self.0.get_mut().unwrap().iter() {
            if NativeStore.delete(reference).is_err() {
                eprintln!("failed to clean up an isolated native test credential");
            }
        }
    }
}

struct PublicAuth(PublicKey);
impl server::Handler for PublicAuth {
    type Error = russh::Error;
    async fn auth_publickey(
        &mut self,
        user: &str,
        key: server::VerifiedPublicKey<'_>,
    ) -> Result<server::Auth, Self::Error> {
        Ok(if user == "fixture" && key.public_key == &self.0 {
            server::Auth::Accept
        } else {
            server::Auth::reject()
        })
    }
}

#[tokio::test]
#[ignore = "Explicit Windows credential-store integration; requires ssh-keygen; random credentials and loopback SSH only"]
async fn native_rsa_4096_save_reopen_and_authenticate() {
    let key = tokio::task::spawn_blocking(|| {
        PrivateKey::from(RsaKeypair::random(&mut rand::rng(), 4096).unwrap())
    })
    .await
    .unwrap();
    let authorized = key.public_key().clone();
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let port = listener.local_addr().unwrap().port();
    let config = Arc::new(server::Config {
        keys: vec![PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).unwrap()],
        auth_rejection_time: std::time::Duration::ZERO,
        ..Default::default()
    });
    let sshd = tokio::spawn(async move {
        while let Ok((socket, _)) = listener.accept().await {
            let config = config.clone();
            let auth = PublicAuth(authorized.clone());
            tokio::spawn(async move {
                let session = server::run_stream(config, socket, auth).await.unwrap();
                let _ = session.await;
            });
        }
    });
    let dir = tempfile::tempdir().unwrap();
    let entries = Arc::new(NativeEntries::default());
    let mut app = Application::initialize(dir.path().into(), dir.path().join("logs")).unwrap();
    let input = HostInput {
        name: "native RSA fixture".into(),
        hostname: "127.0.0.1".into(),
        port,
        username: "fixture".into(),
        auth_type: AuthType::PrivateKey,
        credential_id: None,
        group_id: None,
        description: String::new(),
        favorite: false,
        connect_timeout_secs: 5,
        ssh: Default::default(),
    };
    for format in ["openssh", "encrypted-openssh", "pkcs1"] {
        app.secrets = entries.clone();
        let encrypted = format == "encrypted-openssh";
        let mut contents = if encrypted {
            key.encrypt(&mut rand::rng(), "native-test-passphrase")
                .unwrap()
        } else {
            key.clone()
        }
        .to_openssh(LineEnding::LF)
        .unwrap();
        if format == "pkcs1" {
            let path = dir.path().join("generated-test-key");
            key.write_openssh_file(&path, LineEnding::LF).unwrap();
            let account = format!(
                "{}\\{}:(F)",
                std::env::var("USERDOMAIN").unwrap(),
                std::env::var("USERNAME").unwrap()
            );
            // Restrict only this generated fixture; ssh-keygen enforces Windows key ACLs.
            let permissions = std::process::Command::new("icacls")
                .arg(&path)
                .args(["/inheritance:r", "/grant:r"])
                .arg(account)
                .output()
                .expect("restrict generated fixture permissions");
            assert!(permissions.status.success(), "set test fixture ACL");
            let output = std::process::Command::new("ssh-keygen")
                .args(["-p", "-m", "PEM", "-N", "", "-P", "", "-f"])
                .arg(&path)
                .output()
                .expect("ssh-keygen converts only the generated test fixture");
            assert!(
                output.status.success(),
                "convert generated test fixture to PKCS#1: {}",
                String::from_utf8_lossy(&output.stderr)
            );
            contents = Zeroizing::new(std::fs::read_to_string(&path).unwrap());
            std::fs::remove_file(&path).unwrap();
            assert!(contents.starts_with("-----BEGIN RSA PRIVATE KEY-----"));
        }
        assert!(contents.len() > 2560);
        let authentication = || {
            Some(HostAuthenticationInput::PrivateKey {
                key_data: contents.clone(),
                passphrase: encrypted.then(|| Zeroizing::new("native-test-passphrase".into())),
            })
        };
        let tested = app
            .host_test(None, input.clone(), authentication(), None)
            .await
            .unwrap();
        let tested = match tested {
            HostTestResult::TrustRequired { key } => app
                .host_test(None, input.clone(), authentication(), Some(key))
                .await
                .unwrap(),
            connected => connected,
        };
        let HostTestResult::Connected { test_id, .. } = tested else {
            panic!("SSH authentication must succeed")
        };
        let host = app
            .host_save_tested(None, input.clone(), authentication(), test_id)
            .await
            .unwrap();
        let reference = app
            .database
            .credential_record(host.config.credential_id.as_ref().unwrap())
            .unwrap()
            .secret_ref
            .unwrap();
        assert!(reference.starts_with("chunked:v1:"));
        let stored = NativeStore.read(&reference).unwrap().unwrap();
        assert!(stored.len() > 2560);
        let restored =
            russh::keys::decode_secret_key(std::str::from_utf8(&stored).unwrap(), None).unwrap();
        assert_eq!(restored.public_key(), key.public_key());
        if format == "openssh" {
            let path = dir.path().join("host.sdhosts");
            app.host_backup_export(path.clone()).await.unwrap();
            let data = dir.path().join("new-computer");
            let mut target = Application::initialize(data.clone(), data.join("logs")).unwrap();
            target.secrets = entries.clone();
            target.host_backup_import(path).await.unwrap();
            target.shutdown().await;
            drop(target);
            let target = Application::initialize(data.clone(), data.join("logs")).unwrap();
            let imported = target.catalog().await.unwrap().hosts.pop().unwrap();
            let imported_ref = target
                .database
                .credential_record(imported.config.credential_id.as_ref().unwrap())
                .unwrap()
                .secret_ref
                .unwrap();
            assert_ne!(reference, imported_ref);
            assert!(matches!(
                target
                    .host_test(Some(imported.id.clone()), imported.config, None, None)
                    .await
                    .unwrap(),
                HostTestResult::Connected { .. }
            ));
            target.host_delete(imported.id).await.unwrap();
            assert!(NativeStore.read(&imported_ref).unwrap().is_none());
            target.shutdown().await;
        }
        app.shutdown().await;
        drop(app);

        app = Application::initialize(dir.path().into(), dir.path().join("logs")).unwrap();
        let saved = app.database.host(&host.id).unwrap();
        let HostTestResult::Connected { test_id, .. } = app
            .host_test(Some(saved.id.clone()), saved.config.clone(), None, None)
            .await
            .unwrap()
        else {
            panic!("persisted native credentials must authenticate after reopening");
        };
        app.host_save_tested(Some(saved.id.clone()), saved.config, None, test_id)
            .await
            .unwrap();
        app.host_delete(saved.id).await.unwrap();
        assert!(NativeStore.read(&reference).unwrap().is_none());
        assert_eq!(app.catalog().await.unwrap().pending_secret_deletions, 0);
        let database = std::fs::read(dir.path().join("serverdeck.sqlite3")).unwrap();
        for forbidden in [
            b"PRIVATE KEY".as_slice(),
            b"native-test-passphrase".as_slice(),
        ] {
            assert!(
                !database
                    .windows(forbidden.len())
                    .any(|bytes| bytes == forbidden)
            );
        }
    }
    app.shutdown().await;
    sshd.abort();
}
