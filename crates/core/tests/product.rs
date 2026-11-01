use serverdeck_core::{AppConfig, product::*};
#[test]
fn global_shortcuts_cannot_capture_terminal_control_keys_or_collide() {
    let mut p = ProductPreferences::default();
    p.validate().unwrap();
    p.shortcuts.insert("search".into(), "Ctrl+C".into());
    assert!(p.validate().is_err());
    p.shortcuts.insert("search".into(), "Ctrl+Shift+J".into());
    assert!(p.validate().is_err());
    p.shortcuts.insert("search".into(), "Ctrl+Shift+P".into());
    p.validate().unwrap();
    p.language = "en-US".into();
    assert!(p.validate().is_err());
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
