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
    let source_jump_id = jump.id.clone();
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
    let mut dest =
        Application::initialize(temp.path().join("dest"), temp.path().join("target-logs")).unwrap();
    let store = Arc::new(TestStore::default());
    dest.secrets = store.clone();
    dest.host_backup_import(path.clone()).await.unwrap();
    let catalog = dest.catalog().await.unwrap();
    let restored_folder = catalog.groups.iter().find(|g| g.name == "A").unwrap();
    assert_eq!(
        catalog
            .groups
            .iter()
            .find(|g| Some(&g.id) == restored_folder.parent_id.as_ref())
            .unwrap()
            .name,
        "VPS"
    );
    let target = catalog.hosts.iter().find(|h| h.config.favorite).unwrap();
    let jump = catalog.hosts.iter().find(|h| !h.config.favorite).unwrap();
    assert_ne!(target.id, jump.id);
    assert_eq!(target.config.group_id.as_ref(), Some(&restored_folder.id));
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
    let repeat = dest.host_backup_import(path.clone()).await.unwrap();
    assert_eq!((repeat.hosts, repeat.groups), (0, 0));
    assert_eq!((repeat.skipped_hosts, repeat.reused_groups), (2, 2));
    let merged = dest.catalog().await.unwrap();
    assert_eq!(merged.hosts.len(), 2);
    assert_eq!(merged.groups.len(), 2);
    assert_eq!(
        dest.database.host(&target.id).unwrap().config,
        target.config
    );
    assert_eq!(dest.database.host(&jump.id).unwrap().config, jump.config);
    assert_eq!(store.values.lock().unwrap().len(), 2);
    assert!(dest.database.pending_secret_gc().unwrap().is_empty());

    let mut deploy = host_input(AuthType::Agent);
    deploy.hostname = "inside.example".into();
    deploy.username = "deploy".into();
    deploy.ssh.jump_host_id = Some(source_jump_id);
    let added = source.group_save(None, group("新增", None)).await.unwrap();
    deploy.group_id = Some(added.id);
    let mut direct = deploy.clone();
    direct.ssh.jump_host_id = None;
    source.host_save(None, deploy, None).await.unwrap();
    source.host_save(None, direct, None).await.unwrap();
    source.host_backup_export(path.clone()).await.unwrap();
    std::fs::remove_file(key_path).unwrap();

    // A conflicting key must abort even when the existing host would otherwise be skipped.
    let valid = std::fs::read(&path).unwrap();
    let mut conflict: serde_json::Value = serde_json::from_slice(&valid).unwrap();
    let other = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).unwrap();
    let keys = conflict["directory"]["trustedKeys"].as_array_mut().unwrap();
    let record = keys
        .iter_mut()
        .find(|k| k["hostname"] == "inside.example")
        .unwrap();
    record["publicKey"] = other.public_key().to_openssh().unwrap().into();
    record["fingerprint"] = other
        .public_key()
        .fingerprint(HashAlg::Sha256)
        .to_string()
        .into();
    std::fs::write(&path, serde_json::to_vec(&conflict).unwrap()).unwrap();
    assert!(matches!(
        dest.host_backup_import(path.clone()).await,
        Err(Error::Validation(
            "备份指纹与本机信任记录冲突，未导入主机备份"
        ))
    ));
    let unchanged = dest.catalog().await.unwrap();
    assert_eq!((unchanged.hosts.len(), unchanged.groups.len()), (2, 2));
    assert_eq!(store.values.lock().unwrap().len(), 2);
    assert!(dest.database.pending_secret_gc().unwrap().is_empty());
    assert_eq!(
        dest.database.trusted_key("inside.example", 22).unwrap(),
        Some(pubkey)
    );

    std::fs::write(&path, valid).unwrap();
    let incremental = dest.host_backup_import(path).await.unwrap();
    assert_eq!((incremental.hosts, incremental.groups), (2, 1));
    assert_eq!(
        (incremental.skipped_hosts, incremental.reused_groups),
        (2, 2)
    );
    assert_eq!((incremental.agent_hosts, incremental.missing_auth), (2, 0));
    let merged = dest.catalog().await.unwrap();
    let deploys: Vec<_> = merged
        .hosts
        .iter()
        .filter(|h| h.config.username == "deploy")
        .map(|h| h.config.ssh.jump_host_id.as_deref())
        .collect();
    assert_eq!(deploys.len(), 2);
    assert!(deploys.contains(&Some(jump.id.as_str())));
    assert!(deploys.contains(&None));
    assert_eq!(store.values.lock().unwrap().len(), 2);
}

