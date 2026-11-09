use serverdeck_plugin_sdk::{ApiError,backend::{Action,Context,Runtime},platform::Command,serde_json::{Value,json}};
fn dispatch(context:Context,action:String,input:Value)->Action{Box::pin(async move{match action.as_str(){
 "greet"=>{let name=input["name"].as_str().unwrap_or("").trim();if name.is_empty()||name.len()>240{return Err(ApiError::new("NAME_REQUIRED","请输入有效姓名"));}Ok(json!({"output":format!("你好，{name}！")}))},
 "inspect_memory"=>{let host=input["hostId"].as_str().filter(|host|!host.is_empty()).ok_or_else(||ApiError::new("HOST_REQUIRED","请选择主机"))?;let result=context.execute(host,Command::new("free").arg("-b")).await?.checked()?;let(used,total,available)=memory(&result.stdout)?;let info=context.info().await?;Ok(json!({"total":total,"used":used,"available":available,"status":if u128::from(available)*100/u128::from(total)<10{"可用内存低于10%，请进一步核对进程和缓存"}else{"可用内存不低于10%"},"sampledAt":info["unixMs"]}))},
 _=>Err(ApiError::new("UNKNOWN_ACTION","未知样例动作"))
}})}
fn memory(text:&str)->Result<(u64,u64,u64),ApiError>{let row=text.lines().find(|line|line.trim_start().starts_with("Mem:")).ok_or_else(||ApiError::new("MEMORY_FORMAT","远端 free 输出不兼容"))?;let numbers=row.split_whitespace().skip(1).map(str::parse::<u64>).collect::<Result<Vec<_>,_>>().map_err(|_|ApiError::new("MEMORY_FORMAT","内存计数无效"))?;if numbers.len()!=6||numbers[0]==0||numbers[1]>numbers[0]||numbers[5]>numbers[0]{return Err(ApiError::new("MEMORY_FORMAT","内存计数缺失或不一致"));}Ok((numbers[1],numbers[0],numbers[5]))}
std::thread_local!{static RUNTIME:std::cell::RefCell<Runtime>=std::cell::RefCell::new(Runtime::new(dispatch));}
fn handle(opcode:i32,payload:Value)->Value{RUNTIME.with_borrow_mut(|runtime|runtime.handle(opcode,payload))}
serverdeck_plugin_sdk::export_plugin!(handle);
#[cfg(test)]mod tests{use super::*;#[test]fn memory_business_rules_belong_to_this_plugin(){assert_eq!(memory("Mem: 1000 200 700 0 100 800").unwrap(),(200,1000,800));assert!(memory("Mem: 0 0 0 0 0 0").is_err());assert!(memory("Mem: invalid").is_err());}}
