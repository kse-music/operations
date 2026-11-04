use super::*;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde_json::json;
use serverdeck_core::hosts::{AuthType, HostInput};
use serverdeck_plugin_core::{
    Entry, FileDigest, Manifest, Package, PackageFile, Permission, package::digest,
    permissions::GrantInput,
};
use serverdeck_plugin_sdk::{Capability, Request};

fn host_input(port: u16) -> HostInput {
    HostInput {
        name: "isolated plugin fixture".into(),
        hostname: "127.0.0.1".into(),
        port,
        username: "plugin".into(),
        auth_type: AuthType::Agent,
        credential_id: None,
        group_id: None,
        tags: vec![],
        description: String::new(),
        favorite: false,
        connect_timeout_secs: 5,
        ssh: Default::default(),
    }
}
fn request(operation: Capability) -> Request {
    Request {
        api_version: 1,
        request_id: uuid::Uuid::new_v4().to_string(),
        operation,
    }
}
async fn confirmed(app: &Application, operation: Capability) -> serverdeck_plugin_sdk::Response {
    let pending = app
        .plugin_capability("dev.sdk-linux", request(operation.clone()))
        .await
        .unwrap();
    assert_eq!(
        pending.error.as_ref().map(|error| error.code.as_str()),
        Some("PLUGIN_CONFIRMATION_REQUIRED"),
        "confirmation request failed: {:?}",
        pending.error
    );
    let approval = pending.result["confirmationRequired"]["id"]
        .as_str()
        .expect("separate confirmation");
    app.plugin_approve(approval, true).unwrap();
    app.plugin_capability("dev.sdk-linux", request(operation))
        .await
        .unwrap()
}
fn all_permissions() -> Vec<Permission> {
    vec![
        Permission::HostsRead,
        Permission::SshExecute,
        Permission::SftpRead,
        Permission::SftpWrite,
        Permission::UiContribute,
        Permission::SettingsRead,
        Permission::SettingsWrite,
        Permission::TasksCreate,
    ]
}
fn grant(revision: String, host: String) -> GrantInput {
    GrantInput {
        expected_revision: revision,
        permissions: all_permissions(),
        host_ids: vec![host],
        operations: serverdeck_plugin_core::permissions::OPERATIONS
            .iter()
            .map(|s| (*s).into())
            .collect(),
        read_roots: vec!["/home/plugin/nginx".into()],
        write_roots: vec!["/home/plugin/nginx".into()],
        confirmed: true,
    }
}
async fn install(
    app: &Application,
    dir: &std::path::Path,
    id: &str,
    wasm: Option<&[u8]>,
) -> InstalledPlugin {
    let mut manifest = Manifest {
        icon: None,
        schema_version: 1,
        id: id.into(),
        name: "SDK test".into(),
        version: "1.0.0".into(),
        author: "Local test".into(),
        description: String::new(),
        api_version: "^1".into(),
        entry: Entry {
            backend: wasm.map(|_| "backend.wasm".into()),
            ui: None,
        },
        permissions: all_permissions(),
        contributions: vec![],
        platforms: vec![std::env::consts::OS.into()],
        files: vec![],
        publisher: None,
    };
    let files = if let Some(bytes) = wasm {
        manifest.files.push(FileDigest {
            path: "backend.wasm".into(),
            size: bytes.len() as u64,
            sha256: digest(bytes),
        });
        vec![PackageFile {
            path: "backend.wasm".into(),
            content: STANDARD.encode(bytes),
        }]
    } else {
        vec![]
    };
    let path = dir.join(format!("{id}.sdplugin"));
    std::fs::write(
        &path,
        serde_json::to_vec(&Package {
            format_version: 1,
            manifest,
            files,
        })
        .unwrap(),
    )
    .unwrap();
    app.plugin_install(InstallInput {
        path,
        development_confirmed: true,
        expected_version: None,
        expected_digest: None,
    })
    .await
    .unwrap()
}

