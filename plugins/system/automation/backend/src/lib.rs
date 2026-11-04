use serverdeck_plugin_sdk::{Capability, serde_json::Value, server::SurfaceState, tools::Tool};
use std::sync::Mutex;
static STATE: Mutex<Option<SurfaceState>> = Mutex::new(None);
fn allows(cap: &Capability) -> bool {
    matches!(cap, Capability::ToolInvoke {operation, ..} if operation.tool() == Tool::Automation)
}
fn handle(operation: i32, payload: Value) -> Value {
    let Ok(mut guard) = STATE.lock() else {
        return serverdeck_plugin_sdk::json_error("STATE", "Plugin state is unavailable");
    };
    guard
        .get_or_insert_with(SurfaceState::default)
        .handle(operation, payload, allows)
}
serverdeck_plugin_sdk::export_plugin!(handle);
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn limits_calls_to_its_public_tool_domain() {
        assert!(!allows(&Capability::SettingsRead));
        for operation in [
            serverdeck_plugin_sdk::tools::Operation::AiPrepare,
            serverdeck_plugin_sdk::tools::Operation::BatchList,
            serverdeck_plugin_sdk::tools::Operation::AutomationCatalog,
            serverdeck_plugin_sdk::tools::Operation::DiagnosticList,
        ] {
            assert_eq!(
                allows(&Capability::ToolInvoke {
                    input_id: "owned-ticket".into(),
                    operation
                }),
                operation.tool() == Tool::Automation
            );
        }
    }
}
