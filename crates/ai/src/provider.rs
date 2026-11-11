use crate::{check_request_budget, failure};
use reqwest::{
    Client, Url,
    header::{AUTHORIZATION, CONTENT_TYPE, HeaderValue},
};
use serde_json::Value;
use serverdeck_core::{
    Error,
    ai::{Config, Usage},
};
use std::{future::Future, time::Duration};

pub struct Completion {
    pub text: String,
    pub usage: Option<Usage>,
    pub incomplete: bool,
}

// Narrow provider boundary; future adapters implement this without access to SSH or approvals.
pub trait ModelProvider: Send + Sync {
    fn complete(
        &self,
        config: &Config,
        key: &[u8],
        body: &Value,
    ) -> impl Future<Output = Result<Completion, Error>> + Send;
}

pub struct OpenAiCompatible;
pub async fn complete(config: &Config, key: &[u8], body: &Value) -> Result<Completion, Error> {
    match config.provider {
        serverdeck_core::ai::Provider::LocalCodex => {
            crate::codex::complete(config, key, body).await
        }
        serverdeck_core::ai::Provider::LocalClaudeCode => {
            crate::claude::complete(config, key, body).await
        }
        serverdeck_core::ai::Provider::OpenaiCompatible => {
            OpenAiCompatible.complete(config, key, body).await
        }
    }
}
pub fn endpoint(config: &Config) -> Result<Url, Error> {
    config.validate()?;
    if config.provider.is_local() {
        let url = if config.provider == serverdeck_core::ai::Provider::LocalCodex {
            "codex://local"
        } else {
            "claude-code://local"
        };
        return Url::parse(url).map_err(|error| Error::Worker(Box::new(error)));
    }
    let mut url = Url::parse(&config.base_url)
        .map_err(|_| Error::Validation("AI Base URL 必须为完整 HTTP(S) 地址"))?;
    if url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !(url.scheme() == "https" || (url.scheme() == "http" && config.allow_insecure_http))
    {
        return Err(Error::Validation(
            "AI 地址须用 HTTPS；HTTP 必须显式允许，地址不能含凭据、查询或片段",
        ));
    }
    let path = format!("{}/chat/completions", url.path().trim_end_matches('/'));
    url.set_path(&path);
    Ok(url)
}

impl ModelProvider for OpenAiCompatible {
    async fn complete(
        &self,
        config: &Config,
        key: &[u8],
        body: &Value,
    ) -> Result<Completion, Error> {
        let mut response = response(config, key, body).await?;
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(transport)? {
            if bytes.len() + chunk.len() > 256 * 1024 {
                return Err(failure("AI_OUTPUT_LIMIT", "模型响应超过 256 KiB 上限"));
            }
            bytes.extend_from_slice(&chunk);
        }
        let response: Value =
            serde_json::from_slice(&bytes).map_err(|e| protocol(Some(Box::new(e))))?;
        let choice = response
            .get("choices")
            .and_then(Value::as_array)
            .and_then(|v| v.first())
            .ok_or_else(|| protocol(None))?;
        let message = &choice["message"];
        // Tool/function requests are never dispatched, even if the provider invents them.
        if message
            .get("tool_calls")
            .is_some_and(|v| !v.is_null() && v.as_array().is_none_or(|a| !a.is_empty()))
            || message.get("function_call").is_some_and(|v| !v.is_null())
        {
            return Err(failure(
                "AI_TOOL_REJECTED",
                "模型返回了未授权的工具调用，已拒绝处理",
            ));
        }
        let text = message["content"]
            .as_str()
            .filter(|s| !s.trim().is_empty())
            .ok_or_else(|| protocol(None))?
            .to_owned();
        let usage = response.get("usage").and_then(|u| {
            Some(Usage {
                input_tokens: u["prompt_tokens"].as_u64()?,
                output_tokens: u["completion_tokens"].as_u64()?,
            })
        });
        Ok(Completion {
            text,
            usage,
            incomplete: choice["finish_reason"] != "stop",
        })
    }
}
pub(super) async fn response(
    config: &Config,
    key: &[u8],
    body: &Value,
) -> Result<reqwest::Response, Error> {
    let url = endpoint(config)?;
    let wire = serde_json::to_vec(body).map_err(|error| Error::Worker(Box::new(error)))?;
    let output_tokens = body["max_completion_tokens"]
        .as_u64()
        .ok_or(Error::Validation("模型请求缺少输出上限"))?;
    check_request_budget(config, wire.len(), output_tokens)?;
    let mut authorization = Vec::with_capacity(key.len() + 7);
    authorization.extend_from_slice(b"Bearer ");
    authorization.extend_from_slice(key);
    let authorization = zeroize::Zeroizing::new(authorization);
    let mut header = HeaderValue::from_bytes(&authorization)
        .map_err(|_| Error::Validation("API Key 包含非法字符"))?;
    header.set_sensitive(true);
    // No redirects (even same-origin), retries or ambient proxies carrying private context.
    let client = Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .no_proxy()
        .connect_timeout(Duration::from_secs(8))
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(transport)?;
    let response = client
        .post(url)
        .header(AUTHORIZATION, header)
        .header(CONTENT_TYPE, "application/json")
        .body(wire)
        .send()
        .await
        .map_err(transport)?;
    if !response.status().is_success() {
        let status = response.status().as_u16();
        tracing::warn!(
            operation = "ai_http",
            status,
            "AI request rejected; body not logged"
        );
        return Err(match status {
            401 | 403 => failure("AI_AUTH", "模型认证失败，请检查 API Key 和权限"),
            429 => failure("AI_RATE_LIMIT", "模型限流或额度不足，请稍后手动重试"),
            300..=399 => failure(
                "AI_REDIRECT",
                "模型地址发生重定向；为防止泄露上下文，已拒绝跟随",
            ),
            _ => failure(
                "AI_HTTP",
                "模型服务返回错误，请检查服务和模型 ID；未自动重试",
            ),
        });
    }
    Ok(response)
}
pub(super) fn protocol(source: Option<Box<dyn std::error::Error + Send + Sync>>) -> Error {
    Error::Connection {
        code: "AI_PROTOCOL",
        message: "模型响应格式无效，未生成可执行建议",
        source,
    }
}
pub(super) fn transport(error: reqwest::Error) -> Error {
    let timeout = error.is_timeout();
    tracing::warn!(
        operation = "ai_transport",
        timeout,
        "AI network request failed; URL and payload not logged"
    );
    Error::Connection {
        code: if timeout { "AI_TIMEOUT" } else { "AI_NETWORK" },
        message: if timeout {
            "模型请求超时；服务端可能已计费，未自动重试"
        } else {
            "无法连接模型服务，请检查地址、网络和证书"
        },
        source: Some(Box::new(error.without_url())),
    }
}
