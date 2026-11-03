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
    config["theme"] = json!("light");
    let saved = get_ipc_response(
        &main,
        request("config_save", json!({ "config": config }), origin),
    )
    .expect("save")
    .deserialize::<Value>()
    .expect("json");
    assert_eq!(saved["theme"], "light");
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
    assert!(get_ipc_response(&other, request("app_bootstrap", json!({}), origin)).is_err());
    for (command, body) in [
        ("terminal_upload_pick", json!({"id":"missing"})),
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
    let mut input = json!({"name":"IPC 主机","hostname":"example.com","port":22,"username":"ops","authType":"agent","credentialId":null,"groupId":child["id"],"tags":["linux"],"description":"原备注","favorite":false,"connectTimeoutSecs":15});
    let host = invoke("host_create", json!({"input":input}));
    input["description"] = json!("新备注");
    invoke("host_update", json!({"id":host["id"],"input":input}));
    let copy = invoke("host_copy", json!({"id":host["id"]}));
    assert_ne!(copy["id"], host["id"]);
    assert_eq!(copy["groupId"], child["id"]);
    let catalog = invoke("host_list", json!({}));
    assert_eq!(catalog["hosts"].as_array().expect("hosts").len(), 2);
    let export = invoke("hosts_export", json!({}));
    assert!(!export.as_str().expect("export").contains("credentialId"));
    let exported: Value =
        serde_json::from_str(export.as_str().expect("export")).expect("json export");
    assert_eq!(exported["version"], 2);
    assert_eq!(
        exported["groups"]
            .as_array()
            .expect("groups")
            .iter()
            .find(|g| g["id"] == child["id"])
            .expect("child")["parentId"],
        group["id"]
    );
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
