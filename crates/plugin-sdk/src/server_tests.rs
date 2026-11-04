use crate::{Capability, serde_json::json, server::SurfaceState};

#[test]
fn independent_frontend_requires_v4_safe_assets_and_declared_actions() {
    let text = include_str!("../../../tests/fixtures/plugins/custom-ui/ui.json");
    let original: crate::ui::Ui = serde_json::from_str(text).unwrap();
    original.validate().unwrap();
    assert!(matches!(
        original.pages[0].surface,
        Some(crate::ui::Surface::Frontend)
    ));
    let mut legacy = original.clone();
    legacy.ui_version = 3;
    assert!(legacy.validate().is_err());
    let mut missing = original.clone();
    missing.frontend = None;
    assert!(missing.validate().is_err());
    for path in [
        "../frontend.js",
        "https://evil.example/a.js",
        "<script>.js",
        "/absolute.js",
        "a\\b.js",
    ] {
        let mut invalid = original.clone();
        invalid.frontend.as_mut().unwrap().script = path.into();
        assert!(invalid.validate().is_err(), "{path}");
    }
    let mut unknown: serde_json::Value = serde_json::from_str(text).unwrap();
    unknown["frontend"]["url"] = json!("https://evil.example");
    assert!(serde_json::from_value::<crate::ui::Ui>(unknown).is_err());
}

#[test]
fn surface_only_forwards_its_policy_and_matches_real_host_responses() {
    let mut state = SurfaceState::default();
    let allow = |cap: &Capability| matches!(cap, Capability::MetricsOpen { .. });
    let denied = state.handle(
        6,
        json!({"action":"bridge","values":{"request":"{\"kind\":\"settings_read\"}"}}),
        allow,
    );
    assert_eq!(denied["error"]["code"], "CAPABILITY");
    let request = state.handle(6, json!({"action":"bridge","values":{"request":"{\"kind\":\"metrics_open\",\"intervalSecs\":3}"}}), allow);
    assert_eq!(
        request["result"]["request"]["operation"]["kind"],
        "metrics_open"
    );
    let id = request["result"]["request"]["requestId"].clone();
    let reply = state.handle(
        7,
        json!({"hostResponse":{"requestId":id,"result":{"id":"opaque"},"error":null}}),
        allow,
    );
    assert_eq!(reply["result"]["value"]["id"], "opaque");
    let forged = state.handle(
        7,
        json!({"hostResponse":{"requestId":"forged","result":true,"error":null}}),
        allow,
    );
    assert_eq!(forged["error"]["code"], "HOST_RESPONSE");
}

#[test]
fn guest_cannot_supply_native_confirmation() {
    assert!(serde_json::from_value::<Capability>(json!({"kind":"system_query","request":{"kind":"container_action","id":"abc123","action":"stop","confirmed":true}})).is_err());
}

#[test]
fn server_surface_rejects_unsupported_versions_categories_and_mixed_form_actions() {
    let original: crate::ui::Ui =
        serde_json::from_str(include_str!("../../../plugins/system/resources/ui.json")).unwrap();
    original.validate().unwrap();
    let mut legacy = original.clone();
    legacy.ui_version = 1;
    assert!(legacy.validate().is_err());
    let mut duplicate = original.clone();
    duplicate.pages[0].surface = Some(crate::ui::Surface::Monitor {
        sections: vec!["overview".into(), "overview".into()],
    });
    assert!(duplicate.validate().is_err());
    let mut unknown = original.clone();
    unknown.pages[0].surface = Some(crate::ui::Surface::Monitor {
        sections: vec!["containers".into()],
    });
    assert!(unknown.validate().is_err());
    let mut mixed = original.clone();
    mixed.pages[0].initial_action = Some("bridge".into());
    assert!(mixed.validate().is_err());
    let mut actions = original;
    let extra = actions.pages[0].actions[0].clone();
    actions.pages[0].actions.push(extra);
    assert!(actions.validate().is_err());
}

#[test]
fn tool_surfaces_require_ui_v3_and_keep_bridge_policy_and_inputs_closed() {
    use crate::{
        tools::{Operation, Tool},
        ui::{Surface, Ui},
    };
    let original: Ui =
        serde_json::from_str(include_str!("../../../plugins/system/assistant/ui.json")).unwrap();
    original.validate().unwrap();
    let mut legacy = original.clone();
    legacy.ui_version = 2;
    assert!(legacy.validate().is_err());
    let mut mixed = original.clone();
    mixed.pages[0].initial_action = Some("bridge".into());
    assert!(mixed.validate().is_err());
    let mut unknown = serde_json::to_value(&original).unwrap();
    unknown["pages"][0]["surface"]["tool"] = json!("arbitrary_native_command");
    assert!(serde_json::from_value::<Ui>(unknown).is_err());
    let mut server: Ui =
        serde_json::from_str(include_str!("../../../plugins/system/resources/ui.json")).unwrap();
    server.ui_version = 3;
    server.frontend = None;
    server.validate().unwrap();
    assert!(matches!(
        original.pages[0].surface,
        Some(Surface::Tool {
            tool: Tool::Assistant
        })
    ));
    let mut state = SurfaceState::default();
    let allow = |cap: &Capability| matches!(cap,Capability::ToolInvoke{operation,..} if operation.tool()==Tool::Assistant);
    let bridge = |operation| json!({"action":"bridge","values":{"request":serde_json::to_string(&Capability::ToolInvoke{input_id:"opaque".into(),operation}).unwrap()}});
    assert_eq!(
        state.handle(6, bridge(Operation::AutomationEntryDelete), allow)["error"]["code"],
        "CAPABILITY"
    );
    let accepted = state.handle(6, bridge(Operation::AiPrepare), allow);
    assert_eq!(
        accepted["result"]["request"]["operation"]["inputId"],
        "opaque"
    );
    assert!(
        serde_json::from_value::<Capability>(
            json!({"kind":"tool_invoke","inputId":"opaque","operation":"ai_send","confirmed":true})
        )
        .is_err()
    );
}
