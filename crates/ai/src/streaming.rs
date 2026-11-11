//! Actual provider deltas. HTTP framing, UTF-8 and completion are validated independently.
use crate::{
    failure,
    provider::{self, Completion},
};
use serde_json::Value;
use serverdeck_core::{
    Error,
    ai::{Config, Provider, Usage},
};
use tokio::sync::mpsc;

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextDelta {
    pub text: String,
    pub reset: bool,
}
pub type TextSink = mpsc::Sender<TextDelta>;

pub async fn emit(sink: Option<&TextSink>, text: &str, reset: bool) -> Result<(), Error> {
    let Some(sink) = sink else {
        return Ok(());
    };
    let mut rest = text;
    let mut reset = reset;
    loop {
        let mut end = rest.len().min(8192);
        while !rest.is_char_boundary(end) {
            end -= 1;
        }
        sink.send(TextDelta {
            text: rest[..end].to_owned(),
            reset,
        })
        .await
        .map_err(|_| failure("AI_STREAM_CLOSED", "模型文本流已关闭"))?;
        rest = &rest[end..];
        reset = false;
        if rest.is_empty() {
            return Ok(());
        }
    }
}

pub async fn complete(
    config: &Config,
    key: &[u8],
    body: &Value,
    sink: TextSink,
) -> Result<Completion, Error> {
    match config.provider {
        Provider::LocalCodex => {
            crate::codex::complete_with_sink(config, key, body, Some(sink)).await
        }
        Provider::LocalClaudeCode => {
            crate::claude::complete_with_sink(config, key, body, Some(sink)).await
        }
        Provider::OpenaiCompatible => remote(config, key, body, sink).await,
    }
}

