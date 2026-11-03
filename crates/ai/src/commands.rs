use serverdeck_core::ops::*;

/// No heuristic shell parser: only exact fixed commands and strictly typed targets.
pub fn classify(command: &str) -> Option<Request> {
    Some(match command {
        "uptime" => Request::Diagnostic {
            tool: ReadDiagnostic::Uptime,
        },
        "free -m" => Request::Diagnostic {
            tool: ReadDiagnostic::Memory,
        },
        "df -h" => Request::Diagnostic {
            tool: ReadDiagnostic::Disk,
        },
        "ps -eo pid=,user=,pcpu=,pmem=,etimes=,comm= --sort=-pcpu" => Request::Processes,
        "docker ps -a --no-trunc" => Request::Containers,
        "ss -lntup" => Request::Ports,
        _ => {
            let parts: Vec<_> = command.split(' ').collect();
            if parts.len() != 3 {
                return None;
            }
            let [program, action, target] = [parts[0], parts[1], parts[2]];
            match program {
                "systemctl" if unit_name(target).is_ok() => Request::ServiceAction {
                    scope: Scope::System,
                    unit: target.into(),
                    confirmed: true,
                    action: match action {
                        "start" => ServiceAction::Start,
                        "stop" => ServiceAction::Stop,
                        "restart" => ServiceAction::Restart,
                        _ => return None,
                    },
                },
                "docker" if container_id(target).is_ok() => Request::ContainerAction {
                    id: target.into(),
                    confirmed: true,
                    action: match action {
                        "start" => ContainerAction::Start,
                        "stop" => ContainerAction::Stop,
                        "restart" => ContainerAction::Restart,
                        _ => return None,
                    },
                },
                _ => return None,
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_shell_injection_and_unknown_read_claims() {
        for s in [
            "uptime; reboot",
            "uptime\nreboot",
            "uptime $(id)",
            "sudo uptime",
            "cat /etc/shadow",
            "curl https://evil",
            "systemctl restart a.service;id",
            "systemctl restart $(id).service",
            "systemctl restart -a.service",
            "systemctl  restart a.service",
            "docker exec abc id",
            "echo safe > /etc/passwd",
        ] {
            assert!(classify(s).is_none(), "{s}");
        }
        assert!(classify("uptime").unwrap().action().is_none());
        assert!(
            classify("systemctl restart nginx.service")
                .unwrap()
                .action()
                .is_some()
        );
        assert!(
            classify(&format!("docker stop {}", "a".repeat(64)))
                .unwrap()
                .action()
                .is_some()
        );
    }
}
