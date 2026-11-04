use super::*;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use protocol::*;
use serde_json::{Value, json};
use serverdeck_plugin_core::{
    Entry, FileDigest, InstallInput, Manifest, Package, PackageFile, Repository, UninstallInput,
    package::digest,
};
use std::{
    fs,
    sync::{Arc, atomic::AtomicBool},
    time::Duration,
};

pub(super) fn module(body: &str) -> Vec<u8> {
    module_with_memory(body, "2 65536")
}
fn module_with_memory(body: &str, memory: &str) -> Vec<u8> {
    let reply = serde_json::to_vec(&Reply {
        protocol_version: 1,
        result: json!({"message":"real wasm"}),
        error: None,
    })
    .unwrap();
    let text: String = reply.iter().map(|b| format!("\\{b:02x}")).collect();
    wat::parse_str(format!(
        r#"(module
        (memory (export "memory") {memory})
        (data (i32.const 0) "{text}")
        (func (export "sd_api_version") (result i32) (i32.const 1))
        (func (export "sd_alloc") (param i32) (result i32) (i32.const 65536))
        (func (export "sd_handle") (param i32 i32 i32) (result i64) {body} (i64.const {})))"#,
        reply.len()
    ))
    .unwrap()
}
pub(super) struct Fixture {
    _dir: tempfile::TempDir,
    repository: Repository,
    pub(super) runtime: Runtime,
}
impl Fixture {
    pub(super) fn new(bytes: &[u8]) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let repository = Repository::open(dir.path().join("plugins")).unwrap();
        let package = Package {
            format_version: 1,
            manifest: Manifest {
                icon: None,
                schema_version: 1,
                id: "dev.runtime".into(),
                name: "Runtime fixture".into(),
                version: "1.0.0".into(),
                author: "Local".into(),
                description: "Actual WASM".into(),
                api_version: "^1".into(),
                publisher: None,
                entry: Entry {
                    backend: Some("backend.wasm".into()),
                    ui: None,
                },
                permissions: vec![],
                contributions: vec![],
                platforms: vec![std::env::consts::OS.into()],
                files: vec![FileDigest {
                    path: "backend.wasm".into(),
                    size: bytes.len() as u64,
                    sha256: digest(bytes),
                }],
            },
            files: vec![PackageFile {
                path: "backend.wasm".into(),
                content: STANDARD.encode(bytes),
            }],
        };
        let path = dir.path().join("backend.sdplugin");
        fs::write(&path, serde_json::to_vec(&package).unwrap()).unwrap();
        repository
            .install(InstallInput {
                path,
                development_confirmed: true,
                expected_version: None,
                expected_digest: None,
            })
            .unwrap();
        let runtime = Runtime::new(repository.clone());
        Self {
            _dir: dir,
            repository,
            runtime,
        }
    }
    pub(super) fn enable(&self) {
        self.repository.set_enabled("dev.runtime", true).unwrap();
    }
}
fn error_code(error: &serverdeck_core::Error) -> &str {
    match error {
        serverdeck_core::Error::Connection { code, .. } => code,
        _ => "other",
    }
}

#[tokio::test]
async fn installed_real_hello_lifecycle_duplicate_activation_disable_uninstall() {
    let hello = wat::parse_str(include_str!(
        "../../../tests/fixtures/plugins/hello-world/backend.wat"
    ))
    .unwrap();
    let f = Fixture::new(&hello);
    assert_eq!(
        error_code(&f.runtime.activate("dev.runtime").await.unwrap_err()),
        "PLUGIN_DISABLED"
    );
    f.enable();
    let status = f.runtime.activate("dev.runtime").await.unwrap();
    assert_eq!(status.state, State::Active);
    assert_eq!(
        status.diagnostic.unwrap()["message"],
        "hello from isolated wasm"
    );
    assert_eq!(
        f.runtime.activate("dev.runtime").await.unwrap().revision,
        status.revision
    );
    assert_eq!(f.runtime.statuses().unwrap().len(), 1);
    assert_eq!(
        f.runtime
            .health("dev.runtime")
            .await
            .unwrap()
            .protocol_version,
        1
    );
    assert!(
        f.runtime
            .call("dev.runtime", json!({"input":1}))
            .await
            .unwrap()
            .error
            .is_none()
    );
    f.repository.set_enabled("dev.runtime", false).unwrap();
    assert_eq!(
        error_code(
            &f.runtime
                .call("dev.runtime", Value::Null)
                .await
                .unwrap_err()
        ),
        "PLUGIN_DISABLED"
    );
    f.runtime.remove("dev.runtime").await.unwrap();
    assert!(f.runtime.statuses().unwrap().is_empty());
    f.repository
        .uninstall(UninstallInput {
            id: "dev.runtime".into(),
            clear_data: false,
            confirmed: true,
        })
        .unwrap();
    assert!(f.runtime.activate("dev.runtime").await.is_err());
    f.runtime.shutdown().await.unwrap();
    assert!(matches!(
        f.runtime.activate("dev.runtime").await,
        Err(serverdeck_core::Error::ShuttingDown)
    ));
}

