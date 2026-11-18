use super::*;
use russh::keys::{Algorithm, HashAlg, PrivateKey, ssh_key::LineEnding};
use serverdeck_core::connection::{ProxyKind, ProxySettings};

#[tokio::test]
async fn host_backup_preserves_tree_shared_credentials_proxy_jump_and_trust() {
    let temp = tempfile::tempdir().unwrap();
    let mut source =
        Application::initialize(temp.path().join("source"), temp.path().join("logs")).unwrap();
    source.secrets = Arc::new(TestStore::default());
    let group = |name: &str, parent_id| GroupInput {
        name: name.into(),
        sort_order: 4,
        parent_id,
    };
    let parent = source.group_save(None, group("VPS", None)).await.unwrap();
    let child = source
        .group_save(None, group("A", Some(parent.id.clone())))
        .await
        .unwrap();
    let password = source
        .credential_save(None, None, credential(Some("test-password")))
        .await
        .unwrap()
        .value;
    let unused = source
        .credential_save(None, None, credential(Some("unused-fixture")))
        .await
        .unwrap()
        .value;
    let mut jump = host_input(AuthType::Password);
    jump.credential_id = Some(password.id.clone());
    jump.group_id = Some(parent.id);
    let jump = source.host_save(None, jump, None).await.unwrap();
    let key = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).unwrap();
    let key_path = temp.path().join("fixture-key");
    key.encrypt(&mut rand::rng(), "fixture-passphrase")
        .unwrap()
        .write_openssh_file(&key_path, LineEnding::LF)
        .unwrap();
    let legacy = source
        .credential_save(
            None,
            None,
            CredentialInput {
                kind: AuthType::PrivateKey,
                key_path: Some(key_path.to_str().unwrap().into()),
                ..credential(Some("fixture-passphrase"))
            },
        )
        .await
        .unwrap()
        .value;
    let mut target = host_input(AuthType::PrivateKey);
    target.group_id = Some(child.id);
    target.credential_id = Some(legacy.id);
    target.hostname = "inside.example".into();
    target.favorite = true;
    target.ssh.jump_host_id = Some(jump.id.clone());
    target.ssh.proxy = Some(ProxySettings {
        kind: ProxyKind::Socks5,
        hostname: "proxy.example".into(),
        port: 1080,
        username: Some("ops".into()),
        credential_id: Some(password.id),
    });
    source.host_save(None, target, None).await.unwrap();
    let pubkey = key.public_key().to_openssh().unwrap();
    let fingerprint = key.public_key().fingerprint(HashAlg::Sha256).to_string();
    for name in ["example.com", "inside.example", "retired.example"] {
        source
            .database
            .trust_key(name, 22, &pubkey, &fingerprint)
            .unwrap();
    }
    let path = temp.path().join("all.sdhosts");
    let stats = source.host_backup_export(path.clone()).await.unwrap();
    assert_eq!(
        (
            stats.hosts,
            stats.groups,
            stats.agent_hosts,
            stats.missing_auth
        ),
        (2, 2, 0, 0)
    );
    let text = std::fs::read_to_string(&path).unwrap();
    for excluded in [
        unused.id.as_str(),
        "unused-fixture",
        "fixture-passphrase",
        "retired.example",
        "fixture-key",
    ] {
        assert!(!text.contains(excluded));
    }
    std::fs::remove_file(key_path).unwrap();
    let mut dest =
        Application::initialize(temp.path().join("dest"), temp.path().join("target-logs")).unwrap();
    let store = Arc::new(TestStore::default());
    dest.secrets = store.clone();
    dest.host_backup_import(path.clone()).await.unwrap();
    let catalog = dest.catalog().await.unwrap();
    let group = catalog.groups.iter().find(|g| g.name == "A").unwrap();
    assert_eq!(
        catalog
            .groups
            .iter()
            .find(|g| Some(&g.id) == group.parent_id.as_ref())
            .unwrap()
            .name,
        "VPS"
    );
    let target = catalog.hosts.iter().find(|h| h.config.favorite).unwrap();
    let jump = catalog.hosts.iter().find(|h| !h.config.favorite).unwrap();
    assert_ne!(target.id, jump.id);
    assert_eq!(target.config.group_id.as_ref(), Some(&group.id));
    assert_eq!(target.config.ssh.jump_host_id.as_ref(), Some(&jump.id));
    assert_eq!(
        target.config.ssh.proxy.as_ref().unwrap().credential_id,
        jump.config.credential_id
    );
    assert_eq!(
        dest.database
            .trusted_key("inside.example", 22)
            .unwrap()
            .as_ref(),
        Some(&pubkey)
    );
    assert!(
        dest.database
            .trusted_key("retired.example", 22)
            .unwrap()
            .is_none()
    );
    let key_record = dest
        .database
        .credential_record(target.config.credential_id.as_ref().unwrap())
        .unwrap();
    assert!(key_record.public.key_path.is_none());
    let contents = store
        .read(&key_record.secret_ref.unwrap())
        .unwrap()
        .unwrap();
    assert_eq!(
        russh::keys::decode_secret_key(std::str::from_utf8(&contents).unwrap(), None)
            .unwrap()
            .public_key(),
        key.public_key()
    );
    assert!(dest.host_backup_import(path).await.is_err());
    assert_eq!(dest.catalog().await.unwrap().hosts.len(), 2);
    assert_eq!(store.values.lock().unwrap().len(), 2);
    assert!(dest.database.pending_secret_gc().unwrap().is_empty());
}

