use super::*;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use serverdeck_plugin_core::{
    Entry, Package, Permission,
    permissions::{GrantInput, OPERATIONS},
};
use serverdeck_plugin_sdk::{
    Capability, Request,
    platform::{Command, Request as Primitive},
};
use serverdeck_security::SecretStore;
use std::{
    collections::HashMap,
    sync::Mutex,
    time::{Duration, Instant},
};
use zeroize::Zeroizing;
mod ssh_tests;

#[tokio::test]
#[ignore = "requires an independently built package and explicit QA action/expected result"]
async fn independently_built_package_imports_and_runs_through_the_same_native_platform() {
    let fixture = Fixture::new();
    let path = std::path::PathBuf::from(std::env::var("SERVERDECK_EXTERNAL_PLUGIN").unwrap());
    let plugin = fixture
        .app
        .plugin_install(InstallInput {
            path,
            development_confirmed: true,
            expected_version: None,
            expected_digest: None,
        })
        .await
        .unwrap();
    let id = plugin.manifest.id.clone();
    assert!(!plugin.enabled);
    assert_eq!(
        plugin.source,
        serverdeck_plugin_core::repository::PluginSource::User
    );
    assert!(
        fixture
            .app
            .plugin_permissions(id.clone())
            .await
            .unwrap()
            .is_none()
    );
    fixture.grant(&plugin).await;
    assert_eq!(
        fixture
            .app
            .plugin_ui(id.clone(), plugin.revision)
            .await
            .unwrap()
            .ui_version,
        4
    );
    let action = std::env::var("SERVERDECK_EXTERNAL_ACTION").unwrap();
    let input: Value =
        serde_json::from_str(&std::env::var("SERVERDECK_EXTERNAL_INPUT").unwrap()).unwrap();
    let reply = fixture
        .app
        .plugin_call_scoped(&id, "external-qa", json!({"action":action,"input":input}))
        .await
        .unwrap();
    if let Ok(code) = std::env::var("SERVERDECK_EXTERNAL_ERROR") {
        assert_eq!(reply.error.unwrap().code, code);
    } else {
        assert!(reply.error.is_none());
        let expected: Value =
            serde_json::from_str(&std::env::var("SERVERDECK_EXTERNAL_EXPECTED").unwrap()).unwrap();
        assert_eq!(reply.result, expected);
    }
    fixture
        .app
        .plugin_close_scope(&id, "external-qa")
        .await
        .unwrap();
    fixture.app.shutdown().await;
}
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
struct Fixture {
    dir: tempfile::TempDir,
    app: Application,
}
impl Fixture {
    fn new() -> Self {
        let root =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../.local/qa/sdk-platform");
        std::fs::create_dir_all(&root).unwrap();
        let dir = tempfile::Builder::new()
            .prefix("host-")
            .tempdir_in(root)
            .unwrap();
        let mut app =
            Application::initialize(dir.path().join("data"), dir.path().join("logs")).unwrap();
        app.secrets = Arc::new(Vault::default());
        Self { dir, app }
    }
    async fn install(&self, id: &str) -> InstalledPlugin {
        let manifest = Manifest {
            schema_version: 1,
            id: id.into(),
            name: "Independent fixture".into(),
            icon: None,
            version: "1.0.0".into(),
            author: "Tests".into(),
            description: "Test-only platform boundary".into(),
            api_version: "^5.0.0".into(),
            entry: Entry {
                backend: None,
                ui: None,
            },
            permissions: permissions(),
            preapproved_commands: vec![],
            contributions: vec![],
            platforms: vec![std::env::consts::OS.into()],
            files: vec![],
            publisher: None,
        };
        let path = self.dir.path().join(format!("{id}.sdplugin"));
        std::fs::write(
            &path,
            serde_json::to_vec(&Package {
                format_version: 1,
                manifest,
                files: vec![],
            })
            .unwrap(),
        )
        .unwrap();
        self.app
            .plugin_install(InstallInput {
                path,
                development_confirmed: true,
                expected_version: None,
                expected_digest: None,
            })
            .await
            .unwrap()
    }
    async fn grant(&self, plugin: &InstalledPlugin) {
        self.app
            .plugin_grant(
                plugin.manifest.id.clone(),
                GrantInput {
                    expected_revision: plugin.revision.clone(),
                    permissions: plugin.manifest.permissions.clone(),
                    operations: OPERATIONS.iter().map(|value| value.to_string()).collect(),
                    read_roots: vec!["/etc/fixture".into()],
                    write_roots: vec!["/etc/fixture".into()],
                    confirmed: true,
                },
            )
            .await
            .unwrap();
        self.app
            .plugin_set_enabled(plugin.manifest.id.clone(), true)
            .await
            .unwrap();
    }
    async fn wasm(&self) -> String {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../tests/fixtures/plugins/server-capabilities/server-capabilities.sdplugin")
            .canonicalize()
            .unwrap();
        let plugin = self
            .app
            .plugin_install(InstallInput {
                path,
                development_confirmed: true,
                expected_version: None,
                expected_digest: None,
            })
            .await
            .unwrap();
        self.grant(&plugin).await;
        plugin.manifest.id
    }
}
fn permissions() -> Vec<Permission> {
    vec![
        Permission::UiContribute,
        Permission::HostsRead,
        Permission::SshExecute,
        Permission::SftpRead,
        Permission::SftpWrite,
        Permission::SettingsRead,
        Permission::SettingsWrite,
        Permission::NetworkConnect,
        Permission::ModelsUse,
    ]
}
fn cap(request: Primitive) -> Capability {
    Capability::Platform {
        request,
        bindings: vec![],
    }
}
fn request(operation: Capability) -> Request {
    Request {
        api_version: 1,
        request_id: uuid::Uuid::new_v4().to_string(),
        operation,
    }
}
async fn call(
    app: &Application,
    id: &str,
    owner: &str,
    operation: Primitive,
) -> serverdeck_plugin_sdk::Response {
    app.plugin_capability_scoped(id, owner, request(cap(operation)))
        .await
        .unwrap()
}

