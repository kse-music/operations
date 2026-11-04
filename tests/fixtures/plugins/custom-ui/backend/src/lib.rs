use serverdeck_plugin_sdk::{json_reply, serde_json::{Value, json}};
fn handle(operation: i32, payload: Value) -> Value {
    if operation == 6 {
        let name = payload.get("values").and_then(|v| v.get("name")).and_then(Value::as_str).unwrap_or_default();
        return json_reply(json!({"output": format!("来自独立 WASM 的问候：{name}")}));
    }
    json_reply(json!({"ready": true}))
}
serverdeck_plugin_sdk::export_plugin!(handle);
