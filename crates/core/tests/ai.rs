use serverdeck_core::ai::*;
#[test]
fn model_configuration_is_bounded() {
    let mut config = Config {
        model: "fixture".into(),
        ..Default::default()
    };
    assert!(config.validate().is_ok());
    config.max_output_tokens = 0;
    assert!(config.validate().is_err());
    config.max_output_tokens = 1024;
    config.context_window_tokens = 1024;
    assert!(config.validate().is_err());
    config.context_window_tokens = 8192;
    assert!(config.validate().is_ok());
}
