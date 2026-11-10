use crate::{InstalledPlugin, Permission, invalid};
use serde::{Deserialize, Serialize};
use serverdeck_core::{Error, files::remote_absolute};
use serverdeck_plugin_sdk::Capability;
use std::collections::BTreeSet;

pub const OPERATIONS: &[&str] = &[
    "models.use",
    "network.connect",
    "hosts.read",
    "ssh.execute",
    "ssh.execute.preapproved",
    "operations.read.preapproved",
    "ssh.interactive.preapproved",
    "sftp.read",
    "sftp.write",
    "sftp.transfer",
    "settings.read",
    "settings.write",
    "ui.notify",
    "ui.contribute",
];
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GrantInput {
    pub expected_revision: String,
    pub permissions: Vec<Permission>,
    pub operations: Vec<String>,
    pub read_roots: Vec<String>,
    pub write_roots: Vec<String>,
    pub confirmed: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Grant {
    pub version: u32,
    pub plugin_id: String,
    pub plugin_version: String,
    pub publisher: Option<String>,
    pub package_digest: String,
    pub revision: String,
    pub permissions: Vec<Permission>,
    pub operations: Vec<String>,
    pub read_roots: Vec<String>,
    pub write_roots: Vec<String>,
}
impl Grant {
    pub fn new(plugin: &InstalledPlugin, input: GrantInput) -> Result<Self, Error> {
        if !input.confirmed || input.expected_revision != plugin.revision {
            return Err(Error::Conflict);
        }
        if input
            .permissions
            .iter()
            .any(|p| !plugin.manifest.permissions.contains(p))
            || input.operations.len() > OPERATIONS.len()
            || input
                .operations
                .iter()
                .any(|o| !OPERATIONS.contains(&o.as_str()))
            || input.permissions.iter().collect::<BTreeSet<_>>().len() != input.permissions.len()
            || input.operations.iter().collect::<BTreeSet<_>>().len() != input.operations.len()
        {
            return Err(invalid("插件授权范围无效或超出清单声明"));
        }
        for roots in [&input.read_roots, &input.write_roots] {
            if roots.len() > 16 {
                return Err(invalid("插件文件授权最多十六个根路径"));
            }
            for root in roots {
                remote_absolute(root)?;
                if root.len() > 512 || (root != "/" && root.ends_with('/')) || root.contains("//") {
                    return Err(invalid("插件授权路径需要规范的绝对目录"));
                }
            }
        }
        Ok(Self {
            version: 1,
            plugin_id: plugin.manifest.id.clone(),
            plugin_version: plugin.manifest.version.clone(),
            publisher: plugin.manifest.publisher.clone(),
            package_digest: plugin.package_digest.clone(),
            revision: plugin.revision.clone(),
            permissions: input.permissions,
            operations: input.operations,
            read_roots: input.read_roots,
            write_roots: input.write_roots,
        })
    }
    pub fn matches(&self, plugin: &InstalledPlugin) -> bool {
        self.version == 1
            && self.plugin_id == plugin.manifest.id
            && self.plugin_version == plugin.manifest.version
            && self.publisher == plugin.manifest.publisher
            && self.package_digest == plugin.package_digest
            && self.revision == plugin.revision
    }
    pub fn authorize(&self, plugin: &InstalledPlugin, operation: &Capability) -> Result<(), Error> {
        if !plugin.enabled
            || !self.matches(plugin)
            || !plugin
                .manifest
                .permissions
                .contains(&operation.permission())
            || !self.permissions.contains(&operation.permission())
            || !self.operations.iter().any(|o| o == operation.operation())
        {
            return Err(denied());
        }
        Ok(())
    }
    pub fn path(&self, path: &str, write: bool) -> Result<(), Error> {
        remote_absolute(path)?;
        let roots = if write {
            &self.write_roots
        } else {
            &self.read_roots
        };
        if path.contains("//")
            || !roots.iter().any(|root| {
                root == "/"
                    || path == root
                    || path
                        .strip_prefix(root)
                        .is_some_and(|suffix| suffix.starts_with('/'))
            })
        {
            return Err(denied());
        }
        Ok(())
    }
    /// Fixed commands and interactive sessions have separate, revision-bound grants.
    pub fn preapproves(&self, plugin: &InstalledPlugin, operation: &Capability) -> bool {
        use serverdeck_plugin_sdk::platform::Request;
        if self.authorize(plugin, operation).is_err() {
            return false;
        }
        let Capability::Platform { request, .. } = operation;
        let (permission, name) = match request {
            Request::Execute { command, .. }
                if plugin.manifest.preapproved_commands.contains(command) =>
            {
                (Permission::SshExecutePreapproved, "ssh.execute.preapproved")
            }
            Request::StreamOpen { .. } | Request::Terminal { .. } => (
                Permission::SshInteractivePreapproved,
                "ssh.interactive.preapproved",
            ),
            _ => return false,
        };
        plugin.manifest.permissions.contains(&permission)
            && self.permissions.contains(&permission)
            && self.operations.iter().any(|operation| operation == name)
    }
}
pub fn denied() -> Error {
    Error::Connection {
        code: "PLUGIN_PERMISSION_DENIED",
        message: "插件未获此版本或操作范围的授权，或尚未选择主机",
        source: None,
    }
}

#[cfg(test)]
mod tests;
