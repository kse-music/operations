use serverdeck_core::tasks::*;
fn input() -> DiagnosticInput {
    DiagnosticInput {
        tool: Tool::Ping,
        origin: Origin::Local,
        target: "127.0.0.1".into(),
        port: 22,
        count: 2,
        timeout_secs: 3,
    }
}
#[test]
fn diagnostics_reject_shell_options_controls_and_invalid_limits() {
    for target in [
        "-c 999",
        "example;id",
        "$(id)",
        "host name",
        "x\nwhoami",
        "x'",
        "x/../y",
    ] {
        let mut i = input();
        i.target = target.into();
        assert!(i.validate().is_err(), "{target}");
    }
    for target in ["example.com", "127.0.0.1", "::1", "fe80::1%eth0"] {
        let mut i = input();
        i.target = target.into();
        assert!(i.validate().is_ok());
    }
    let mut i = input();
    i.count = 0;
    assert!(i.validate().is_err());
    i = input();
    i.timeout_secs = 301;
    assert!(i.validate().is_err());
    i = input();
    i.tool = Tool::Tcp;
    i.port = 0;
    assert!(i.validate().is_err());
    i = input();
    i.tool = Tool::SshLatency;
    assert!(i.validate().is_err());
    i = input();
    i.tool = Tool::Interfaces;
    i.target = "x".repeat(254);
    assert!(i.validate().is_err());
    i = input();
    i.origin = Origin::Remote {
        host_id: uuid::Uuid::new_v4().to_string(),
        session_id: "x".repeat(500),
    };
    assert!(i.validate().is_err());
}
