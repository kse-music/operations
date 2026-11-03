use super::*;
use std::sync::Mutex;
#[derive(Default)]
pub(super) struct Store {
    values: Mutex<std::collections::HashMap<String, Vec<u8>>>,
    unavailable: AtomicBool,
}
impl Store {
    fn check(&self) -> Result<(), Error> {
        if self.unavailable.load(Ordering::Acquire) {
            Err(Error::SecureStore(Box::new(std::io::Error::other(
                "fixture vault unavailable",
            ))))
        } else {
            Ok(())
        }
    }
}
impl SecretStore for Store {
    fn read(&self, id: &str) -> Result<Option<Zeroizing<Vec<u8>>>, Error> {
        self.check()?;
        Ok(self
            .values
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .map(Zeroizing::new))
    }
    fn write(&self, id: &str, value: &[u8]) -> Result<(), Error> {
        self.check()?;
        self.values.lock().unwrap().insert(id.into(), value.into());
        Ok(())
    }
    fn delete(&self, id: &str) -> Result<(), Error> {
        self.check()?;
        self.values.lock().unwrap().remove(id);
        Ok(())
    }
}
fn input(id: &str, question: &str) -> PrepareInput {
    PrepareInput {
        model_id: id.into(),
        session_id: None,
        question: question.into(),
        selection: ContextSelection {
            server: false,
            metrics: false,
            processes: false,
            docker: false,
            log: None,
            log_lines: 100,
        },
        mask_addresses: true,
        redact_values: vec![],
        history: vec![],
        session_ids: vec![],
        auto_hosts: false,
        expected_model_revision: None,
    }
}
fn edit(model: &Model) -> ModelInput {
    ModelInput {
        id: Some(model.id.clone()),
        expected_revision: Some(model.revision.clone()),
        name: model.name.clone(),
        config: model.config.clone(),
        api_key: None,
        clear_key: false,
        test_id: None,
    }
}
pub(super) fn create(name: &str, key: Option<&str>) -> ModelInput {
    ModelInput {
        id: None,
        expected_revision: None,
        name: name.into(),
        config: Config {
            model: format!("fixture-{name}"),
            ..Default::default()
        },
        api_key: key.map(|k| Zeroizing::new(k.into())),
        clear_key: false,
        test_id: None,
    }
}
#[tokio::test]
async fn model_crud_keeps_secrets_independent_and_invalidates_only_its_own_previews() {
    let dir = tempfile::tempdir().unwrap();
    let mut app =
        Application::initialize(dir.path().join("data"), dir.path().join("logs")).unwrap();
    let store = Arc::new(Store::default());
    app.secrets = store.clone();
    let a = tested(&app, create("A", Some("never-store-model-a-key")))
        .await
        .unwrap()
        .value;
    let b = tested(&app, create("B", Some("never-store-model-b-key")))
        .await
        .unwrap()
        .value;
    assert_ne!(a.id, b.id);
    assert_eq!(app.ai_models().await.unwrap().len(), 2);
    assert_eq!(store.values.lock().unwrap().len(), 2);
    let preview_a = app
        .ai_prepare(input(&a.id, "never-store-model-a-key explain"))
        .await
        .unwrap();
    let preview_b = app.ai_prepare(input(&b.id, "second model")).await.unwrap();
    assert_eq!(preview_a.model_id, a.id);
    assert!(!preview_a.body.contains("never-store-model-a-key"));
    assert!(preview_a.body.contains(&a.config.model));
    assert!(!preview_a.body.contains(&b.config.model));
    let mut update = edit(&a);
    update.name = "Renamed A".into();
    let renamed = app.ai_model_save(update).await.unwrap().value;
    assert_eq!(renamed.id, a.id);
    assert_ne!(renamed.revision, a.revision);
    assert!(renamed.has_key);
    assert!(app.assistant.preview_model_id(&preview_a.id).is_err());
    assert_eq!(app.assistant.preview_model_id(&preview_b.id).unwrap(), b.id);
    assert!(matches!(
        app.ai_model_save(edit(&a)).await,
        Err(Error::Conflict)
    ));
    let mut endpoint = edit(&renamed);
    endpoint.config.base_url = "https://another.example/v1".into();
    assert!(app.ai_model_save(endpoint).await.is_err());
    let mut rotated = edit(&renamed);
    rotated.api_key = Some(Zeroizing::new("replacement-a-key".into()));
    let rotated = tested(&app, rotated).await.unwrap().value;
    assert_eq!(store.values.lock().unwrap().len(), 2);
    assert!(
        store
            .values
            .lock()
            .unwrap()
            .values()
            .any(|k| k == b"never-store-model-b-key")
    );
    let exposed = serde_json::to_string(&app.ai_models().await.unwrap()).unwrap();
    assert!(!exposed.contains("secretRef"));
    assert!(!exposed.contains("replacement-a-key"));
    let bytes = std::fs::read(dir.path().join("data/serverdeck.sqlite3")).unwrap();
    for key in [
        b"never-store-model-a-key".as_slice(),
        b"never-store-model-b-key",
        b"replacement-a-key",
    ] {
        assert!(!bytes.windows(key.len()).any(|w| w == key));
    }
    assert!(
        app.ai_model_delete(ModelDeleteInput {
            id: rotated.id.clone(),
            expected_revision: rotated.revision.clone(),
            confirmed: false
        })
        .await
        .is_err()
    );
    assert!(matches!(
        app.ai_model_delete(ModelDeleteInput {
            id: rotated.id.clone(),
            expected_revision: a.revision,
            confirmed: true
        })
        .await,
        Err(Error::Conflict)
    ));
    app.ai_model_delete(ModelDeleteInput {
        id: rotated.id.clone(),
        expected_revision: rotated.revision,
        confirmed: true,
    })
    .await
    .unwrap();
    assert!(matches!(
        app.ai_prepare(input(&rotated.id, "deleted")).await,
        Err(Error::NotFound)
    ));
    assert_eq!(app.ai_models().await.unwrap().len(), 1);
    assert_eq!(store.values.lock().unwrap().len(), 1);
    assert!(app.assistant.preview_model_id(&preview_b.id).is_ok());
    app.shutdown().await;
}
#[tokio::test]
async fn unavailable_vault_preserves_other_modules_and_deletion_has_durable_cleanup() {
    let dir = tempfile::tempdir().unwrap();
    let mut app =
        Application::initialize(dir.path().join("data"), dir.path().join("logs")).unwrap();
    let store = Arc::new(Store::default());
    app.secrets = store.clone();
    let model = tested(&app, create("A", Some("fixture-key")))
        .await
        .unwrap()
        .value;
    store.unavailable.store(true, Ordering::Release);
    assert!(matches!(
        app.ai_prepare(input(&model.id, "test")).await,
        Err(Error::SecureStore(_))
    ));
    assert!(matches!(
        tested(&app, create("B", Some("new-key"))).await,
        Err(Error::SecureStore(_))
    ));
    assert_eq!(app.ai_models().await.unwrap().len(), 1);
    assert!(app.bootstrap().await.is_ok());
    assert!(app.catalog().await.is_ok());
    assert!(app.ops_connections().unwrap().is_empty());
    let removed = app
        .ai_model_delete(ModelDeleteInput {
            id: model.id,
            expected_revision: model.revision,
            confirmed: true,
        })
        .await
        .unwrap();
    assert!(!removed.warnings.is_empty());
    assert!(app.ai_models().await.unwrap().is_empty());
    assert!(!app.database.pending_secret_gc().unwrap().is_empty());
    store.unavailable.store(false, Ordering::Release);
    app.cleanup_secrets().await.unwrap();
    assert!(store.values.lock().unwrap().is_empty());
    app.shutdown().await;
}
#[tokio::test]
async fn explicit_scope_and_model_identity_are_required() {
    let dir = tempfile::tempdir().unwrap();
    let mut app =
        Application::initialize(dir.path().join("data"), dir.path().join("logs")).unwrap();
    app.secrets = Arc::new(Store::default());
    // Seed an existing legacy model without credentials; new registrations require a test.
    let without_key = app
        .database
        .ai_model_save(
            ModelRecord {
                id: "legacy-no-key".into(),
                name: "No Key".into(),
                config: create("No Key", None).config,
                secret_ref: None,
                revision: "legacy-r1".into(),
            },
            None,
        )
        .unwrap()
        .public();
    assert!(!without_key.has_key);
    assert!(
        app.ai_prepare(input(&without_key.id, "test"))
            .await
            .is_err()
    );
    assert!(matches!(
        app.ai_prepare(input("forged", "test")).await,
        Err(Error::NotFound)
    ));
    for field in ["server", "metrics", "processes", "docker", "log"] {
        let mut request = input(&without_key.id, "test");
        match field {
            "server" => request.selection.server = true,
            "metrics" => request.selection.metrics = true,
            "processes" => request.selection.processes = true,
            "docker" => request.selection.docker = true,
            _ => {
                request.selection.log = Some(serverdeck_core::ops::LogSource::File {
                    path: "/var/log/syslog".into(),
                })
            }
        }
        assert!(matches!(
            app.ai_prepare(request).await,
            Err(Error::Validation(_))
        ));
    }
    assert!(matches!(
        app.ai_send("forged".into(), false).await,
        Err(Error::Validation(_))
    ));
    assert!(
        app.ai_execute(ExecuteInput {
            proposal_id: "forged".into(),
            confirmed: true,
            change_confirmation: None
        })
        .await
        .is_err()
    );
    app.shutdown().await;
}

