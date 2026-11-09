use super::*;
use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

pub async fn http_fixture(
    status: &str,
    body: String,
    delay: bool,
) -> (
    Config,
    tokio::task::JoinHandle<Value>,
    Arc<tokio::sync::Notify>,
) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let status = status.to_owned();
    let received = Arc::new(tokio::sync::Notify::new());
    let notify = received.clone();
    let task = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut bytes = Vec::new();
        let header_end = loop {
            let mut chunk = [0; 4096];
            let n = stream.read(&mut chunk).await.unwrap();
            assert_ne!(n, 0);
            bytes.extend_from_slice(&chunk[..n]);
            if let Some(i) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                break i + 4;
            }
        };
        let headers = std::str::from_utf8(&bytes[..header_end]).unwrap();
        assert!(headers.starts_with("POST /v1/chat/completions HTTP/1.1"));
        assert!(
            headers
                .to_ascii_lowercase()
                .contains("authorization: bearer test-key")
        );
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
        while bytes.len() < header_end + len {
            let mut chunk = [0; 4096];
            let n = stream.read(&mut chunk).await.unwrap();
            assert_ne!(n, 0);
            bytes.extend_from_slice(&chunk[..n]);
        }
        let request: Value = serde_json::from_slice(&bytes[header_end..header_end + len]).unwrap();
        notify.notify_one();
        if delay {
            std::future::pending::<()>().await;
        }
        let response = format!(
            "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nLocation: http://127.0.0.1:9/stolen\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        stream.write_all(response.as_bytes()).await.unwrap();
        request
    });
    (
        Config {
            base_url: format!("http://{address}/v1"),
            model: "fixture-model".into(),
            allow_insecure_http: true,
            ..Default::default()
        },
        task,
        received,
    )
}
pub fn messages(config: &Config, question: &str, context: Value) -> Value {
    serde_json::json!({"model":config.model,"messages":[{"role":"system","content":"Generic model fixture. Return the requested response."},{"role":"user","content":serde_json::json!({"input":question,"data":context}).to_string()}],"max_completion_tokens":config.max_output_tokens,"stream":false,"store":false})
}
#[test]
fn model_calls_are_bounded_revoked_independently_and_release_on_drop() {
    let models = Models::default();
    let a = models.begin("a").unwrap();
    let b = models.begin("b").unwrap();
    models.revoke_model("a").unwrap();
    assert!(a.cancel.is_cancelled());
    assert!(!b.cancel.is_cancelled());
    drop(a);
    drop(b);
    assert!(lock(&models.state).unwrap().active.is_empty());
    let calls = (0..4)
        .map(|_| models.begin("a").unwrap())
        .collect::<Vec<_>>();
    assert!(matches!(models.begin("excess"), Err(Error::Busy)));
    drop(calls);
    assert!(models.begin("new").is_ok());
}
#[tokio::test]
async fn generic_messages_are_forwarded_without_a_business_prompt_or_tools() {
    let (config, http, _) = http_fixture(
        "200 OK",
        r#"{"choices":[{"message":{"content":"fixture"},"finish_reason":"stop"}]}"#.into(),
        false,
    )
    .await;
    let body = messages(
        &config,
        "plugin supplied input",
        serde_json::json!({"owned":true}),
    );
    let response = provider::complete(&config, b"test-key", &body)
        .await
        .unwrap();
    assert_eq!(response.text, "fixture");
    let actual = http.await.unwrap();
    assert_eq!(actual["messages"], body["messages"]);
    assert!(actual.get("tools").is_none());
    assert_eq!(actual["store"], false);
}
