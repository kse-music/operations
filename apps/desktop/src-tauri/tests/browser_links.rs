use serde_json::json;
use serverdeck_desktop_lib::browser_commands::http_url;
use tauri::{
    ipc::{CallbackFn, InvokeBody},
    test::{INVOKE_KEY, get_ipc_response, mock_builder},
    webview::InvokeRequest,
};

#[test]
fn http_links_preserve_local_addresses_ports_queries_and_fragments() {
    for value in [
        "http://localhost:8080/login?state=abc&next=%2Fhome#result",
        "http://127.0.0.1:1420/",
        "http://[::1]:8080/",
        "https://example.com/path?q=%E4%B8%AD%E6%96%87#section",
        "https://example.com/",
    ] {
        assert_eq!(http_url(value).unwrap().as_str(), value);
    }
}

#[test]
fn links_reject_non_web_schemes_malformed_and_control_input() {
    for value in [
        "",
        "https://",
        "https://[invalid]/",
        "file:///C:/Windows/System32/cmd.exe",
        "javascript:alert(1)",
        "data:text/html,hello",
        "mailto:test@example.com",
        "ftp://example.com/file",
        "serverdeck://run",
        "--help",
        "https://example.com/path with spaces",
        "https://example.com/\r\nstart",
        "https://example.com/\0hidden",
    ] {
        assert!(http_url(value).is_err(), "accepted {value:?}");
    }
    assert!(http_url(&format!("https://example.com/{}", "a".repeat(32 * 1024))).is_err());
}

fn request(url: &str, origin: &str) -> InvokeRequest {
    InvokeRequest {
        cmd: "terminal_open_link".into(),
        callback: CallbackFn(0),
        error: CallbackFn(1),
        url: origin.parse().unwrap(),
        body: InvokeBody::Json(json!({ "url": url })),
        headers: Default::default(),
        invoke_key: INVOKE_KEY.into(),
    }
}

#[test]
fn browser_ipc_rejects_invalid_urls_and_untrusted_callers_without_launching() {
    let app = mock_builder()
        .invoke_handler(serverdeck_desktop_lib::command_handler())
        .build(tauri::generate_context!())
        .unwrap();
    let main = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    let other = tauri::WebviewWindowBuilder::new(&app, "untrusted-links", Default::default())
        .build()
        .unwrap();
    let origin = if cfg!(windows) {
        "http://tauri.localhost"
    } else {
        "tauri://localhost"
    };
    let error = get_ipc_response(&main, request("file:///C:/Windows", origin)).unwrap_err();
    assert_eq!(error["code"], "VALIDATION");
    let denied = get_ipc_response(&other, request("https://example.invalid/", origin)).unwrap_err();
    assert!(denied.as_str().unwrap().contains("not allowed"));
    let remote = get_ipc_response(
        &main,
        request("https://example.invalid/", "https://untrusted.invalid"),
    )
    .unwrap_err();
    assert!(remote.as_str().unwrap().contains("not allowed"));
}

#[test]
#[ignore = "opens the system default browser on an isolated loopback HTTP fixture"]
fn native_browser_opens_http_link() {
    use std::{
        io::{Read, Write},
        net::TcpListener,
        time::{Duration, Instant},
    };
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let url = format!(
        "http://{}/serverdeck-link-test?state=test&next=%2Fhome#result",
        listener.local_addr().unwrap()
    );
    tauri::async_runtime::block_on(
        serverdeck_desktop_lib::browser_commands::terminal_open_link(url),
    )
    .unwrap();
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        match listener.accept() {
            Ok((mut stream, _)) => {
                stream
                    .set_read_timeout(Some(Duration::from_secs(3)))
                    .unwrap();
                let mut buffer = [0; 4096];
                let length = stream.read(&mut buffer).unwrap();
                let request = String::from_utf8_lossy(&buffer[..length]);
                stream
                    .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nConnection: close\r\n\r\n<!doctype html><title>ServerDeck link test</title><p>ServerDeck browser link test passed. You can close this tab.</p>")
                    .unwrap();
                if request.starts_with("GET /serverdeck-link-test?state=test&next=%2Fhome ") {
                    break;
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                assert!(
                    Instant::now() < deadline,
                    "browser did not reach the loopback fixture"
                );
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(error) => panic!("loopback listener failed: {error}"),
        }
    }
}
