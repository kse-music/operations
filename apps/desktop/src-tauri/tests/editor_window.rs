use serde_json::{Value, json};
use serverdeck_application::Application;
use serverdeck_core::files::TextDocument;
use serverdeck_desktop_lib::{
    editor_commands::{EditorWindows, create_window},
    file_commands::ExitApproval,
};
use std::sync::atomic::AtomicBool;
use tauri::{
    Listener, Manager,
    ipc::{CallbackFn, InvokeBody},
    test::{INVOKE_KEY, MockRuntime, get_ipc_response, mock_builder},
    webview::InvokeRequest,
};

fn request(command: &str, body: Value, remote: bool) -> InvokeRequest {
    let origin = if remote {
        "https://untrusted.invalid"
    } else if cfg!(windows) {
        "http://tauri.localhost"
    } else {
        "tauri://localhost"
    };
    InvokeRequest {
        cmd: command.into(),
        callback: CallbackFn(0),
        error: CallbackFn(1),
        url: origin.parse().unwrap(),
        body: InvokeBody::Json(body),
        headers: Default::default(),
        invoke_key: INVOKE_KEY.into(),
    }
}

fn fixture() -> (
    tempfile::TempDir,
    tauri::App<MockRuntime>,
    tauri::WebviewWindow<MockRuntime>,
) {
    let directory = tempfile::tempdir().unwrap();
    let application =
        Application::initialize(directory.path().join("data"), directory.path().join("logs"))
            .unwrap();
    let app = mock_builder()
        .manage(application)
        .manage(EditorWindows::default())
        .manage(ExitApproval(AtomicBool::new(false)))
        .invoke_handler(serverdeck_desktop_lib::command_handler())
        .on_window_event(|window, event| {
            serverdeck_desktop_lib::editor_commands::window_event(window, event);
        })
        .build(tauri::generate_context!())
        .unwrap();
    let main = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    (directory, app, main)
}

fn document() -> TextDocument {
    TextDocument {
        token: "test-document".into(),
        session_id: "bound-session".into(),
        path: "/配置/server.conf".into(),
        content: "fixture text, never emitted to main status".into(),
        sha256: "fixture".into(),
        permissions: Some(0o600),
        uid: Some(1000),
        gid: Some(1000),
        atomic_save: true,
    }
}

#[test]
fn independent_editor_is_singleton_and_status_does_not_copy_file_content() {
    let (_directory, app, main) = fixture();
    create_window(app.handle(), document(), Some("ops@server.example")).unwrap();
    assert!(app.state::<EditorWindows>().is_open());
    assert!(
        create_window(
            app.handle(),
            TextDocument {
                token: "second".into(),
                ..document()
            },
            None,
        )
        .is_err()
    );
    assert!(app.get_webview_window("remote-editor-second").is_none());
    let status = get_ipc_response(&main, request("editor_status", json!({}), false))
        .unwrap()
        .deserialize::<Value>()
        .unwrap();
    assert_eq!(
        status,
        json!({"document":{"token":"test-document", "sessionId":"bound-session", "path":"/配置/server.conf"}, "dirty":false})
    );
    let error = get_ipc_response(
        &main,
        request(
            "files_close",
            json!({"id":"bound-session","cancel":true}),
            false,
        ),
    )
    .unwrap_err();
    assert!(error["message"].as_str().unwrap().contains("独立编辑器"));
}

#[test]
fn editor_can_load_only_its_bound_document_and_cannot_use_main_commands() {
    let (_directory, app, main) = fixture();
    create_window(app.handle(), document(), None).unwrap();
    let editor = app
        .get_webview_window("remote-editor-test-document")
        .unwrap();
    let loaded = get_ipc_response(
        &editor,
        request(
            "editor_load",
            json!({"token":"other-document","id":"other-session","path":"/etc/shadow"}),
            false,
        ),
    )
    .unwrap()
    .deserialize::<Value>()
    .unwrap();
    assert_eq!(loaded["document"]["token"], "test-document");
    assert_eq!(loaded["document"]["path"], "/配置/server.conf");
    assert_eq!(loaded["document"]["content"], document().content);
    assert!(loaded.get("config").is_none());
    assert!(loaded.get("dataDirectory").is_none());
    for (command, body) in [
        ("editor_status", json!({})),
        (
            "editor_open",
            json!({"id":"other-session","path":"/etc/shadow"}),
        ),
        (
            "text_read",
            json!({"id":"other-session","path":"/etc/shadow"}),
        ),
        (
            "text_save",
            json!({"input":{"token":"other-document","content":"replacement","confirmReplace":true}}),
        ),
        ("files_local", json!({"path":null})),
        ("files_close", json!({"id":"bound-session","cancel":true})),
        ("app_exit_confirm", json!({"confirmed":true})),
        ("app_bootstrap", json!({})),
    ] {
        assert!(
            get_ipc_response(&editor, request(command, body, false)).is_err(),
            "{command}"
        );
    }
    assert!(get_ipc_response(&main, request("editor_load", json!({}), false)).is_err());
    assert!(get_ipc_response(&editor, request("editor_load", json!({}), true)).is_err());
}

#[test]
fn an_editor_shaped_window_has_no_document_authority_without_a_backend_binding() {
    let (_directory, app, _main) = fixture();
    create_window(app.handle(), document(), None).unwrap();
    let other = tauri::WebviewWindowBuilder::new(&app, "remote-editor-forged", Default::default())
        .build()
        .unwrap();
    for (command, body) in [
        ("editor_load", json!({})),
        ("editor_dirty", json!({"dirty":false})),
        ("editor_save", json!({"content":"attack"})),
        ("editor_reload", json!({"discard":true})),
        ("editor_close", json!({"discard":true})),
    ] {
        let error = get_ipc_response(&other, request(command, body, false)).unwrap_err();
        assert!(
            error["message"].as_str().unwrap().contains("没有可访问"),
            "{command}: {error}"
        );
    }
    assert!(
        app.get_webview_window("remote-editor-test-document")
            .is_some()
    );
}

#[test]
fn a_failed_open_does_not_reserve_the_single_editor_slot() {
    let (_directory, app, main) = fixture();
    assert!(
        get_ipc_response(
            &main,
            request(
                "editor_open",
                json!({"id":"missing-session","path":"/config.ini"}),
                false
            )
        )
        .is_err()
    );
    assert!(!app.state::<EditorWindows>().is_open());
    create_window(app.handle(), document(), None).unwrap();
}

#[test]
fn unconfirmed_exit_reviews_an_open_editor_even_before_dirty_events_arrive() {
    let (_directory, app, main) = fixture();
    create_window(app.handle(), document(), None).unwrap();
    let reviewed = std::sync::Arc::new(AtomicBool::new(false));
    let flag = reviewed.clone();
    main.listen("app-exit-review", move |_| {
        flag.store(true, std::sync::atomic::Ordering::Release);
    });
    get_ipc_response(
        &main,
        request("app_exit_confirm", json!({"confirmed":false}), false),
    )
    .unwrap();
    assert!(reviewed.load(std::sync::atomic::Ordering::Acquire));
    assert!(
        !app.state::<ExitApproval>()
            .0
            .load(std::sync::atomic::Ordering::Acquire)
    );
    assert!(
        app.get_webview_window("remote-editor-test-document")
            .is_some()
    );
}
