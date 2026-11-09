//! Test-only probe of the public platform; never included among system plugins.
use serverdeck_plugin_sdk::{ApiError,backend::{Action,Context,Runtime},platform::{self,Command},serde_json::{Value,json}};
fn dispatch(context:Context,action:String,input:Value)->Action{Box::pin(async move{match action.as_str(){
 "pipeline"=>{context.request(platform::Request::SettingsWrite{value:input["first"].clone()}).await?;let target=input["target"].as_str().ok_or_else(||ApiError::new("INPUT","target"))?;let port=input["port"].as_u64().and_then(|v|u16::try_from(v).ok()).ok_or_else(||ApiError::new("INPUT","port"))?;let result=context.request(platform::Request::TcpConnect{target:target.into(),port}).await;match result{Ok(value)=>Ok(json!({"connected":value})),Err(error)=>Ok(json!({"cancelled":error.code=="USER_CANCELLED","code":error.code}))}},
 "command"=>{let host=input["hostId"].as_str().ok_or_else(||ApiError::new("INPUT","host"))?;let command=serverdeck_plugin_sdk::serde_json::from_value::<Command>(input["command"].clone()).map_err(|_|ApiError::new("INPUT","command"))?;let result=context.execute(host,command).await?.checked()?;Ok(json!({"output":result.stdout}))},
 "platform"=>{let request=serverdeck_plugin_sdk::serde_json::from_value(input).map_err(|_|ApiError::new("INPUT","primitive"))?;context.request(request).await},
 "large"=>{let size=input["bytes"].as_u64().filter(|size|*size<=1024*1024).ok_or_else(||ApiError::new("INPUT","size"))?;Ok(json!({"text":"x".repeat(size as usize)}))},
 _=>Err(ApiError::new("ACTION","Unknown fixture action")),
}})}
std::thread_local!{static RUNTIME:std::cell::RefCell<Runtime>=std::cell::RefCell::new(Runtime::new(dispatch));}
fn handle(op:i32,payload:Value)->Value{RUNTIME.with_borrow_mut(|runtime|runtime.handle(op,payload))}
serverdeck_plugin_sdk::export_plugin!(handle);
