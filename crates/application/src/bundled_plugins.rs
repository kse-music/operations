use super::*;
include!("../../../plugins/system/packages/registry.rs");
impl Application {
    /// Startup-only standard package distribution with fixed system grants.
    /// A tombstone preserves uninstall; existing enable choices remain unchanged.
    pub fn provision_bundled_plugins(&self) -> Result<(), Error> {
        // Root/DB failures remain fatal; an individual plugin cannot block the host.
        self.plugins.inventory()?;
        let mut problems = Vec::new();
        for (id, bytes) in PACKAGES {
            let configured = self.database.bundled_plugin_provisioned(id)?;
            match self.provision_bundled_plugin(id, bytes, configured) {
                Ok(()) => self.database.mark_bundled_plugin_provisioned(id)?,
                Err(error) => {
                    let problem = self.plugins.problem(id, error);
                    tracing::error!(operation="plugin_provision", plugin_id=%problem.id, code=%problem.code, message=%problem.message, "plugin unavailable; application startup continues");
                    problems.push(problem);
                }
            }
        }
        *self
            .plugin_startup_problems
            .lock()
            .map_err(|_| Error::Busy)? = problems;
        Ok(())
    }
    fn provision_bundled_plugin(
        &self,
        id: &str,
        bytes: &[u8],
        configured: bool,
    ) -> Result<(), Error> {
        if !configured {
            match self.plugins.detail(id) {
                Ok(_) => (),
                Err(Error::NotFound) => {
                    self.plugins.install_bundled(bytes, id)?;
                    self.plugins.set_enabled(id, true)?;
                }
                Err(error) => return Err(error),
            }
        }
        match self.plugins.detail(id) {
            Ok(plugin)
                if plugin.source == serverdeck_plugin_core::repository::PluginSource::System =>
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
        Ok(())
    }
    pub async fn plugin_reinstall_bundled(
        &self,
        id: String,
        expected_record_digest: Option<String>,
        confirmed: bool,
    ) -> Result<serverdeck_plugin_core::InstalledPlugin, Error> {
        if !confirmed {
            return Err(Error::Validation("重新安装内置插件需要明确确认"));
        }
        let bytes = PACKAGES
            .iter()
            .find(|(key, _)| *key == id)
            .map(|(_, bytes)| *bytes)
            .ok_or(Error::Validation(
                "此插件没有随应用分发的安装包，请重新上传当前版本",
            ))?;
        if expected_record_digest.is_some() {
            self.plugin_stop_resources(&id).await?;
            self.plugin_runtime.remove(&id).await?;
        }
        let repository = self.plugins.clone();
        let target = id.clone();
        let plugin = self
            .blocking(move |database| {
                let plugin = match expected_record_digest {
                    Some(digest) => {
                        repository.reinstall_bundled(bytes, &target, &digest, confirmed)?
                    }
                    None => repository.restore_bundled(bytes, &target, confirmed)?,
                };
                let grant = bundled_grant(&plugin)?;
                repository.set_grant(
                    &target,
                    serverdeck_plugin_core::permissions::GrantInput {
                        expected_revision: grant.revision,
                        permissions: grant.permissions,
                        operations: grant.operations,
                        read_roots: grant.read_roots,
                        write_roots: grant.write_roots,
                        confirmed: true,
                    },
                )?;
                database.mark_bundled_plugin_provisioned(&target)?;
                Ok(plugin)
            })
            .await?;
        self.plugin_startup_problems
            .lock()
            .map_err(|_| Error::Busy)?
            .retain(|problem| problem.id != id);
        Ok(plugin)
    }
}
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginInventory {
    pub installed: Vec<serverdeck_plugin_core::InstalledPlugin>,
    pub problems: Vec<PluginProblem>,
    pub available_bundled: Vec<serverdeck_plugin_core::Manifest>,
}
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginProblem {
    #[serde(flatten)]
    pub problem: serverdeck_plugin_core::repository::PluginProblem,
    pub replacement: Option<PluginReplacement>,
}
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginReplacement {
    pub name: String,
    pub version: String,
}
impl Application {
    pub async fn plugin_inventory(&self) -> Result<PluginInventory, Error> {
        let repository = self.plugins.clone();
        let startup = self
            .plugin_startup_problems
            .lock()
            .map_err(|_| Error::Busy)?
            .clone();
        self.blocking(move |_| {
            let mut inventory = repository.inventory()?;
            let invalid = inventory
                .problems
                .iter()
                .map(|problem| problem.id.clone())
                .collect::<std::collections::BTreeSet<_>>();
            for problem in startup {
                if !inventory
                    .problems
                    .iter()
                    .any(|existing| existing.id == problem.id)
                {
                    inventory.problems.push(problem);
                }
            }
            let mut available_bundled = Vec::new();
            for (id, bytes) in PACKAGES {
                if !inventory
                    .installed
                    .iter()
                    .any(|plugin| plugin.manifest.id == id)
                    && !invalid.contains(id)
                {
                    #[derive(serde::Deserialize)]
                    struct Metadata {
                        manifest: serverdeck_plugin_core::Manifest,
                    }
                    let package: Metadata = serde_json::from_slice(bytes)
                        .map_err(|error| Error::Worker(Box::new(error)))?;
                    available_bundled.push(package.manifest);
                }
            }
            let problems = inventory
                .problems
                .into_iter()
                .map(|problem| {
                    let replacement =
                        if problem.record_digest.is_some() && invalid.contains(&problem.id) {
                            PACKAGES
                                .iter()
                                .find(|(id, _)| *id == problem.id)
                                .map(|(_, bytes)| {
                                    #[derive(serde::Deserialize)]
                                    struct Metadata {
                                        manifest: PluginReplacement,
                                    }
                                    let package: Metadata = serde_json::from_slice(bytes)
                                        .map_err(|error| Error::Worker(Box::new(error)))?;
                                    Ok::<_, Error>(package.manifest)
                                })
                                .transpose()?
                        } else {
                            None
                        };
                    Ok(PluginProblem {
                        problem,
                        replacement,
                    })
                })
                .collect::<Result<Vec<_>, Error>>()?;
            Ok(PluginInventory {
                installed: inventory.installed,
                problems,
                available_bundled,
            })
        })
        .await
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
            Permission::NetworkConnect => &["network.connect"][..],
            Permission::ModelsUse => &["models.use"][..],
            Permission::HostsRead => &["hosts.read"],
            Permission::SshExecute => &["ssh.execute"],
            Permission::SshExecutePreapproved => &["ssh.execute.preapproved"],
            Permission::SshInteractivePreapproved => &["ssh.interactive.preapproved"],
            Permission::SftpRead => &["sftp.read"],
            Permission::SftpWrite => &["sftp.write"],
            Permission::SftpTransfer => &["sftp.transfer"],
            Permission::SftpTransferPreapproved => &["sftp.transfer.preapproved"],
            Permission::OperationsReadPreapproved => &["operations.read.preapproved"],
            Permission::OperationsReadArgumentsPreapproved => {
                &["operations.read.arguments.preapproved"]
            }
            Permission::OperationsFullPreapproved => &["operations.full.preapproved"],
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

    fn bundled(id: &str) -> (&'static str, &'static [u8]) {
        PACKAGES
            .iter()
            .copied()
            .find(|(key, _)| *key == id)
            .unwrap()
    }
    #[tokio::test]
    async fn docker_archive_grant_preapproves_streams_and_file_transfers() {
        use serverdeck_plugin_sdk::{
            Capability, Permission,
            platform::{Command, Request},
        };
        let dir = tempfile::tempdir().unwrap();
        let app =
            Application::initialize(dir.path().join("data"), dir.path().join("logs")).unwrap();
        app.provision_bundled_plugins().unwrap();
        let plugin = app.plugins.detail("cn.hiboot.plugins.docker").unwrap();
        let grant = app.plugins.grant(&plugin.manifest.id).unwrap().unwrap();
        assert!(
            grant
                .permissions
                .contains(&Permission::SftpTransferPreapproved)
        );
        for request in [
            Request::StreamOpen {
                host_id: "host".into(),
                command: Command::script("archive"),
            },
            Request::TransferStart { id: "copy".into() },
        ] {
            assert!(grant.preapproves(
                &plugin,
                &Capability::Platform {
                    request,
                    bindings: vec![]
                }
            ));
        }
        app.shutdown().await;
    }
    #[tokio::test]
    async fn uninstalled_bundled_plugin_is_restored_only_on_request_with_retained_settings() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().join("data");
        let logs = dir.path().join("logs");
        let app = Application::initialize(data.clone(), logs.clone()).unwrap();
        app.provision_bundled_plugins().unwrap();
        let id = "cn.hiboot.plugins.docker";
        let original = app.plugins.detail(id).unwrap();
        let other = app.plugins.detail("cn.hiboot.plugins.assistant").unwrap();
        app.plugins
            .settings_write(id, &json!({"retained":"docker-configuration"}))
            .unwrap();
        app.plugin_uninstall(UninstallInput {
            id: id.into(),
            clear_data: false,
            confirmed: true,
        })
        .await
        .unwrap();
        app.provision_bundled_plugins().unwrap();
        let inventory = app.plugin_inventory().await.unwrap();
        assert_eq!(
            inventory
                .available_bundled
                .iter()
                .map(|p| p.id.as_str())
                .collect::<Vec<_>>(),
            vec![id]
        );
        assert!(matches!(app.plugins.detail(id), Err(Error::NotFound)));
        assert!(
            app.plugin_reinstall_bundled(id.into(), None, false)
                .await
                .is_err()
        );
        assert!(
            app.plugin_reinstall_bundled("dev.not-bundled".into(), None, true)
                .await
                .is_err()
        );
        assert!(matches!(app.plugins.detail(id), Err(Error::NotFound)));
        let restored = app
            .plugin_reinstall_bundled(id.into(), None, true)
            .await
            .unwrap();
        assert_eq!(
            restored.source,
            serverdeck_plugin_core::repository::PluginSource::System
        );
        assert!(!restored.enabled);
        assert_ne!(restored.revision, original.revision);
        assert_eq!(
            app.plugins.settings_read(id).unwrap()["retained"],
            "docker-configuration"
        );
        assert_eq!(
            app.plugins.grant(id).unwrap().unwrap(),
            bundled_grant(&restored).unwrap()
        );
        assert!(
            app.plugin_inventory()
                .await
                .unwrap()
                .available_bundled
                .is_empty()
        );
        assert_eq!(
            app.plugins.detail(&other.manifest.id).unwrap().revision,
            other.revision
        );
        assert!(app.plugin_statuses().unwrap().is_empty());
        app.shutdown().await;

        let restarted = Application::initialize(data, logs).unwrap();
        restarted.provision_bundled_plugins().unwrap();
        let plugin = restarted.plugins.detail(id).unwrap();
        assert_eq!(plugin.revision, restored.revision);
        assert!(!plugin.enabled);
        assert_eq!(
            restarted.plugins.settings_read(id).unwrap()["retained"],
            "docker-configuration"
        );
        restarted.plugin_set_enabled(id.into(), true).await.unwrap();
        assert!(
            restarted
                .plugin_runtime
                .health(id)
                .await
                .unwrap()
                .error
                .is_none()
        );
        restarted.shutdown().await;
    }

