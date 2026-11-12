use super::*;
use crate::{Entry, Manifest, repository::Trust};
use serverdeck_plugin_sdk::{
    Request,
    platform::{Command, Request as Primitive},
};

fn plugin() -> InstalledPlugin {
    InstalledPlugin {
        manifest: Manifest {
            icon: None,
            schema_version: 1,
            id: "dev.policy".into(),
            name: "Policy".into(),
            version: "1.0.0".into(),
            author: "Local".into(),
            description: String::new(),
            api_version: "^5.0.0".into(),
            entry: Entry {
                backend: None,
                ui: None,
            },
            permissions: vec![
                Permission::HostsRead,
                Permission::SshExecute,
                Permission::SftpRead,
                Permission::SftpWrite,
                Permission::SettingsRead,
                Permission::SettingsWrite,
            ],
            preapproved_commands: vec![],
            contributions: vec![],
            platforms: vec![std::env::consts::OS.into()],
            files: vec![],
            publisher: Some("self-declared".into()),
        },
        enabled: true,
        source: crate::repository::PluginSource::User,
        trust: Trust::LocalDevelopmentUnverified,
        package_digest: "digest".into(),
        revision: "version-one".into(),
        previous_version: None,
    }
}
fn input() -> GrantInput {
    GrantInput {
        expected_revision: "version-one".into(),
        permissions: plugin().manifest.permissions,
        operations: vec![
            "hosts.read".into(),
            "sftp.read".into(),
            "sftp.write".into(),
            "settings.read".into(),
            "settings.write".into(),
        ],
        read_roots: vec!["/etc/nginx".into()],
        write_roots: vec!["/etc/nginx".into()],
        confirmed: true,
    }
}

