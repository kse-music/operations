use serde_json::json;
use serverdeck_application::Application;
use tauri::{
    ipc::{CallbackFn, InvokeBody},
    test::{INVOKE_KEY, get_ipc_response, mock_builder},
    webview::InvokeRequest,
};

fn request(command: &str, body: InvokeBody, url: &str) -> InvokeRequest {
    InvokeRequest {
        cmd: command.into(),
        callback: CallbackFn(0),
        error: CallbackFn(1),
        url: url.parse().expect("url"),
        body,
        headers: Default::default(),
        invoke_key: INVOKE_KEY.into(),
    }
}

#[test]
fn binary_zmodem_requires_main_origin_bounded_raw_payload_and_native_file_grant() {
    let directory = tempfile::tempdir().expect("directory");
    let app = mock_builder()
        .manage(
            Application::initialize(directory.path().join("data"), directory.path().join("logs"))
                .expect("application"),
        )
        .invoke_handler(serverdeck_desktop_lib::command_handler())
        .build(tauri::generate_context!())
        .expect("mock IPC runtime");
    let main = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .expect("main");
    let other = tauri::WebviewWindowBuilder::new(&app, "untrusted-zmodem", Default::default())
        .build()
        .expect("other");
    let origin = if cfg!(windows) {
        "http://tauri.localhost"
    } else {
        "tauri://localhost"
    };
    let read_body = json!({"id":"missing","token":"forged","index":0,"offset":0});
    assert_eq!(
        get_ipc_response(
            &main,
            request(
                "terminal_zmodem_read",
                InvokeBody::Json(read_body.clone()),
                origin
            )
        )
        .expect_err("grant required")["code"],
        "NOT_FOUND"
    );
    for (window, url) in [(&other, origin), (&main, "https://untrusted.invalid")] {
        let error = get_ipc_response(
            window,
            request(
                "terminal_zmodem_read",
                InvokeBody::Json(read_body.clone()),
                url,
            ),
        )
        .expect_err("read ACL");
        assert!(
            error
                .as_str()
                .is_some_and(|message| message.contains("not allowed"))
        );
        let error = get_ipc_response(
            window,
            request("terminal_zmodem_write", InvokeBody::Raw(vec![24]), url),
        )
        .expect_err("write ACL");
        assert!(
            error
                .as_str()
                .is_some_and(|message| message.contains("not allowed"))
        );
    }
    for body in [
        InvokeBody::Json(json!({"data":[24]})),
        InvokeBody::Raw(vec![]),
        InvokeBody::Raw(vec![0; 256 * 1024 + 1]),
        InvokeBody::Raw(vec![24]),
    ] {
        assert_eq!(
            get_ipc_response(&main, request("terminal_zmodem_write", body, origin))
                .expect_err("payload or headers invalid")["code"],
            "VALIDATION"
        );
    }
    let mut forged = request(
        "terminal_zmodem_write",
        InvokeBody::Raw(vec![0, 24, 255]),
        origin,
    );
    forged.headers.insert(
        "x-serverdeck-session",
        "missing".parse().expect("session header"),
    );
    forged.headers.insert(
        "x-serverdeck-token",
        "forged".parse().expect("grant header"),
    );
    assert_eq!(
        get_ipc_response(&main, forged).expect_err("forged grant")["code"],
        "NOT_FOUND"
    );
}
