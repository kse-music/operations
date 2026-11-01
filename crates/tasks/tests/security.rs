use serverdeck_core::{files::ConflictPolicy, tasks::*};
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
#[test]
fn batch_requires_complete_confirmation_unique_targets_and_overwrite_consent() {
    let id = uuid::Uuid::new_v4().to_string();
    let mut i = BatchInput {
        targets: vec![Target {
            host_id: id.clone(),
            session_id: None,
        }],
        operation: BatchOperation::Command {
            command: "printf '中文'".into(),
        },
        concurrency: 3,
        timeout_secs: 5,
        confirmed: false,
    };
    assert!(i.validate().is_err());
    i.confirmed = true;
    assert!(i.validate().is_ok());
    i.targets[0].session_id = Some("invalid-session".into());
    assert!(i.validate().is_err());
    i.targets[0].session_id = None;
    i.targets.push(i.targets[0].clone());
    assert!(i.validate().is_err());
    i.targets.pop();
    i.concurrency = 0;
    assert!(i.validate().is_err());
    i.concurrency = 9;
    assert!(i.validate().is_err());
    i.concurrency = 1;
    i.operation = BatchOperation::Command {
        command: "x\0y".into(),
    };
    assert!(i.validate().is_err());
    i.operation = BatchOperation::File {
        source: "source".into(),
        destination: "/tmp/中文 ' ;".into(),
        conflict: ConflictPolicy::Overwrite,
        confirm_overwrite: false,
    };
    assert!(i.validate().is_err());
    if let BatchOperation::File {
        confirm_overwrite, ..
    } = &mut i.operation
    {
        *confirm_overwrite = true;
    }
    assert!(i.validate().is_ok());
    if let BatchOperation::File { destination, .. } = &mut i.operation {
        *destination = "/tmp/../etc".into();
    }
    assert!(i.validate().is_err());
}
