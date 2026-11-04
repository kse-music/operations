use serverdeck_application::Application;
use std::sync::Arc;
use tauri::{Manager, http};

const CSP: &str = "default-src 'none'; script-src sdplugin: http://sdplugin.localhost; style-src sdplugin: http://sdplugin.localhost 'unsafe-inline'; img-src data:; font-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; sandbox allow-scripts allow-forms";

pub fn register<R: tauri::Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    let slots = Arc::new(tokio::sync::Semaphore::new(8));
    builder.register_asynchronous_uri_scheme_protocol("sdplugin", move |context, request, responder| {
        let Ok(slot) = slots.clone().try_acquire_owned() else {
            let mut response = http::Response::new(b"Plugin UI busy".to_vec());
            *response.status_mut() = http::StatusCode::TOO_MANY_REQUESTS;
            responder.respond(response);
            return;
        };
        let state = context.app_handle().try_state::<Application>().map(|s| s.inner().clone());
        let allowed = context.webview_label() == "main" && request.method() == http::Method::GET;
        tauri::async_runtime::spawn_blocking(move || {
            let _slot = slot;
            let path = request.uri().path().trim_start_matches('/');
            let parts: Vec<_> = path.split('/').collect();
            let result = if allowed && parts.len() == 4 && request.uri().query().is_none() {
                state.ok_or(serverdeck_core::Error::ShuttingDown).and_then(|app| {
                    if parts[3] == "index.html" {
                        app.plugin_frontend_document(parts[0], parts[1], parts[2])
                    } else {
                        app.plugin_frontend_asset(parts[0], parts[1], parts[2], parts[3])
                    }
                })
            } else {
                Err(serverdeck_core::Error::Validation("插件界面请求无效"))
            };
            let (status, body) = match result {
                Ok(bytes) => (http::StatusCode::OK, bytes),
                Err(error) => {
                    if matches!(&error, serverdeck_core::Error::Storage(_)) {
                        tracing::warn!(operation="plugin_ui_resource", error=%error, "could not read plugin UI resource");
                    }
                    (http::StatusCode::FORBIDDEN, b"Plugin UI unavailable".to_vec())
                },
            };
            let mime = if path.ends_with(".js") { "text/javascript" }
                else if path.ends_with(".css") { "text/css" } else { "text/html" };
            let mut response = http::Response::new(body);
            *response.status_mut() = status;
            for (name, value) in [
                ("Content-Type", mime), ("Content-Security-Policy", CSP),
                ("Access-Control-Allow-Origin", "*"), ("Cache-Control", "no-store"),
                ("X-Content-Type-Options", "nosniff"),
            ] {
                response.headers_mut().insert(
                    http::header::HeaderName::from_static(match name {
                        "Content-Type" => "content-type",
                        "Content-Security-Policy" => "content-security-policy",
                        "Access-Control-Allow-Origin" => "access-control-allow-origin",
                        "Cache-Control" => "cache-control",
                        _ => "x-content-type-options",
                    }),
                    http::HeaderValue::from_static(value),
                );
            }
            responder.respond(response);
        });
    })
}