    #[tokio::test]
    async fn missing_plugin_restore_never_replaces_installed_uploads_or_damaged_records() {
        let dir = tempfile::tempdir().unwrap();
        let app =
            Application::initialize(dir.path().join("data"), dir.path().join("logs")).unwrap();
        app.provision_bundled_plugins().unwrap();
        let id = "cn.hiboot.plugins.docker";
        let original = app.plugins.detail(id).unwrap();
        assert!(
            app.plugin_reinstall_bundled(id.into(), None, true)
                .await
                .is_err()
        );
        assert_eq!(app.plugins.detail(id).unwrap().revision, original.revision);
        assert!(app.plugins.detail(id).unwrap().enabled);
        app.plugin_uninstall(UninstallInput {
            id: id.into(),
            clear_data: false,
            confirmed: true,
        })
        .await
        .unwrap();
        let path = dir.path().join("upload.sdplugin");
        std::fs::write(&path, bundled(id).1).unwrap();
        let upload = app
            .plugin_install(serverdeck_plugin_core::InstallInput {
                path,
                development_confirmed: true,
                expected_version: None,
                expected_digest: None,
            })
            .await
            .unwrap();
        assert!(
            app.plugin_inventory()
                .await
                .unwrap()
                .available_bundled
                .is_empty()
        );
        assert!(
            app.plugin_reinstall_bundled(id.into(), None, true)
                .await
                .is_err()
        );
        assert_eq!(app.plugins.detail(id).unwrap().revision, upload.revision);
        assert_eq!(
            app.plugins.detail(id).unwrap().source,
            serverdeck_plugin_core::repository::PluginSource::User
        );
        assert!(app.plugins.grant(id).unwrap().is_none());
        let record = dir
            .path()
            .join("data/plugins/packages")
            .join(id)
            .join("record.json");
        std::fs::write(&record, b"{ damaged }").unwrap();
        let inventory = app.plugin_inventory().await.unwrap();
        assert!(inventory.available_bundled.is_empty());
        assert_eq!(inventory.problems.len(), 1);
        assert!(inventory.problems[0].replacement.is_some());
        assert!(
            app.plugin_reinstall_bundled(id.into(), None, true)
                .await
                .is_err()
        );
        assert_eq!(std::fs::read(&record).unwrap(), b"{ damaged }");
        app.shutdown().await;
    }