#[derive(Default)]
struct Sse {
    line: Vec<u8>,
    data: Vec<u8>,
    text: String,
    finish: Option<String>,
    usage: Option<Usage>,
    done: bool,
}
impl Sse {
    async fn bytes(&mut self, bytes: &[u8], sink: &TextSink) -> Result<(), Error> {
        for &byte in bytes {
            if self.done {
                break;
            }
            if byte != b'\n' {
                if self.line.len() >= 256 * 1024 {
                    return Err(failure("AI_OUTPUT_LIMIT", "模型流事件超过上限"));
                }
                self.line.push(byte);
                continue;
            }
            if self.line.last() == Some(&b'\r') {
                self.line.pop();
            }
            let line = std::mem::take(&mut self.line);
            if line.is_empty() {
                if !self.data.is_empty() {
                    self.event(sink).await?;
                }
            } else if let Some(mut data) = line.strip_prefix(b"data:") {
                if data.first() == Some(&b' ') {
                    data = &data[1..];
                }
                if self.data.len() + data.len() + 1 > 256 * 1024 {
                    return Err(failure("AI_OUTPUT_LIMIT", "模型流事件超过上限"));
                }
                if !self.data.is_empty() {
                    self.data.push(b'\n');
                }
                self.data.extend_from_slice(data);
            }
        }
        Ok(())
    }
    async fn event(&mut self, sink: &TextSink) -> Result<(), Error> {
        let data = std::mem::take(&mut self.data);
        if data == b"[DONE]" {
            self.done = true;
            return Ok(());
        }
        let event: Value =
            serde_json::from_slice(&data).map_err(|e| provider::protocol(Some(Box::new(e))))?;
        if !event["error"].is_null() {
            return Err(failure("AI_STREAM_ERROR", "模型流返回错误，回答未完成"));
        }
        if let Some(u) = event.get("usage").filter(|u| !u.is_null()) {
            self.usage = u["prompt_tokens"]
                .as_u64()
                .zip(u["completion_tokens"].as_u64())
                .map(|(input_tokens, output_tokens)| Usage {
                    input_tokens,
                    output_tokens,
                });
        }
        let choices = event["choices"]
            .as_array()
            .ok_or_else(|| provider::protocol(None))?;
        if choices.is_empty() && !event["usage"].is_null() {
            return Ok(());
        }
        if choices.len() != 1 || choices[0]["index"].as_u64().is_some_and(|i| i != 0) {
            return Err(provider::protocol(None));
        }
        let choice = &choices[0];
        let delta = &choice["delta"];
        if delta
            .get("tool_calls")
            .is_some_and(|v| !v.is_null() && v.as_array().is_none_or(|a| !a.is_empty()))
            || delta.get("function_call").is_some_and(|v| !v.is_null())
            || matches!(
                choice["finish_reason"].as_str(),
                Some("tool_calls" | "function_call")
            )
        {
            return Err(failure(
                "AI_TOOL_REJECTED",
                "模型返回了未授权的工具调用，已拒绝处理",
            ));
        }
        if let Some(content) = delta.get("content").filter(|v| !v.is_null()) {
            let text = content.as_str().ok_or_else(|| provider::protocol(None))?;
            if self.finish.is_some() || self.text.len() + text.len() > 256 * 1024 {
                return Err(failure(
                    "AI_OUTPUT_LIMIT",
                    "模型流文本无效或超过256 KiB上限",
                ));
            }
            self.text.push_str(text);
            if !text.is_empty() {
                emit(Some(sink), text, false).await?;
            }
        }
        if let Some(reason) = choice["finish_reason"].as_str()
            && self.finish.replace(reason.into()).is_some()
        {
            return Err(provider::protocol(None));
        }
        Ok(())
    }
    fn finish(self) -> Result<Completion, Error> {
        if !self.done || self.finish.is_none() || self.text.trim().is_empty() {
            return Err(failure(
                "AI_STREAM_INCOMPLETE",
                "模型流未正常结束，已保留部分回答；未开放执行",
            ));
        }
        Ok(Completion {
            text: self.text,
            usage: self.usage,
            incomplete: self.finish.as_deref() != Some("stop"),
        })
    }
}
async fn remote(
    config: &Config,
    key: &[u8],
    body: &Value,
    sink: TextSink,
) -> Result<Completion, Error> {
    let mut response = provider::response(config, key, body).await?;
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|h| h.to_str().ok())
        .unwrap_or("");
    if !content_type
        .split(';')
        .next()
        .is_some_and(|s| s.trim().eq_ignore_ascii_case("text/event-stream"))
    {
        return Err(failure(
            "AI_STREAM_UNSUPPORTED",
            "模型服务未返回流式响应，请检查服务的stream支持；未自动重试",
        ));
    }
    let mut parser = Sse::default();
    let mut bytes = 0usize;
    while let Some(chunk) = response.chunk().await.map_err(provider::transport)? {
        bytes += chunk.len();
        if bytes > 4 * 1024 * 1024 {
            return Err(failure("AI_OUTPUT_LIMIT", "模型流响应超过4 MiB上限"));
        }
        parser.bytes(&chunk, &sink).await?;
        if parser.done {
            break;
        }
    }
    parser.finish()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    fn event(text: &str, finish: Value) -> String {
        format!(
            "data: {}\r\n\r\n",
            json!({"choices":[{"index":0,"delta":{"content":text},"finish_reason":finish}]})
        )
    }
    #[tokio::test]
    async fn split_sse_utf8_crlf_usage_and_finish_are_preserved_without_duplicate_text() {
        let wire = format!(
            ": ping\r\n\r\n{}{}data: {{\"choices\":[],\"usage\":{{\"prompt_tokens\":3,\"completion_tokens\":2}}}}\r\n\r\ndata: [DONE]\r\n\r\n",
            event("你😀", Value::Null),
            event("好", json!("stop"))
        );
        let (sink, mut rx) = mpsc::channel(16);
        let mut parser = Sse::default();
        for byte in wire.as_bytes() {
            parser.bytes(&[*byte], &sink).await.unwrap();
        }
        let complete = parser.finish().unwrap();
        assert_eq!(complete.text, "你😀好");
        assert!(!complete.incomplete);
        assert_eq!(complete.usage.unwrap().output_tokens, 2);
        let mut text = String::new();
        while let Ok(delta) = rx.try_recv() {
            text.push_str(&delta.text);
        }
        assert_eq!(text, complete.text);
    }
    #[tokio::test]
    async fn missing_done_invalid_data_tool_calls_and_remote_errors_never_complete() {
        for tail in [
            "",
            "data: broken\n\n",
            "data: {\"error\":{\"message\":\"provider secret\"}}\n\n",
            "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{}]}}]}\n\n",
        ] {
            let (sink, _rx) = mpsc::channel(16);
            let mut parser = Sse::default();
            parser
                .bytes(event("partial", Value::Null).as_bytes(), &sink)
                .await
                .unwrap();
            let result = parser
                .bytes(tail.as_bytes(), &sink)
                .await
                .and_then(|_| parser.finish());
            assert!(result.is_err(), "{tail}");
        }
        let (sink, _rx) = mpsc::channel(16);
        let mut parser = Sse::default();
        parser
            .bytes(
                format!("{}data: [DONE]\n\n", event("cut", json!("length"))).as_bytes(),
                &sink,
            )
            .await
            .unwrap();
        assert!(parser.finish().unwrap().incomplete);
    }
    #[tokio::test]
    async fn real_http_emits_the_first_text_before_the_server_allows_completion() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let gate = std::sync::Arc::new(tokio::sync::Notify::new());
        let release = gate.clone();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut bytes = Vec::new();
            let mut chunk = [0u8; 4096];
            let header_end = loop {
                let n = socket.read(&mut chunk).await.unwrap();
                assert!(n > 0);
                bytes.extend_from_slice(&chunk[..n]);
                if let Some(at) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                    break at + 4;
                }
            };
            let headers = std::str::from_utf8(&bytes[..header_end]).unwrap();
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
                let n = socket.read(&mut chunk).await.unwrap();
                assert!(n > 0);
                bytes.extend_from_slice(&chunk[..n]);
            }
            let request: Value =
                serde_json::from_slice(&bytes[header_end..header_end + len]).unwrap();
            assert_eq!(request["stream"], true);
            socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n").await.unwrap();
            socket
                .write_all(event("first ", Value::Null).as_bytes())
                .await
                .unwrap();
            release.notified().await;
            socket
                .write_all(format!("{}data: [DONE]\n\n", event("last", json!("stop"))).as_bytes())
                .await
                .unwrap();
        });
        let config = Config {
            base_url: format!("http://{address}/v1"),
            model: "fixture".into(),
            allow_insecure_http: true,
            ..Default::default()
        };
        let mut body = crate::tests::messages(&config, "test", json!({}));
        body["stream"] = json!(true);
        let (sink, mut rx) = mpsc::channel(16);
        let call = tokio::spawn(async move { complete(&config, b"test-key", &body, sink).await });
        let first = tokio::time::timeout(std::time::Duration::from_secs(3), rx.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(first.text, "first ");
        assert!(!call.is_finished());
        gate.notify_one();
        assert_eq!(call.await.unwrap().unwrap().text, "first last");
        server.await.unwrap();
    }
}
