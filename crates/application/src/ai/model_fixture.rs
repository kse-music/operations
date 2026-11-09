use super::*;
use serde_json::{Value, json};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};
pub(super) async fn model_requests(count: usize) -> (Config, tokio::task::JoinHandle<Value>) {
    model_requests_reply(count, "platform fixture".into()).await
}
pub(super) async fn model_requests_reply(
    count: usize,
    reply: String,
) -> (Config, tokio::task::JoinHandle<Value>) {
    model_sequence(vec![reply; count]).await
}
async fn model_sequence(replies: Vec<String>) -> (Config, tokio::task::JoinHandle<Value>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let task = tokio::spawn(async move {
        let mut last = Value::Null;
        for reply in replies {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut data = vec![];
            let end = loop {
                let mut b = [0; 4096];
                let n = stream.read(&mut b).await.unwrap();
                assert_ne!(n, 0);
                data.extend_from_slice(&b[..n]);
                if let Some(i) = data.windows(4).position(|w| w == b"\r\n\r\n") {
                    break i + 4;
                }
            };
            let header = std::str::from_utf8(&data[..end]).unwrap();
            let n: usize = header
                .lines()
                .find_map(|l| {
                    l.to_ascii_lowercase()
                        .strip_prefix("content-length: ")
                        .map(str::to_owned)
                })
                .unwrap()
                .parse()
                .unwrap();
            while data.len() < end + n {
                let mut b = [0; 4096];
                let n = stream.read(&mut b).await.unwrap();
                assert_ne!(n, 0);
                data.extend_from_slice(&b[..n]);
            }
            let request = serde_json::from_slice(&data[end..end + n]).unwrap();
            let body = json!({"choices":[{"message":{"content":reply},"finish_reason":"stop"}]})
                .to_string();
            stream
                .write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
            last = request;
        }
        last
    });
    (
        Config {
            base_url: format!("http://{address}/v1"),
            model: "fixture".into(),
            allow_insecure_http: true,
            ..Default::default()
        },
        task,
    )
}
