use super::*;
use serverdeck_core::identity::LEGACY_PLUGIN_PREFIX;
const PACKAGES: [(&str, &[u8]); 2] = [
    (
        "cn.hiboot.plugins.docker",
        include_bytes!("../../../plugins/system/packages/docker.sdplugin"),
    ),
    (
        "cn.hiboot.plugins.assistant",
        include_bytes!("../../../plugins/system/packages/assistant.sdplugin"),
    ),
];
// UI v2/v3 selected a host renderer. Keep that published contract usable for
// installed and uploaded legacy packages without granting an ID-based privilege.
pub(crate) fn legacy_frontend(
    ui: &serverdeck_plugin_sdk::ui::Ui,
    page: &str,
    path: &str,
) -> Result<Vec<u8>, Error> {
    use serverdeck_plugin_sdk::{tools::Tool, ui::Surface};
    if !matches!(path, "frontend.js" | "frontend.css") {
        return Err(Error::Validation("插件界面资源无效"));
    }
    let surface = ui
        .pages
        .iter()
        .find(|p| p.id == page)
        .and_then(|p| p.surface.as_ref())
        .ok_or(Error::Validation("插件界面不存在"))?;
    let name = match surface {
        Surface::Frontend => return Err(Error::Validation("独立界面没有兼容渲染器")),
        Surface::Tool { tool } => match tool {
            Tool::Assistant => "assistant",
        },
        Surface::Operations { .. } => {
            return Ok(if path.ends_with(".js") {
                include_bytes!("../../../plugins/compat/server/assets/frontend.js").to_vec()
            } else {
                include_bytes!("../../../plugins/compat/server/assets/frontend.css").to_vec()
            });
        }
    };
    let bytes = PACKAGES
        .iter()
        .find(|(id, _)| id.rsplit('.').next() == Some(name))
        .map(|(_, bytes)| *bytes)
        .ok_or(Error::Validation("兼容界面不可用"))?;
    let package =
        serverdeck_plugin_core::package::Package::validate_bytes(bytes, std::env::consts::OS)?;
    package
        .files
        .into_iter()
        .find(|(entry, _)| entry == path)
        .map(|(_, bytes)| bytes)
        .ok_or(Error::Validation("兼容界面资源缺失"))
}
impl Application {
    /// Startup-only standard package distribution with fixed system grants.
    /// A tombstone preserves uninstall; existing enable choices remain unchanged.
    pub fn provision_bundled_plugins(&self) -> Result<(), Error> {
        for (id, bytes) in PACKAGES {
            let old_id = id.replacen("cn.hiboot.plugins.", LEGACY_PLUGIN_PREFIX, 1);
            let previous = match self.plugins.detail(&old_id) {
                Ok(plugin) => Some(plugin),
                Err(Error::NotFound) => None,
                Err(error) => return Err(error),
            };
            let configured = self.database.bundled_plugin_provisioned(id)?;
            if !configured {
                match self.plugins.detail(id) {
                    Ok(_) => (),
                    Err(Error::NotFound) => {
                        // Preserve an uninstall performed under the previous domain.
                        if previous.is_some()
                            || !self.database.bundled_plugin_provisioned(&old_id)?
                        {
                            self.plugins.install_bundled(bytes, id)?;
                            let enabled = previous
                                .as_ref()
                                .filter(|plugin| {
                                    plugin.source
                                        == serverdeck_plugin_core::repository::PluginSource::System
                                })
                                .is_none_or(|plugin| plugin.enabled);
                            self.plugins.set_enabled(id, enabled)?;
                        }
                    }
                    Err(error) => return Err(error),
                }
            }
            if previous.is_some_and(|p| {
                p.source == serverdeck_plugin_core::repository::PluginSource::System
            }) {
                self.plugins.retire_bundled_identity(&old_id, id)?;
            }
            match self.plugins.detail(id) {
                Ok(plugin)
                    if plugin.source
                        == serverdeck_plugin_core::repository::PluginSource::System =>
                {
                    let plugin = self.plugins.install_bundled(bytes, id)?;
                    let grant = bundled_grant(&plugin)?;
                    if self
                        .plugins
                        .grant(id)?
                        .is_none_or(|current| current != grant)
                    {
                        self.plugins.set_grant(
                            id,
                            serverdeck_plugin_core::permissions::GrantInput {
                                expected_revision: plugin.revision,
                                permissions: grant.permissions,
                                host_ids: vec![],
                                operations: grant.operations,
                                read_roots: grant.read_roots,
                                write_roots: grant.write_roots,
                                confirmed: true,
                            },
                        )?;
                    }
                }
                Ok(_) | Err(Error::NotFound) => (),
                Err(error) => return Err(error),
            }
            self.database.mark_bundled_plugin_provisioned(id)?;
        }
        Ok(())
    }
}
fn bundled_grant(
    plugin: &serverdeck_plugin_core::InstalledPlugin,
) -> Result<serverdeck_plugin_core::permissions::Grant, Error> {
    use serverdeck_plugin_core::{
        Permission,
        permissions::{Grant, GrantInput},
    };
    let operations = plugin
        .manifest
        .permissions
        .iter()
        .flat_map(|p| match p {
            Permission::AssistantUse => &["assistant.use"][..],
            Permission::MetricsRead => &["metrics.read"][..],
            Permission::SystemRead => &["system.read"],
            Permission::SystemManage => &["system.manage", "system.shell"],
            Permission::LogsRead => &["logs.read"],
            Permission::HostsRead => &["hosts.read"],
            Permission::SshExecute => &["ssh.read_only", "ssh.execute"],
            Permission::SftpRead => &["sftp.read"],
            Permission::SftpWrite => &["sftp.write"],
            Permission::UiContribute => &["ui.contribute", "ui.notify"],
            Permission::SettingsRead => &["settings.read"],
            Permission::SettingsWrite => &["settings.write"],
        })
        .map(|o| (*o).to_owned())
        .collect();
    Grant::new(
        plugin,
        GrantInput {
            expected_revision: plugin.revision.clone(),
            permissions: plugin.manifest.permissions.clone(),
            host_ids: vec![],
            operations,
            read_roots: if plugin.manifest.permissions.contains(&Permission::SftpRead) {
                vec!["/".into()]
            } else {
                vec![]
            },
            write_roots: if plugin.manifest.permissions.contains(&Permission::SftpWrite) {
                vec!["/".into()]
            } else {
                vec![]
            },
            confirmed: true,
        },
    )
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use serverdeck_plugin_core::{
        permissions::GrantInput,
        repository::{InstallInput, PluginSource, UninstallInput},
    };

    #[tokio::test]
    async fn releasing_pages_allows_both_guests_to_run_and_reactivate_without_disabling() {
        use serverdeck_plugin_runtime::protocol::State;
        let dir = tempfile::tempdir().unwrap();
        let app =
            Application::initialize(dir.path().join("data"), dir.path().join("logs")).unwrap();
        app.provision_bundled_plugins().unwrap();
        for (id, _) in PACKAGES.iter().chain(PACKAGES.iter().rev()) {
            app.plugin_set_enabled((*id).into(), true).await.unwrap();
            assert!(app.plugin_runtime.health(id).await.unwrap().error.is_none());
            assert_eq!(
                app.plugin_statuses()
                    .unwrap()
                    .iter()
                    .filter(|s| s.state == State::Active)
                    .count(),
                1,
            );
            app.plugin_clear_context((*id).into()).await.unwrap();
            assert!(app.plugin_detail((*id).into()).await.unwrap().enabled);
            assert!(
                app.plugin_statuses()
                    .unwrap()
                    .iter()
                    .all(|s| s.state == State::Stopped)
            );
        }
        assert_eq!(app.plugin_statuses().unwrap().len(), 2);
        app.shutdown().await;
    }

    #[tokio::test]
    async fn bundled_update_preserves_settings_enable_choices_uploads_and_uninstall() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().join("data");
        let logs = dir.path().join("logs");
        let app = Application::initialize(data.clone(), logs.clone()).unwrap();
        let mut previous = Vec::new();
        for (index, (id, bytes)) in PACKAGES.iter().enumerate() {
            let mut package: serde_json::Value = serde_json::from_slice(bytes).unwrap();
            package["manifest"]["version"] = json!("1.1.1");
            let old = app
                .plugins
                .install_bundled(&serde_json::to_vec(&package).unwrap(), id)
                .unwrap();
            previous.push(old.revision);
            app.plugins.set_enabled(id, index == 0).unwrap();
            app.plugins.settings_write(id, &json!({"keep":id})).unwrap();
            app.database.mark_bundled_plugin_provisioned(id).unwrap();
        }
        app.provision_bundled_plugins().unwrap();
        for (index, (id, bytes)) in PACKAGES.iter().enumerate() {
            let plugin = app.plugins.detail(id).unwrap();
            let mut package: serde_json::Value = serde_json::from_slice(bytes).unwrap();
            assert_eq!(
                plugin.manifest.version,
                package["manifest"]["version"].as_str().unwrap()
            );
            assert_ne!(plugin.revision, previous[index]);
            assert_eq!(plugin.enabled, index == 0);
            assert_eq!(app.plugins.settings_read(id).unwrap()["keep"], *id);
            assert!(
                app.plugins
                    .grant(id)
                    .unwrap()
                    .is_some_and(|g| g.matches(&plugin))
            );
            package["manifest"]["version"] = json!("1.1.1");
            assert_eq!(
                app.plugins
                    .install_bundled(&serde_json::to_vec(&package).unwrap(), id)
                    .unwrap()
                    .revision,
                plugin.revision
            );
        }
        app.plugin_uninstall(UninstallInput {
            id: PACKAGES[1].0.into(),
            clear_data: false,
            confirmed: true,
        })
        .await
        .unwrap();
        app.plugin_uninstall(UninstallInput {
            id: PACKAGES[0].0.into(),
            clear_data: false,
            confirmed: true,
        })
        .await
        .unwrap();
        let path = dir.path().join("upload.sdplugin");
        std::fs::write(&path, PACKAGES[0].1).unwrap();
        let upload = app
            .plugin_install(InstallInput {
                path,
                development_confirmed: true,
                expected_version: None,
                expected_digest: None,
            })
            .await
            .unwrap();
        app.provision_bundled_plugins().unwrap();
        assert_eq!(
            app.plugins.detail(PACKAGES[0].0).unwrap().source,
            PluginSource::User
        );
        assert_eq!(
            app.plugins.detail(PACKAGES[0].0).unwrap().revision,
            upload.revision
        );
        assert!(app.plugins.grant(PACKAGES[0].0).unwrap().is_none());
        assert!(matches!(
            app.plugins.detail(PACKAGES[1].0),
            Err(Error::NotFound)
        ));
        app.shutdown().await;
        let restarted = Application::initialize(data, logs).unwrap();
        restarted.provision_bundled_plugins().unwrap();
        assert_eq!(
            restarted.plugins.detail(PACKAGES[0].0).unwrap().revision,
            upload.revision
        );
        assert!(matches!(
            restarted.plugins.detail(PACKAGES[1].0),
            Err(Error::NotFound)
        ));
        restarted.shutdown().await;
    }

    #[tokio::test]
    async fn system_packages_have_fixed_defaults_while_uploaded_packages_still_require_grants() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().join("data");
        let logs = dir.path().join("logs");
        let app = Application::initialize(data.clone(), logs.clone()).unwrap();
        app.provision_bundled_plugins().unwrap();
        let list = app.plugin_list().await.unwrap();
        assert_eq!(list.len(), PACKAGES.len());
        for plugin in list {
            let id = plugin.manifest.id.clone();
            assert_eq!(plugin.source, PluginSource::System);
            assert!(plugin.enabled);
            let defaults = app.plugin_permissions(id.clone()).await.unwrap().unwrap();
            assert_eq!(defaults.permissions, plugin.manifest.permissions);
            if id.ends_with("docker") {
                assert!(defaults.operations.contains(&"system.shell".into()));
                assert!(
                    defaults
                        .permissions
                        .contains(&serverdeck_plugin_core::Permission::LogsRead)
                );
            }
            assert!(
                app.plugin_grant(
                    id.clone(),
                    GrantInput {
                        expected_revision: plugin.revision.clone(),
                        permissions: vec![serverdeck_plugin_core::Permission::UiContribute],
                        host_ids: vec![],
                        operations: vec!["ui.contribute".into()],
                        read_roots: vec![],
                        write_roots: vec![],
                        confirmed: true,
                    },
                )
                .await
                .is_err()
            );
            let ui = app.plugin_ui(id.clone(), plugin.revision).await.unwrap();
            assert_eq!(ui.ui_version, 4);
            assert!(ui.frontend.is_some());
            assert!(ui.pages[0].surface.is_some());
            app.plugin_activate(&id).await.unwrap();
            let denied = app
                .plugin_call(
                    &id,
                    json!({"action":"bridge","values":{"request":"{\"kind\":\"settings_read\"}"}}),
                )
                .await
                .unwrap();
            if id == "cn.hiboot.plugins.assistant" {
                assert!(
                    denied.error.is_none(),
                    "assistant owns its model binding settings"
                );
                assert_eq!(denied.result, json!({}));
            } else {
                assert_eq!(denied.error.unwrap().code, "CAPABILITY");
            }
            let capability = json!({"kind":"system_query","request":{"kind":"capabilities"}});
            let host_denied = app
                .plugin_call(
                    &id,
                    json!({"action":"bridge","values":{"request":capability.to_string()}}),
                )
                .await
                .unwrap();
            assert_eq!(
                host_denied.error.unwrap().code,
                if matches!(
                    ui.pages[0].surface,
                    Some(serverdeck_plugin_sdk::ui::Surface::Tool { .. })
                ) {
                    "CAPABILITY"
                } else {
                    "PLUGIN_PERMISSION_DENIED"
                }
            );
            assert!(app.plugin_revoke(id.clone()).await.is_err());
            assert_eq!(
                app.plugin_permissions(id.clone()).await.unwrap().unwrap(),
                defaults
            );
            app.plugin_set_enabled(id.clone(), false).await.unwrap();
            assert!(
                app.plugin_ui(id.clone(), app.plugins.detail(&id).unwrap().revision)
                    .await
                    .is_err()
            );
        }
        // Upgrading the application repairs legacy partial grants, without re-enabling plugins.
        app.plugins.revoke_grant(PACKAGES[0].0).unwrap();
        app.provision_bundled_plugins().unwrap();
        assert!(
            app.plugin_permissions(PACKAGES[0].0.into())
                .await
                .unwrap()
                .unwrap()
                .operations
                .contains(&"system.shell".into())
        );
        assert!(!app.plugins.detail(PACKAGES[0].0).unwrap().enabled);
        let id = PACKAGES[0].0;
        app.plugin_uninstall(UninstallInput {
            id: id.into(),
            clear_data: false,
            confirmed: true,
        })
        .await
        .unwrap();
        app.provision_bundled_plugins().unwrap();
        assert_eq!(app.plugin_list().await.unwrap().len(), PACKAGES.len() - 1);
        let path = dir.path().join("upload.sdplugin");
        std::fs::write(&path, PACKAGES[0].1).unwrap();
        let uploaded = app
            .plugin_install(InstallInput {
                path,
                development_confirmed: true,
                expected_version: None,
                expected_digest: None,
            })
            .await
            .unwrap();
        assert_eq!(uploaded.source, PluginSource::User);
        assert!(!uploaded.enabled);
        assert!(app.plugin_permissions(id.into()).await.unwrap().is_none());
        app.shutdown().await;
        let restarted = Application::initialize(data, logs).unwrap();
        restarted.provision_bundled_plugins().unwrap();
        assert_eq!(restarted.plugin_list().await.unwrap().len(), PACKAGES.len());
        assert_eq!(
            restarted.plugins.detail(id).unwrap().source,
            PluginSource::User
        );
        assert!(
            restarted
                .plugin_permissions(id.into())
                .await
                .unwrap()
                .is_none()
        );
        assert!(!restarted.plugins.detail(PACKAGES[0].0).unwrap().enabled);
        restarted.shutdown().await;
    }
    #[tokio::test]
    async fn domain_migration_preserves_settings_and_uninstall_choice_and_uses_system_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let app =
            Application::initialize(dir.path().join("data"), dir.path().join("logs")).unwrap();
        let old_id = format!("{LEGACY_PLUGIN_PREFIX}docker");
        let old = old_id.as_str();
        let mut package: serde_json::Value = serde_json::from_slice(PACKAGES[0].1).unwrap();
        package["manifest"]["id"] = json!(old);
        let previous = app
            .plugins
            .install_bundled(&serde_json::to_vec(&package).unwrap(), old)
            .unwrap();
        app.plugins
            .settings_write(old, &json!({"keep":"my configuration"}))
            .unwrap();
        app.plugins
            .set_grant(
                old,
                GrantInput {
                    expected_revision: previous.revision,
                    permissions: vec![serverdeck_plugin_core::Permission::UiContribute],
                    host_ids: vec![],
                    operations: vec!["ui.contribute".into()],
                    read_roots: vec![],
                    write_roots: vec![],
                    confirmed: true,
                },
            )
            .unwrap();
        app.database.mark_bundled_plugin_provisioned(old).unwrap();
        app.database
            .mark_bundled_plugin_provisioned(&format!("{LEGACY_PLUGIN_PREFIX}assistant"))
            .unwrap();
        app.provision_bundled_plugins().unwrap();
        assert!(matches!(app.plugins.detail(old), Err(Error::NotFound)));
        let migrated = app.plugins.detail("cn.hiboot.plugins.docker").unwrap();
        assert!(!migrated.enabled);
        assert_eq!(
            app.plugins
                .settings_read("cn.hiboot.plugins.docker")
                .unwrap()["keep"],
            "my configuration"
        );
        assert!(
            app.plugins
                .grant("cn.hiboot.plugins.docker")
                .unwrap()
                .is_some_and(|g| g.permissions == migrated.manifest.permissions)
        );
        assert!(matches!(
            app.plugins.detail("cn.hiboot.plugins.assistant"),
            Err(Error::NotFound)
        ));
        app.provision_bundled_plugins().unwrap();
        assert_eq!(app.plugin_list().await.unwrap().len(), PACKAGES.len() - 1);
        app.shutdown().await;
    }
    #[tokio::test]
    async fn removed_service_identities_are_not_reprovisioned() {
        let dir = tempfile::tempdir().unwrap();
        let app =
            Application::initialize(dir.path().join("data"), dir.path().join("logs")).unwrap();
        for _ in 0..2 {
            app.provision_bundled_plugins().unwrap();
            let ids: Vec<_> = app
                .plugin_list()
                .await
                .unwrap()
                .into_iter()
                .map(|p| p.manifest.id)
                .collect();
            assert_eq!(ids.len(), 2);
            assert!(
                ids.iter()
                    .all(|id| id.ends_with("docker") || id.ends_with("assistant"))
            );
        }
        for id in [
            "cn.hiboot.plugins.services".to_owned(),
            format!("{LEGACY_PLUGIN_PREFIX}services"),
        ] {
            assert!(matches!(app.plugins.detail(&id), Err(Error::NotFound)));
            let mut package: serde_json::Value = serde_json::from_slice(PACKAGES[0].1).unwrap();
            package["manifest"]["id"] = json!(id);
            assert!(
                app.plugins
                    .install_bundled(&serde_json::to_vec(&package).unwrap(), &id)
                    .is_err()
            );
        }
        app.shutdown().await;
    }
}
