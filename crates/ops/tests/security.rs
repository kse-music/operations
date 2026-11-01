use serde_json::json;
use serverdeck_core::ops::*;
use serverdeck_ops::parse::response;
const ID: &str = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
#[test]
fn mutations_and_secret_reveal_require_confirmation_and_immutable_targets() {
    for request in [
        Request::ContainerAction {
            id: ID.into(),
            action: ContainerAction::Stop,
            confirmed: false,
        },
        Request::ImageRemove {
            id: ID.into(),
            confirmed: false,
        },
        Request::ServiceAction {
            scope: Scope::System,
            unit: "sshd.service".into(),
            action: ServiceAction::Stop,
            confirmed: false,
        },
        Request::ContainerDetails {
            id: ID.into(),
            reveal_env: true,
            confirmed: false,
        },
        Request::Signal {
            pid: 10,
            start_ticks: "1".into(),
            boot_id: "12345678-1234-1234-1234-123456789012".into(),
            signal: ProcessSignal::Kill,
            confirmed: false,
        },
    ] {
        assert!(request.command().is_err());
    }
    for bad in ["short", "name; rm -rf /", "-a", "$(id)"] {
        assert!(container_id(bad).is_err());
        assert!(image_id(bad).is_err());
    }
    for unit in ["../x.service", "a.service;id", "--system", "x\n.service"] {
        assert!(unit_name(unit).is_err());
    }
    assert!(pid_valid(0).is_err());
    assert!(pid_valid(1).is_err());
    assert!(target_valid("x;id", 22).is_err());
    assert!(target_valid("localhost", 0).is_err());
    let command = Request::ContainerAction {
        id: ID.into(),
        action: ContainerAction::Remove,
        confirmed: true,
    }
    .command()
    .expect("remove");
    assert!(!command.contains("--force"));
    assert!(!command.contains("sudo"));
    assert!(command.contains("unix://$sd_socket"));
    assert!(command.contains("unset DOCKER_HOST DOCKER_CONTEXT"));
    let signal = Request::Signal {
        pid: 200,
        start_ticks: "123".into(),
        boot_id: "12345678-1234-1234-1234-123456789012".into(),
        signal: ProcessSignal::Term,
        confirmed: true,
    }
    .command()
    .expect("signal");
    assert!(signal.contains("pidfd_send_signal"));
    assert!(!signal.contains("os.kill("));
}
#[test]
fn quoted_paths_are_literal_and_log_requests_have_limits() {
    let path = "/tmp/中文 ' ;$(id) log";
    let command = LogInput {
        source: LogSource::File { path: path.into() },
        lines: 200,
        follow: true,
    }
    .command()
    .expect("command");
    assert!(command.contains("'\"'\"'"));
    assert!(command.contains("-- '/tmp/中文"));
    assert!(
        LogInput {
            source: LogSource::File { path: path.into() },
            lines: 0,
            follow: true
        }
        .command()
        .is_err()
    );
    assert!(quote("bad\0value").is_err());
    assert!(
        ContainerShell {
            id: ID.into(),
            bash: false,
            confirmed: false
        }
        .command()
        .is_err()
    );
    let shell = ContainerShell {
        id: ID.into(),
        bash: false,
        confirmed: true,
    }
    .command()
    .expect("shell");
    assert!(shell.contains("exec -it"));
    assert!(shell.ends_with("/bin/sh"));
}
#[test]
fn default_inspection_redacts_all_environment_values_before_ipc() {
    let input = json!({"Id":ID,"Name":"/fixture","Config":{"Image":"fixture","Env":["PASSWORD=do-not-expose","NORMAL=also-private"],"Labels":{"hidden":"not-returned"},"Cmd":["secret-command-arg"]},"State":{"Running":true},"NetworkSettings":{"Ports":{"8080/tcp":[{"HostIp":"127.0.0.1","HostPort":"1234"}]}},"Mounts":[{"Type":"bind"}],"HostConfig":{"RestartPolicy":{"Name":"no"}}});
    let raw = serde_json::to_vec(&input).expect("JSON");
    let redacted = response(
        &Request::ContainerDetails {
            id: ID.into(),
            reveal_env: false,
            confirmed: false,
        },
        &raw,
    )
    .expect("response");
    let serialized = serde_json::to_string(&redacted).expect("JSON");
    assert!(!serialized.contains("do-not-expose"));
    assert!(!serialized.contains("also-private"));
    assert!(!serialized.contains("secret-command-arg"));
    assert!(!serialized.contains("not-returned"));
    assert!(serialized.contains("PASSWORD=••••••"));
    let shown = response(
        &Request::ContainerDetails {
            id: ID.into(),
            reveal_env: true,
            confirmed: true,
        },
        &raw,
    )
    .expect("shown");
    assert!(
        serde_json::to_string(&shown)
            .expect("JSON")
            .contains("do-not-expose")
    );
}
#[test]
fn processes_ports_services_and_missing_process_permissions_are_explicit() {
    let p = response(&Request::Processes, b"12 tester 50.0 1.5 100 my process\n").expect("ps");
    assert_eq!(p.records[0]["pid"], 12);
    assert_eq!(p.records[0]["command"], "my process");
    let ports=response(&Request::Ports,b"tcp LISTEN 0 128 127.0.0.1:22 0.0.0.0:*\nudp UNCONN 0 0 [::1]:99 [::]:* users:((\"fixture\",pid=12,fd=3))\n").expect("ss");
    assert!(ports.records[0]["process"].is_null());
    assert!(
        ports.records[1]["process"]
            .as_str()
            .expect("process")
            .contains("pid=12")
    );
    let s=response(&Request::Services{scope:Scope::User},b"fixture.service loaded active running Fixture test\n\0fixture.service enabled enabled\nother.service disabled enabled\n").expect("services");
    assert_eq!(s.records[0]["enabled"], "enabled");
    assert!(s.records[1]["active"].is_null());
    assert!(response(&Request::Processes, b"unparseable").is_err());
    assert!(response(&Request::Containers, b"not-json").is_err());
}
#[test]
fn process_identity_parses_comm_with_spaces_and_parentheses() {
    let mut fields = vec!["S"; 20];
    fields[19] = "12345";
    let raw = format!(
        "SDPROC1\0boot-id\n\010 (name with ) text) {}\0Name:\tfixture\nUid:\t1000\0/bin/sleep",
        fields.join(" ")
    );
    let p = response(&Request::ProcessDetails { pid: 10 }, raw.as_bytes()).expect("details");
    let d = p.detail.expect("detail");
    assert_eq!(d["startTicks"], "12345");
    assert_eq!(d["pid"], 10);
}
