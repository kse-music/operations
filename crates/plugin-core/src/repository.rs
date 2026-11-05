use crate::{
    Manifest, Package, invalid, io,
    manifest::{validate_id, validate_path},
    package::digest,
};
use serde::{Deserialize, Serialize};
use serverdeck_core::Error;
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Trust {
    LocalDevelopmentUnverified,
}
#[derive(Debug, Default, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PluginSource {
    System,
    #[default]
    User,
}

/// Reserved for a real cryptographic verifier. No production verifier is installed in v1.
/// Implementations must bind publisher identity, complete manifest and all file digests.
pub trait PublisherVerifier: Send + Sync {
    fn verify(
        &self,
        manifest: &Manifest,
        package_digest: &str,
        signature: &[u8],
    ) -> Result<String, Error>;
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InstalledPlugin {
    #[serde(default)]
    pub source: PluginSource,
    pub manifest: Manifest,
    pub enabled: bool,
    pub trust: Trust,
    pub package_digest: String,
    pub revision: String,
    pub previous_version: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackagePreview {
    pub manifest: Manifest,
    pub package_digest: String,
    pub trust: Trust,
    pub compatible: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Record {
    version: u32,
    current: InstalledPlugin,
    backup: Option<InstalledPlugin>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InstallInput {
    pub path: PathBuf,
    pub development_confirmed: bool,
    pub expected_version: Option<String>,
    #[serde(default)]
    pub expected_digest: Option<String>,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UninstallInput {
    pub id: String,
    pub clear_data: bool,
    pub confirmed: bool,
}

#[derive(Clone)]
pub struct Repository {
    root: PathBuf,
    platform: String,
}
mod layout;
impl Repository {
    pub fn open(root: PathBuf) -> Result<Self, Error> {
        ensure_directory(&root)?;
        for name in [
            "packages",
            "upload",
            "system",
            "data",
            "cache",
            "authorizations",
        ] {
            ensure_directory(&root.join(name))?;
        }
        let repository = Self {
            root,
            platform: std::env::consts::OS.into(),
        };
        repository.retire_removed_tools()?;
        repository.migrate_payload_layout()?;
        Ok(repository)
    }
    pub fn preview(&self, path: &Path) -> Result<Manifest, Error> {
        Ok(Package::read(path, &self.platform)?.manifest)
    }
    pub fn preview_info(&self, path: &Path) -> Result<PackagePreview, Error> {
        let p = Package::read(path, &self.platform)?;
        Ok(PackagePreview {
            manifest: p.manifest,
            package_digest: p.digest,
            trust: Trust::LocalDevelopmentUnverified,
            compatible: true,
        })
    }
    pub fn ui(&self, id: &str, revision: &str) -> Result<serverdeck_plugin_sdk::ui::Ui, Error> {
        let plugin = self.detail(id)?;
        let grant = self.grant(id)?.ok_or_else(crate::permissions::denied)?;
        if !plugin.enabled
            || plugin.revision != revision
            || !grant.matches(&plugin)
            || !grant.permissions.contains(&crate::Permission::UiContribute)
            || !grant.operations.iter().any(|o| o == "ui.contribute")
        {
            return Err(crate::permissions::denied());
        }
        let path = plugin
            .manifest
            .entry
            .ui
            .as_ref()
            .ok_or_else(|| invalid("插件没有声明式 UI"))?;
        let bytes = self.read_file(&plugin, path)?;
        if bytes.len() > 64 * 1024 {
            return Err(invalid("插件 UI 声明超限"));
        }
        let ui: serverdeck_plugin_sdk::ui::Ui =
            serde_json::from_slice(&bytes).map_err(|_| invalid("插件 UI 声明损坏"))?;
        ui.validate().map_err(invalid)?;
        Ok(ui)
    }
    pub fn install(&self, input: InstallInput) -> Result<InstalledPlugin, Error> {
        self.install_inner(input, false)
    }
    /// Only the two declared UI assets are accessible; authorization and digests
    /// are checked again on every resource request, including after revocation.
    pub fn frontend_asset(&self, id: &str, revision: &str, path: &str) -> Result<Vec<u8>, Error> {
        let ui = self.ui(id, revision)?;
        let frontend = ui.frontend.ok_or_else(|| invalid("插件没有独立界面"))?;
        if path != frontend.script && path != frontend.style {
            return Err(crate::permissions::denied());
        }
        let plugin = self.detail(id)?;
        if !plugin.enabled || plugin.revision != revision {
            return Err(crate::permissions::denied());
        }
        self.read_file(&plugin, path)
    }
    fn install_inner(
        &self,
        input: InstallInput,
        fail_commit: bool,
    ) -> Result<InstalledPlugin, Error> {
        self.install_with_source(input, fail_commit, PluginSource::User)
    }
    fn install_with_source(
        &self,
        input: InstallInput,
        fail_commit: bool,
        source: PluginSource,
    ) -> Result<InstalledPlugin, Error> {
        if !input.development_confirmed {
            return Err(invalid(
                "尚未提供签名验证；必须明确确认安装不可信本地开发包",
            ));
        }
        let package = Package::read(&input.path, &self.platform)?;
        if input
            .expected_digest
            .as_ref()
            .is_some_and(|d| d != &package.digest)
        {
            return Err(invalid("插件包在预览后已变化，请重新预览并确认"));
        }
        let id = &package.manifest.id;
        let folder = self.folder(id)?;
        let old = if folder.join("record.json").try_exists().map_err(io)? {
            Some(self.record(id)?)
        } else {
            None
        };
        match &old {
            Some(old) => {
                if input.expected_version.as_ref() != Some(&old.current.manifest.version) {
                    return Err(Error::Conflict);
                }
                let parse =
                    |v: &str| semver::Version::parse(v).map_err(|_| invalid("插件版本无效"));
                if parse(&package.manifest.version)? <= parse(&old.current.manifest.version)? {
                    return Err(invalid("重复安装或降级被拒绝；升级必须使用更高版本"));
                }
            }
            None => {
                if input.expected_version.is_some() {
                    return Err(Error::Conflict);
                }
                if self.list()?.len() >= 64 {
                    return Err(invalid("已安装插件数量达到 64 个上限"));
                }
            }
        }
        if let Some(record) = &old {
            self.clean_versions(id, record)?;
        }
        ensure_directory(&folder)?;
        let versions = self.payload_folder(source, id)?.join("versions");
        ensure_directory(&versions)?;
        let candidate = tempfile::Builder::new()
            .prefix("version-")
            .tempdir_in(&versions)
            .map_err(io)?;
        for (name, data) in &package.files {
            let path = candidate.path().join(name);
            if let Some(parent) = path.parent() {
                ensure_directory(parent)?;
            }
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(path)
                .map_err(io)?;
            file.write_all(data).map_err(io)?;
            file.sync_all().map_err(io)?;
        }
        let revision = candidate
            .path()
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or_else(|| invalid("插件存储路径无效"))?
            .to_owned();
        let plugin = InstalledPlugin {
            source,
            manifest: package.manifest,
            enabled: source == PluginSource::System
                && old.as_ref().is_some_and(|record| record.current.enabled),
            trust: Trust::LocalDevelopmentUnverified,
            package_digest: package.digest,
            revision,
            previous_version: old.as_ref().map(|r| r.current.manifest.version.clone()),
        };
        // Durable old generation is the backup. The atomic pointer is the only commit point.
        let record = Record {
            version: 1,
            current: plugin.clone(),
            backup: old.map(|r| r.current),
        };
        if fail_commit {
            return Err(invalid("安装提交故障（测试注入）"));
        }
        write_json(&folder.join("record.json"), &record)?;
        let _committed = candidate.keep();
        Ok(plugin)
    }
    pub fn list(&self) -> Result<Vec<InstalledPlugin>, Error> {
        check_directory(&self.root.join("packages"))?;
        let mut plugins = Vec::new();
        for entry in fs::read_dir(self.root.join("packages")).map_err(io)? {
            let entry = entry.map_err(io)?;
            check_directory(&entry.path())?;
            let id = entry
                .file_name()
                .into_string()
                .map_err(|_| invalid("插件仓库目录名无效"))?;
            validate_id(&id)?;
            if entry.path().join("record.json").try_exists().map_err(io)? {
                plugins.push(self.detail(&id)?);
                if plugins.len() > 64 {
                    return Err(invalid("插件仓库数量超限"));
                }
            }
        }
        plugins.sort_by(|a, b| a.manifest.id.cmp(&b.manifest.id));
        Ok(plugins)
    }
    /// Only the application distribution calls this with its embedded package bytes.
    /// Existing system packages may advance; uploads and newer versions are preserved.
    pub fn install_bundled(
        &self,
        bytes: &[u8],
        expected_id: &str,
    ) -> Result<InstalledPlugin, Error> {
        use std::io::Write;
        let mut temporary = tempfile::NamedTempFile::new_in(self.root.join("cache")).map_err(io)?;
        temporary.write_all(bytes).map_err(io)?;
        let preview = self.preview_info(temporary.path())?;
        if preview.manifest.id != expected_id {
            return Err(invalid("随应用分发的插件身份不匹配"));
        }
        let existing = match self.detail(expected_id) {
            Ok(plugin) if plugin.source == PluginSource::System => Some(plugin),
            Ok(_) => return Err(Error::Conflict),
            Err(Error::NotFound) => None,
            Err(error) => return Err(error),
        };
        if let Some(plugin) = &existing {
            let version =
                |value: &str| semver::Version::parse(value).map_err(|_| invalid("插件版本无效"));
            if version(&preview.manifest.version)? <= version(&plugin.manifest.version)? {
                return Ok(plugin.clone());
            }
        }
        self.install_with_source(
            InstallInput {
                path: temporary.path().to_owned(),
                development_confirmed: true,
                expected_version: existing.map(|plugin| plugin.manifest.version),
                expected_digest: Some(preview.package_digest),
            },
            false,
            PluginSource::System,
        )
    }
    pub fn detail(&self, id: &str) -> Result<InstalledPlugin, Error> {
        Ok(self.record(id)?.current)
    }
    pub fn set_enabled(&self, id: &str, enabled: bool) -> Result<InstalledPlugin, Error> {
        let mut record = self.record(id)?;
        if enabled {
            self.verify_installed(&record.current)?;
        }
        record.current.enabled = enabled;
        write_json(&self.folder(id)?.join("record.json"), &record)?;
        Ok(record.current)
    }
    pub fn uninstall(&self, input: UninstallInput) -> Result<(), Error> {
        if !input.confirmed {
            return Err(invalid("卸载插件需要明确确认"));
        }
        self.detail(&input.id)?;
        // Disable durably before removing any content; a partial cleanup can never activate.
        self.set_enabled(&input.id, false)?;
        self.revoke_grant(&input.id)?;
        for source in [PluginSource::User, PluginSource::System] {
            let payload = self.payload_folder(source, &input.id)?;
            if payload.try_exists().map_err(io)? {
                remove_tree(&payload)?;
            }
        }
        remove_tree(&self.folder(&input.id)?)?;
        let cache = self.root.join("cache").join(&input.id);
        if cache.try_exists().map_err(io)? {
            remove_tree(&cache)?;
        }
        if input.clear_data {
            let data = self.root.join("data").join(&input.id);
            if data.try_exists().map_err(io)? {
                remove_tree(&data)?;
            }
        }
        Ok(())
    }
    pub fn data_directory(&self, id: &str) -> Result<PathBuf, Error> {
        self.detail(id)?;
        let path = self.root.join("data").join(id);
        ensure_directory(&path)?;
        Ok(path)
    }
    pub fn grant(&self, id: &str) -> Result<Option<crate::permissions::Grant>, Error> {
        let plugin = self.detail(id)?;
        let path = self.root.join("authorizations").join(format!("{id}.json"));
        check_ancestors(&path)?;
        if !path.try_exists().map_err(io)? {
            return Ok(None);
        }
        let bytes = read_bounded(&path, 32 * 1024)?;
        let metadata: serde_json::Value =
            serde_json::from_slice(&bytes).map_err(|e| Error::Storage(Box::new(e)))?;
        let revision = metadata["revision"]
            .as_str()
            .ok_or_else(|| invalid("插件授权记录缺少安装代号"))?;
        let version = metadata["pluginVersion"]
            .as_str()
            .ok_or_else(|| invalid("插件授权记录缺少版本"))?;
        if revision != plugin.revision || version != plugin.manifest.version {
            return Ok(None);
        }
        let grant: crate::permissions::Grant =
            serde_json::from_slice(&bytes).map_err(|e| Error::Storage(Box::new(e)))?;
        Ok(grant.matches(&plugin).then_some(grant))
    }
    pub fn set_grant(
        &self,
        id: &str,
        input: crate::permissions::GrantInput,
    ) -> Result<crate::permissions::Grant, Error> {
        let grant = crate::permissions::Grant::new(&self.detail(id)?, input)?;
        write_json(
            &self.root.join("authorizations").join(format!("{id}.json")),
            &grant,
        )?;
        Ok(grant)
    }
    pub fn revoke_grant(&self, id: &str) -> Result<(), Error> {
        self.detail(id)?;
        let path = self.root.join("authorizations").join(format!("{id}.json"));
        check_ancestors(&path)?;
        if path.try_exists().map_err(io)? {
            fs::remove_file(path).map_err(io)?;
        }
        Ok(())
    }
    pub fn settings_read(&self, id: &str) -> Result<serde_json::Value, Error> {
        let path = self.data_directory(id)?.join("settings.json");
        check_ancestors(&path)?;
        if !path.try_exists().map_err(io)? {
            return Ok(serde_json::json!({}));
        }
        serde_json::from_slice(&read_bounded(&path, 16 * 1024)?)
            .map_err(|e| Error::Storage(Box::new(e)))
    }
    pub fn settings_write(&self, id: &str, value: &serde_json::Value) -> Result<(), Error> {
        if serde_json::to_vec(value)
            .map_err(|e| Error::Storage(Box::new(e)))?
            .len()
            > 16 * 1024
        {
            return Err(invalid("插件设置超过 16 KiB"));
        }
        write_json(&self.data_directory(id)?.join("settings.json"), value)
    }
    pub fn read_file(&self, plugin: &InstalledPlugin, path: &str) -> Result<Vec<u8>, Error> {
        validate_path(path)?;
        let file = plugin
            .manifest
            .files
            .iter()
            .find(|f| f.path == path)
            .ok_or_else(|| invalid("插件文件未声明"))?;
        let base = self
            .payload_folder(plugin.source, &plugin.manifest.id)?
            .join("versions")
            .join(&plugin.revision);
        check_directory(&base)?;
        let target = base.join(path);
        check_ancestors(&target)?;
        let data = read_bounded(&target, crate::package::MAX_FILE as u64)?;
        if data.len() as u64 != file.size || digest(&data) != file.sha256 {
            return Err(invalid("已安装插件文件被修改"));
        }
        Ok(data)
    }
    pub fn verify_installed(&self, plugin: &InstalledPlugin) -> Result<(), Error> {
        for file in &plugin.manifest.files {
            self.read_file(plugin, &file.path)?;
        }
        Ok(())
    }
    fn record(&self, id: &str) -> Result<Record, Error> {
        let path = self.folder(id)?.join("record.json");
        if !path.try_exists().map_err(io)? {
            return Err(Error::NotFound);
        }
        let record: Record = serde_json::from_slice(&read_bounded(&path, 128 * 1024)?)
            .map_err(|e| Error::Storage(Box::new(e)))?;
        if record.version != 1 || record.current.manifest.id != id {
            return Err(invalid("插件仓库状态损坏"));
        }
        for p in std::iter::once(&record.current).chain(record.backup.iter()) {
            p.manifest.validate(&self.platform)?;
            validate_path(&p.revision)?;
            if p.revision.contains('/') || !p.revision.starts_with("version-") {
                return Err(invalid("插件存储代号无效"));
            }
        }
        Ok(record)
    }
    fn folder(&self, id: &str) -> Result<PathBuf, Error> {
        validate_id(id)?;
        let folder = self.root.join("packages").join(id);
        check_ancestors(&folder)?;
        Ok(folder)
    }
    fn clean_versions(&self, id: &str, record: &Record) -> Result<(), Error> {
        for source in [PluginSource::User, PluginSource::System] {
            let versions = self.payload_folder(source, id)?.join("versions");
            if !versions.try_exists().map_err(io)? {
                continue;
            }
            check_directory(&versions)?;
            for item in fs::read_dir(&versions).map_err(io)? {
                let item = item.map_err(io)?;
                let name = item.file_name();
                let name = name.to_str().ok_or_else(|| invalid("插件版本目录名无效"))?;
                if !(record.current.source == source && name == record.current.revision)
                    && !record
                        .backup
                        .as_ref()
                        .is_some_and(|b| b.source == source && b.revision == name)
                {
                    if !name.starts_with("version-") {
                        return Err(invalid("插件版本目录包含未知产物"));
                    }
                    remove_tree(&item.path())?;
                }
            }
        }
        Ok(())
    }
}

fn read_bounded(path: &Path, limit: u64) -> Result<Vec<u8>, Error> {
    check_ancestors(path)?;
    let file = fs::File::open(path).map_err(io)?;
    if !file.metadata().map_err(io)?.is_file() {
        return Err(invalid("插件文件类型无效"));
    }
    let mut bytes = Vec::new();
    file.take(limit + 1).read_to_end(&mut bytes).map_err(io)?;
    if bytes.len() as u64 > limit {
        return Err(invalid("插件文件大小超限"));
    }
    Ok(bytes)
}
fn write_json(path: &Path, value: &impl Serialize) -> Result<(), Error> {
    check_ancestors(path)?;
    let parent = path.parent().ok_or_else(|| invalid("插件存储目录无效"))?;
    let mut temp = tempfile::NamedTempFile::new_in(parent).map_err(io)?;
    serde_json::to_writer(temp.as_file_mut(), value).map_err(|e| Error::Storage(Box::new(e)))?;
    temp.as_file_mut().sync_all().map_err(io)?;
    temp.persist(path).map_err(|e| io(e.error))?;
    Ok(())
}
fn is_link(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}
fn check_ancestors(path: &Path) -> Result<(), Error> {
    for path in path.ancestors() {
        match fs::symlink_metadata(path) {
            Ok(m) if is_link(&m) => return Err(invalid("插件目录不允许符号链接或重解析点")),
            Ok(_) => (),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
            Err(e) => return Err(io(e)),
        }
    }
    Ok(())
}
fn check_directory(path: &Path) -> Result<(), Error> {
    check_ancestors(path)?;
    if !fs::metadata(path).map_err(io)?.is_dir() {
        return Err(invalid("插件目录类型无效"));
    }
    Ok(())
}
fn ensure_directory(path: &Path) -> Result<(), Error> {
    check_ancestors(path)?;
    fs::create_dir_all(path).map_err(io)?;
    check_directory(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(io)?;
    }
    Ok(())
}
fn remove_tree(path: &Path) -> Result<(), Error> {
    // Validate the complete owned tree before deletion; never traverse links or reparse points.
    check_directory(path)?;
    verify_tree(path)?;
    fs::remove_dir_all(path).map_err(io)
}
fn verify_tree(path: &Path) -> Result<(), Error> {
    for item in fs::read_dir(path).map_err(io)? {
        let item = item.map_err(io)?;
        let m = fs::symlink_metadata(item.path()).map_err(io)?;
        if is_link(&m) || (!m.is_dir() && !m.is_file()) {
            return Err(invalid("插件清理路径包含不安全文件类型"));
        }
        if m.is_dir() {
            verify_tree(&item.path())?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests;