#[tokio::test]
async fn expired_approval_explains_retry_and_cannot_authorize_an_operation() {
    use std::time::{Duration, Instant};

    let dir = tempfile::tempdir().unwrap();
    let app = Application::initialize(dir.path().join("data"), dir.path().join("logs")).unwrap();
    let host = app.database.host_create(host_input(22)).unwrap();
    let plugin = install(&app, dir.path(), "dev.expiry", None).await;
    app.plugin_set_enabled("dev.expiry".into(), true)
        .await
        .unwrap();
    app.plugin_context(
        "dev.expiry".into(),
        ContextInput {
            host_id: host.id,
            ops_session: None,
            file_session: None,
        },
    )
    .await
    .unwrap();
    let call = app.plugin_host.start("dev.expiry").unwrap();
    let operation = Capability::Execute {
        command: "printf 'approval gate'".into(),
        timeout_secs: 5,
    };
    let pending = app
        .plugin_confirmation(&call, &plugin, &operation)
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
    assert!(
        !app.plugin_host
            .lock()
            .unwrap()
            .approvals
            .contains_key(&pending.id)
    );
    let repeated =
        serverdeck_core::IpcError::from(app.plugin_approve(&pending.id, true).unwrap_err());
    assert_eq!(repeated.code, "PLUGIN_CONFIRMATION_EXPIRED");
    app.plugin_approve(&pending.id, false).unwrap();

    let fresh = app
        .plugin_confirmation(&call, &plugin, &operation)
        .unwrap()
        .unwrap();
    assert_ne!(fresh.id, pending.id);
    app.plugin_approve(&fresh.id, true).unwrap();
    assert!(
        app.plugin_confirmation(&call, &plugin, &operation)
            .unwrap()
            .is_none()
    );
    assert!(
        app.plugin_confirmation(&call, &plugin, &operation)
            .unwrap()
            .is_some()
    );
    drop(call);
    app.shutdown().await;
}

#[tokio::test]
async fn failed_upgrade_resumes_old_capabilities_and_retains_identity_and_grant() {
    let dir = tempfile::tempdir().unwrap();
    let app = Application::initialize(dir.path().join("data"), dir.path().join("logs")).unwrap();
    let host = app.database.host_create(host_input(22)).unwrap();
    let plugin = install(&app, dir.path(), "dev.rollback", None).await;
    app.plugin_grant(
        "dev.rollback".into(),
        grant(plugin.revision.clone(), host.id.clone()),
    )
    .await
    .unwrap();
    app.plugin_set_enabled("dev.rollback".into(), true)
        .await
        .unwrap();
    let path = dir.path().join("dev.rollback.sdplugin");
    assert!(
        app.plugin_install(InstallInput {
            path: path.clone(),
            development_confirmed: true,
            expected_version: Some("1.0.0".into()),
            expected_digest: None
        })
        .await
        .is_err()
    );
    let active = app
        .plugin_capability("dev.rollback", request(Capability::SettingsRead))
        .await
        .unwrap();
    assert!(
        active.error.is_none(),
        "duplicate install must not leave the retained plugin stopped"
    );
    #[cfg(windows)]
    {
        let record = dir
            .path()
            .join("data/plugins/packages/dev.rollback/record.json");
        let permissions = std::fs::metadata(&record).unwrap().permissions();
        let mut readonly = permissions.clone();
        readonly.set_readonly(true);
        std::fs::set_permissions(&record, readonly).unwrap();
        let mut package: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        package["manifest"]["version"] = json!("2.0.0");
        std::fs::write(&path, serde_json::to_vec(&package).unwrap()).unwrap();
        let result = app
            .plugin_install(InstallInput {
                path,
                development_confirmed: true,
                expected_version: Some("1.0.0".into()),
                expected_digest: None,
            })
            .await;
        std::fs::set_permissions(&record, permissions).unwrap();
        assert!(result.is_err(), "real commit to read-only record must fail");
    }
    let restored = app.plugin_detail("dev.rollback".into()).await.unwrap();
    assert_eq!(restored.revision, plugin.revision);
    assert!(restored.enabled);
    assert!(
        app.plugin_permissions("dev.rollback".into())
            .await
            .unwrap()
            .is_some()
    );
    let active = app
        .plugin_capability("dev.rollback", request(Capability::SettingsRead))
        .await
        .unwrap();
    assert!(
        active.error.is_none(),
        "real failed commit must resume Host capabilities"
    );
    app.plugin_context(
        "dev.rollback".into(),
        ContextInput {
            host_id: host.id,
            ops_session: None,
            file_session: None,
        },
    )
    .await
    .unwrap();
    assert!(
        app.plugin_capability("dev.rollback", request(Capability::HostsRead))
            .await
            .unwrap()
            .error
            .is_none()
    );
}

