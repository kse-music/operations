use crate::{Manifest, invalid, io, manifest::validate_path};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use serverdeck_core::Error;
use sha2::{Digest, Sha256};
use std::{collections::BTreeSet, fs::File, io::Read, path::Path};

pub const MAX_PACKAGE: u64 = 16 * 1024 * 1024;
pub const MAX_FILE: usize = 4 * 1024 * 1024;
pub const MAX_TOTAL: usize = 12 * 1024 * 1024;
pub const MAX_FILES: usize = 128;

/// .sdplugin v1 is bounded JSON + base64 regular files; compression and links do not exist.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Package {
    pub format_version: u32,
    pub manifest: Manifest,
    pub files: Vec<PackageFile>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PackageFile {
    pub path: String,
    pub content: String,
}
pub struct ValidatedPackage {
    pub manifest: Manifest,
    pub files: Vec<(String, Vec<u8>)>,
    pub digest: String,
}

impl Package {
    pub fn read(path: &Path, platform: &str) -> Result<ValidatedPackage, Error> {
        if !std::fs::symlink_metadata(path)
            .map_err(io)?
            .file_type()
            .is_file()
        {
            return Err(invalid("插件包必须是普通文件且不能是符号链接"));
        }
        let file = File::open(path).map_err(io)?;
        if !file.metadata().map_err(io)?.is_file() {
            return Err(invalid("插件包必须是普通文件"));
        }
        if file.metadata().map_err(io)?.len() > MAX_PACKAGE {
            return Err(invalid("插件包超过 16 MiB"));
        }
        let mut bytes = Vec::new();
        file.take(MAX_PACKAGE + 1)
            .read_to_end(&mut bytes)
            .map_err(io)?;
        Self::validate_bytes(&bytes, platform)
    }
    pub fn validate_bytes(bytes: &[u8], platform: &str) -> Result<ValidatedPackage, Error> {
        if bytes.len() as u64 > MAX_PACKAGE {
            return Err(invalid("插件包超过 16 MiB"));
        }
        let package: Self = serde_json::from_slice(bytes).map_err(|source| Error::Connection {
            code: "PLUGIN_INVALID",
            message: "插件包 JSON 损坏或含未知字段",
            source: Some(Box::new(source)),
        })?;
        if package.format_version != 1
            || package.files.len() > MAX_FILES
            || package.files.len() != package.manifest.files.len()
        {
            return Err(invalid("插件包版本、文件数量或清单无效"));
        }
        package.manifest.validate(platform)?;
        let mut names = BTreeSet::new();
        let mut files = Vec::new();
        let mut total = 0;
        for item in package.files {
            validate_path(&item.path)?;
            let name = item.path.to_ascii_lowercase();
            if !names.insert(name.clone()) || name == "manifest.json" {
                return Err(invalid("插件包存在重复或保留文件路径"));
            }
            if item.content.len() > MAX_FILE.div_ceil(3) * 4 {
                return Err(invalid("插件单文件超过 4 MiB"));
            }
            let data = STANDARD
                .decode(&item.content)
                .map_err(|_| invalid("插件文件 base64 损坏"))?;
            total += data.len();
            if data.len() > MAX_FILE || total > MAX_TOTAL {
                return Err(invalid("插件解码大小超限"));
            }
            let matching: Vec<_> = package
                .manifest
                .files
                .iter()
                .filter(|f| f.path == item.path)
                .collect();
            if matching.len() != 1
                || matching[0].size != data.len() as u64
                || matching[0].sha256 != digest(&data)
            {
                return Err(invalid("插件文件完整性校验失败"));
            }
            files.push((item.path, data));
        }
        for name in &names {
            let mut parent = name.as_str();
            while let Some((prefix, _)) = parent.rsplit_once('/') {
                if names.contains(prefix) {
                    return Err(invalid("插件文件与目录路径冲突"));
                }
                parent = prefix;
            }
        }
        if let Some(entry) = &package.manifest.entry.ui {
            if !entry.ends_with(".json") {
                return Err(invalid("插件 UI 入口必须是 JSON 声明"));
            }
            let bytes = &files
                .iter()
                .find(|(path, _)| path == entry)
                .ok_or_else(|| invalid("UI 入口缺失"))?
                .1;
            if bytes.len() > 64 * 1024 {
                return Err(invalid("插件 UI 声明超过 64 KiB"));
            }
            let ui: serverdeck_plugin_sdk::ui::Ui = serde_json::from_slice(bytes)
                .map_err(|_| invalid("插件 UI 声明无效或含未知字段"))?;
            ui.validate().map_err(invalid)?;
            if let Some(frontend) = &ui.frontend {
                for entry in [&frontend.script, &frontend.style] {
                    if !files.iter().any(|(path, _)| path == entry) {
                        return Err(invalid("插件界面资源入口缺失"));
                    }
                }
            }
            if ui.pages.iter().any(|page| page.surface.is_some())
                && package.manifest.entry.backend.is_none()
            {
                return Err(invalid("标准视图需要 WASM 后端"));
            }
            if package
                .manifest
                .contributions
                .iter()
                .any(|c| !ui.pages.iter().any(|p| p.id == c.id))
            {
                return Err(invalid("UI 贡献缺少对应声明页面"));
            }
        }
        Ok(ValidatedPackage {
            manifest: package.manifest,
            files,
            digest: digest(bytes),
        })
    }
}
pub fn digest(data: &[u8]) -> String {
    format!("{:x}", Sha256::digest(data))
}