async fn tested(app: &Application, mut input: ModelInput) -> Result<Mutation<Model>, Error> {
    let (config, http) = super::protocol_tests::model_requests(1).await;
    input.config.base_url = config.base_url;
    input.config.allow_insecure_http = true;
    input.test_id = Some(app.ai_model_test(clone_model_input(&input)).await?.id);
    http.await.unwrap();
    app.ai_model_save(input).await
}

#[tokio::test]
async fn registration_test_is_required_bound_to_configuration_and_key_and_single_use() {
    let dir = tempfile::tempdir().unwrap();
    let mut app =
        Application::initialize(dir.path().join("data"), dir.path().join("logs")).unwrap();
    let store = Arc::new(Store::default());
    app.secrets = store.clone();
    let (config, http) = super::protocol_tests::model_requests(4).await;
    let mut input = create("Tested", Some("fixture-test-key"));
    input.config = config;
    assert!(app.ai_model_save(clone_model_input(&input)).await.is_err());
    assert!(app.ai_models().await.unwrap().is_empty());
    assert!(store.values.lock().unwrap().is_empty());
    input.test_id = Some(
        app.ai_model_test(clone_model_input(&input))
            .await
            .unwrap()
            .id,
    );
    let mut changed = clone_model_input(&input);
    changed.config.model = "changed-model".into();
    assert!(app.ai_model_save(changed).await.is_err());
    // A mismatched/replayed receipt cannot authorize registration.
    assert!(app.ai_model_save(clone_model_input(&input)).await.is_err());
    input.test_id = Some(
        app.ai_model_test(clone_model_input(&input))
            .await
            .unwrap()
            .id,
    );
    let mut changed = clone_model_input(&input);
    changed.api_key = Some(Zeroizing::new("different-key".into()));
    assert!(app.ai_model_save(changed).await.is_err());
    input.test_id = Some(
        app.ai_model_test(clone_model_input(&input))
            .await
            .unwrap()
            .id,
    );
    let saved = app
        .ai_model_save(clone_model_input(&input))
        .await
        .unwrap()
        .value;
    assert!(app.ai_model_save(input).await.is_err());
    let mut update = edit(&saved);
    update.config.max_output_tokens += 1;
    assert!(app.ai_model_save(clone_model_input(&update)).await.is_err());
    update.test_id = Some(
        app.ai_model_test(clone_model_input(&update))
            .await
            .unwrap()
            .id,
    );
    assert!(app.ai_model_save(update).await.is_ok());
    let request = http.await.unwrap();
    assert_eq!(request["messages"].as_array().unwrap().len(), 1);
    assert_eq!(
        request["messages"][0]["content"],
        "ServerDeck connection test. Reply OK."
    );
    assert_eq!(request["max_completion_tokens"], 256);
    assert_eq!(request["store"], false);
    assert!(request.get("tools").is_none());
    app.shutdown().await;
}

