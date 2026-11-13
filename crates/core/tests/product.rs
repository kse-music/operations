use serverdeck_core::{AppConfig, product::*};
#[test]
fn global_shortcuts_cannot_capture_terminal_control_keys_or_collide() {
    let mut p = ProductPreferences::default();
    p.validate().unwrap();
    p.shortcuts.insert("search".into(), "Ctrl+C".into());
    assert!(p.validate().is_err());
    p.shortcuts.insert("search".into(), "Ctrl+Shift+J".into());
    p.validate().unwrap();
    p.shortcuts.insert("search".into(), "Ctrl+Shift+P".into());
    assert!(p.validate().is_err());
    p.shortcuts.insert("search".into(), "Ctrl+,".into());
    p.validate().unwrap();
}
#[test]
fn interface_language_accepts_chinese_and_english_but_rejects_unknown_values() {
    for language in ["zh-CN", "en-US"] {
        let mut config = AppConfig::default();
        config.product.language = language.into();
        config.validate().unwrap();
        let serialized = serde_json::to_string(&config).unwrap();
        let restored: AppConfig = serde_json::from_str(&serialized).unwrap();
        assert_eq!(restored.product.language, language);
    }
    for language in ["", "en", "fr-FR", "EN-US"] {
        let mut config = AppConfig::default();
        config.product.language = language.into();
        assert!(config.validate().is_err());
    }
}
#[test]
fn removed_task_shortcut_is_rejected_without_resetting_other_preferences() {
    let mut value = serde_json::to_value(AppConfig::default()).unwrap();
    value["product"]["shortcuts"]["search"] = "Ctrl+Shift+O".into();
    value["product"]["shortcuts"]["tasks"] = "Ctrl+Shift+J".into();
    value["product"]["sshDefaults"]["keepaliveIntervalSecs"] = 25.into();
    let config: AppConfig = serde_json::from_value(value).unwrap();
    assert!(config.validate().is_err());
    assert_eq!(config.product.shortcuts.len(), 3);
    assert_eq!(config.product.shortcuts["search"], "Ctrl+Shift+O");
    assert_eq!(config.product.shortcuts["settings"], "Ctrl+Shift+P");
    assert_eq!(config.product.ssh_defaults.keepalive_interval_secs, 25);
    assert!(
        serde_json::to_value(config).unwrap()["product"]["shortcuts"]
            .get("tasks")
            .is_some()
    );
}
#[test]
fn settings_reject_partial_proxy_auth_relative_download_and_invalid_keepalive() {
    let mut c = AppConfig::default();
    c.product.ssh_defaults.keepalive_interval_secs = 0;
    assert!(c.validate().is_err());
    c.product.ssh_defaults.keepalive_interval_secs = 20;
    c.product.download_directory = Some("relative/downloads".into());
    assert!(c.validate().is_err());
    c.product.download_directory = None;
    c.product.ssh_defaults.proxy = Some(serverdeck_core::connection::ProxySettings {
        kind: serverdeck_core::connection::ProxyKind::Socks5,
        hostname: "127.0.0.1".into(),
        port: 1080,
        username: Some("proxy-user".into()),
        credential_id: None,
    });
    assert!(c.validate().is_err());
}
