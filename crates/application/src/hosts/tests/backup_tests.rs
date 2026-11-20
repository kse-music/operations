use super::*;
use russh::keys::{Algorithm, HashAlg, PrivateKey, ssh_key::LineEnding};
use serverdeck_core::connection::{ProxyKind, ProxySettings};

fn tag_input(name: &str, color: EnvironmentTagColor) -> EnvironmentTagInput {
    EnvironmentTagInput {
        name: name.into(),
        color,
    }
}

#[tokio::test]
async fn host_backup_restores_the_complete_tag_catalog_and_each_hosts_assignment() {
    let temp = tempfile::tempdir().unwrap();
    let mut source =
        Application::initialize(temp.path().join("source"), temp.path().join("logs")).unwrap();
    source.secrets = Arc::new(TestStore::default());
    use EnvironmentTagColor::{Blue, Green, Violet};
    source
        .environment_tag_save(Some("production".into()), tag_input("生产", Green))
        .await
        .unwrap();
    source
        .environment_tag_delete("staging".into())
        .await
        .unwrap();
    source
        .environment_tag_save(None, tag_input("闲置标签", Violet))
        .await
        .unwrap();
    let mut original_ids = Vec::new();
    for tag_id in [Some("production"), Some("testing"), None] {
        let host = source
            .host_save(None, host_input(AuthType::Agent), None)
            .await
            .unwrap();
        original_ids.push(host.id.clone());
        if let Some(tag_id) = tag_id {
            source
                .host_set_environment_tag(host.id, Some(tag_id.into()))
                .await
                .unwrap();
        }
    }
    let path = temp.path().join("tagged.sdhosts");
    source.host_backup_export(path.clone()).await.unwrap();
    let bytes = std::fs::read(&path).unwrap();
    let json: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(json["version"], 2);
    assert_eq!(json["environmentTags"]["tags"].as_array().unwrap().len(), 3);
    assert_eq!(
        json["environmentTags"]["assignments"]
            .as_array()
            .unwrap()
            .len(),
        2
    );

    let mut dest =
        Application::initialize(temp.path().join("dest"), temp.path().join("logs")).unwrap();
    dest.secrets = Arc::new(TestStore::default());
    for (hosts, skipped) in [(3, 0), (0, 3)] {
        let result = dest.host_backup_import(path.clone()).await.unwrap();
        assert_eq!((result.hosts, result.skipped_hosts), (hosts, skipped));
        let restored = dest.catalog().await.unwrap();
        let tags = &restored.environment_tags;
        let definitions: Vec<_> = tags
            .tags
            .iter()
            .map(|tag| (tag.name.as_str(), tag.color))
            .collect();
        assert_eq!(
            definitions,
            [("生产", Green), ("测试", Blue), ("闲置标签", Violet)]
        );
        assert_eq!(restored.hosts.len(), 3);
        let mut applied: Vec<_> = restored
            .hosts
            .iter()
            .map(|host| {
                assert!(!original_ids.contains(&host.id));
                tags.assignments.get(&host.id).map(|id| id.as_str())
            })
            .collect();
        applied.sort_unstable();
        assert_eq!(applied, [None, Some("production"), Some("testing")]);
    }
}

