use super::*;
use serverdeck_core::hosts::{AuthType, CredentialInput, HostInput};
use serverdeck_security::SecretStore;
use std::{collections::HashMap, sync::Mutex, time::Duration};
use zeroize::Zeroizing;

#[derive(Default)]
struct Vault(Mutex<HashMap<String, Vec<u8>>>);
impl SecretStore for Vault {
    fn read(&self, id: &str) -> Result<Option<Zeroizing<Vec<u8>>>, Error> {
        Ok(self.0.lock().unwrap().get(id).cloned().map(Zeroizing::new))
    }
    fn write(&self, id: &str, value: &[u8]) -> Result<(), Error> {
        self.0.lock().unwrap().insert(id.into(), value.into());
        Ok(())
    }
    fn delete(&self, id: &str) -> Result<(), Error> {
        self.0.lock().unwrap().remove(id);
        Ok(())
    }
}

#[tokio::test]
#[ignore = "requires an owned loopback OpenSSH endpoint and SERVERDECK_SFTP_TEST_* environment"]
async fn real_sudo_sftp_switch_preserves_identity_and_recovers_from_failure() {
    use russh::keys::{HashAlg, PublicKey};
    let port: u16 = std::env::var("SERVERDECK_SFTP_TEST_PORT")
        .unwrap()
        .parse()
        .unwrap();
    let key = Zeroizing::new(
        std::fs::read_to_string(std::env::var("SERVERDECK_SFTP_TEST_KEY").unwrap()).unwrap(),
    );
    let public = std::env::var("SERVERDECK_SFTP_TEST_HOST_KEY")
        .unwrap()
        .split_whitespace()
        .take(2)
        .collect::<Vec<_>>()
        .join(" ");
    let remote_root = std::env::var("SERVERDECK_SFTP_TEST_ROOT").unwrap();
    assert!(remote_root.starts_with("/tmp/serverdeck-sftp-user-"));
    let directory = tempfile::tempdir().unwrap();
    let mut app =
        Application::initialize(directory.path().join("data"), directory.path().join("logs"))
            .unwrap();
    app.secrets = Arc::new(Vault::default());
    app.database
        .trust_key(
            "127.0.0.1",
            port,
            &public,
            &PublicKey::from_openssh(&public)
                .unwrap()
                .fingerprint(HashAlg::Sha256)
                .to_string(),
        )
        .unwrap();
    let credential = app
        .credential_save(
            None,
            None,
            CredentialInput {
                name: "isolated sudo test".into(),
                kind: AuthType::PrivateKey,
                key_path: None,
                key_data: Some(key),
                secret: None,
                clear_secret: false,
            },
        )
        .await
        .unwrap()
        .value;
    let host = app
        .database
        .host_create(HostInput {
            name: "isolated sudo test".into(),
            hostname: "127.0.0.1".into(),
            port,
            username: "root".into(),
            auth_type: AuthType::PrivateKey,
            credential_id: Some(credential.id),
            group_id: None,
            description: String::new(),
            favorite: false,
            connect_timeout_secs: 5,
            ssh: Default::default(),
        })
        .unwrap();
    let (sender, mut events) = tokio::sync::mpsc::channel(16);
    let original = app
        .files_open(
            host.id.clone(),
            Arc::new(move |event| sender.try_send(event).is_ok()),
        )
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            match events.recv().await.unwrap() {
                serverdeck_core::terminal::TerminalEvent::State {
                    state: "connected", ..
                } => break,
                serverdeck_core::terminal::TerminalEvent::State {
                    state: "failed",
                    code,
                    ..
                } => panic!("SSH failed: {code:?}"),
                _ => (),
            }
        }
    })
    .await
    .unwrap();
    app.files_list(&original.id, ".").await.unwrap();
    let sudo = |username: &str| {
        Some(SftpUser {
            username: username.into(),
            server_path: String::new(),
            password: None,
        })
    };
    let root = app
        .files_switch_user(original.id.clone(), sudo("root"))
        .await
        .unwrap();
    assert_ne!(root.session.id, original.id);
    assert!(app.terminals.file_is_elevated(&root.session.id).unwrap());
    assert!(
        app.terminals.login_file_connections().unwrap().is_empty(),
        "plugins cannot inherit sudo"
    );
    assert!(app.terminals.session_info(&original.id).is_err());
    let source = directory.path().join("identity.txt");
    tokio::fs::write(&source, b"real sudo SFTP content")
        .await
        .unwrap();
    let task = app
        .transfer_start(TransferInput {
            session_id: root.session.id.clone(),
            direction: Direction::Upload,
            sources: vec![source.to_str().unwrap().into()],
            destination: remote_root.clone(),
            conflict: ConflictPolicy::Fail,
            confirm_overwrite: false,
        })
        .unwrap();
    tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            let task = app
                .transfer_list()
                .unwrap()
                .into_iter()
                .find(|t| t.id == task.id)
                .unwrap();
            if !task.unfinished() {
                assert_eq!(task.state, "completed", "{:?}", task.message);
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    let remote_file = format!("{remote_root}/identity.txt");
    assert_eq!(
        app.files_properties(&root.session.id, &remote_file)
            .await
            .unwrap()
            .uid,
        Some(0)
    );
    let doc = app.text_read(&root.session.id, &remote_file).await.unwrap();
    assert_eq!(doc.content, "real sudo SFTP content");
    app.text_dirty(&doc.token, true).unwrap();
    assert!(
        app.files_switch_user(root.session.id.clone(), None)
            .await
            .is_err()
    );
    app.text_close(&doc.token, true).unwrap();
    assert!(
        app.files_switch_user(root.session.id.clone(), sudo("serverdeck-nonexistent-user"))
            .await
            .is_err()
    );
    app.files_list(&root.session.id, &remote_root)
        .await
        .expect("failed sudo keeps original lease");
    assert!(
        app.files_switch_user(
            root.session.id.clone(),
            Some(SftpUser {
                username: "root".into(),
                server_path: "/nonexistent/sftp-server".into(),
                password: None
            })
        )
        .await
        .is_err()
    );
    assert_eq!(
        app.file_connections().unwrap().len(),
        1,
        "failed candidates must be closed"
    );
    let nobody = app
        .files_switch_user(root.session.id, sudo("nobody"))
        .await
        .unwrap();
    let owned_directory = format!("{remote_root}/nobody-owned");
    app.files_action(
        &nobody.session.id,
        RemoteAction::Mkdir {
            path: owned_directory.clone(),
        },
    )
    .await
    .unwrap();
    assert_eq!(
        app.files_properties(&nobody.session.id, &owned_directory)
            .await
            .unwrap()
            .uid,
        Some(65534),
        "the SFTP server really runs as the target uid"
    );
    let login = app
        .files_switch_user(nobody.session.id, None)
        .await
        .unwrap();
    assert!(!app.terminals.file_is_elevated(&login.session.id).unwrap());
    assert_eq!(app.terminals.login_file_connections().unwrap().len(), 1);
    assert_eq!(
        app.text_read(&login.session.id, &remote_file)
            .await
            .unwrap()
            .content,
        "real sudo SFTP content"
    );
    app.shutdown().await;
}