fn cap(request: Primitive) -> Capability {
    Capability::Platform {
        request,
        bindings: vec![],
    }
}
#[test]
fn identity_is_bound_and_metadata_has_no_ambient_host_lease() {
    let plugin = plugin();
    let grant = Grant::new(&plugin, input()).unwrap();
    grant.authorize(&plugin, &cap(Primitive::Hosts)).unwrap();
    for field in 0..6 {
        let mut changed = plugin.clone();
        match field {
            0 => changed.manifest.id = "dev.impersonator".into(),
            1 => changed.manifest.version = "1.1.0".into(),
            2 => changed.manifest.publisher = Some("other".into()),
            3 => changed.package_digest = "other".into(),
            4 => changed.revision = "version-two".into(),
            _ => changed.enabled = false,
        };
        assert!(grant.authorize(&changed, &cap(Primitive::Hosts)).is_err());
    }
    let mut invalid = serde_json::to_value(&grant).unwrap();
    invalid["hostIds"] = serde_json::json!(["forged"]);
    assert!(serde_json::from_value::<Grant>(invalid).is_err());
    let mut invalid = serde_json::to_value(input()).unwrap();
    invalid["hostIds"] = serde_json::json!(["forged"]);
    assert!(serde_json::from_value::<GrantInput>(invalid).is_err());
}
#[test]
fn permissions_are_default_deny_and_every_command_requires_confirmation() {
    let plugin = plugin();
    let mut grant = Grant::new(&plugin, input()).unwrap();
    for command in [
        "uname -a",
        "uname -a; reboot",
        "env X=y uname -a",
        "uname  -a",
        "uname -a\nreboot",
        "nginx -s reload",
    ] {
        let operation = cap(Primitive::Execute {
            host_id: "explicit-target".into(),
            command: Command::script(command),
        });
        assert!(operation.needs_confirmation());
        assert!(grant.authorize(&plugin, &operation).is_err());
        grant.operations.push("ssh.execute".into());
        grant.authorize(&plugin, &operation).unwrap();
        grant.operations.retain(|name| name != "ssh.execute");
    }
    grant.permissions.clear();
    assert!(grant.authorize(&plugin, &cap(Primitive::Hosts)).is_err());
    let mut invalid = input();
    invalid.permissions.push(Permission::UiContribute);
    assert!(Grant::new(&plugin, invalid).is_err());
    assert!(serde_json::from_str::<Request>(r#"{"apiVersion":1,"requestId":"x","pluginId":"dev.other","operation":{"kind":"platform","request":{"kind":"hosts"},"bindings":[]}}"#).is_err());
    assert!(serde_json::from_str::<Request>(r#"{"apiVersion":1,"requestId":"x","operation":{"kind":"platform","request":{"kind":"execute","hostId":"host","command":{"program":"reboot","args":[],"timeoutSecs":10},"readOnly":true},"bindings":[]}}"#).is_err());
    assert!(serde_json::from_str::<Request>(r#"{"apiVersion":1,"requestId":"x","operation":{"kind":"system_query","request":{"kind":"containers"}}}"#).is_err());
}
#[test]
fn interactive_preapproval_is_explicit_and_cannot_approve_execute_or_other_operations() {
    let mut plugin = plugin();
    plugin
        .manifest
        .permissions
        .push(Permission::SshInteractivePreapproved);
    plugin.manifest.validate(std::env::consts::OS).unwrap();
    let mut input = input();
    input.operations.push("ssh.execute".into());
    let mut grant = Grant::new(&plugin, input).unwrap();
    let operations = [
        cap(Primitive::StreamOpen {
            host_id: "host".into(),
            command: Command::script("logs"),
        }),
        cap(Primitive::Terminal {
            host_id: "host".into(),
            command: Command::script("shell"),
        }),
    ];
    for operation in &operations {
        assert!(!grant.preapproves(&plugin, operation));
    }
    grant
        .permissions
        .push(Permission::SshInteractivePreapproved);
    for operation in &operations {
        assert!(!grant.preapproves(&plugin, operation));
    }
    grant.operations.push("ssh.interactive.preapproved".into());
    for operation in &operations {
        assert!(grant.preapproves(&plugin, operation));
        for field in 0..8 {
            let mut changed = plugin.clone();
            let mut changed_grant = grant.clone();
            match field {
                0 => changed.revision = "upgraded".into(),
                1 => changed.package_digest = "tampered".into(),
                2 => changed.manifest.version = "2.0.0".into(),
                3 => changed.enabled = false,
                4 => changed
                    .manifest
                    .permissions
                    .retain(|p| *p != Permission::SshInteractivePreapproved),
                5 => changed_grant
                    .permissions
                    .retain(|p| *p != Permission::SshExecute),
                6 => changed_grant
                    .operations
                    .retain(|name| name != "ssh.execute"),
                _ => changed_grant
                    .permissions
                    .retain(|p| *p != Permission::SshInteractivePreapproved),
            }
            assert!(!changed_grant.preapproves(&changed, operation));
        }
    }
    for request in [
        Primitive::Execute {
            host_id: "host".into(),
            command: Command::script("stop"),
        },
        Primitive::TcpConnect {
            target: "127.0.0.1".into(),
            port: 80,
        },
        Primitive::SaveFile {
            document_id: "document".into(),
            content: "changed".into(),
        },
    ] {
        assert!(!grant.preapproves(&plugin, &cap(request)));
    }
    plugin
        .manifest
        .permissions
        .retain(|p| *p != Permission::SshExecute);
    assert!(plugin.manifest.validate(std::env::consts::OS).is_err());
}

#[test]
fn transfer_preapproval_is_independent_and_bound_to_the_installed_revision() {
    use serverdeck_plugin_sdk::platform::{RemotePath, TransferSource};
    let mut plugin = plugin();
    plugin.manifest.permissions.extend([
        Permission::SftpTransfer,
        Permission::SftpTransferPreapproved,
    ]);
    plugin.manifest.validate(std::env::consts::OS).unwrap();
    let mut settings = input();
    settings.permissions = plugin.manifest.permissions.clone();
    settings
        .permissions
        .retain(|p| *p != Permission::SftpTransferPreapproved);
    settings.operations.push("sftp.transfer".into());
    let mut grant = Grant::new(&plugin, settings).unwrap();
    let operations = [
        cap(Primitive::TransferPrepare {
            source: TransferSource::Local {
                path: "C:/image.tar".into(),
            },
            destination: RemotePath {
                host_id: "host".into(),
                path: "/tmp".into(),
            },
            overwrite: false,
        }),
        cap(Primitive::TransferDownloadPrepare {
            source: RemotePath {
                host_id: "host".into(),
                path: "/tmp/image.tar".into(),
            },
            destination: "C:/image.tar".into(),
        }),
        cap(Primitive::TransferStart {
            id: "native-copy".into(),
        }),
    ];
    for operation in &operations {
        assert!(!grant.preapproves(&plugin, operation));
    }
    grant.permissions.push(Permission::SftpTransferPreapproved);
    for operation in &operations {
        assert!(!grant.preapproves(&plugin, operation));
    }
    grant.operations.push("sftp.transfer.preapproved".into());
    for operation in &operations {
        assert!(grant.preapproves(&plugin, operation));
        for change in 0..6 {
            let mut plugin = plugin.clone();
            let mut grant = grant.clone();
            match change {
                0 => plugin.revision = "new-revision".into(),
                1 => plugin.package_digest = "new-digest".into(),
                2 => plugin.enabled = false,
                3 => plugin
                    .manifest
                    .permissions
                    .retain(|p| *p != Permission::SftpTransferPreapproved),
                4 => grant.permissions.retain(|p| *p != Permission::SftpTransfer),
                _ => grant.operations.retain(|name| name != "sftp.transfer"),
            }
            assert!(!grant.preapproves(&plugin, operation));
        }
    }
    for operation in [
        cap(Primitive::ReadFile {
            host_id: "host".into(),
            path: "/etc/nginx/a.conf".into(),
        }),
        cap(Primitive::SaveFile {
            document_id: "doc".into(),
            content: "changed".into(),
        }),
        cap(Primitive::Execute {
            host_id: "host".into(),
            command: Command::script("reboot"),
        }),
    ] {
        assert!(!grant.preapproves(&plugin, &operation));
    }
    plugin
        .manifest
        .permissions
        .retain(|p| *p != Permission::SftpTransfer);
    assert!(plugin.manifest.validate(std::env::consts::OS).is_err());
}
#[test]
fn preset_execution_requires_a_separate_revision_bound_grant_and_exact_command() {
    let mut plugin = plugin();
    let command = Command::new("fixture-tool").arg("literal argument");
    plugin
        .manifest
        .permissions
        .push(Permission::SshExecutePreapproved);
    plugin.manifest.preapproved_commands = vec![command.clone()];
    plugin.manifest.validate(std::env::consts::OS).unwrap();
    let operation = cap(Primitive::Execute {
        host_id: "host".into(),
        command: command.clone(),
    });
    let mut input = input();
    input.permissions = plugin.manifest.permissions.clone();
    input
        .permissions
        .retain(|permission| *permission != Permission::SshExecutePreapproved);
    input.operations.push("ssh.execute".into());
    let mut grant = Grant::new(&plugin, input).unwrap();
    assert!(!grant.preapproves(&plugin, &operation));
    grant.permissions.push(Permission::SshExecutePreapproved);
    assert!(!grant.preapproves(&plugin, &operation));
    grant.operations.push("ssh.execute.preapproved".into());
    assert!(grant.preapproves(&plugin, &operation));
    for changed in [
        Command::new("another-tool").arg("literal argument"),
        command.clone().arg("; reboot"),
        Command {
            timeout_secs: 1,
            ..command.clone()
        },
    ] {
        assert!(!grant.preapproves(
            &plugin,
            &cap(Primitive::Execute {
                host_id: "host".into(),
                command: changed
            })
        ));
    }
    for operation in [
        cap(Primitive::StreamOpen {
            host_id: "host".into(),
            command: command.clone(),
        }),
        cap(Primitive::Terminal {
            host_id: "host".into(),
            command,
        }),
    ] {
        assert!(!grant.preapproves(&plugin, &operation));
    }
    for field in 0..4 {
        let mut changed = plugin.clone();
        match field {
            0 => changed.revision = "upgraded".into(),
            1 => changed.package_digest = "tampered".into(),
            2 => changed.enabled = false,
            _ => changed.manifest.preapproved_commands.clear(),
        }
        assert!(!grant.preapproves(&changed, &operation));
    }
    grant
        .permissions
        .retain(|permission| *permission != Permission::SshExecute);
    assert!(!grant.preapproves(&plugin, &operation));
}

#[test]
fn preset_manifest_rejects_undeclared_invalid_duplicate_and_excessive_commands() {
    let mut manifest = plugin().manifest;
    let command = Command::new("fixture-tool").arg("literal");
    manifest.preapproved_commands = vec![command.clone()];
    assert!(manifest.validate(std::env::consts::OS).is_err());
    manifest.permissions.push(Permission::SshExecutePreapproved);
    manifest.validate(std::env::consts::OS).unwrap();
    for commands in [
        vec![],
        vec![command.clone(), command.clone()],
        vec![command; 17],
        vec![Command::new("fixture-tool").arg("bad\0argument")],
        (0..16)
            .map(|index| Command::new("fixture-tool").arg(format!("{index}{}", "x".repeat(4000))))
            .collect(),
    ] {
        let mut changed = manifest.clone();
        changed.preapproved_commands = commands;
        assert!(changed.validate(std::env::consts::OS).is_err());
    }
    manifest
        .permissions
        .retain(|permission| *permission != Permission::SshExecute);
    assert!(manifest.validate(std::env::consts::OS).is_err());
}
#[test]
fn file_roots_use_path_component_boundaries_and_cannot_escape() {
    let grant = Grant::new(&plugin(), input()).unwrap();
    for path in ["/etc/nginx/nginx.conf", "/etc/nginx/conf.d/site.conf"] {
        grant.path(path, false).unwrap();
        grant.path(path, true).unwrap();
    }
    for path in [
        "/etc/nginx-secret/key",
        "/etc/nginx/../shadow",
        "/etc/nginx//site.conf",
        "/etc/shadow",
        "relative",
    ] {
        assert!(grant.path(path, false).is_err(), "{path}");
    }
    assert!(
        Grant::new(
            &plugin(),
            GrantInput {
                read_roots: vec!["/etc/../".into()],
                ..input()
            }
        )
        .is_err()
    );
    assert!(
        Grant::new(
            &plugin(),
            GrantInput {
                confirmed: false,
                ..input()
            }
        )
        .is_err()
    );
}

#[test]
fn argument_templates_require_an_explicit_new_permission_and_do_not_change_fixed_ssh_grants() {
    let mut plugin = plugin();
    let template = Command::script("printf '%s' \"$1\"")
        .arg("read")
        .arg("{{sd:uint:2:2147483647}}");
    plugin.manifest.preapproved_commands = vec![template.clone()];
    plugin
        .manifest
        .permissions
        .push(Permission::SshExecutePreapproved);
    assert!(plugin.manifest.validate(std::env::consts::OS).is_err());
    plugin.manifest.permissions.extend([
        Permission::OperationsReadPreapproved,
        Permission::OperationsReadArgumentsPreapproved,
    ]);
    plugin.manifest.validate(std::env::consts::OS).unwrap();
    let mut input = input();
    input.permissions = plugin.manifest.permissions.clone();
    input.operations.extend([
        "ssh.execute.preapproved".into(),
        "operations.read.preapproved".into(),
        "operations.read.arguments.preapproved".into(),
    ]);
    let grant = Grant::new(&plugin, input).unwrap();
    let concrete = Command::script("printf '%s' \"$1\"").arg("read").arg("42");
    assert!(!grant.preapproves(
        &plugin,
        &Capability::Platform {
            request: Primitive::Execute {
                host_id: "host".into(),
                command: concrete
            },
            bindings: vec![]
        }
    ));
    plugin.manifest.preapproved_commands = vec![Command::script("{{sd:identifier:256:}}")];
    assert!(plugin.manifest.validate(std::env::consts::OS).is_err());
}