#[tokio::test]
async fn trap_and_dead_loop_crash_only_guest_and_allow_explicit_restart() {
    for (body, expected) in [
        (
            "(if (i32.eq (local.get 0) (i32.const 6)) (then unreachable))",
            "PLUGIN_TRAP",
        ),
        (
            "(if (i32.eq (local.get 0) (i32.const 6)) (then (loop $spin (br $spin))))",
            "PLUGIN_FUEL",
        ),
    ] {
        let f = Fixture::new(&module(body));
        f.enable();
        f.runtime.activate("dev.runtime").await.unwrap();
        let error = tokio::time::timeout(
            Duration::from_secs(3),
            f.runtime.call("dev.runtime", Value::Null),
        )
        .await
        .expect("fuel must terminate the worker")
        .unwrap_err();
        assert_eq!(error_code(&error), expected);
        let status = f.runtime.statuses().unwrap().pop().unwrap();
        assert_eq!(status.state, State::Crashed);
        assert_eq!(status.error_code.as_deref(), Some(expected));
        assert!(
            f.runtime.call("dev.runtime", Value::Null).await.is_err(),
            "no silent restart"
        );
        assert_eq!(
            f.runtime.activate("dev.runtime").await.unwrap().state,
            State::Active
        );
        f.runtime.shutdown().await.unwrap();
        assert!(f.runtime.statuses().unwrap().is_empty());
    }
}

#[test]
fn native_wasi_network_and_environment_imports_are_unavailable() {
    for (namespace, name) in [
        ("wasi_snapshot_preview1", "path_open"),
        ("wasi_snapshot_preview1", "environ_get"),
        ("wasi_snapshot_preview1", "sock_open"),
        ("tauri", "invoke"),
        ("host", "secret_read"),
    ] {
        let wasm = wat::parse_str(format!(
            "(module (import \"{namespace}\" \"{name}\" (func)))"
        ))
        .unwrap();
        let error = match vm::Vm::new(&wasm, Arc::new(AtomicBool::new(false))) {
            Ok(_) => panic!("ambient import accepted"),
            Err(e) => e,
        };
        assert_eq!(error_code(&error), "PLUGIN_IMPORT");
    }
}

#[test]
fn infinite_module_start_is_fuel_metered_before_abi_negotiation() {
    let bytes =
        wat::parse_str("(module (func $start (loop $forever (br $forever))) (start $start))")
            .unwrap();
    let error = match vm::Vm::new(&bytes, Arc::new(AtomicBool::new(false))) {
        Ok(_) => panic!("unmetered start"),
        Err(e) => e,
    };
    assert_eq!(error_code(&error), "PLUGIN_FUEL");
}

#[test]
fn memory_growth_initial_memory_and_bad_pointers_are_rejected() {
    let huge = module_with_memory("", "257 65536");
    let error = match vm::Vm::new(&huge, Arc::new(AtomicBool::new(false))) {
        Ok(_) => panic!("initial memory quota bypassed"),
        Err(e) => e,
    };
    assert_eq!(error_code(&error), "PLUGIN_TRAP");
    for body in [
        "(drop (memory.grow (i32.const 257)))",
        "(i32.store (i32.const 16777216) (i32.const 1))",
    ] {
        let mut vm = vm::Vm::new(&module(body), Arc::new(AtomicBool::new(false))).unwrap();
        assert!(vm.call(Operation::Invoke, Value::Null).is_err());
    }
    let wasm = wat::parse_str("(module (memory (export \"memory\") 1) (func (export \"sd_api_version\") (result i32) i32.const 1) (func (export \"sd_alloc\") (param i32) (result i32) i32.const -1) (func (export \"sd_handle\") (param i32 i32 i32) (result i64) i64.const 0))").unwrap();
    let mut vm = vm::Vm::new(&wasm, Arc::new(AtomicBool::new(false))).unwrap();
    assert_eq!(
        error_code(&vm.call(Operation::Invoke, Value::Null).unwrap_err()),
        "PLUGIN_ABI"
    );
}

#[tokio::test]
async fn malformed_reply_and_incompatible_abi_do_not_escape_guest() {
    let incompatible =
        wat::parse_str("(module (func (export \"sd_api_version\") (result i32) i32.const 2))")
            .unwrap();
    let error = match vm::Vm::new(&incompatible, Arc::new(AtomicBool::new(false))) {
        Ok(_) => panic!("incompatible ABI accepted"),
        Err(e) => e,
    };
    assert_eq!(error_code(&error), "PLUGIN_PROTOCOL");
    let f = Fixture::new(&module(
        "(if (i32.eq (local.get 0) (i32.const 6)) (then (i32.store8 (i32.const 0) (i32.const 120))))",
    ));
    f.enable();
    f.runtime.activate("dev.runtime").await.unwrap();
    assert_eq!(
        error_code(
            &f.runtime
                .call("dev.runtime", Value::Null)
                .await
                .unwrap_err()
        ),
        "PLUGIN_PROTOCOL"
    );
    assert_eq!(f.runtime.statuses().unwrap()[0].state, State::Crashed);
    f.runtime.shutdown().await.unwrap();
}