#[tokio::test]
async fn default_deny_revision_bound_grants_public_metadata_and_revocation() {
    let fixture = Fixture::new();
    let app = &fixture.app;
    let plugin = fixture.install("dev.boundary").await;
    app.plugin_set_enabled(plugin.manifest.id.clone(), true)
        .await
        .unwrap();
    let denied = call(app, &plugin.manifest.id, "page", Primitive::Hosts).await;
    assert_eq!(denied.error.unwrap().code, "PLUGIN_PERMISSION_DENIED");
    fixture.grant(&plugin).await;
    let host = app
        .database
        .host_create(serverdeck_core::hosts::HostInput {
            name: "fixture-host".into(),
            hostname: "127.0.0.1".into(),
            port: 2222,
            username: "ops".into(),
            auth_type: serverdeck_core::hosts::AuthType::Agent,
            credential_id: None,
            group_id: None,
            description: "fixture".into(),
            favorite: false,
            connect_timeout_secs: 3,
            ssh: Default::default(),
        })
        .unwrap();
    let response = call(app, &plugin.manifest.id, "page", Primitive::Hosts).await;
    assert!(response.error.is_none());
    assert_eq!(response.result["hosts"][0]["id"], host.id);
    let text = response.result.to_string();
    for field in ["credentialId", "privateKey", "authType", "proxy", "ssh"] {
        assert!(!text.contains(field));
    }
    let closed = call(
        app,
        &plugin.manifest.id,
        "page",
        Primitive::Execute {
            host_id: host.id,
            command: Command::new("uname").arg("-a"),
        },
    )
    .await;
    assert_eq!(closed.error.unwrap().code, "PLUGIN_SESSION_CLOSED");
    let mut stale = app
        .plugin_permissions(plugin.manifest.id.clone())
        .await
        .unwrap()
        .unwrap();
    stale.revision = "forged-revision".into();
    assert!(!stale.matches(&app.plugin_detail(plugin.manifest.id.clone()).await.unwrap()));
    app.plugin_revoke(plugin.manifest.id.clone()).await.unwrap();
    assert!(
        app.plugin_permissions(plugin.manifest.id.clone())
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        app.plugin_capability_scoped(&plugin.manifest.id, "page", request(cap(Primitive::Hosts)))
            .await
            .is_err()
    );
    app.shutdown().await;
}
#[tokio::test]
async fn settings_are_persistent_confined_and_no_unverified_host_is_executed() {
    let fixture = Fixture::new();
    let a = fixture.install("dev.settings-a").await;
    let b = fixture.install("dev.settings-b").await;
    fixture.grant(&a).await;
    fixture.grant(&b).await;
    let value = json!({"note":"本地插件设置"});
    assert!(
        call(
            &fixture.app,
            &a.manifest.id,
            "page",
            Primitive::SettingsWrite {
                value: value.clone()
            }
        )
        .await
        .error
        .is_none()
    );
    assert_eq!(
        call(
            &fixture.app,
            &a.manifest.id,
            "page",
            Primitive::SettingsRead
        )
        .await
        .result,
        value
    );
    assert_eq!(
        call(
            &fixture.app,
            &b.manifest.id,
            "page",
            Primitive::SettingsRead
        )
        .await
        .result,
        json!({})
    );
    fixture.app.shutdown().await;
    let restarted = Application::initialize(
        fixture.dir.path().join("data"),
        fixture.dir.path().join("logs"),
    )
    .unwrap();
    assert_eq!(
        call(&restarted, &a.manifest.id, "page", Primitive::SettingsRead)
            .await
            .result,
        value
    );
    restarted.shutdown().await;
}
#[tokio::test]
async fn confirmation_is_frozen_to_request_owner_generation_and_profile_and_single_use() {
    let fixture = Fixture::new();
    let plugin = fixture.install("dev.approval").await;
    fixture.grant(&plugin).await;
    let app = &fixture.app;
    let current = app.plugin_detail(plugin.manifest.id.clone()).await.unwrap();
    let call = app
        .plugin_host
        .start_scoped(&plugin.manifest.id, "page-a")
        .unwrap();
    let operation = cap(Primitive::Execute {
        host_id: "host".into(),
        command: Command::new("uname").arg("-a"),
    });
    let first = app
        .plugin_confirmation_bound(
            &call,
            &current,
            &operation,
            Some("profile-a"),
            Some("ops@fixture:22"),
        )
        .unwrap()
        .unwrap();
    assert!(first.description.contains("uname"));
    app.plugin_approve(&first.id, true).unwrap();
    assert!(
        app.plugin_confirmation_bound(
            &call,
            &current,
            &operation,
            Some("profile-b"),
            Some("ops@fixture:22")
        )
        .unwrap()
        .is_some()
    );
    assert!(
        app.plugin_confirmation_bound(
            &call,
            &current,
            &operation,
            Some("profile-a"),
            Some("ops@fixture:22")
        )
        .unwrap()
        .is_none()
    );
    assert!(
        app.plugin_confirmation_bound(
            &call,
            &current,
            &operation,
            Some("profile-a"),
            Some("ops@fixture:22")
        )
        .unwrap()
        .is_some()
    );
    drop(call);
    let call = app
        .plugin_host
        .start_scoped(&plugin.manifest.id, "page-b")
        .unwrap();
    let pending = app
        .plugin_confirmation_bound(
            &call,
            &current,
            &operation,
            Some("profile-a"),
            Some("ops@fixture:22"),
        )
        .unwrap()
        .unwrap();
    app.plugin_host
        .lock()
        .unwrap()
        .approvals
        .get_mut(&pending.id)
        .unwrap()
        .at = Instant::now() - Duration::from_secs(61);
    let error = serverdeck_core::IpcError::from(app.plugin_approve(&pending.id, true).unwrap_err());
    assert_eq!(error.code, "PLUGIN_CONFIRMATION_EXPIRED");
    assert!(error.message.contains("重新点击原操作"));
    assert!(app.plugin_approve(&pending.id, true).is_err());
    app.plugin_approve(&pending.id, false).unwrap();
    drop(call);
    app.shutdown().await;
}
#[tokio::test]
async fn native_approval_continues_the_original_wasm_future_and_decline_reaches_cleanup() {
    let fixture = Fixture::new();
    let id = fixture.wasm().await;
    let app = &fixture.app;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let initial=app.plugin_call_scoped(&id,"page",json!({"action":"pipeline","input":{"first":{"stage":1},"target":"127.0.0.1","port":port}})).await.unwrap();
    assert_eq!(initial.error.unwrap().code, "PLUGIN_CONFIRMATION_REQUIRED");
    let token = initial.result["continuation"].as_str().unwrap().to_owned();
    let approval = initial.result["id"].as_str().unwrap();
    let marker = json!({"stage":"changed while reviewing"});
    call(
        app,
        &id,
        "page",
        Primitive::SettingsWrite {
            value: marker.clone(),
        },
    )
    .await;
    assert!(
        app.plugin_continue(&id, "wrong-page", &token, false)
            .await
            .is_err()
    );
    app.plugin_approve(approval, true).unwrap();
    let result = app
        .plugin_continue(&id, "page", &token, false)
        .await
        .unwrap();
    assert!(result.error.is_none());
    assert_eq!(result.result["connected"]["reachable"], true);
    tokio::time::timeout(Duration::from_secs(1), listener.accept())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        call(app, &id, "page", Primitive::SettingsRead).await.result,
        marker,
        "an approved continuation must not replay the initial settings write"
    );
    assert!(
        app.plugin_continue(&id, "page", &token, false)
            .await
            .is_err()
    );
    let pending = app
        .plugin_call_scoped(
            &id,
            "page",
            json!({"action":"pipeline","input":{"first":{},"target":"127.0.0.1","port":port}}),
        )
        .await
        .unwrap();
    let token = pending.result["continuation"].as_str().unwrap();
    app.plugin_approve(pending.result["id"].as_str().unwrap(), false)
        .unwrap();
    let result = app.plugin_continue(&id, "page", token, true).await.unwrap();
    assert_eq!(result.result["cancelled"], true);
    assert!(
        tokio::time::timeout(Duration::from_millis(100), listener.accept())
            .await
            .is_err()
    );
    app.shutdown().await;
}
#[tokio::test]
async fn chunk_results_are_bounded_owned_expiring_and_owner_cleanup_is_independent() {
    let fixture = Fixture::new();
    let plugin = fixture.install("dev.results").await;
    fixture.grant(&plugin).await;
    let app = &fixture.app;
    let a = app
        .plugin_host
        .start_scoped(&plugin.manifest.id, "a")
        .unwrap();
    let value = json!({"text":"测试".repeat(20000)});
    let descriptor = app.plugin_result(&a, value.clone()).unwrap();
    let token = descriptor["__pluginResult"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let mut bytes = vec![];
    for chunk in 0..descriptor["__pluginResult"]["chunks"].as_u64().unwrap() {
        let part = app.plugin_result_read(&a, &token, chunk as u32).unwrap();
        bytes.extend(
            STANDARD
                .decode(part["dataBase64"].as_str().unwrap())
                .unwrap(),
        );
    }
    assert_eq!(serde_json::from_slice::<Value>(&bytes).unwrap(), value);
    assert!(app.plugin_result_read(&a, &token, u32::MAX).is_err());
    drop(a);
    let b = app
        .plugin_host
        .start_scoped(&plugin.manifest.id, "b")
        .unwrap();
    assert!(app.plugin_result_read(&b, &token, 0).is_err());
    assert!(app.plugin_result_close(&b, &token).is_err());
    let kept = app
        .plugin_result(&b, json!({"text":"b".repeat(2048)}))
        .unwrap();
    let kept = kept["__pluginResult"]["id"].as_str().unwrap().to_owned();
    drop(b);
    app.plugin_close_scope(&plugin.manifest.id, "a")
        .await
        .unwrap();
    assert!(!app.plugin_host.lock().unwrap().results.contains_key(&token));
    let b = app
        .plugin_host
        .start_scoped(&plugin.manifest.id, "b")
        .unwrap();
    assert!(app.plugin_result_read(&b, &kept, 0).is_ok());
    app.plugin_host
        .lock()
        .unwrap()
        .results
        .get_mut(&kept)
        .unwrap()
        .at = Instant::now() - Duration::from_secs(61);
    assert!(app.plugin_result_read(&b, &kept, 0).is_err());
    drop(b);
    app.plugin_stop_resources(&plugin.manifest.id)
        .await
        .unwrap();
    assert!(app.plugin_host.lock().unwrap().results.is_empty());
    app.shutdown().await;
}
#[tokio::test]
async fn packaged_wasm_publishes_large_outputs_through_bounded_chunks() {
    let fixture = Fixture::new();
    let id = fixture.wasm().await;
    let reply = fixture
        .app
        .plugin_call_scoped(
            &id,
            "page",
            json!({"action":"large","input":{"bytes":600000}}),
        )
        .await
        .unwrap();
    assert!(reply.error.is_none());
    let resource = &reply.result["__pluginResult"];
    assert!(resource["bytes"].as_u64().unwrap() > 600000);
    let call = fixture.app.plugin_host.start_scoped(&id, "page").unwrap();
    let mut bytes = vec![];
    for chunk in 0..resource["chunks"].as_u64().unwrap() {
        let part = fixture
            .app
            .plugin_result_read(&call, resource["id"].as_str().unwrap(), chunk as u32)
            .unwrap();
        bytes.extend(
            STANDARD
                .decode(part["dataBase64"].as_str().unwrap())
                .unwrap(),
        );
    }
    assert_eq!(
        serde_json::from_slice::<Value>(&bytes).unwrap()["text"]
            .as_str()
            .unwrap()
            .len(),
        600000
    );
    fixture
        .app
        .plugin_result_close(&call, resource["id"].as_str().unwrap())
        .unwrap();
    drop(call);
    fixture.app.shutdown().await;
}
#[tokio::test]
async fn local_tcp_is_a_confirmed_primitive_and_host_control_fields_cannot_be_forged() {
    let fixture = Fixture::new();
    let plugin = fixture.install("dev.network").await;
    fixture.grant(&plugin).await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let operation = Primitive::TcpConnect {
        target: "127.0.0.1".into(),
        port,
    };
    let first = call(&fixture.app, &plugin.manifest.id, "page", operation.clone()).await;
    assert_eq!(first.error.unwrap().code, "PLUGIN_CONFIRMATION_REQUIRED");
    assert!(
        tokio::time::timeout(Duration::from_millis(50), listener.accept())
            .await
            .is_err()
    );
    fixture
        .app
        .plugin_approve(
            first.result["confirmationRequired"]["id"].as_str().unwrap(),
            true,
        )
        .unwrap();
    assert_eq!(
        call(&fixture.app, &plugin.manifest.id, "page", operation)
            .await
            .result["reachable"],
        true
    );
    assert!(serde_json::from_value::<Request>(json!({"apiVersion":1,"requestId":"forged","owner":"other","operation":{"kind":"platform","request":{"kind":"info"},"bindings":[]}})).is_err());
    fixture.app.shutdown().await;
}
