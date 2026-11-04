use serverdeck_plugin_sdk::{
    Capability, Response, host_call, json_error, json_reply,
    serde_json::{self, Value, json},
};
thread_local! { static HOST: std::cell::RefCell<Option<Value>> = const { std::cell::RefCell::new(None) }; }

fn handle(operation: i32, payload: Value) -> Value {
    match operation {
        6 => {
            if payload["action"] != "diagnose" {
                return json_error("ACTION", "Expected diagnose action");
            }
            HOST.with_borrow_mut(|host| *host = None);
            json_reply(host_call("host", Capability::HostsRead))
        }
        7 => {
            let response: Response = match serde_json::from_value(payload["hostResponse"].clone()) {
                Ok(response) => response,
                Err(_) => return json_error("PROTOCOL", "Invalid host response"),
            };
            if let Some(error) = response.error {
                return json_error(&error.code, &error.message);
            }
            match response.request_id.as_str(){
                "host"=>{HOST.with_borrow_mut(|host|*host=Some(response.result));json_reply(host_call("diagnostic",Capability::Execute{command:"uname -a".into(),timeout_secs:10}))},
                "diagnostic"=>HOST.with_borrow_mut(|host|json_reply(json!({"kind":"done","value":{"host":host.take(),"diagnostic":response.result}}))),
                _=>json_error("PROTOCOL","Unexpected response correlation id"),
            }
        }
        _ => json_reply(json!({"message":"Public SDK diagnostics backend","apiVersion":1})),
    }
}
serverdeck_plugin_sdk::export_plugin!(handle);