    #[tokio::test]
    async fn old_or_corrupt_plugin_records_do_not_block_startup_and_reinstall_is_explicit() {
        let dir = tempfile::tempdir().unwrap();
        let app =
            Application::initialize(dir.path().join("data"), dir.path().join("logs")).unwrap();
        app.provision_bundled_plugins().unwrap();
        let id = "cn.hiboot.plugins.assistant";
        let record = dir
            .path()
            .join("data/plugins/packages")
            .join(id)
            .join("record.json");
        app.plugins
            .settings_write(id, &json!({"modelId":"preserved-model"}))
            .unwrap();
        let mut raw: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&record).unwrap()).unwrap();
        raw["current"]["manifest"]["apiVersion"] = json!("^4.0.0");
        raw["current"]["manifest"]["permissions"] = json!(["assistant.use"]);
        let original = serde_json::to_vec(&raw).unwrap();
        std::fs::write(&record, &original).unwrap();
        let config = app.bootstrap().await.unwrap().config;
        app.provision_bundled_plugins().unwrap();
        let inventory = app.plugin_inventory().await.unwrap();
        assert_eq!(inventory.installed.len(), PACKAGES.len() - 1);
        assert_eq!(inventory.problems.len(), 1);
        let issue = &inventory.problems[0];
        assert_eq!(issue.problem.id, id);
        assert_eq!(issue.replacement.as_ref().unwrap().name, "AI 运维助手");
        assert_eq!(std::fs::read(&record).unwrap(), original);
        assert!(app.plugin_activate(id).await.is_err());
        assert_eq!(app.bootstrap().await.unwrap().config, config);
        let token = issue.problem.record_digest.clone().unwrap();
        assert!(
            app.plugin_reinstall_bundled(id.into(), Some(token.clone()), false)
                .await
                .is_err()
        );
        assert_eq!(std::fs::read(&record).unwrap(), original);
        let installed = app
            .plugin_reinstall_bundled(id.into(), Some(token), true)
            .await
            .unwrap();
        assert!(!installed.enabled);
        assert!(installed.manifest.validate(std::env::consts::OS).is_ok());
        assert!(app.plugin_inventory().await.unwrap().problems.is_empty());
        assert_eq!(
            app.plugins.settings_read(id).unwrap()["modelId"],
            "preserved-model"
        );
        let grant = app.plugin_permissions(id.into()).await.unwrap().unwrap();
        assert_eq!(grant.revision, installed.revision);
        assert!(
            !grant
                .operations
                .iter()
                .any(|operation| operation == "assistant.use")
        );
        app.shutdown().await;
    }

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
            app.plugin_reset((*id).into()).await.unwrap();
            assert!(app.plugin_detail((*id).into()).await.unwrap().enabled);
            assert!(
                app.plugin_statuses()
                    .unwrap()
                    .iter()
                    .all(|s| s.state == State::Stopped)
            );
        }
        assert_eq!(app.plugin_statuses().unwrap().len(), PACKAGES.len());
        app.shutdown().await;
    }

    #[tokio::test]
    async fn docker_search_styles_upgrade_from_installed_2_3_4_without_resetting_settings() {
        use base64::{Engine as _, engine::general_purpose::STANDARD};
        use sha2::{Digest, Sha256};

        let id = "cn.hiboot.plugins.docker";
        let (_, bytes) = bundled(id);
        let mut previous: serde_json::Value = serde_json::from_slice(bytes).unwrap();
        let css = previous["files"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|file| file["path"] == "frontend.css")
            .unwrap();
        let current_css = STANDARD.decode(css["content"].as_str().unwrap()).unwrap();
        let mut old_css = current_css.clone();
        old_css.extend_from_slice(b"\n.operations-view .ops-search input:focus-visible{outline:2px solid var(--accent);outline-offset:3px}\n");
        css["content"] = json!(STANDARD.encode(&old_css));
        let css_digest = previous["manifest"]["files"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|file| file["path"] == "frontend.css")
            .unwrap();
        css_digest["size"] = json!(old_css.len());
        css_digest["sha256"] = json!(format!("{:x}", Sha256::digest(&old_css)));
        previous["manifest"]["version"] = json!("2.3.4");

        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().join("data");
        let logs = dir.path().join("logs");
        let app = Application::initialize(data.clone(), logs.clone()).unwrap();
        app.provision_bundled_plugin(id, &serde_json::to_vec(&previous).unwrap(), false)
            .unwrap();
        app.database.mark_bundled_plugin_provisioned(id).unwrap();
        app.plugins
            .settings_write(id, &json!({"keep":"search-style-upgrade"}))
            .unwrap();
        let original = app.plugins.detail(id).unwrap();
        assert_eq!(original.manifest.version, "2.3.4");
        assert_eq!(
            app.plugin_frontend_asset(id, &original.revision, "server", "frontend.css")
                .unwrap(),
            old_css
        );
        app.shutdown().await;

        let restarted = Application::initialize(data, logs).unwrap();
        restarted.provision_bundled_plugins().unwrap();
        let upgraded = restarted.plugins.detail(id).unwrap();
        let current: serde_json::Value = serde_json::from_slice(bytes).unwrap();
        assert_eq!(
            upgraded.manifest.version,
            current["manifest"]["version"].as_str().unwrap()
        );
        assert_ne!(upgraded.manifest.version, original.manifest.version);
        assert_ne!(upgraded.revision, original.revision);
        assert!(upgraded.enabled);
        assert_eq!(
            restarted.plugins.settings_read(id).unwrap()["keep"],
            "search-style-upgrade"
        );
        assert_eq!(
            restarted
                .plugin_frontend_asset(id, &upgraded.revision, "server", "frontend.css")
                .unwrap(),
            current_css
        );
        assert!(
            restarted
                .plugin_frontend_asset(id, &original.revision, "server", "frontend.css")
                .is_err()
        );
        restarted.shutdown().await;
    }

    #[tokio::test]
    async fn bundled_update_preserves_settings_enable_choices_uploads_and_uninstall() {
        let packages = [
            bundled("cn.hiboot.plugins.docker"),
            bundled("cn.hiboot.plugins.assistant"),
        ];
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().join("data");
        let logs = dir.path().join("logs");
        let app = Application::initialize(data.clone(), logs.clone()).unwrap();
        let mut previous = Vec::new();
        for (index, (id, bytes)) in packages.iter().enumerate() {
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
        for (index, (id, bytes)) in packages.iter().enumerate() {
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
            id: packages[1].0.into(),
            clear_data: false,
            confirmed: true,
        })
        .await
        .unwrap();
        app.plugin_uninstall(UninstallInput {
            id: packages[0].0.into(),
            clear_data: false,
            confirmed: true,
        })
        .await
        .unwrap();
        let path = dir.path().join("upload.sdplugin");
        std::fs::write(&path, packages[0].1).unwrap();
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
            app.plugins.detail(packages[0].0).unwrap().source,
            PluginSource::User
        );
        assert_eq!(
            app.plugins.detail(packages[0].0).unwrap().revision,
            upload.revision
        );
        assert!(app.plugins.grant(packages[0].0).unwrap().is_none());
        assert!(matches!(
            app.plugins.detail(packages[1].0),
            Err(Error::NotFound)
        ));
        app.shutdown().await;
        let restarted = Application::initialize(data, logs).unwrap();
        restarted.provision_bundled_plugins().unwrap();
        assert_eq!(
            restarted.plugins.detail(packages[0].0).unwrap().revision,
            upload.revision
        );
        assert!(matches!(
            restarted.plugins.detail(packages[1].0),
            Err(Error::NotFound)
        ));
        restarted.shutdown().await;
    }

    #[tokio::test]
    async fn system_packages_have_fixed_defaults_while_uploaded_packages_still_require_grants() {
        let docker = bundled("cn.hiboot.plugins.docker");
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
            assert_eq!(defaults, bundled_grant(&plugin).unwrap());
            if id.ends_with("docker") {
                assert!(defaults.operations.contains(&"ssh.execute".into()));
                assert!(
                    defaults
                        .permissions
                        .contains(&serverdeck_plugin_core::Permission::SshExecute)
                );
            }
            assert!(
                app.plugin_grant(
                    id.clone(),
                    GrantInput {
                        expected_revision: plugin.revision.clone(),
                        permissions: vec![serverdeck_plugin_core::Permission::UiContribute],
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
            assert!(
                denied.error.is_some(),
                "unknown business actions must not become platform passthrough"
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
        // Provisioning restores fixed system grants without re-enabling disabled plugins.
        app.plugins.revoke_grant(docker.0).unwrap();
        app.provision_bundled_plugins().unwrap();
        assert!(
            app.plugin_permissions(docker.0.into())
                .await
                .unwrap()
                .unwrap()
                .operations
                .contains(&"ssh.execute".into())
        );
        assert!(!app.plugins.detail(docker.0).unwrap().enabled);
        let id = docker.0;
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
        std::fs::write(&path, docker.1).unwrap();
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
        assert!(!restarted.plugins.detail(docker.0).unwrap().enabled);
        restarted.shutdown().await;
    }
    #[tokio::test]
    async fn only_current_system_packages_are_provisioned() {
        let dir = tempfile::tempdir().unwrap();
        let app =
            Application::initialize(dir.path().join("data"), dir.path().join("logs")).unwrap();
        for _ in 0..2 {
            app.provision_bundled_plugins().unwrap();
            let ids: std::collections::BTreeSet<_> = app
                .plugin_list()
                .await
                .unwrap()
                .into_iter()
                .map(|p| p.manifest.id)
                .collect();
            let expected = PACKAGES.iter().map(|(id, _)| (*id).to_owned()).collect();
            assert_eq!(ids, expected);
            assert_eq!(
                ids.len(),
                PACKAGES.len(),
                "bundled plugin IDs must be unique"
            );
            let sources =
                std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../plugins/system");
            let mut source_ids = std::collections::BTreeSet::new();
            for entry in std::fs::read_dir(sources).unwrap() {
                let entry = entry.unwrap();
                if !entry.file_type().unwrap().is_dir() || entry.file_name() == "packages" {
                    continue;
                }
                let manifest: serde_json::Value = serde_json::from_slice(
                    &std::fs::read(entry.path().join("manifest.json")).unwrap(),
                )
                .unwrap();
                source_ids.insert(manifest["id"].as_str().unwrap().to_owned());
            }
            assert_eq!(
                ids, source_ids,
                "rebuild plugins when source directories change"
            );
            for plugin in app.plugin_list().await.unwrap() {
                if plugin.manifest.entry.ui.is_none() {
                    continue;
                }
                let ui = app
                    .plugins
                    .ui(&plugin.manifest.id, &plugin.revision)
                    .unwrap();
                let frontend = ui.frontend.unwrap();
                for asset in [frontend.script, frontend.style] {
                    let bytes = app
                        .plugins
                        .frontend_asset(&plugin.manifest.id, &plugin.revision, &asset)
                        .unwrap();
                    assert!(
                        !bytes.is_empty(),
                        "{} must supply {asset}",
                        plugin.manifest.id
                    );
                }
            }
        }
        app.shutdown().await;
    }
}