#[tokio::test]
async fn default_deny_revocation_any_current_host_context_and_redacted_metadata() {
    let dir = tempfile::tempdir().unwrap();
    let app = Application::initialize(dir.path().join("data"), dir.path().join("logs")).unwrap();
    let host = app.database.host_create(host_input(22)).unwrap();
    let other = app
        .database
        .host_create(HostInput {
            name: "other".into(),
            hostname: "other.invalid".into(),
            ..host_input(22)
        })
        .unwrap();
    let plugin = install(&app, dir.path(), "dev.policy", None).await;
    app.plugin_set_enabled("dev.policy".into(), true)
        .await
        .unwrap();
    let denied = app
        .plugin_capability("dev.policy", request(Capability::SettingsRead))
        .await
        .unwrap();
    assert_eq!(denied.error.unwrap().code, "PLUGIN_PERMISSION_DENIED");
    app.plugin_grant("dev.policy".into(), grant(plugin.revision, host.id.clone()))
        .await
        .unwrap();
    app.plugin_context(
        "dev.policy".into(),
        ContextInput {
            host_id: host.id.clone(),
            ops_session: None,
            file_session: None,
        },
    )
    .await
    .unwrap();
    let result = app
        .plugin_capability("dev.policy", request(Capability::HostsRead))
        .await
        .unwrap();
    assert!(result.error.is_none());
    assert_eq!(result.result["id"], host.id);
    let fields = result.result.as_object().unwrap();
    assert_eq!(fields.len(), 5);
    assert!(!fields.contains_key("credentialId"));
    assert!(!fields.contains_key("authType"));
    app.plugin_context(
        "dev.policy".into(),
        ContextInput {
            host_id: other.id.clone(),
            ops_session: None,
            file_session: None,
        },
    )
    .await
    .unwrap();
    let switched = app
        .plugin_capability("dev.policy", request(Capability::HostsRead))
        .await
        .unwrap();
    assert!(switched.error.is_none());
    assert_eq!(switched.result["id"], other.id);
    assert_eq!(switched.result.as_object().unwrap().len(), 5);
    app.plugin_revoke("dev.policy".into()).await.unwrap();
    app.plugin_context(
        "dev.policy".into(),
        ContextInput {
            host_id: host.id,
            ops_session: None,
            file_session: None,
        },
    )
    .await
    .unwrap();
    assert_eq!(
        app.plugin_capability("dev.policy", request(Capability::HostsRead))
            .await
            .unwrap()
            .error
            .unwrap()
            .code,
        "PLUGIN_PERMISSION_DENIED"
    );
    assert!(
        app.plugin_events()
            .unwrap()
            .iter()
            .any(|e| e.kind == "permission_denied")
    );
    app.shutdown().await;
}

#[tokio::test]
async fn settings_are_persistent_and_confined_and_closed_sessions_never_execute() {
    let dir = tempfile::tempdir().unwrap();
    let app = Application::initialize(dir.path().join("data"), dir.path().join("logs")).unwrap();
    let host = app.database.host_create(host_input(22)).unwrap();
    for id in ["dev.first", "dev.second"] {
        let p = install(&app, dir.path(), id, None).await;
        app.plugin_grant(id.into(), grant(p.revision, host.id.clone()))
            .await
            .unwrap();
        app.plugin_set_enabled(id.into(), true).await.unwrap();
        app.plugin_context(
            id.into(),
            ContextInput {
                host_id: host.id.clone(),
                ops_session: None,
                file_session: None,
            },
        )
        .await
        .unwrap();
    }
    app.plugin_capability(
        "dev.first",
        request(Capability::SettingsWrite {
            value: json!({"owned":"first"}),
        }),
    )
    .await
    .unwrap();
    assert_eq!(
        app.plugin_capability("dev.first", request(Capability::SettingsRead))
            .await
            .unwrap()
            .result["owned"],
        "first"
    );
    assert_eq!(
        app.plugin_capability("dev.second", request(Capability::SettingsRead))
            .await
            .unwrap()
            .result,
        json!({})
    );
    for command in ["uname -a", "touch /home/plugin/nginx/forbidden"] {
        let result = app
            .plugin_capability(
                "dev.first",
                request(Capability::Execute {
                    command: command.into(),
                    timeout_secs: 5,
                }),
            )
            .await
            .unwrap();
        assert!(result.result.is_null());
        assert_eq!(result.error.unwrap().code, "PLUGIN_SESSION_CLOSED");
    }
    app.shutdown().await;
}

