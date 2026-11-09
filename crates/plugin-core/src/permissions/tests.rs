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