#[tokio::test]
async fn host_backup_reuses_the_same_folder_path_and_preserves_distinct_credentials() {
    let temp = tempfile::tempdir().unwrap();
    let mut source =
        Application::initialize(temp.path().join("source"), temp.path().join("source-logs"))
            .unwrap();
    let mut dest =
        Application::initialize(temp.path().join("dest"), temp.path().join("dest-logs")).unwrap();
    source.secrets = Arc::new(TestStore::default());
    let store = Arc::new(TestStore::default());
    dest.secrets = store.clone();
    let group = |name: &str, parent_id, sort_order| GroupInput {
        name: name.into(),
        parent_id,
        sort_order,
    };
    let source_parent = source
        .group_save(None, group("Production", None, 2))
        .await
        .unwrap();
    let source_folder = source
        .group_save(None, group("Web", Some(source_parent.id), 3))
        .await
        .unwrap();
    let other = dest
        .group_save(None, group("Other", None, 4))
        .await
        .unwrap();
    let dest_folder = dest
        .group_save(None, group("web", Some(other.id), 9))
        .await
        .unwrap();
    let mut backup_host = host_input(AuthType::Password);
    backup_host.group_id = Some(source_folder.id);
    let password = |value: &str| {
        Some(HostAuthenticationInput::Password {
            password: Zeroizing::new(value.to_owned()),
        })
    };
    source
        .host_save(None, backup_host, password("backup-password"))
        .await
        .unwrap();
    let path = temp.path().join("merge.sdhosts");
    source.host_backup_export(path.clone()).await.unwrap();
    assert!(matches!(
        dest.host_backup_import(path.clone()).await,
        Err(Error::Validation("同名文件夹位于不同路径，未导入主机备份"))
    ));
    let before = dest.catalog().await.unwrap();
    assert_eq!(before.groups.len(), 2);
    assert!(before.hosts.is_empty());
    assert!(store.values.lock().unwrap().is_empty());
    assert!(dest.database.pending_secret_gc().unwrap().is_empty());

    let parent = dest
        .group_save(None, group("production", None, 7))
        .await
        .unwrap();
    dest.group_save(
        Some(dest_folder.id.clone()),
        group("web", Some(parent.id.clone()), 9),
    )
    .await
    .unwrap();
    let mut local_host = host_input(AuthType::Password);
    local_host.group_id = Some(dest_folder.id.clone());
    let local = dest
        .host_save(None, local_host, password("local-password"))
        .await
        .unwrap();
    let merged = dest.host_backup_import(path.clone()).await.unwrap();
    assert_eq!(
        (
            merged.hosts,
            merged.groups,
            merged.skipped_hosts,
            merged.reused_groups
        ),
        (1, 0, 0, 2)
    );
    let catalog = dest.catalog().await.unwrap();
    let reused = catalog
        .groups
        .iter()
        .find(|g| g.id == dest_folder.id)
        .unwrap();
    assert_eq!(
        (
            &*reused.name,
            reused.sort_order,
            reused.parent_id.as_deref()
        ),
        ("web", 9, Some(parent.id.as_str()))
    );
    assert_eq!(catalog.hosts.len(), 2);
    assert_eq!(dest.database.host(&local.id).unwrap().config, local.config);
    assert!(
        catalog
            .hosts
            .iter()
            .all(|h| h.config.group_id.as_ref() == Some(&dest_folder.id))
    );
    assert_eq!(store.values.lock().unwrap().len(), 2);
    let repeat = dest.host_backup_import(path).await.unwrap();
    assert_eq!(
        (
            repeat.hosts,
            repeat.groups,
            repeat.skipped_hosts,
            repeat.reused_groups
        ),
        (0, 0, 1, 2)
    );
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