#[tokio::test]
#[ignore = "Requires the owned Docker Linux test host and prebuilt public SDK WASM; run tools/plugin-test-host/test.ps1"]
async fn linux_sdk_capability_roundtrip() {
    use serverdeck_core::hosts::CredentialInput;
    use serverdeck_security::{NativeStore, SecretStore};
    use std::time::Duration;
    let port = std::env::var("SERVERDECK_PLUGIN_TEST_PORT")
        .unwrap()
        .parse()
        .unwrap();
    let password =
        zeroize::Zeroizing::new(std::env::var("SERVERDECK_PLUGIN_TEST_PASSWORD").unwrap());
    let public_key = std::env::var("SERVERDECK_PLUGIN_TEST_HOST_KEY")
        .unwrap()
        .split_whitespace()
        .take(2)
        .collect::<Vec<_>>()
        .join(" ");
    let key = russh::keys::PublicKey::from_openssh(&public_key).unwrap();
    let dir = tempfile::tempdir().unwrap();
    let app = Application::initialize(dir.path().join("data"), dir.path().join("logs")).unwrap();
    app.database
        .trust_key(
            "127.0.0.1",
            port,
            &public_key,
            &key.fingerprint(russh::keys::HashAlg::Sha256).to_string(),
        )
        .unwrap();
    let credential = app
        .credential_save(
            None,
            None,
            CredentialInput {
                name: format!("plugin-test-{}", uuid::Uuid::new_v4()),
                kind: AuthType::Password,
                key_path: None,
                secret: Some(password),
                clear_secret: false,
            },
        )
        .await
        .unwrap()
        .value;
    struct SecretCleanup(Option<String>);
    impl Drop for SecretCleanup {
        fn drop(&mut self) {
            if let Some(reference) = &self.0
                && NativeStore.delete(reference).is_err()
            {
                eprintln!("temporary test secret cleanup failed");
            }
        }
    }
    let mut cleanup = SecretCleanup(
        app.database
            .credential_record(&credential.id)
            .unwrap()
            .secret_ref,
    );
    let host = app
        .host_create(HostInput {
            auth_type: AuthType::Password,
            credential_id: Some(credential.id.clone()),
            ..host_input(port)
        })
        .await
        .unwrap();
    let states = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let record = states.clone();
    let sink: serverdeck_ssh::Sink = std::sync::Arc::new(move |event| {
        if let serverdeck_core::terminal::TerminalEvent::State { state, code, .. } = event {
            record.lock().unwrap().push((state.to_owned(), code));
        }
        true
    });
    let ops = app.ops_open(host.id.clone(), sink.clone()).await.unwrap();
    let files = app.files_open(host.id.clone(), sink).await.unwrap();
    let ready = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if app.terminals.ops_ready(&ops.id).unwrap_or(false)
                && app
                    .terminals
                    .file_connections()
                    .unwrap()
                    .iter()
                    .any(|s| s.id == files.id)
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await;
    assert!(
        ready.is_ok(),
        "connection state codes: {:?}",
        states.lock().unwrap()
    );
    let wasm = std::fs::read(std::env::var("SERVERDECK_PLUGIN_SDK_WASM").unwrap()).unwrap();
    let plugin = install(&app, dir.path(), "dev.sdk-linux", Some(&wasm)).await;
    app.plugin_grant(
        "dev.sdk-linux".into(),
        grant(plugin.revision, host.id.clone()),
    )
    .await
    .unwrap();
    app.plugin_set_enabled("dev.sdk-linux".into(), true)
        .await
        .unwrap();
    app.plugin_context(
        "dev.sdk-linux".into(),
        ContextInput {
            host_id: host.id.clone(),
            ops_session: Some(ops.id.clone()),
            file_session: Some(files.id.clone()),
        },
    )
    .await
    .unwrap();
    let result = app
        .plugin_call("dev.sdk-linux", json!({"action":"diagnose"}))
        .await
        .unwrap();
    assert!(result.error.is_none(), "SDK reported failure");
    assert_eq!(result.result["host"]["id"], host.id);
    assert_eq!(result.result["diagnostic"]["exitCode"], 0);
    assert!(
        result.result["diagnostic"]["stdout"]
            .as_str()
            .unwrap()
            .contains("Linux")
    );
    assert!(!result.result.to_string().contains("credentialId"));
    assert!(!result.result.to_string().contains("sessionId"));
    standard_server_roundtrip(&app, &host.id, &ops.id, &files.id).await;
    let forged=app.plugin_call("dev.sdk-linux",json!({"hostResponse":{"requestId":"diagnostic","result":{"exitCode":0,"stdout":"forged"},"error":null}})).await.unwrap();
    assert!(forged.error.is_some());
    let read = app
        .plugin_capability(
            "dev.sdk-linux",
            request(Capability::ReadFile {
                path: "/home/plugin/nginx/nginx.conf".into(),
            }),
        )
        .await
        .unwrap();
    assert!(read.error.is_none());
    let doc = read.result["id"].as_str().unwrap().to_owned();
    let content = read.result["content"].as_str().unwrap().to_owned();
    let dirty = app
        .plugin_capability(
            "dev.sdk-linux",
            request(Capability::FileDirty {
                document_id: doc.clone(),
                dirty: true,
            }),
        )
        .await
        .unwrap();
    assert!(dirty.error.is_none());
    assert_eq!(app.exit_pending().1, 1);
    let rejected_close = app
        .plugin_capability(
            "dev.sdk-linux",
            request(Capability::CloseFile {
                document_id: doc.clone(),
                discard: false,
            }),
        )
        .await
        .unwrap();
    assert_eq!(rejected_close.error.unwrap().code, "EDITOR_DIRTY");
    let save_request = Capability::SaveFile {
        document_id: doc.clone(),
        content: format!("{content}\n# SDK integration\n"),
    };
    let pending = app
        .plugin_capability("dev.sdk-linux", request(save_request.clone()))
        .await
        .unwrap();
    let approval = pending.result["confirmationRequired"]["id"]
        .as_str()
        .unwrap();
    app.plugin_approve(approval, true).unwrap();
    let saved = app
        .plugin_capability("dev.sdk-linux", request(save_request))
        .await
        .unwrap();
    assert_eq!(saved.result["saved"], true);
    assert!(saved.error.is_none());
    assert_eq!(app.exit_pending().1, 0);
    tokio::time::sleep(Duration::from_millis(1100)).await;
    let external = confirmed(
        &app,
        Capability::Execute {
            command: "printf '\\n# external\\n' >> /home/plugin/nginx/nginx.conf".into(),
            timeout_secs: 5,
        },
    )
    .await;
    assert_eq!(external.result["exitCode"], 0);
    let conflict = confirmed(
        &app,
        Capability::SaveFile {
            document_id: doc.clone(),
            content: content.clone(),
        },
    )
    .await;
    assert_eq!(conflict.error.unwrap().code, "EDITOR_CONFLICT");
    let reread = app
        .plugin_capability(
            "dev.sdk-linux",
            request(Capability::ReadFile {
                path: "/home/plugin/nginx/nginx.conf".into(),
            }),
        )
        .await
        .unwrap();
    assert!(
        reread.result["content"]
            .as_str()
            .unwrap()
            .contains("# external")
    );
    let link = confirmed(
        &app,
        Capability::Execute {
            command: "ln -s /etc/passwd /home/plugin/nginx/escape".into(),
            timeout_secs: 5,
        },
    )
    .await;
    assert_eq!(link.result["exitCode"], 0);
    let escape = app
        .plugin_capability(
            "dev.sdk-linux",
            request(Capability::ReadFile {
                path: "/home/plugin/nginx/escape".into(),
            }),
        )
        .await
        .unwrap();
    assert_eq!(escape.error.unwrap().code, "PLUGIN_PERMISSION_DENIED");
    let command = "printf 'confirmed\\n'";
    let pending = app
        .plugin_capability(
            "dev.sdk-linux",
            request(Capability::Execute {
                command: command.into(),
                timeout_secs: 5,
            }),
        )
        .await
        .unwrap();
    assert!(!pending.result["confirmationRequired"].is_null());
    let approval = pending.result["confirmationRequired"]["id"]
        .as_str()
        .unwrap();
    app.plugin_approve(approval, true).unwrap();
    let executed = app
        .plugin_capability(
            "dev.sdk-linux",
            request(Capability::Execute {
                command: command.into(),
                timeout_secs: 5,
            }),
        )
        .await
        .unwrap();
    assert_eq!(executed.result["exitCode"], 0);
    assert_eq!(executed.result["stdout"], "confirmed\n");
    let repeated = app
        .plugin_capability(
            "dev.sdk-linux",
            request(Capability::Execute {
                command: command.into(),
                timeout_secs: 5,
            }),
        )
        .await
        .unwrap();
    assert!(
        !repeated.result["confirmationRequired"].is_null(),
        "approval must be single-use"
    );
    tokio::time::sleep(Duration::from_millis(1100)).await;
    let task = app
        .plugin_capability(
            "dev.sdk-linux",
            request(Capability::TaskCreate {
                command: "uname -a".into(),
                timeout_secs: 5,
            }),
        )
        .await
        .unwrap();
    assert!(
        task.error.is_none(),
        "task creation failed: {:?}",
        task.error
    );
    let task_id = task.result["id"].as_str().unwrap().to_owned();
    let completed = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let state = app
                .plugin_capability(
                    "dev.sdk-linux",
                    request(Capability::TaskRead {
                        task_id: task_id.clone(),
                    }),
                )
                .await
                .unwrap();
            if state.result["finished"] == true {
                break state.result;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(completed["exitCode"], 0);
    assert!(completed["stdout"].as_str().unwrap().contains("Linux"));
    let log = app
        .plugin_capability(
            "dev.sdk-linux",
            request(Capability::LogStart {
                path: "/home/plugin/nginx/logs/access.log".into(),
                lines: 10,
            }),
        )
        .await
        .unwrap();
    let log_id = log.result["id"].as_str().unwrap().to_owned();
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let http_port = std::env::var("SERVERDECK_PLUGIN_TEST_HTTP_PORT").unwrap();
    let mut http = tokio::net::TcpStream::connect(format!("127.0.0.1:{http_port}"))
        .await
        .unwrap();
    http.write_all(b"GET /sdk-log-check HTTP/1.0\r\nHost: localhost\r\n\r\n")
        .await
        .unwrap();
    let mut bytes = Vec::new();
    http.read_to_end(&mut bytes).await.unwrap();
    let output = tokio::time::timeout(Duration::from_secs(5), async {
        let mut output = String::new();
        loop {
            let poll = app
                .plugin_capability(
                    "dev.sdk-linux",
                    request(Capability::LogPoll {
                        log_id: log_id.clone(),
                    }),
                )
                .await
                .unwrap();
            assert!(poll.error.is_none());
            for event in poll.result["events"].as_array().unwrap() {
                if let Some(encoded) = event["dataBase64"].as_str() {
                    output.push_str(&String::from_utf8_lossy(&STANDARD.decode(encoded).unwrap()));
                }
            }
            if output.contains("/sdk-log-check") {
                break output;
            }
            tokio::time::sleep(Duration::from_millis(150)).await;
        }
    })
    .await
    .unwrap();
    assert!(output.contains("GET /sdk-log-check"));
    for paused in [true, false] {
        assert!(
            app.plugin_capability(
                "dev.sdk-linux",
                request(Capability::LogPause {
                    log_id: log_id.clone(),
                    paused
                })
            )
            .await
            .unwrap()
            .error
            .is_none()
        );
    }
    assert!(
        app.plugin_capability("dev.sdk-linux", request(Capability::LogStop { log_id }))
            .await
            .unwrap()
            .error
            .is_none()
    );
    tokio::time::sleep(Duration::from_millis(1100)).await;
    let timed = confirmed(
        &app,
        Capability::Execute {
            command: "sleep 5".into(),
            timeout_secs: 1,
        },
    )
    .await;
    assert_eq!(timed.result["state"], "uncertain");
    assert!(timed.result["exitCode"].is_null());
    let limited = confirmed(
        &app,
        Capability::Execute {
            command: "python3 -c 'print(\"x\" * 10000)'".into(),
            timeout_secs: 5,
        },
    )
    .await;
    assert_eq!(limited.result["truncated"], true);
    assert!(limited.result["stdout"].as_str().unwrap().len() <= 4096);
    let slow = Capability::Execute {
        command: "sleep 10".into(),
        timeout_secs: 15,
    };
    let pending = app
        .plugin_capability("dev.sdk-linux", request(slow.clone()))
        .await
        .unwrap();
    app.plugin_approve(
        pending.result["confirmationRequired"]["id"]
            .as_str()
            .unwrap(),
        true,
    )
    .unwrap();
    let running = app.clone();
    let running = tokio::spawn(async move {
        running
            .plugin_capability("dev.sdk-linux", request(slow))
            .await
    });
    tokio::time::sleep(Duration::from_millis(80)).await;
    assert!(
        matches!(
            app.plugin_capability("dev.sdk-linux", request(Capability::HostsRead))
                .await,
            Err(Error::Busy)
        ),
        "real concurrent request must be rejected"
    );
    app.plugin_cancel("dev.sdk-linux").unwrap();
    let cancelled = tokio::time::timeout(Duration::from_secs(3), running)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(cancelled.error.unwrap().code, "PLUGIN_CANCELLED");
    app.plugin_activate("dev.sdk-linux").await.unwrap();
    app.plugin_capability(
        "dev.sdk-linux",
        request(Capability::CloseFile {
            document_id: doc,
            discard: false,
        }),
    )
    .await
    .unwrap();
    app.ops_close(&ops.id).await.unwrap();
    let closed = app
        .plugin_capability(
            "dev.sdk-linux",
            request(Capability::Execute {
                command: "uname -a".into(),
                timeout_secs: 5,
            }),
        )
        .await
        .unwrap();
    assert!(closed.error.is_some());
    app.plugin_set_enabled("dev.sdk-linux".into(), false)
        .await
        .unwrap();
    app.host_delete(host.id).await.unwrap();
    let deletion = app.credential_delete(credential.id, false).await.unwrap();
    assert!(deletion.warnings.is_empty());
    cleanup.0 = None;
    app.shutdown().await;
}

async fn standard_rpc(
    app: &Application,
    id: &str,
    operation: serde_json::Value,
) -> serde_json::Value {
    tokio::time::sleep(std::time::Duration::from_millis(70)).await;
    let reply = app
        .plugin_call(
            id,
            json!({"action":"bridge","values":{"request":operation.to_string()}}),
        )
        .await
        .unwrap();
    assert!(reply.error.is_none(), "{id}: {:?}", reply.error);
    let descriptor = &reply.result["__pluginResult"];
    if descriptor.is_null() {
        return reply.result;
    }
    let resource = descriptor["id"].as_str().unwrap();
    let mut bytes = vec![];
    for chunk in 0..descriptor["chunks"].as_u64().unwrap() {
        tokio::time::sleep(std::time::Duration::from_millis(70)).await;
        let response = app
            .plugin_capability(
                id,
                request(Capability::ResultRead {
                    result_id: resource.into(),
                    chunk: chunk as u32,
                }),
            )
            .await
            .unwrap();
        assert!(response.error.is_none());
        bytes.extend(
            STANDARD
                .decode(response.result["dataBase64"].as_str().unwrap())
                .unwrap(),
        );
    }
    tokio::time::sleep(std::time::Duration::from_millis(70)).await;
    assert!(
        app.plugin_capability(
            id,
            request(Capability::ResultClose {
                result_id: resource.into()
            })
        )
        .await
        .unwrap()
        .error
        .is_none()
    );
    serde_json::from_slice(&bytes).unwrap()
}
async fn standard_server_roundtrip(app: &Application, host: &str, ops: &str, files: &str) {
    app.provision_bundled_plugins().unwrap();
    for plugin in app
        .plugin_list()
        .await
        .unwrap()
        .into_iter()
        .filter(|p| p.source == serverdeck_plugin_core::repository::PluginSource::System)
    {
        let id = plugin.manifest.id;
        assert_eq!(
            app.plugin_permissions(id.clone())
                .await
                .unwrap()
                .unwrap()
                .permissions,
            plugin.manifest.permissions
        );
        app.plugin_set_enabled(id.clone(), true).await.unwrap();
        app.plugin_context(
            id,
            ContextInput {
                host_id: host.into(),
                ops_session: Some(ops.into()),
                file_session: Some(files.into()),
            },
        )
        .await
        .unwrap();
    }
    let resource = "cn.hiboot.plugins.resources";
    let monitor = standard_rpc(
        app,
        resource,
        json!({"kind":"metrics_open","intervalSecs":3}),
    )
    .await["id"]
        .as_str()
        .unwrap()
        .to_string();
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(20);
    loop {
        let snapshot = standard_rpc(
            app,
            resource,
            json!({"kind":"metrics_snapshot","monitorId":monitor,"afterRevision":null}),
        )
        .await;
        if !snapshot["sample"].is_null() {
            assert_eq!(snapshot["sessionId"], monitor);
            assert!(
                !snapshot["sample"]["system"]["kernel"]
                    .as_str()
                    .unwrap()
                    .is_empty()
            );
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "standard metrics did not sample: {snapshot}"
        );
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    }
    standard_rpc(
        app,
        resource,
        json!({"kind":"metrics_visible","monitorId":monitor,"visible":false}),
    )
    .await;
    standard_rpc(
        app,
        resource,
        json!({"kind":"metrics_close","monitorId":monitor}),
    )
    .await;
    for (id, query) in [
        ("processes", json!({"kind":"processes"})),
        ("processes", json!({"kind":"ports"})),
        ("docker", json!({"kind":"containers"})),
        ("services", json!({"kind":"services","scope":"system"})),
    ] {
        let response = standard_rpc(
            app,
            &format!("cn.hiboot.plugins.{id}"),
            json!({"kind":"system_query","request":query}),
        )
        .await;
        assert!(response["success"].is_boolean());
        if id == "processes" {
            assert_eq!(response["success"], true);
            assert!(
                response["records"]
                    .as_array()
                    .is_some_and(|rows| !rows.is_empty())
            );
        } else if response["success"] == false {
            assert!(response["code"].is_string());
            assert!(response["message"].is_string());
        }
    }
    let logs = "cn.hiboot.plugins.logs";
    let log=standard_rpc(app,logs,json!({"kind":"system_log_start","source":{"kind":"file","path":"/home/plugin/nginx/nginx.conf"},"lines":20,"follow":false})).await["id"].as_str().unwrap().to_string();
    let mut output = vec![];
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
    loop {
        let events = standard_rpc(app, logs, json!({"kind":"system_log_poll","logId":log})).await;
        for event in events["events"].as_array().unwrap() {
            if let Some(base64) = event["dataBase64"].as_str() {
                output.extend(STANDARD.decode(base64).unwrap());
            }
        }
        if !output.is_empty() {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "standard log did not return actual file bytes"
        );
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    assert!(String::from_utf8(output).unwrap().contains("http"));
    standard_rpc(app, logs, json!({"kind":"system_log_stop","logId":log})).await;
    for plugin in app
        .plugin_list()
        .await
        .unwrap()
        .into_iter()
        .filter(|p| p.source == serverdeck_plugin_core::repository::PluginSource::System)
    {
        app.plugin_set_enabled(plugin.manifest.id, false)
            .await
            .unwrap();
    }
    assert!(app.plugin_host.lock().unwrap().monitors.is_empty());
    assert!(app.plugin_host.lock().unwrap().logs.is_empty());
    assert!(
        app.terminals.ops_ready(ops).unwrap(),
        "system plugin cleanup must keep the shared operations lease"
    );
    assert!(
        app.terminals
            .file_connections()
            .unwrap()
            .iter()
            .any(|session| session.id == files),
        "system plugin cleanup must keep the shared SFTP lease"
    );
}
