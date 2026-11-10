use serverdeck_plugin_sdk::{
    ApiError,
    backend::{Action, Context, Runtime},
    serde_json::Value,
};
mod agent;
mod budget;
mod collection;
mod disk;
mod files;
mod metrics;
mod metrics_types;
mod ops;
mod parse;
mod prompts;
mod redact;
mod routing;
mod summary;
mod task;
mod tools;
mod types;
mod workflow;
#[derive(Debug)]
pub enum Error {
    Validation(&'static str),
    Conflict,
    NotFound,
    Busy,
    Worker(Box<dyn std::error::Error>),
    Connection {
        code: &'static str,
        message: &'static str,
        source: Option<Box<dyn std::error::Error>>,
    },
    Platform(ApiError),
}
impl Error {
    pub fn message(&self) -> String {
        match self {
            Self::Validation(message) => message.to_string(),
            Self::Conflict => "模型或目标配置已变化，请重新查询确认".into(),
            Self::NotFound => "请求不存在、已消费或已过期".into(),
            Self::Busy => "助手请求资源已满".into(),
            Self::Worker(error) => format!("业务处理失败：{error}"),
            Self::Connection { message, .. } => message.to_string(),
            Self::Platform(error) => error.message.clone(),
        }
    }
}
impl From<ApiError> for Error {
    fn from(value: ApiError) -> Self {
        Self::Platform(value)
    }
}
impl From<Error> for ApiError {
    fn from(value: Error) -> Self {
        if let Error::Platform(error) = value {
            return error;
        }
        let code = match &value {
            Error::Validation(_) => "AI_INPUT",
            Error::Conflict => "AI_CONTEXT_CHANGED",
            Error::NotFound => "NOT_FOUND",
            Error::Busy => "BUSY",
            Error::Connection { code, .. } => code,
            _ => "AI_BUSINESS",
        };
        ApiError::new(code, value.message())
    }
}
fn dispatch(context: Context, action: String, input: Value) -> Action {
    Box::pin(async move {
        workflow::dispatch(context, action, input)
            .await
            .map_err(Into::into)
    })
}
std::thread_local! {static RUNTIME:std::cell::RefCell<Runtime>=std::cell::RefCell::new(Runtime::new(dispatch));}
fn handle(opcode: i32, payload: Value) -> Value {
    // Compile immutable rules once, using the startup entry's own fuel budget.
    if opcode == 0
        && let Err(error) = redact::initialize()
    {
        let error: ApiError = error.into();
        return serverdeck_plugin_sdk::json_error(&error.code, &error.message);
    }
    RUNTIME.with_borrow_mut(|runtime| runtime.handle(opcode, payload))
}
serverdeck_plugin_sdk::export_plugin!(handle);