#[tokio::test]
async fn host_backup_merges_tag_definitions_and_fills_only_unassigned_hosts() {
    let temp = tempfile::tempdir().unwrap();
    let mut source =
        Application::initialize(temp.path().join("source"), temp.path().join("logs")).unwrap();
    let mut dest =
        Application::initialize(temp.path().join("dest"), temp.path().join("logs")).unwrap();
    source.secrets = Arc::new(TestStore::default());
    dest.secrets = Arc::new(TestStore::default());
    use EnvironmentTagColor::{Blue, Green, Violet};
    let source_tags = source
        .environment_tag_save(None, tag_input("Release", Violet))
        .await
        .unwrap();
    let local_tags = dest
        .environment_tag_save(None, tag_input("release", Green))
        .await
        .unwrap();
    let source_id = source_tags.tags.last().unwrap().id.clone();
    let local_id = local_tags.tags.last().unwrap().id.clone();
    assert_ne!(local_id, source_id);
    let mut reused = Vec::new();
    for hostname in ["unassigned.example", "local-tag.example"] {
        let input = HostInput {
            hostname: hostname.into(),
            ..host_input(AuthType::Agent)
        };
        let from_backup = source.host_save(None, input.clone(), None).await.unwrap();
        source
            .host_set_environment_tag(from_backup.id, Some(source_id.clone()))
            .await
            .unwrap();
        reused.push(dest.host_save(None, input, None).await.unwrap().id);
    }
    dest.host_set_environment_tag(reused[1].clone(), Some("testing".into()))
        .await
        .unwrap();
    source
        .environment_tag_save(None, tag_input("备用", Blue))
        .await
        .unwrap();
    let path = temp.path().join("merge-tags.sdhosts");
    source.host_backup_export(path.clone()).await.unwrap();

    assert!(matches!(
        dest.host_backup_import(path.clone()).await,
        Err(Error::Validation(
            "本机有同名异色的环境标签，请先调整标签名称或颜色再导入"
        ))
    ));
    let unchanged = dest.catalog().await.unwrap().environment_tags;
    assert_eq!(unchanged.tags.len(), 4);
    assert_eq!(unchanged.tags.last().unwrap().color, Green);
    assert_eq!(unchanged.assignments.len(), 1);
    assert_eq!(unchanged.assignments[&reused[1]], "testing");

    dest.environment_tag_save(Some(local_id.clone()), tag_input("release", Violet))
        .await
        .unwrap();
    let result = dest.host_backup_import(path).await.unwrap();
    assert_eq!((result.hosts, result.skipped_hosts), (0, 2));
    let merged = dest.catalog().await.unwrap();
    assert_eq!(merged.hosts.len(), 2);
    let tags = merged.environment_tags;
    assert_eq!(tags.tags.len(), 5);
    assert_eq!(
        tags.tags
            .iter()
            .find(|tag| tag.id == local_id)
            .unwrap()
            .name,
        "release"
    );
    assert_eq!(tags.assignments[&reused[0]], local_id);
    assert_eq!(tags.assignments[&reused[1]], "testing");
}

