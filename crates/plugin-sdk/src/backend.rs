//! A small, single-action async executor. Await platform calls; business state stays in the plugin.
use crate::{ApiError, Capability, Response, host_call, json_error, json_reply, platform};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use std::{
    cell::RefCell,
    future::Future,
    pin::Pin,
    rc::Rc,
    task::{Context as TaskContext, Poll, Waker},
};
pub type Result<T> = std::result::Result<T, ApiError>;
pub type Action = Pin<Box<dyn Future<Output = Result<Value>>>>;
pub type Handler = fn(Context, String, Value) -> Action;
#[derive(Default)]
struct Bridge {
    sequence: u64,
    outgoing: Option<crate::Request>,
    waiting: Option<String>,
    response: Option<Result<Value>>,
}
#[derive(Clone)]
pub struct Context {
    bridge: Rc<RefCell<Bridge>>,
    bindings: Vec<String>,
}
impl Context {
    /// Bind later work to opaque platform resource revisions, without exposing credentials.
    pub fn with_bindings(&self, bindings: Vec<String>) -> Self {
        Self {
            bridge: self.bridge.clone(),
            bindings,
        }
    }
    /// Results larger than one wire message are transparently read and released.
    pub async fn request(&self, request: platform::Request) -> Result<Value> {
        let value = self.raw(request).await?;
        let Some(resource) = value.get("__pluginResult") else {
            return Ok(value);
        };
        let id = resource["id"].as_str().ok_or_else(format_error)?.to_owned();
        let bytes = resource["bytes"]
            .as_u64()
            .filter(|size| (1..=1024 * 1024).contains(size))
            .ok_or_else(format_error)? as usize;
        let chunks = resource["chunks"]
            .as_u64()
            .filter(|count| *count == bytes.div_ceil(32768) as u64)
            .ok_or_else(format_error)?;
        let mut buffer = Vec::with_capacity(bytes);
        let collected = async {
            for chunk in 0..chunks {
                let value = self
                    .raw(platform::Request::ResultRead {
                        result_id: id.clone(),
                        chunk: chunk as u32,
                    })
                    .await?;
                if value["chunk"].as_u64() != Some(chunk) {
                    return Err(format_error());
                }
                let decoded = STANDARD
                    .decode(value["dataBase64"].as_str().ok_or_else(format_error)?)
                    .map_err(|_| format_error())?;
                if buffer.len() + decoded.len() > bytes {
                    return Err(format_error());
                }
                buffer.extend_from_slice(&decoded);
            }
            if buffer.len() != bytes {
                return Err(format_error());
            }
            serde_json::from_slice(&buffer).map_err(|_| format_error())
        }
        .await;
        let closed = self
            .raw(platform::Request::ResultClose { result_id: id })
            .await;
        match (collected, closed) {
            (Ok(value), Ok(_)) => Ok(value),
            (Err(mut error), Err(cleanup)) => {
                error.message = format!("{}；结果释放失败：{}", error.message, cleanup.message);
                Err(error)
            }
            (Err(error), _) | (_, Err(error)) => Err(error),
        }
    }
    fn raw(&self, request: platform::Request) -> HostCall {
        HostCall {
            bridge: self.bridge.clone(),
            operation: Some(request),
            bindings: self.bindings.clone(),
            started: false,
        }
    }
    pub async fn execute(
        &self,
        host: impl Into<String>,
        command: platform::Command,
    ) -> Result<crate::CommandResult> {
        command.validate()?;
        let value = self
            .request(platform::Request::Execute {
                host_id: host.into(),
                command,
            })
            .await?;
        serde_json::from_value(value).map_err(|_| format_error())
    }
    pub async fn info(&self) -> Result<Value> {
        self.request(platform::Request::Info).await
    }
    async fn output(&self, value: Value) -> Result<Value> {
        let bytes = serde_json::to_vec(&value).map_err(|_| format_error())?;
        if bytes.len() <= 48 * 1024 {
            return Ok(value);
        }
        if bytes.len() > 1024 * 1024 {
            return Err(ApiError::new(
                "OUTPUT_LIMIT",
                "插件结果超过 1 MiB，请缩小范围",
            ));
        }
        let opened = self
            .raw(platform::Request::OutputOpen {
                bytes: bytes.len() as u32,
            })
            .await?;
        let id = opened["id"].as_str().ok_or_else(format_error)?.to_owned();
        let uploaded = async {
            for (offset, part) in bytes.chunks(32768).enumerate() {
                self.raw(platform::Request::OutputPart {
                    result_id: id.clone(),
                    offset: (offset * 32768) as u32,
                    data_base64: STANDARD.encode(part),
                })
                .await?;
            }
            self.raw(platform::Request::OutputFinish {
                result_id: id.clone(),
            })
            .await
        }
        .await;
        match uploaded {
            Ok(value) => Ok(value),
            Err(primary) => match self
                .raw(platform::Request::ResultClose { result_id: id })
                .await
            {
                Ok(_) => Err(primary),
                Err(cleanup) => Err(ApiError::new(
                    primary.code,
                    format!("{}；结果资源清理失败：{}", primary.message, cleanup.message),
                )),
            },
        }
    }
}
fn format_error() -> ApiError {
    ApiError::new("PLATFORM_RESPONSE", "平台响应格式无效或超出限制")
}
struct HostCall {
    bridge: Rc<RefCell<Bridge>>,
    operation: Option<platform::Request>,
    bindings: Vec<String>,
    started: bool,
}
impl Future for HostCall {
    type Output = Result<Value>;
    fn poll(self: Pin<&mut Self>, _cx: &mut TaskContext<'_>) -> Poll<Self::Output> {
        let this = self.get_mut();
        let mut bridge = this.bridge.borrow_mut();
        if this.started {
            return bridge
                .response
                .take()
                .map(Poll::Ready)
                .unwrap_or(Poll::Pending);
        }
        if bridge.waiting.is_some() || bridge.outgoing.is_some() {
            return Poll::Ready(Err(ApiError::new(
                "PLATFORM_CONCURRENT",
                "单个动作中的平台调用须按顺序等待",
            )));
        }
        let Some(operation) = this.operation.take() else {
            return Poll::Ready(Err(format_error()));
        };
        bridge.sequence = bridge.sequence.wrapping_add(1);
        let id = format!("platform-{}", bridge.sequence);
        bridge.waiting = Some(id.clone());
        bridge.outgoing = Some(crate::Request {
            api_version: crate::API_VERSION,
            request_id: id,
            operation: Capability::Platform {
                request: operation,
                bindings: this.bindings.clone(),
            },
        });
        this.started = true;
        Poll::Pending
    }
}
pub struct Runtime {
    handler: Handler,
    bridge: Rc<RefCell<Bridge>>,
    action: Option<Action>,
}
impl Runtime {
    pub fn new(handler: Handler) -> Self {
        Self {
            handler,
            bridge: Rc::default(),
            action: None,
        }
    }
    pub fn handle(&mut self, opcode: i32, payload: Value) -> Value {
        match opcode {
            6 => {
                self.action = None;
                let sequence = self.bridge.borrow().sequence;
                *self.bridge.borrow_mut() = Bridge {
                    sequence,
                    ..Bridge::default()
                };
                let Some(action) = payload["action"].as_str().filter(|name| !name.is_empty())
                else {
                    return json_error("ACTION", "缺少插件动作");
                };
                let input = payload.get("input").cloned().unwrap_or(Value::Null);
                let context = Context {
                    bridge: self.bridge.clone(),
                    bindings: Vec::new(),
                };
                let future = (self.handler)(context.clone(), action.to_owned(), input);
                self.action = Some(Box::pin(async move {
                    let value = future.await?;
                    context.output(value).await
                }));
            }
            7 => {
                let response =
                    match serde_json::from_value::<Response>(payload["hostResponse"].clone()) {
                        Ok(value) => value,
                        Err(_) => return self.fail("HOST_RESPONSE", "平台响应格式无效"),
                    };
                let matches =
                    self.bridge.borrow().waiting.as_deref() == Some(response.request_id.as_str());
                if !matches || self.action.is_none() {
                    return self.fail("HOST_RESPONSE", "平台响应与在途请求不匹配");
                }
                let mut bridge = self.bridge.borrow_mut();
                bridge.waiting = None;
                bridge.response = Some(match response.error {
                    Some(error) => Err(error),
                    None => Ok(response.result),
                });
            }
            _ => {
                self.action = None;
                *self.bridge.borrow_mut() = Bridge::default();
                return json_reply(json!({"ready":true}));
            }
        }
        let Some(action) = self.action.as_mut() else {
            return self.fail("ACTION", "插件没有在途动作");
        };
        let waker = Waker::noop();
        match action.as_mut().poll(&mut TaskContext::from_waker(waker)) {
            Poll::Ready(result) => {
                self.action = None;
                match result {
                    Ok(value) => json_reply(json!({"kind":"done","value":value})),
                    Err(error) => json_error(&error.code, &error.message),
                }
            }
            Poll::Pending => {
                let request = self.bridge.borrow_mut().outgoing.take();
                match request {
                    Some(request) => json_reply(host_call(&request.request_id, request.operation)),
                    None => self.fail("ASYNC_PENDING", "插件异步动作只能等待平台调用"),
                }
            }
        }
    }
    fn fail(&mut self, code: &str, message: &str) -> Value {
        self.action = None;
        *self.bridge.borrow_mut() = Bridge::default();
        json_error(code, message)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn handler(context: Context, action: String, input: Value) -> Action {
        Box::pin(async move {
            if action != "inspect" {
                return Err(ApiError::new("ACTION", "unknown"));
            }
            let first = context
                .execute(
                    input["host"].as_str().unwrap(),
                    platform::Command::new("tool").arg("literal; value"),
                )
                .await?;
            Ok(json!({"value":first.stdout.trim().parse::<u64>().map_err(|_|format_error())?+1}))
        })
    }
    fn resume(runtime: &mut Runtime, call: &Value, result: Value) -> Value {
        runtime.handle(7,json!({"hostResponse":{"requestId":call["result"]["request"]["requestId"],"result":result,"error":null}}))
    }
    #[test]
    fn business_input_and_output_stay_in_the_plugin_and_forged_resumes_are_rejected() {
        let mut runtime = Runtime::new(handler);
        let call = runtime.handle(6, json!({"action":"inspect","input":{"host":"owned"}}));
        assert_eq!(
            call["result"]["request"]["operation"]["request"]["hostId"],
            "owned"
        );
        let done = resume(
            &mut runtime,
            &call,
            json!({"state":"completed","exitCode":0,"stdout":"41\n","stderr":"","truncated":false,"message":null}),
        );
        assert_eq!(done["result"]["value"]["value"], 42);
        assert_eq!(
            runtime.handle(
                7,
                json!({"hostResponse":{"requestId":"forged","result":null,"error":null}})
            )["error"]["code"],
            "HOST_RESPONSE"
        );
    }
    #[test]
    fn large_platform_results_are_reassembled_and_released_before_business_parsing() {
        let mut runtime = Runtime::new(handler);
        let call = runtime.handle(6, json!({"action":"inspect","input":{"host":"owned"}}));
        let bytes=serde_json::to_vec(&json!({"state":"completed","exitCode":0,"stdout":"41\n","stderr":"","truncated":false,"message":null})).unwrap();
        let read = resume(
            &mut runtime,
            &call,
            json!({"__pluginResult":{"id":"owned-result","bytes":bytes.len(),"chunks":1}}),
        );
        assert_eq!(
            read["result"]["request"]["operation"]["request"]["kind"],
            "result_read"
        );
        let close = resume(
            &mut runtime,
            &read,
            json!({"chunk":0,"dataBase64":STANDARD.encode(bytes)}),
        );
        assert_eq!(
            close["result"]["request"]["operation"]["request"]["kind"],
            "result_close"
        );
        let done = resume(&mut runtime, &close, Value::Null);
        assert_eq!(done["result"]["value"]["value"], 42);
    }
    #[test]
    fn result_read_and_cleanup_failures_keep_both_causes() {
        let mut runtime = Runtime::new(handler);
        let call = runtime.handle(6, json!({"action":"inspect","input":{"host":"owned"}}));
        let read = resume(
            &mut runtime,
            &call,
            json!({"__pluginResult":{"id":"owned-result","bytes":1,"chunks":1}}),
        );
        let close=runtime.handle(7,json!({"hostResponse":{"requestId":read["result"]["request"]["requestId"],"result":null,"error":{"code":"READ_FAILED","message":"read failed"}}}));
        assert_eq!(
            close["result"]["request"]["operation"]["request"]["kind"],
            "result_close"
        );
        let done=runtime.handle(7,json!({"hostResponse":{"requestId":close["result"]["request"]["requestId"],"result":null,"error":{"code":"CLOSE_FAILED","message":"close failed"}}}));
        assert_eq!(done["error"]["code"], "READ_FAILED");
        assert!(
            done["error"]["message"]
                .as_str()
                .unwrap()
                .contains("read failed")
        );
        assert!(
            done["error"]["message"]
                .as_str()
                .unwrap()
                .contains("close failed")
        );
    }
}
