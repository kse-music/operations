use serverdeck_plugin_sdk::{
    json_error, json_reply,
    serde_json::{Value, json},
};

fn handle(operation: i32, payload: Value) -> Value {
    // Operation 6 is the UI action opcode in the current wire protocol.
    if operation != 6 {
        return json_reply(json!({ "ready": true }));
    }
    if payload["action"].as_str() != Some("greet") {
        return json_error("UNKNOWN_ACTION", "未知的样例动作");
    }
    let name = payload["values"]["name"]
        .as_str()
        .unwrap_or_default()
        .trim();
    if name.is_empty() {
        return json_error("NAME_REQUIRED", "请输入姓名");
    }
    json_reply(json!({ "output": format!("你好，{name}！") }))
}

serverdeck_plugin_sdk::export_plugin!(handle);
