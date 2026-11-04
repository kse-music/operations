use super::*;
use crate::{Entry, Manifest, repository::Trust};
use serverdeck_plugin_sdk::{Request, read_only};

fn plugin() -> InstalledPlugin {
    InstalledPlugin {
        manifest: Manifest {
            schema_version: 1,
            id: "dev.policy".into(),
            name: "Policy".into(),
            version: "1.0.0".into(),
            author: "Local".into(),
            description: String::new(),
            api_version: "^1".into(),
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
                Permission::TasksCreate,
            ],
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
        host_ids: vec!["12345678-1234-4234-8234-123456789012".into()],
        operations: vec![
            "hosts.read".into(),
            "ssh.read_only".into(),
            "sftp.read".into(),
            "sftp.write".into(),
            "settings.read".into(),
            "settings.write".into(),
            "tasks.read_only".into(),
            "tasks.manage".into(),
        ],
        read_roots: vec!["/etc/nginx".into()],
        write_roots: vec!["/etc/nginx".into()],
        confirmed: true,
    }
}

#[test]
fn identity_is_bound_but_any_current_host_is_allowed_including_legacy_grants() {
    let plugin = plugin();
    let grant = Grant::new(&plugin, input()).unwrap();
    assert!(grant.host_ids.is_empty());
    let host = "12345678-1234-4234-8234-123456789012";
    grant
        .authorize(&plugin, Some(host), &Capability::HostsRead)
        .unwrap();
    assert!(
        grant
            .authorize(&plugin, None, &Capability::HostsRead)
            .is_err()
    );
    assert!(
        grant
            .authorize(
                &plugin,
                Some("87654321-4321-4321-8321-123456789012"),
                &Capability::HostsRead
            )
            .is_ok()
    );
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
        assert!(
            grant
                .authorize(&changed, Some(host), &Capability::HostsRead)
                .is_err()
        );
    }
    let mut legacy = serde_json::to_value(&grant).unwrap();
    assert!(legacy.get("hostIds").is_none());
    legacy["hostIds"] = serde_json::json!([host]);
    let legacy: Grant = serde_json::from_value(legacy).unwrap();
    legacy
        .authorize(
            &plugin,
            Some("87654321-4321-4321-8321-123456789012"),
            &Capability::HostsRead,
        )
        .unwrap();
    assert!(
        legacy
            .authorize(&plugin, None, &Capability::HostsRead)
            .is_err()
    );
    let mut no_hosts = serde_json::to_value(input()).unwrap();
    assert!(no_hosts.get("hostIds").is_none());
    no_hosts["confirmed"] = true.into();
    assert!(Grant::new(&plugin, serde_json::from_value(no_hosts).unwrap()).is_ok());
}

#[test]
fn permissions_are_default_deny_and_operation_types_cannot_be_relabelled() {
    let plugin = plugin();
    let mut grant = Grant::new(&plugin, input()).unwrap();
    let host = "12345678-1234-4234-8234-123456789012".to_string();
    grant
        .authorize(
            &plugin,
            Some(&host),
            &Capability::Execute {
                command: "uname -a".into(),
                timeout_secs: 10,
            },
        )
        .unwrap();
    for command in [
        "uname -a; reboot",
        "env X=y uname -a",
        "uname  -a",
        "uname -a\nreboot",
        "nginx -s reload",
    ] {
        let cap = Capability::Execute {
            command: command.into(),
            timeout_secs: 10,
        };
        assert!(!read_only(command));
        assert!(cap.needs_confirmation());
        assert!(grant.authorize(&plugin, Some(&host), &cap).is_err());
    }
    grant.permissions.clear();
    assert!(
        grant
            .authorize(&plugin, Some(&host), &Capability::HostsRead)
            .is_err()
    );
    let mut input = input();
    input.permissions.push(Permission::UiContribute);
    assert!(Grant::new(&plugin, input).is_err());
    let forged = r#"{"apiVersion":1,"requestId":"x","pluginId":"dev.other","operation":{"kind":"hosts_read"}}"#;
    assert!(serde_json::from_str::<Request>(forged).is_err());
    assert!(serde_json::from_str::<Request>(r#"{"apiVersion":1,"requestId":"x","operation":{"kind":"execute","command":"reboot","timeoutSecs":10,"readOnly":true}}"#).is_err());
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
