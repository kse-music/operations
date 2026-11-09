use serverdeck_plugin_sdk::{ApiError,backend::{Action,Context,Runtime},platform::{Command,Request},serde_json::{Value,json}};
fn dispatch(context:Context,action:String,input:Value)->Action{Box::pin(async move{match action.as_str(){
 "host"=>Ok(json!({"output":context.request(Request::Hosts).await?})),
 "diagnose"=>{let host=input["hostId"].as_str().ok_or_else(||ApiError::new("HOST","请选择主机"))?;let result=context.execute(host,Command::new("uname").arg("-a")).await?.checked()?;Ok(json!({"output":result.stdout}))},
 "settings_read"=>{let value=context.request(Request::SettingsRead).await?;Ok(json!({"values":{"note":value["note"].as_str().unwrap_or("")},"output":value}))},
 "settings_write"=>{context.request(Request::SettingsWrite{value:json!({"note":input["note"].as_str().unwrap_or("")})}).await?;Ok(json!({"saved":true}))},
 _=>Err(ApiError::new("ACTION","Unknown fixture action"))
}})}
std::thread_local!{static RUNTIME:std::cell::RefCell<Runtime>=std::cell::RefCell::new(Runtime::new(dispatch));}
fn handle(op:i32,payload:Value)->Value{RUNTIME.with_borrow_mut(|runtime|runtime.handle(op,payload))}
serverdeck_plugin_sdk::export_plugin!(handle);
