use serde_json::{Value, json};
use serverdeck_application::Application;
use tauri::{
    ipc::{CallbackFn, InvokeBody},
    test::{INVOKE_KEY, get_ipc_response, mock_builder},
    webview::InvokeRequest,
};

fn request(command: &str, body: Value, url: &str) -> InvokeRequest {
    InvokeRequest {
        cmd: command.into(),
        callback: CallbackFn(0),
        error: CallbackFn(1),
        url: url.parse().expect("url"),
        body: InvokeBody::Json(body),
        headers: Default::default(),
        invoke_key: INVOKE_KEY.into(),
    }
}

#[test]
fn local_drives_use_real_system_roots_and_main_window_acl() {
    let directory = tempfile::tempdir().unwrap();
    let application =
        Application::initialize(directory.path().join("data"), directory.path().join("logs"))
            .unwrap();
    let app = mock_builder()
        .manage(application)
        .invoke_handler(serverdeck_desktop_lib::command_handler())
        .build(tauri::generate_context!())
        .unwrap();
    let main = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    let other = tauri::WebviewWindowBuilder::new(&app, "untrusted-drives", Default::default())
        .build()
        .unwrap();
    let origin = if cfg!(windows) {
        "http://tauri.localhost"
    } else {
        "tauri://localhost"
    };
    let drives = get_ipc_response(&main, request("files_local_drives", json!({}), origin))
        .expect("real drive enumeration")
        .deserialize::<Vec<serverdeck_core::files::LocalDrive>>()
        .unwrap();
    assert!(!drives.is_empty());
    let executable = std::env::current_exe().unwrap();
    assert!(
        drives
            .iter()
            .any(|drive| executable.starts_with(&drive.path))
    );
    let drive = drives
        .iter()
        .find(|drive| executable.starts_with(&drive.path))
        .unwrap();
    let root = get_ipc_response(
        &main,
        request("files_local", json!({"path": drive.path}), origin),
    )
    .expect("browse an actual drive root")
    .deserialize::<serverdeck_core::files::DirectoryListing>()
    .unwrap();
    assert!(root.parent.is_none());
    assert_eq!(
        std::path::Path::new(&root.path),
        std::fs::canonicalize(&drive.path).unwrap()
    );
    #[cfg(windows)]
    {
        assert!(drives.len() <= 26);
        assert!(drives.windows(2).all(|pair| pair[0].path < pair[1].path));
        for drive in &drives {
            assert_eq!(drive.path.len(), 3);
            assert!(drive.path.as_bytes()[0].is_ascii_uppercase());
            assert!(drive.path.ends_with(":\\"));
            assert!(drive.name.starts_with(&drive.path[..2]));
        }
    }
    assert!(get_ipc_response(&other, request("files_local_drives", json!({}), origin)).is_err());
    assert!(
        get_ipc_response(
            &main,
            request("files_local_drives", json!({}), "https://untrusted.invalid")
        )
        .is_err()
    );
}

#[test]
fn file_opening_commands_reject_untrusted_windows_and_invalid_files_without_launching_apps() {
    let directory = tempfile::tempdir().unwrap();
    let application =
        Application::initialize(directory.path().join("data"), directory.path().join("logs"))
            .unwrap();
    let app = mock_builder()
        .manage(application)
        .invoke_handler(serverdeck_desktop_lib::command_handler())
        .build(tauri::generate_context!())
        .unwrap();
    let main = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    let other = tauri::WebviewWindowBuilder::new(&app, "untrusted-open", Default::default())
        .build()
        .unwrap();
    let origin = if cfg!(windows) {
        "http://tauri.localhost"
    } else {
        "tauri://localhost"
    };
    for path in [
        "config.ini".to_owned(),
        "https://example.invalid/file.ini".into(),
        directory.path().to_string_lossy().into_owned(),
        directory
            .path()
            .join("missing.ini")
            .to_string_lossy()
            .into_owned(),
        "bad\0file".into(),
    ] {
        assert!(
            get_ipc_response(
                &main,
                request("files_open_local", json!({"path": path}), origin)
            )
            .is_err()
        );
    }
    for (command, body) in [
        ("files_open_local", json!({"path": directory.path()})),
        (
            "external_prepare",
            json!({"id": "invalid-session", "path": "/config.ini"}),
        ),
        ("external_ready", json!({"token": "unknown"})),
        (
            "external_save",
            json!({"token": "unknown", "confirmed": true}),
        ),
    ] {
        assert!(get_ipc_response(&other, request(command, body.clone(), origin)).is_err());
        assert!(
            get_ipc_response(&main, request(command, body, "https://untrusted.invalid")).is_err()
        );
    }
    let error = get_ipc_response(
        &main,
        request(
            "external_save",
            json!({"token": "unknown", "confirmed": false}),
            origin,
        ),
    )
    .unwrap_err();
    assert!(error["message"].as_str().unwrap().contains("确认"));
}