#[tokio::test]
async fn host_backup_imports_v1_without_changing_local_tags() {
    let temp = tempfile::tempdir().unwrap();
    let mut dest =
        Application::initialize(temp.path().join("dest"), temp.path().join("logs")).unwrap();
    dest.secrets = Arc::new(TestStore::default());
    dest.environment_tag_save(
        Some("production".into()),
        tag_input("本机生产", EnvironmentTagColor::Green),
    )
    .await
    .unwrap();
    let local = dest
        .host_save(None, host_input(AuthType::Agent), None)
        .await
        .unwrap();
    assert_eq!(local.config.hostname, "example.com");
    dest.host_set_environment_tag(local.id.clone(), Some("production".into()))
        .await
        .unwrap();
    let path = temp.path().join("v1.sdhosts");
    // Historical v1 file shape, independent of the current exporter.
    std::fs::write(
        &path,
        r#"{
        "format": "serverdeck-hosts",
        "version": 1,
        "directory": {
            "groups": [],
            "hosts": [{
                "id": "1f85926b-bdfc-4f2b-94e0-e9b8aeaf04ee",
                "config": {
                    "name": "Legacy host",
                    "hostname": "legacy.example",
                    "port": 2222,
                    "username": "ops",
                    "authType": "agent",
                    "credentialId": null,
                    "groupId": null,
                    "description": "",
                    "favorite": true,
                    "connectTimeoutSecs": 15
                }
            }],
            "credentials": [],
            "trustedKeys": []
        }
    }"#,
    )
    .unwrap();

    let result = dest.host_backup_import(path).await.unwrap();
    assert_eq!((result.hosts, result.agent_hosts), (1, 1));
    let catalog = dest.catalog().await.unwrap();
    let host = catalog
        .hosts
        .iter()
        .find(|host| host.config.favorite)
        .unwrap();
    assert_eq!(host.config.hostname, "legacy.example");
    assert_eq!(host.config.port, 2222);
    assert_eq!(catalog.environment_tags.tags[0].name, "本机生产");
    assert_eq!(
        catalog.environment_tags.tags[0].color,
        EnvironmentTagColor::Green
    );
    assert_eq!(catalog.environment_tags.assignments.len(), 1);
    assert_eq!(
        catalog.environment_tags.assignments[&local.id],
        "production"
    );
}

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
    let tags = source
        .environment_tag_save(None, tag_input("隔离", EnvironmentTagColor::Gray))
        .await
        .unwrap();
    let tag_id = tags.tags.last().unwrap().id.clone();
    for hostname in ["one.example", "two.example"] {
        let input = HostInput {
            hostname: hostname.into(),
            ..host_input(AuthType::Password)
        };
        let host = source
            .host_save(
                None,
                input,
                Some(HostAuthenticationInput::Password {
                    password: Zeroizing::new("fixture".into()),
                }),
            )
            .await
            .unwrap();
        source
            .host_set_environment_tag(host.id, Some(tag_id.clone()))
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
    let original_tags =
        serde_json::to_value(dest.catalog().await.unwrap().environment_tags).unwrap();
    assert!(matches!(
        dest.host_backup_import(path.clone()).await,
        Err(Error::SecureStore(_))
    ));
    let catalog = dest.catalog().await.unwrap();
    assert!(catalog.hosts.is_empty());
    assert_eq!(
        serde_json::to_value(catalog.environment_tags).unwrap(),
        original_tags
    );
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
            3.into()
        } else {
            "unknown".into()
        };
        std::fs::write(&path, serde_json::to_vec(&bad).unwrap()).unwrap();
        assert!(dest.host_backup_import(path.clone()).await.is_err());
        assert!(dest.catalog().await.unwrap().hosts.is_empty());
    }
    let mut invalid_tags = json.clone();
    invalid_tags["environmentTags"]["assignments"][0]["tagId"] = "missing".into();
    let mut invalid_host = json.clone();
    invalid_host["environmentTags"]["assignments"][0]["hostId"] = "missing".into();
    let mut duplicate = json.clone();
    let assignments = duplicate["environmentTags"]["assignments"]
        .as_array_mut()
        .unwrap();
    assignments.push(assignments[0].clone());
    for invalid in [invalid_tags, invalid_host, duplicate] {
        std::fs::write(&path, serde_json::to_vec(&invalid).unwrap()).unwrap();
        assert!(matches!(
            dest.host_backup_import(path.clone()).await,
            Err(Error::Validation("备份中的环境标签分配无效或重复"))
        ));
        let catalog = dest.catalog().await.unwrap();
        assert!(catalog.hosts.is_empty());
        assert_eq!(
            serde_json::to_value(catalog.environment_tags).unwrap(),
            original_tags
        );
    }
    let mut missing_tags = json.clone();
    missing_tags
        .as_object_mut()
        .unwrap()
        .remove("environmentTags");
    let mut null_tags = json.clone();
    null_tags["environmentTags"] = serde_json::Value::Null;
    let mut invalid_v1_tags = json;
    invalid_v1_tags["version"] = 1.into();
    for invalid in [missing_tags, null_tags, invalid_v1_tags] {
        std::fs::write(&path, serde_json::to_vec(&invalid).unwrap()).unwrap();
        assert!(dest.host_backup_import(path.clone()).await.is_err());
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
    let restored = fresh.catalog().await.unwrap().environment_tags;
    assert_eq!(restored.assignments.len(), 2);
    assert!(restored.assignments.values().all(|id| id == &tag_id));
}