async fn asset(app: &Application, name: &str, address: &str) -> serverdeck_core::hosts::Host {
    app.host_create(serde_json::from_value(json!({"name":name,"hostname":address,"port":22,"username":"ops","authType":"agent","credentialId":null,"groupId":null,"tags":[],"description":"","favorite":false,"connectTimeoutSecs":1})).unwrap()).await.unwrap()
}
fn route_input(model: &Model, question: &str) -> ResolveHostsInput {
    ResolveHostsInput {
        model_id: model.id.clone(),
        request_id: uuid::Uuid::new_v4().to_string(),
        question: question.into(),
        previous_host_ids: vec![],
        mask_addresses: true,
        redact_values: vec![],
    }
}
#[tokio::test]
async fn local_asset_resolution_uses_the_registered_inventory_without_model_or_ssh_calls() {
    let dir = tempfile::tempdir().unwrap();
    let mut app =
        Application::initialize(dir.path().join("data"), dir.path().join("logs")).unwrap();
    app.secrets = Arc::new(Store::default());
    let model = tested(&app, create("local-route", Some("fixture-key")))
        .await
        .unwrap()
        .value;
    let a = asset(&app, "web-a", "10.0.0.1").await;
    let b = asset(&app, "web-b", "10.0.0.10").await;
    let resolved = app
        .ai_resolve_hosts(route_input(&model, "web-a的状态"))
        .await
        .unwrap();
    assert_eq!(resolved.host_ids, vec![a.id]);
    assert_eq!(resolved.model_revision, model.revision);
    let all = app
        .ai_resolve_hosts(route_input(&model, "全部服务器的负载"))
        .await
        .unwrap();
    assert_eq!(all.host_ids.len(), 2);
    assert!(all.host_ids.contains(&b.id));
    assert!(
        app.ai_resolve_hosts(route_input(&model, "有哪些服务器"))
            .await
            .unwrap()
            .host_ids
            .is_empty()
    );
    let mut request = input(&model.id, "inventory");
    request.auto_hosts = true;
    request.expected_model_revision = Some("stale".into());
    assert!(matches!(
        app.ai_prepare(request).await,
        Err(Error::Conflict)
    ));
    assert!(app.ops_connections().unwrap().is_empty());
    app.shutdown().await;
}
#[tokio::test]
async fn semantic_asset_routing_redacts_metadata_and_rejects_invented_ids() {
    for forged in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let mut app =
            Application::initialize(dir.path().join("data"), dir.path().join("logs")).unwrap();
        app.secrets = Arc::new(Store::default());
        let host = asset(&app, "database", "10.2.3.4").await;
        let reply =
            json!({"hostIds":[if forged {"invented"} else {&host.id}],"message":""}).to_string();
        let (config, http) = super::protocol_tests::model_requests_reply(2, reply).await;
        let mut registration = create("semantic-route", Some("route-model-secret"));
        registration.config = config;
        registration.test_id = Some(
            app.ai_model_test(clone_model_input(&registration))
                .await
                .unwrap()
                .id,
        );
        let model = app.ai_model_save(registration).await.unwrap().value;
        let resolved = app
            .ai_resolve_hosts(route_input(&model, "生产服务异常，route-model-secret"))
            .await;
        if forged {
            assert!(matches!(resolved, Err(Error::Validation(_))));
        } else {
            assert_eq!(resolved.unwrap().host_ids, vec![host.id]);
        }
        let request = http.await.unwrap();
        assert!(request.get("tools").is_none());
        assert_eq!(request["store"], false);
        let payload = request.to_string();
        assert!(!payload.contains("route-model-secret"));
        assert!(!payload.contains("10.2.3.4"));
        assert!(!payload.contains("credentialId"));
        assert!(!payload.contains("keyPath"));
        assert!(!payload.contains("secretRef"));
        assert!(app.ops_connections().unwrap().is_empty());
        app.shutdown().await;
    }
}