#[test]
fn storage_preview_confirmation_and_main_window_acl() {
    use serverdeck_application::storage_location::{LOCATOR, Locations, Profile};
    use serverdeck_desktop_lib::storage_commands::StorageState;
    let directory = tempfile::tempdir().unwrap();
    let data = directory.path().join("data");
    let application = Application::initialize(data.clone(), data.join("logs")).unwrap();
    let profile = Profile::open(data.join(LOCATOR), Locations::unified(data.clone())).unwrap();
    let app = mock_builder()
        .manage(application)
        .manage(StorageState::new(profile))
        .invoke_handler(serverdeck_desktop_lib::command_handler())
        .build(tauri::generate_context!())
        .unwrap();
    let main = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    let other = tauri::WebviewWindowBuilder::new(&app, "storage-untrusted", Default::default())
        .build()
        .unwrap();
    let origin = if cfg!(windows) {
        "http://tauri.localhost"
    } else {
        "tauri://localhost"
    };
    let input = json!({"targetDirectory": directory.path().join("target")});
    let preview: Value =
        get_ipc_response(&main, request("app_storage_preview", input.clone(), origin))
            .unwrap()
            .deserialize()
            .unwrap();
    assert!(preview["bytes"].as_u64().unwrap() > 0);
    assert_eq!(preview["dirtyDocuments"], 0);
    assert!(
        get_ipc_response(
            &other,
            request("app_storage_preview", input.clone(), origin)
        )
        .is_err()
    );
    assert!(
        get_ipc_response(
            &main,
            request(
                "app_storage_preview",
                input.clone(),
                "https://untrusted.invalid"
            )
        )
        .is_err()
    );
    let config = serverdeck_core::AppConfig::default();
    let rejected = get_ipc_response(
        &main,
        request(
            "app_storage_migrate",
            json!({"targetDirectory": directory.path().join("target"), "config": config, "confirmed": false, "discardDocuments": false}),
            origin,
        ),
    );
    assert!(rejected.is_err());
    assert!(!data.join(LOCATOR).exists());
    assert!(get_ipc_response(&other, request("app_storage_ready", json!({}), origin)).is_err());
    let ready: Value = get_ipc_response(&main, request("app_storage_ready", json!({}), origin))
        .unwrap()
        .deserialize()
        .unwrap();
    assert_eq!(ready["rootDirectory"], data.to_string_lossy().as_ref());
}

