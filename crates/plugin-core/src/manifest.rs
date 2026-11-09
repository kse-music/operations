use crate::invalid;
use semver::{Version, VersionReq};
use serde::{Deserialize, Serialize};
use serverdeck_core::Error;
use std::collections::BTreeSet;

pub const API_VERSION: &str = "5.0.0";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Manifest {
    pub schema_version: u32,
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    pub version: String,
    pub author: String,
    pub description: String,
    pub api_version: String,
    pub entry: Entry,
    pub permissions: Vec<Permission>,
    pub contributions: Vec<Contribution>,
    pub platforms: Vec<String>,
    pub files: Vec<FileDigest>,
    pub publisher: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Entry {
    pub backend: Option<String>,
    pub ui: Option<String>,
}

pub use serverdeck_plugin_sdk::Permission;
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ContributionKind {
    Workspace,
    Navigation,
    HostMenu,
    Command,
    Settings,
    Server,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Contribution {
    pub id: String,
    pub label: String,
    pub kind: ContributionKind,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub routes: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileDigest {
    pub path: String,
    pub size: u64,
    pub sha256: String,
}

pub fn validate_id(id: &str) -> Result<(), Error> {
    validate_path(id)?;
    if id.len() < 3
        || id.len() > 80
        || !id.contains('.')
        || id.split('.').any(|part| {
            part.is_empty()
                || !part.as_bytes()[0].is_ascii_lowercase()
                || !part
                    .bytes()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
        })
    {
        return Err(invalid("插件 ID 必须是小写反向域名标识"));
    }
    Ok(())
}

/// A deliberately portable, canonical relative path subset. No links, ADS or aliases.
pub fn validate_path(path: &str) -> Result<(), Error> {
    if path.is_empty()
        || path.len() > 200
        || path.split('/').any(|part| {
            let stem = part
                .split('.')
                .next()
                .unwrap_or_default()
                .to_ascii_uppercase();
            part.is_empty()
                || part == "."
                || part == ".."
                || part.ends_with('.')
                || !part
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
                || [
                    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6",
                    "COM7", "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7",
                    "LPT8", "LPT9",
                ]
                .contains(&stem.as_str())
        })
    {
        return Err(invalid("插件包包含不安全或不兼容的文件路径"));
    }
    Ok(())
}

impl Manifest {
    pub fn validate(&self, platform: &str) -> Result<(), Error> {
        validate_id(&self.id)?;
        if let Some(icon) = &self.icon
            && (icon.is_empty()
                || icon.len() > 64
                || !icon.as_bytes()[0].is_ascii_lowercase()
                || icon.split('-').any(|part| {
                    part.is_empty()
                        || !part
                            .bytes()
                            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
                }))
        {
            return Err(invalid("插件图标必须是最多 64 字节的小写图标名称"));
        }
        if self.schema_version != 1
            || self.name.trim().is_empty()
            || self.name.len() > 120
            || self.author.trim().is_empty()
            || self.author.len() > 200
            || self.description.len() > 2000
            || self
                .publisher
                .as_ref()
                .is_some_and(|s| s.is_empty() || s.len() > 200)
        {
            return Err(invalid("插件清单字段或协议版本无效"));
        }
        Version::parse(&self.version).map_err(|_| invalid("插件版本必须是 SemVer"))?;
        let api =
            VersionReq::parse(&self.api_version).map_err(|_| invalid("插件 API 版本范围无效"))?;
        let current = Version::parse(API_VERSION).map_err(|_| invalid("宿主 API 版本无效"))?;
        if !api.matches(&current) {
            return Err(invalid("插件 API 版本与宿主不兼容"));
        }
        if self.platforms.is_empty()
            || self.platforms.len() > 3
            || self
                .platforms
                .iter()
                .any(|p| !["windows", "linux", "macos"].contains(&p.as_str()))
            || !self.platforms.iter().any(|p| p == platform)
        {
            return Err(invalid("插件不支持当前平台"));
        }
        let permissions: BTreeSet<_> = self.permissions.iter().collect();
        if permissions.len() != self.permissions.len() || self.contributions.len() > 32 {
            return Err(invalid("插件权限重复或 UI 贡献超限"));
        }
        let mut contribution_ids = BTreeSet::new();
        for c in &self.contributions {
            if c.routes.len() > 32
                || c.routes
                    .iter()
                    .any(|route| !serverdeck_plugin_sdk::ui::identifier(route))
                || c.routes.iter().collect::<BTreeSet<_>>().len() != c.routes.len()
            {
                return Err(invalid("插件导航路由无效或重复"));
            }
            validate_path(&c.id)?;
            if !contribution_ids.insert(&c.id) || c.label.trim().is_empty() || c.label.len() > 120 {
                return Err(invalid("插件 UI 贡献标识重复或标签无效"));
            }
        }
        if !self.contributions.is_empty()
            && (self.entry.ui.is_none() || !permissions.contains(&Permission::UiContribute))
        {
            return Err(invalid("UI 贡献需要 UI 入口和 ui.contribute 声明"));
        }
        for (path, suffix) in [(&self.entry.backend, ".wasm"), (&self.entry.ui, ".json")] {
            if let Some(path) = path {
                validate_path(path)?;
                if !path.ends_with(suffix) || !self.files.iter().any(|f| &f.path == path) {
                    return Err(invalid("插件入口必须在文件清单中且类型受支持"));
                }
            }
        }
        Ok(())
    }
}