#[tokio::test]
async fn oversized_requests_responses_and_floods_are_bounded() {
    let f = Fixture::new(&module(""));
    f.enable();
    f.runtime.activate("dev.runtime").await.unwrap();
    assert_eq!(
        error_code(
            &f.runtime
                .call("dev.runtime", json!("x".repeat(MAX_MESSAGE)))
                .await
                .unwrap_err()
        ),
        "PLUGIN_MESSAGE_LIMIT"
    );
    for _ in 0..20 {
        f.runtime.call("dev.runtime", Value::Null).await.unwrap();
    }
    assert_eq!(
        error_code(
            &f.runtime
                .call("dev.runtime", Value::Null)
                .await
                .unwrap_err()
        ),
        "PLUGIN_RATE_LIMIT"
    );
    f.runtime.shutdown().await.unwrap();
    let f = Fixture::new(&module(
        "(if (i32.eq (local.get 0) (i32.const 6)) (then (return (i64.const 65537))))",
    ));
    f.enable();
    f.runtime.activate("dev.runtime").await.unwrap();
    assert_eq!(
        error_code(
            &f.runtime
                .call("dev.runtime", Value::Null)
                .await
                .unwrap_err()
        ),
        "PLUGIN_MESSAGE_LIMIT"
    );
    assert_eq!(f.runtime.statuses().unwrap()[0].state, State::Crashed);
    f.runtime.shutdown().await.unwrap();
}

#[tokio::test]
async fn cancellation_releases_guest_and_old_revision_cannot_execute_after_upgrade() {
    let f = Fixture::new(&module(""));
    f.enable();
    f.runtime.activate("dev.runtime").await.unwrap();
    f.runtime.cancel("dev.runtime").unwrap();
    assert_eq!(
        error_code(
            &f.runtime
                .call("dev.runtime", Value::Null)
                .await
                .unwrap_err()
        ),
        "PLUGIN_CANCELLED"
    );
    f.runtime.remove("dev.runtime").await.unwrap();
    assert!(f.runtime.statuses().unwrap().is_empty());
    f.runtime.activate("dev.runtime").await.unwrap();
    let path = f._dir.path().join("backend.sdplugin");
    let mut upgrade: Package = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    upgrade.manifest.version = "2.0.0".into();
    fs::write(&path, serde_json::to_vec(&upgrade).unwrap()).unwrap();
    f.repository
        .install(InstallInput {
            path,
            development_confirmed: true,
            expected_version: Some("1.0.0".into()),
            expected_digest: None,
        })
        .unwrap();
    assert_eq!(
        error_code(
            &f.runtime
                .call("dev.runtime", Value::Null)
                .await
                .unwrap_err()
        ),
        "PLUGIN_DISABLED"
    );
    f.enable();
    assert_eq!(
        error_code(
            &f.runtime
                .call("dev.runtime", Value::Null)
                .await
                .unwrap_err()
        ),
        "PLUGIN_INACTIVE"
    );
    f.runtime.activate("dev.runtime").await.unwrap();
    assert!(f.runtime.call("dev.runtime", Value::Null).await.is_ok());
    f.runtime.shutdown().await.unwrap();
}

#[tokio::test]
async fn idle_guest_receives_cancel_and_is_released_even_when_handler_traps() {
    let f = Fixture::new(&module(
        "(if (i32.eq (local.get 0) (i32.const 4)) (then unreachable))",
    ));
    f.enable();
    f.runtime.activate("dev.runtime").await.unwrap();
    f.runtime.cancel("dev.runtime").unwrap();
    let error = f.runtime.remove("dev.runtime").await.unwrap_err();
    assert_eq!(
        error_code(&error),
        "PLUGIN_TRAP",
        "the actual cancel operation reached the guest"
    );
    assert!(
        f.runtime.statuses().unwrap().is_empty(),
        "trap cannot retain a live instance"
    );
    f.runtime.shutdown().await.unwrap();
}

#[tokio::test]
async fn active_instance_quota_is_released_by_removal() {
    let f = Fixture::new(&module(""));
    let path = f._dir.path().join("backend.sdplugin");
    let mut package: Package = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    for index in 0..9 {
        let id = format!("dev.runtime{index}");
        package.manifest.id = id.clone();
        fs::write(&path, serde_json::to_vec(&package).unwrap()).unwrap();
        f.repository
            .install(InstallInput {
                path: path.clone(),
                development_confirmed: true,
                expected_version: None,
                expected_digest: None,
            })
            .unwrap();
        f.repository.set_enabled(&id, true).unwrap();
        let result = f.runtime.activate(&id).await;
        if index < 8 {
            assert_eq!(result.unwrap().state, State::Active);
        } else {
            assert_eq!(error_code(&result.unwrap_err()), "PLUGIN_QUOTA");
        }
    }
    f.runtime.remove("dev.runtime0").await.unwrap();
    f.runtime.activate("dev.runtime8").await.unwrap();
    f.runtime.shutdown().await.unwrap();
    assert!(f.runtime.statuses().unwrap().is_empty());
}