struct FailSecondWrite(TestStore);
impl SecretStore for FailSecondWrite {
    fn read(&self, id: &str) -> Result<Option<Zeroizing<Vec<u8>>>, Error> {
        self.0.read(id)
    }
    fn delete(&self, id: &str) -> Result<(), Error> {
        self.0.delete(id)
    }
    fn write(&self, id: &str, value: &[u8]) -> Result<(), Error> {
        if !self.0.values.lock().unwrap().is_empty() {
            return Err(Error::SecureStore(Box::new(std::io::Error::other(
                "test write failure",
            ))));
        }
        self.0.write(id, value)
    }
}

#[tokio::test]
async fn host_backup_rolls_back_failed_import_and_preserves_previous_export() {
    let temp = tempfile::tempdir().unwrap();
    let mut source =
        Application::initialize(temp.path().join("source"), temp.path().join("logs")).unwrap();
    let source_store = Arc::new(TestStore::default());
    source.secrets = source_store.clone();
    for hostname in ["one.example", "two.example"] {
        let input = HostInput {
            hostname: hostname.into(),
            ..host_input(AuthType::Password)
        };
        source
            .host_save(
                None,
                input,
                Some(HostAuthenticationInput::Password {
                    password: Zeroizing::new("fixture".into()),
                }),
            )
            .await
            .unwrap();
    }
    let key = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).unwrap();
    source
        .database
        .trust_key(
            "one.example",
            22,
            &key.public_key().to_openssh().unwrap(),
            &key.public_key().fingerprint(HashAlg::Sha256).to_string(),
        )
        .unwrap();
    let path = temp.path().join("backup.sdhosts");
    source.host_backup_export(path.clone()).await.unwrap();
    let good = std::fs::read(&path).unwrap();
    source_store.values.lock().unwrap().clear();
    assert!(source.host_backup_export(path.clone()).await.is_err());
    assert!(std::fs::read(&path).unwrap() == good);
    let mut dest =
        Application::initialize(temp.path().join("dest"), temp.path().join("dest-logs")).unwrap();
    let failing = Arc::new(FailSecondWrite(TestStore::default()));
    dest.secrets = failing.clone();
    assert!(matches!(
        dest.host_backup_import(path.clone()).await,
        Err(Error::SecureStore(_))
    ));
    assert!(dest.catalog().await.unwrap().hosts.is_empty());
    assert!(
        dest.database
            .trusted_key("one.example", 22)
            .unwrap()
            .is_none()
    );
    assert!(failing.0.values.lock().unwrap().is_empty());
    assert!(dest.database.pending_secret_gc().unwrap().is_empty());
    dest.secrets = Arc::new(TestStore::default());
    let json: serde_json::Value = serde_json::from_slice(&good).unwrap();
    for pointer in [
        "/version",
        "/directory/trustedKeys/0/fingerprint",
        "/directory/hosts/1/config/credentialId",
    ] {
        let mut bad = json.clone();
        *bad.pointer_mut(pointer).unwrap() = if pointer == "/version" {
            2.into()
        } else {
            "unknown".into()
        };
        std::fs::write(&path, serde_json::to_vec(&bad).unwrap()).unwrap();
        assert!(dest.host_backup_import(path.clone()).await.is_err());
        assert!(dest.catalog().await.unwrap().hosts.is_empty());
    }
    std::fs::write(&path, good).unwrap();
    let other = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).unwrap();
    let prior_key = other.public_key().to_openssh().unwrap();
    dest.database
        .trust_key(
            "one.example",
            22,
            &prior_key,
            &other.public_key().fingerprint(HashAlg::Sha256).to_string(),
        )
        .unwrap();
    assert!(dest.host_backup_import(path.clone()).await.is_err());
    assert!(dest.catalog().await.unwrap().hosts.is_empty());
    assert_eq!(
        dest.database
            .trusted_key("one.example", 22)
            .unwrap()
            .as_ref(),
        Some(&prior_key)
    );
    let mut fresh =
        Application::initialize(temp.path().join("fresh"), temp.path().join("fresh-logs")).unwrap();
    fresh.secrets = Arc::new(TestStore::default());
    assert_eq!(fresh.host_backup_import(path).await.unwrap().hosts, 2);
}