#[test]
fn system_packages_use_standard_ipc_and_main_window_acl() {
    let directory = tempfile::tempdir().expect("tempdir");
    let data = directory.path().join("data");
    let logs = directory.path().join("logs");
    let application = Application::initialize(data.clone(), logs.clone()).expect("initialize");
    application
        .provision_bundled_plugins()
        .expect("standard packages");
    let app = mock_builder()
        .manage(application)
        .invoke_handler(serverdeck_desktop_lib::command_handler())
        .build(tauri::generate_context!())
        .expect("app");
    let main = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    let other = tauri::WebviewWindowBuilder::new(&app, "plugin", Default::default())
        .build()
        .unwrap();
    let origin = if cfg!(windows) {
        "http://tauri.localhost"
    } else {
        "tauri://localhost"
    };
    let invoke = |command: &str, body: Value| {
        get_ipc_response(&main, request(command, body, origin))
            .expect("IPC")
            .deserialize::<Value>()
            .unwrap()
    };
    let initial = invoke("plugin_list", json!({}));
    let source_directory =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../plugins/system");
    let expected_ids: std::collections::BTreeSet<_> = std::fs::read_dir(source_directory)
        .unwrap()
        .map(|entry| entry.unwrap())
        .filter(|entry| entry.file_type().unwrap().is_dir() && entry.file_name() != "packages")
        .map(|entry| {
            let manifest: Value =
                serde_json::from_slice(&std::fs::read(entry.path().join("manifest.json")).unwrap())
                    .unwrap();
            manifest["id"].as_str().unwrap().to_owned()
        })
        .collect();
    let initial_ids: std::collections::BTreeSet<_> = initial
        .as_array()
        .unwrap()
        .iter()
        .map(|plugin| plugin["manifest"]["id"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(expected_ids, initial_ids);
    for plugin in initial.as_array().unwrap() {
        assert_eq!(plugin["source"], "system");
        assert_eq!(plugin["enabled"], true);
        assert!(plugin["manifest"]["entry"]["backend"].is_string());
        let grant = invoke("plugin_permissions", json!({"id":plugin["manifest"]["id"]}));
        assert_eq!(grant["permissions"], plugin["manifest"]["permissions"]);
        assert!(grant.get("hostIds").is_none());
    }
    let id = "cn.hiboot.plugins.docker";
    assert_eq!(
        invoke("plugin_set_enabled", json!({"id":id,"enabled":true}))["enabled"],
        true
    );
    let revision = invoke("plugin_detail", json!({"id":id}))["revision"].clone();
    for (command, body) in [
        (
            "plugin_grant",
            json!({"id":id,"input":{"expectedRevision":revision,"permissions":["ui.contribute"],"operations":["ui.contribute"],"readRoots":[],"writeRoots":[],"confirmed":true}}),
        ),
        ("plugin_revoke", json!({"id":id})),
    ] {
        assert!(get_ipc_response(&main, request(command, body, origin)).is_err());
    }
    let ui = invoke("plugin_ui", json!({"id":id,"revision":revision}));
    assert_eq!(ui["uiVersion"], 4);
    assert_eq!(ui["frontend"]["script"], "frontend.js");
    assert_eq!(ui["frontend"]["style"], "frontend.css");
    assert_eq!(
        invoke("plugin_set_enabled", json!({"id":id,"enabled":false}))["enabled"],
        false
    );
    assert!(
        get_ipc_response(
            &main,
            request("plugin_ui", json!({"id":id,"revision":revision}), origin)
        )
        .is_err()
    );
    for (command, body) in [
        ("plugin_list", json!({})),
        ("plugin_set_enabled", json!({"id":id,"enabled":false})),
        (
            "plugin_tool_stage",
            json!({"id":"cn.hiboot.plugins.assistant","input":{"operation":"ai_prepare","args":{}}}),
        ),
        (
            "plugin_tool_cancel_request",
            json!({"id":"cn.hiboot.plugins.assistant","request":"forged"}),
        ),
        (
            "plugin_tool_abort_input",
            json!({"id":"cn.hiboot.plugins.assistant","inputId":"forged"}),
        ),
        (
            "plugin_terminal_open",
            json!({"id":id,"ticket":"forged","expectedHost":"x","expected":{"id":"abc123","bash":false,"confirmed":true},"size":{"cols":80,"rows":24},"events":"__CHANNEL__:0"}),
        ),
    ] {
        assert!(get_ipc_response(&other, request(command, body.clone(), origin)).is_err());
        assert!(
            get_ipc_response(&main, request(command, body, "https://untrusted.invalid")).is_err()
        );
    }
    invoke(
        "plugin_uninstall",
        json!({"input":{"id":id,"clearData":false,"confirmed":true}}),
    );
    let reopened = Application::initialize(data, logs).expect("reopen");
    reopened
        .provision_bundled_plugins()
        .expect("provision after uninstall");
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let after_uninstall = runtime.block_on(reopened.plugin_list()).unwrap();
    assert_eq!(after_uninstall.len(), expected_ids.len() - 1);
    assert!(
        after_uninstall
            .iter()
            .all(|plugin| plugin.manifest.id != id)
    );
}

#[test]
fn plugin_metadata_real_ipc_lifecycle_and_acl() {
    let directory = tempfile::tempdir().expect("tempdir");
    let application =
        Application::initialize(directory.path().join("data"), directory.path().join("logs"))
            .expect("initialize");
    let app = mock_builder()
        .manage(application)
        .invoke_handler(serverdeck_desktop_lib::command_handler())
        .build(tauri::generate_context!())
        .expect("app");
    let main = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .expect("window");
    let other = tauri::WebviewWindowBuilder::new(&app, "plugin", Default::default())
        .build()
        .expect("untrusted window");
    let origin = if cfg!(windows) {
        "http://tauri.localhost"
    } else {
        "tauri://localhost"
    };
    let invoke = |command: &str, body: Value| {
        get_ipc_response(&main, request(command, body, origin))
            .expect("IPC")
            .deserialize::<Value>()
            .expect("JSON")
    };
    let path = directory.path().join("metadata.sdplugin");
    let mut manifest: Value = serde_json::from_str(include_str!(
        "../../../../tests/fixtures/plugins/metadata/manifest.json"
    ))
    .expect("manifest");
    manifest["permissions"] = json!(["settings.read", "settings.write"]);
    manifest["files"] = json!([{"path":"readme.txt", "size":8, "sha256":serverdeck_plugin_core::package::digest(b"metadata")}]);
    std::fs::write(&path, serde_json::to_vec(&json!({"formatVersion":1,"manifest":manifest,"files":[{"path":"readme.txt","content":"bWV0YWRhdGE="}]})).unwrap()).unwrap();
    assert!(
        invoke("plugin_list", json!({}))
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        invoke("plugin_preview", json!({"path":path}))["id"],
        "dev.serverdeck.metadata"
    );
    let body = json!({"input":{"path":path,"developmentConfirmed":true,"expectedVersion":null}});
    let installed = invoke("plugin_install", body.clone());
    assert_eq!(installed["trust"], "local_development_unverified");
    assert!(get_ipc_response(&main, request("plugin_install", body, origin)).is_err());
    assert_eq!(
        invoke(
            "plugin_set_enabled",
            json!({"id":"dev.serverdeck.metadata","enabled":true})
        )["enabled"],
        true
    );
    assert_eq!(
        invoke("plugin_detail", json!({"id":"dev.serverdeck.metadata"}))["enabled"],
        true
    );
    let capability = |operation: Value| json!({"id":"dev.serverdeck.metadata","owner":"ipc-page","request":{"apiVersion":1,"requestId":"ipc","operation":{"kind":"platform","request":operation,"bindings":[]}}});
    assert_eq!(
        invoke(
            "plugin_capability",
            capability(json!({"kind":"settings_read"}))
        )["error"]["code"],
        "PLUGIN_PERMISSION_DENIED"
    );
    invoke(
        "plugin_grant",
        json!({"id":"dev.serverdeck.metadata","input":{"expectedRevision":installed["revision"],"permissions":["settings.read","settings.write"],"operations":["settings.read","settings.write"],"readRoots":[],"writeRoots":[],"confirmed":true}}),
    );
    assert_eq!(
        invoke(
            "plugin_permissions",
            json!({"id":"dev.serverdeck.metadata"})
        )["revision"],
        installed["revision"]
    );
    invoke(
        "plugin_capability",
        capability(json!({"kind":"settings_write","value":{"ipc":true}})),
    );
    assert_eq!(
        invoke(
            "plugin_capability",
            capability(json!({"kind":"settings_read"}))
        )["result"]["ipc"],
        true
    );
    let mut forged = capability(json!({"kind":"settings_read"}));
    forged["request"]["pluginId"] = json!("dev.other");
    assert!(get_ipc_response(&main, request("plugin_capability", forged, origin)).is_err());
    invoke("plugin_revoke", json!({"id":"dev.serverdeck.metadata"}));
    invoke(
        "plugin_set_enabled",
        json!({"id":"dev.serverdeck.metadata","enabled":true}),
    );
    assert_eq!(
        invoke(
            "plugin_capability",
            capability(json!({"kind":"settings_read"}))
        )["error"]["code"],
        "PLUGIN_PERMISSION_DENIED"
    );
    for command in [
        "plugin_preview",
        "plugin_preview_info",
        "plugin_ui",
        "plugin_pick",
        "plugin_save_development_kit",
        "plugin_install",
        "plugin_list",
        "plugin_inventory",
        "plugin_reinstall_bundled",
        "plugin_detail",
        "plugin_set_enabled",
        "plugin_uninstall",
        "plugin_statuses",
        "plugin_activate",
        "plugin_call",
        "plugin_health",
        "plugin_cancel",
        "plugin_grant",
        "plugin_permissions",
        "plugin_revoke",
        "plugin_reset",
        "plugin_continue",
        "plugin_cancel_scope",
        "plugin_close_scope",
        "plugin_scope_visibility",
        "plugin_platform_terminal_open",
        "plugin_approve",
        "plugin_events",
        "plugin_capability",
    ] {
        for (window, url) in [(&other, origin), (&main, "https://example.com")] {
            let failure = get_ipc_response(window, request(command, json!({}), url))
                .expect_err("plugin IPC restricted to local main");
            assert!(failure.to_string().contains("not allowed"));
        }
    }
    invoke(
        "plugin_uninstall",
        json!({"input":{"id":"dev.serverdeck.metadata","clearData":false,"confirmed":true}}),
    );
    assert!(
        invoke("plugin_list", json!({}))
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert!(
        !directory
            .path()
            .join("data/plugins/packages/dev.serverdeck.metadata")
            .exists()
    );
}

#[test]
fn real_wasm_backend_through_install_enable_call_disable_and_uninstall_ipc() {
    use base64::{Engine as _, engine::general_purpose::STANDARD};
    let directory = tempfile::tempdir().unwrap();
    let application =
        Application::initialize(directory.path().join("data"), directory.path().join("logs"))
            .unwrap();
    let app = mock_builder()
        .manage(application)
        .invoke_handler(serverdeck_desktop_lib::command_handler())
        .build(tauri::generate_context!())
        .unwrap();
    let main = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    let origin = if cfg!(windows) {
        "http://tauri.localhost"
    } else {
        "tauri://localhost"
    };
    let invoke = |command: &str, body: Value| {
        get_ipc_response(&main, request(command, body, origin))
            .expect("IPC")
            .deserialize::<Value>()
            .unwrap()
    };
    let bytes = wat::parse_str(include_str!(
        "../../../../tests/fixtures/plugins/hello-world/backend.wat"
    ))
    .unwrap();
    let mut manifest: Value = serde_json::from_str(include_str!(
        "../../../../tests/fixtures/plugins/hello-world/manifest.json"
    ))
    .unwrap();
    manifest["files"] = json!([{"path":"backend.wasm","size":bytes.len(),"sha256":serverdeck_plugin_core::package::digest(&bytes)}]);
    let path = directory.path().join("hello.sdplugin");
    std::fs::write(&path, serde_json::to_vec(&json!({"formatVersion":1,"manifest":manifest,"files":[{"path":"backend.wasm","content":STANDARD.encode(bytes)}]})).unwrap()).unwrap();
    invoke(
        "plugin_install",
        json!({"input":{"path":path,"developmentConfirmed":true,"expectedVersion":null}}),
    );
    assert!(
        get_ipc_response(
            &main,
            request(
                "plugin_activate",
                json!({"id":"dev.serverdeck.hello"}),
                origin
            )
        )
        .is_err()
    );
    invoke(
        "plugin_set_enabled",
        json!({"id":"dev.serverdeck.hello","enabled":true}),
    );
    assert_eq!(invoke("plugin_statuses", json!({}))[0]["state"], "active");
    assert_eq!(
        invoke(
            "plugin_call",
            json!({"id":"dev.serverdeck.hello","owner":"ipc-page","payload":{}})
        )["result"]["message"],
        "hello from isolated wasm"
    );
    assert_eq!(
        invoke("plugin_health", json!({"id":"dev.serverdeck.hello"}))["protocolVersion"],
        1
    );
    invoke(
        "plugin_set_enabled",
        json!({"id":"dev.serverdeck.hello","enabled":false}),
    );
    assert!(
        invoke("plugin_statuses", json!({}))
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert!(
        get_ipc_response(
            &main,
            request(
                "plugin_call",
                json!({"id":"dev.serverdeck.hello","owner":"ipc-page","payload":{}}),
                origin
            )
        )
        .is_err()
    );
    invoke(
        "plugin_uninstall",
        json!({"input":{"id":"dev.serverdeck.hello","clearData":false,"confirmed":true}}),
    );
    assert!(
        invoke("plugin_list", json!({}))
            .as_array()
            .unwrap()
            .is_empty()
    );
}

#[test]
fn real_ipc_dispatcher_roundtrip_validation_and_window_acl() {
    let directory = tempfile::tempdir().expect("tempdir");
    let application =
        Application::initialize(directory.path().join("data"), directory.path().join("logs"))
            .expect("initialize");
    let app = mock_builder()
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(application)
        .invoke_handler(serverdeck_desktop_lib::command_handler())
        .build(tauri::generate_context!())
        .expect("app");
    let main = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .expect("window");
    let origin = if cfg!(windows) {
        "http://tauri.localhost"
    } else {
        "tauri://localhost"
    };
    let response = get_ipc_response(&main, request("app_bootstrap", json!({}), origin))
        .expect("bootstrap")
        .deserialize::<Value>()
        .expect("json");
    assert_eq!(
        response["databaseVersion"],
        serverdeck_core::DATABASE_VERSION
    );
    assert_eq!(response["config"]["theme"], "dark");
    let ai = get_ipc_response(&main, request("ai_models", json!({}), origin))
        .expect("AI settings")
        .deserialize::<Value>()
        .unwrap();
    assert!(ai.as_array().unwrap().is_empty());
    // Real loopback completion verifies the test/save contract through the dispatcher.
    use std::io::{Read, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let fixture = std::thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        socket
            .set_read_timeout(Some(std::time::Duration::from_secs(5)))
            .unwrap();
        let mut data = Vec::new();
        loop {
            let mut b = [0; 4096];
            let n = socket.read(&mut b).unwrap();
            assert_ne!(n, 0);
            data.extend_from_slice(&b[..n]);
            if let Some(end) = data.windows(4).position(|w| w == b"\r\n\r\n") {
                let headers = std::str::from_utf8(&data[..end]).unwrap();
                let len: usize = headers
                    .lines()
                    .find_map(|l| {
                        l.to_ascii_lowercase()
                            .strip_prefix("content-length: ")
                            .map(str::to_owned)
                    })
                    .unwrap()
                    .parse()
                    .unwrap();
                if data.len() >= end + 4 + len {
                    break;
                }
            }
        }
        let body = r#"{"choices":[{"message":{"content":"OK"},"finish_reason":"stop"}]}"#;
        write!(
            socket,
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        )
        .unwrap();
    });
    let model_config = serde_json::to_value(serverdeck_core::ai::Config {
        model: "ipc-model".into(),
        base_url: format!("http://{address}/v1"),
        allow_insecure_http: true,
        ..Default::default()
    })
    .unwrap();
    let mut input = json!({"id":null,"expectedRevision":null,"name":"IPC 模型","config":model_config,"apiKey":"fixture-ipc-key","clearKey":false});
    assert_eq!(
        get_ipc_response(
            &main,
            request("ai_model_save", json!({"input":input}), origin)
        )
        .unwrap_err()["code"],
        "VALIDATION"
    );
    let tested = get_ipc_response(
        &main,
        request("ai_model_test", json!({"input":input}), origin),
    )
    .unwrap()
    .deserialize::<Value>()
    .unwrap();
    fixture.join().unwrap();
    input["testId"] = tested["id"].clone();
    let created = get_ipc_response(
        &main,
        request("ai_model_save", json!({"input":input}), origin),
    )
    .unwrap()
    .deserialize::<Value>()
    .unwrap();
    let model = &created["value"];
    for command in [
        "ai_resolve_hosts",
        "ai_prepare",
        "ai_send",
        "ai_execute",
        "ai_cancel",
        "plugin_tool_stage",
        "plugin_context",
    ] {
        assert!(
            get_ipc_response(&main, request(command, json!({}), origin)).is_err(),
            "Removed business IPC must not return: {command}"
        );
    }
    assert_eq!(model["name"], "IPC 模型");
    assert_eq!(model["hasKey"], true);
    assert!(!created.to_string().contains("fixture-ipc-key"));
    assert!(model.get("apiKey").is_none());
    assert!(model.get("secretRef").is_none());
    assert_eq!(
        get_ipc_response(&main, request("ai_models", json!({}), origin))
            .unwrap()
            .deserialize::<Value>()
            .unwrap()
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(get_ipc_response(&main,request("ai_model_delete",json!({"input":{"id":model["id"],"expectedRevision":model["revision"],"confirmed":false}}),origin)).unwrap_err()["code"],"VALIDATION");
    assert_eq!(
        get_ipc_response(
            &main,
            request(
                "ai_model_delete",
                json!({"input":{"id":model["id"],"expectedRevision":"stale","confirmed":true}}),
                origin
            )
        )
        .unwrap_err()["code"],
        "CONFLICT"
    );
    get_ipc_response(&main,request("ai_model_delete",json!({"input":{"id":model["id"],"expectedRevision":model["revision"],"confirmed":true}}),origin)).unwrap();
    assert!(
        get_ipc_response(&main, request("ai_models", json!({}), origin))
            .unwrap()
            .deserialize::<Value>()
            .unwrap()
            .as_array()
            .unwrap()
            .is_empty()
    );
    for (command, body) in [
        ("ai_send", json!({"id":"forged","confirmed":false})),
        (
            "ai_execute",
            json!({"input":{"proposalId":"forged","confirmed":true,"changeConfirmation":null}}),
        ),
    ] {
        assert!(
            get_ipc_response(&main, request(command, body, origin))
                .unwrap_err()
                .as_str()
                .unwrap()
                .contains("not allowed")
        );
    }
    let error=get_ipc_response(&main,request("transfer_start",json!({"input":{
        "sessionId":"fb29e64b-3628-46b0-8a22-66a6f450cc8a","direction":"upload","sources":["source"],"destination":"/tmp","conflict":"fail","confirmOverwrite":false
    }}),origin)).expect_err("no file connection");
    assert_eq!(
        error["code"], "NOT_FOUND",
        "transfer command must run on the async runtime before resolving its session"
    );
    std::fs::write(directory.path().join("actual local.txt"), b"fixture").expect("local fixture");
    let listing = get_ipc_response(
        &main,
        request(
            "files_local",
            json!({"path":directory.path().to_str().expect("unicode")}),
            origin,
        ),
    )
    .expect("local listing")
    .deserialize::<Value>()
    .expect("listing JSON");
    assert!(
        listing["entries"]
            .as_array()
            .expect("entries")
            .iter()
            .any(|entry| entry["name"] == "actual local.txt")
    );
    let mut config = response["config"].clone();
    assert_eq!(config["interfaceFontSize"], "standard");
    config["theme"] = json!("light");
    config["interfaceFontSize"] = json!("ultraLarge");
    let saved = get_ipc_response(
        &main,
        request("config_save", json!({ "config": config }), origin),
    )
    .expect("save")
    .deserialize::<Value>()
    .expect("json");
    assert_eq!(saved["theme"], "light");
    assert_eq!(saved["interfaceFontSize"], "ultraLarge");
    assert_eq!(
        saved["terminalFontSize"],
        response["config"]["terminalFontSize"]
    );
    let mut invalid = saved.clone();
    invalid["sidebarWidth"] = json!(0);
    let error = get_ipc_response(
        &main,
        request("config_save", json!({ "config": invalid }), origin),
    )
    .expect_err("invalid rejected");
    assert_eq!(error["code"], "VALIDATION");
    let response = get_ipc_response(&main, request("app_bootstrap", json!({}), origin))
        .expect("read")
        .deserialize::<Value>()
        .expect("json");
    assert_eq!(response["config"], saved);
    for command in ["backup_export", "backup_preview", "backup_restore"] {
        let error = get_ipc_response(&main, request(command, json!({}), origin))
            .expect_err("removed backup commands must be rejected by the local main window");
        assert!(
            error
                .as_str()
                .is_some_and(|message| message.contains("not allowed"))
        );
    }
    assert!(
        get_ipc_response(
            &main,
            request("app_bootstrap", json!({}), "https://example.com")
        )
        .is_err()
    );
    let other = tauri::WebviewWindowBuilder::new(&app, "untrusted", Default::default())
        .build()
        .expect("window");
    let drag = json!({"sessionId":"missing","sources":["/fixture.txt"]});
    assert_eq!(
        get_ipc_response(&main, request("files_drag_download", drag.clone(), origin))
            .expect_err("export requires a connected SFTP session")["code"],
        "VALIDATION"
    );
    for (window, url) in [(&other, origin), (&main, "https://example.com")] {
        let error = get_ipc_response(window, request("files_drag_download", drag.clone(), url))
            .expect_err("only the local main window can start native file dragging");
        assert!(error.as_str().is_some_and(|s| s.contains("not allowed")));
    }
    let switch = json!({"id":"missing","user":{"username":"root","serverPath":"","password":null}});
    assert_eq!(
        get_ipc_response(&main, request("files_switch_user", switch.clone(), origin))
            .expect_err("switch requires a live file lease")["code"],
        "NOT_FOUND"
    );
    for (window, url) in [(&other, origin), (&main, "https://example.com")] {
        let error = get_ipc_response(window, request("files_switch_user", switch.clone(), url))
            .expect_err("only local main window may authorize sudo SFTP");
        assert!(
            error
                .as_str()
                .is_some_and(|message| message.contains("not allowed"))
        );
    }
    for command in [
        "ai_models",
        "ai_local_codex_status",
        "ai_local_codex_authorize",
        "ai_local_tool_install",
        "ai_local_tool_install_cancel",
        "ai_local_claude_code_status",
        "ai_local_claude_code_authorize",
        "ai_model_save",
        "ai_model_test",
        "ai_model_delete",
        "ai_prepare",
        "ai_resolve_hosts",
        "ai_send",
        "ai_execute",
        "ai_cancel",
    ] {
        for (window, url) in [(&other, origin), (&main, "https://example.com")] {
            let error = get_ipc_response(window, request(command, json!({}), url))
                .expect_err("AI commands restricted to local main window");
            assert!(error.as_str().is_some_and(|s| s.contains("not allowed")));
        }
    }
    assert!(get_ipc_response(&other, request("app_bootstrap", json!({}), origin)).is_err());
    for (command, body) in [
        ("terminal_upload_pick", json!({"id":"missing"})),
        (
            "terminal_upload_claim_drop",
            json!({"id":"missing","grant":"forged"}),
        ),
        (
            "terminal_upload_prepare_drop",
            json!({"id":"missing","token":"forged","confirmed":true}),
        ),
        (
            "terminal_upload_read",
            json!({"id":"missing","token":"forged","index":0,"offset":0}),
        ),
        (
            "terminal_upload_release",
            json!({"id":"missing","token":"forged"}),
        ),
    ] {
        for (window, url) in [(&other, origin), (&main, "https://example.com")] {
            let error = get_ipc_response(window, request(command, body.clone(), url))
                .expect_err("upload commands must be restricted to the local main window");
            assert!(
                error
                    .as_str()
                    .is_some_and(|message| message.contains("not allowed"))
            );
        }
        if command != "terminal_upload_release" {
            let error = get_ipc_response(&main, request(command, body, origin))
                .expect_err("invalid terminal must be rejected before opening a picker or file");
            assert_eq!(error["code"], "NOT_FOUND");
        }
    }
    // Permission checks must reject these before touching the system clipboard.
    for (command, body) in [
        ("plugin:clipboard-manager|read_text", json!({})),
        (
            "plugin:clipboard-manager|write_text",
            json!({"text":"ACL test"}),
        ),
    ] {
        for (window, url) in [(&other, origin), (&main, "https://example.com")] {
            let error = get_ipc_response(window, request(command, body.clone(), url))
                .expect_err("clipboard access must be denied");
            assert!(
                error
                    .as_str()
                    .is_some_and(|message| message.contains("not allowed"))
            );
        }
    }
    for command in [
        "clear",
        "read_image",
        "write_image",
        "write_html",
        "write_secret",
    ] {
        let error = get_ipc_response(
            &main,
            request(
                &format!("plugin:clipboard-manager|{command}"),
                json!({}),
                origin,
            ),
        )
        .expect_err("only text clipboard commands are permitted");
        assert!(
            error
                .as_str()
                .is_some_and(|message| message.contains("not allowed"))
        );
    }
    let local = json!({"size":{"cols":0,"rows":24},"events":"__CHANNEL__:1"});
    let invalid = get_ipc_response(&main, request("terminal_local_open", local.clone(), origin))
        .expect_err("invalid local PTY size");
    assert_eq!(invalid["code"], "VALIDATION");
    assert!(
        get_ipc_response(
            &other,
            request("terminal_local_open", local.clone(), origin)
        )
        .is_err()
    );
    assert!(
        get_ipc_response(
            &main,
            request("terminal_local_open", local, "https://example.com")
        )
        .is_err()
    );
    assert!(get_ipc_response(&main, request("plugin:shell|execute", json!({}), origin)).is_err());
}

#[test]
fn host_management_ipc_uses_sqlite_and_never_exposes_secret_read_commands() {
    let directory = tempfile::tempdir().expect("dir");
    let app = mock_builder()
        .manage(
            Application::initialize(directory.path().join("data"), directory.path().join("logs"))
                .expect("init"),
        )
        .invoke_handler(serverdeck_desktop_lib::command_handler())
        .build(tauri::generate_context!())
        .expect("app");
    let main = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .expect("window");
    let origin = if cfg!(windows) {
        "http://tauri.localhost"
    } else {
        "tauri://localhost"
    };
    let invoke = |command: &str, body: Value| {
        get_ipc_response(&main, request(command, body, origin))
            .expect("ipc")
            .deserialize::<Value>()
            .expect("json")
    };
    let group = invoke(
        "group_save",
        json!({"id":null,"input":{"name":"IPC 分组","sortOrder":1}}),
    );
    assert!(group["parentId"].is_null());
    let child = invoke(
        "group_save",
        json!({"id":null,"input":{"name":"IPC 子文件夹","sortOrder":0,"parentId":group["id"]}}),
    );
    assert_eq!(child["parentId"], group["id"]);
    assert!(get_ipc_response(&main, request("group_save", json!({"id":group["id"],"input":{"name":"IPC 分组","sortOrder":1,"parentId":child["id"]}}), origin)).is_err());
    let mut input = json!({"name":"IPC 主机","hostname":"example.com","port":22,"username":"ops","authType":"agent","credentialId":null,"groupId":child["id"],"description":"原备注","favorite":false,"connectTimeoutSecs":15});
    let test_error = get_ipc_response(&main, request("host_test", json!({"input":input}), origin))
        .expect_err("host test requires authentication");
    assert_eq!(test_error["code"], "VALIDATION");
    let save_error = get_ipc_response(
        &main,
        request(
            "host_create_tested",
            json!({"input":input,"testId":"1ab96783-093d-4d83-9baf-4c694d6da65a"}),
            origin,
        ),
    )
    .expect_err("tested creation requires an issued receipt");
    assert_eq!(save_error["code"], "VALIDATION");
    assert!(
        invoke("host_list", json!({}))["hosts"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    let host = invoke("host_create", json!({"input":input}));
    input["description"] = json!("新备注");
    let error = get_ipc_response(
        &main,
        request(
            "host_update_tested",
            json!({"id":host["id"],"input":input,"testId":"1ab96783-093d-4d83-9baf-4c694d6da65a"}),
            origin,
        ),
    )
    .expect_err("tested edit requires an issued receipt");
    assert_eq!(error["code"], "VALIDATION");
    assert_eq!(
        invoke("host_list", json!({}))["hosts"][0]["description"],
        "原备注"
    );
    invoke("host_update", json!({"id":host["id"],"input":input}));
    let copy = invoke("host_copy", json!({"id":host["id"]}));
    assert_ne!(copy["id"], host["id"]);
    assert_eq!(copy["groupId"], child["id"]);
    let catalog = invoke("host_list", json!({}));
    assert_eq!(catalog["hosts"].as_array().expect("hosts").len(), 2);
    for (command, body) in [
        ("hosts_export", json!({})),
        ("hosts_import_archive", json!({"text":"{}"})),
    ] {
        let error = get_ipc_response(&main, request(command, body, origin))
            .expect_err("removed host JSON commands must be unavailable");
        assert!(error.as_str().is_some_and(|message| {
            message.contains("not allowed") || message.contains("not found")
        }));
    }
    assert_eq!(invoke("host_list", json!({})), catalog);
    let credential = invoke(
        "credential_save",
        json!({"id":null,"expectedRevision":null,"input":{"name":"IPC 私钥路径","kind":"private_key","keyPath":"~/.ssh/id_ed25519","secret":null,"clearSecret":false}}),
    );
    assert_eq!(credential["value"]["hasSecret"], false);
    assert!(!credential.to_string().contains("secretRef"));
    assert!(
        get_ipc_response(
            &main,
            request(
                "credential_read",
                json!({"id":credential["value"]["id"]}),
                origin
            )
        )
        .is_err()
    );
    input["password"] = json!("must-not-be-accepted");
    assert!(
        get_ipc_response(
            &main,
            request("host_create", json!({"input":input}), origin)
        )
        .is_err()
    );
    invoke("host_delete", json!({"id":host["id"]}));
    invoke("host_delete", json!({"id":copy["id"]}));
    invoke(
        "credential_delete",
        json!({"id":credential["value"]["id"],"detachHosts":false}),
    );
    invoke("group_delete", json!({"id":group["id"]}));
    let remaining = invoke("host_list", json!({}));
    assert!(
        remaining["groups"]
            .as_array()
            .expect("groups")
            .iter()
            .find(|g| g["id"] == child["id"])
            .expect("preserved child")["parentId"]
            .is_null()
    );
    invoke("group_delete", json!({"id":child["id"]}));
    assert!(
        invoke("host_list", json!({}))["hosts"]
            .as_array()
            .expect("hosts")
            .is_empty()
    );
}
