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
#[test]
fn managed_tool_login_hint_uses_a_quoted_native_executable_without_requiring_path() {
    let message = local_login_hint(
        Provider::LocalCodex,
        std::path::Path::new(r"\\?\C:\Tools\O'Brien\codex.exe"),
    );
    assert!(message.contains(r"& 'C:\Tools\O''Brien\codex.exe' login"));
    let message = local_login_hint(
        Provider::LocalClaudeCode,
        std::path::Path::new(r"\\?\UNC\server\tools\claude.exe"),
    );
    assert!(message.contains(r"& '\\server\tools\claude.exe' auth login"));
}

#[tokio::test]
async fn local_sources_require_platform_consent_and_revocation_cancels_only_that_source() {
    let dir = tempfile::tempdir().unwrap();
    let app = Application::initialize(dir.path().join("data"), dir.path().join("logs")).unwrap();
    for id in [LOCAL_CODEX_MODEL_ID, LOCAL_CLAUDE_CODE_MODEL_ID] {
        let error = app.ai_credentials(id.into()).await.err().unwrap();
        assert!(matches!(
            serverdeck_core::IpcError::from(error).code,
            "AI_CODEX_CONSENT" | "AI_CLAUDE_CONSENT"
        ));
        app.ai_local_authorize(id, true).await.unwrap();
    }
    let codex = app.models_runtime.begin(LOCAL_CODEX_MODEL_ID).unwrap();
    let claude = app
        .models_runtime
        .begin(LOCAL_CLAUDE_CODE_MODEL_ID)
        .unwrap();
    app.ai_local_claude_code_authorize(false).await.unwrap();
    assert!(claude.cancel.is_cancelled());
    assert!(!codex.cancel.is_cancelled());
    assert!(app.database.ai_local_codex_consent().unwrap().authorized);
    assert!(
        app.ai_credentials(LOCAL_CLAUDE_CODE_MODEL_ID.into())
            .await
            .is_err()
    );
    app.ai_local_codex_authorize(false).await.unwrap();
    assert!(codex.cancel.is_cancelled());
    assert!(
        app.ai_credentials(LOCAL_CODEX_MODEL_ID.into())
            .await
            .is_err()
    );
    drop(codex);
    drop(claude);
    app.shutdown().await;
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
async fn model_crud_keeps_secrets_independent_and_cancels_only_its_own_platform_calls() {
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
    assert!(
        a.created_at
            .as_deref()
            .is_some_and(|time| time.ends_with('Z'))
    );
    assert_eq!(app.ai_models().await.unwrap()[0].created_at, a.created_at);
    assert_eq!(app.ai_models().await.unwrap().len(), 2);
    assert_eq!(store.values.lock().unwrap().len(), 2);
    let call_a = app.models_runtime.begin(&a.id).unwrap();
    let call_b = app.models_runtime.begin(&b.id).unwrap();
    assert_eq!(
        app.ai_credentials(a.id.clone())
            .await
            .unwrap()
            .0
            .config
            .model,
        a.config.model
    );
    let mut update = edit(&a);
    update.name = "Renamed A".into();
    let renamed = app.ai_model_save(update).await.unwrap().value;
    assert_eq!(renamed.id, a.id);
    assert_ne!(renamed.revision, a.revision);
    assert_eq!(renamed.created_at, a.created_at);
    assert!(renamed.has_key);
    assert!(call_a.cancel.is_cancelled());
    assert!(!call_b.cancel.is_cancelled());
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
        app.ai_credentials(rotated.id.clone()).await,
        Err(Error::NotFound)
    ));
    assert_eq!(app.ai_models().await.unwrap().len(), 1);
    assert_eq!(store.values.lock().unwrap().len(), 1);
    assert!(!call_b.cancel.is_cancelled());
    drop(call_a);
    drop(call_b);
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
        app.ai_credentials(model.id.clone()).await,
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
async fn tested(app: &Application, mut input: ModelInput) -> Result<Mutation<Model>, Error> {
    let (config, http) = super::model_fixture::model_requests(1).await;
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
    let (config, http) = super::model_fixture::model_requests(4).await;
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
