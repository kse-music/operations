use serverdeck_plugin_sdk::{
    Capability, Response, host_call, json_error, json_reply,
    serde_json::{self, Value, json},
};
fn handle(op: i32, payload: Value) -> Value {
    match op {
        6 => {
            let cap = match payload["action"].as_str() {
                Some("host") => Capability::HostsRead,
                Some("diagnose") => Capability::Execute {
                    command: "uname -a".into(),
                    timeout_secs: 10,
                },
                Some("settings_read") => Capability::SettingsRead,
                Some("settings_write") => Capability::SettingsWrite {
                    value: json!({"note":payload["values"]["note"].as_str().unwrap_or("")}),
                },
                _ => return json_error("ACTION", "Unknown UI action"),
            };
            json_reply(host_call(
                if payload["action"] == "settings_read" {
                    "settings"
                } else {
                    "result"
                },
                cap,
            ))
        }
        7 => {
            let response: Response = match serde_json::from_value(payload["hostResponse"].clone()) {
                Ok(r) => r,
                Err(_) => return json_error("PROTOCOL", "Invalid Host response"),
            };
            if let Some(error) = response.error {
                return json_error(&error.code, &error.message);
            }
            let value = if response.request_id == "settings" {
                json!({"values":{"note":response.result["note"].as_str().unwrap_or("")},"output":response.result})
            } else {
                json!({"output":response.result})
            };
            json_reply(json!({"kind":"done","value":value}))
        }
        _ => json_reply(json!({"apiVersion":1,"name":"Host Info"})),
    }
}
serverdeck_plugin_sdk::export_plugin!(handle);
