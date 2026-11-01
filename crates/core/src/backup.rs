use crate::{
    AppConfig, Error,
    automation::{EntryInput, Group},
    hosts::{HostGroup, HostInput},
};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BackupHost {
    pub id: String,
    pub config: HostInput,
    pub proxy_auth_required: bool,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BackupEntry {
    pub id: String,
    pub input: EntryInput,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Backup {
    pub format: String,
    pub version: u32,
    pub groups: Vec<HostGroup>,
    pub hosts: Vec<BackupHost>,
    pub command_groups: Vec<Group>,
    pub entries: Vec<BackupEntry>,
    pub preferences: AppConfig,
}
impl Backup {
    pub fn parse(text: &str) -> Result<Self, Error> {
        if text.len() > 8 * 1024 * 1024 {
            return Err(Error::Validation("备份文件超过 8 MiB"));
        }
        let mut b: Self = serde_json::from_str(text)
            .map_err(|_| Error::Validation("备份格式无效、包含未知字段或类型错误"))?;
        b.validate()?;
        for host in &mut b.hosts {
            host.config = host.config.clone().normalize()?;
        }
        Ok(b)
    }
    pub fn validate(&self) -> Result<(), Error> {
        if self.format != "serverdeck-backup" || self.version != 1 {
            return Err(Error::Validation("不支持的备份格式或版本"));
        }
        if self.hosts.len() > 5000
            || self.groups.len() > 512
            || self.entries.len() > 256
            || self.command_groups.len() > 64
        {
            return Err(Error::Validation("备份条目数量超过限制"));
        }
        self.preferences.validate()?;
        if self
            .preferences
            .product
            .ssh_defaults
            .proxy
            .as_ref()
            .is_some_and(|p| p.credential_id.is_some() || p.username.is_some())
        {
            return Err(Error::Validation("备份偏好不能包含代理凭据引用"));
        }
        let mut ids = HashSet::new();
        for id in self
            .groups
            .iter()
            .map(|g| &g.id)
            .chain(self.hosts.iter().map(|h| &h.id))
            .chain(self.command_groups.iter().map(|g| &g.id))
            .chain(self.entries.iter().map(|e| &e.id))
        {
            crate::automation::uuid_id(id)?;
            if !ids.insert(id) {
                return Err(Error::Validation("备份 ID 重复"));
            }
        }
        for name in self
            .groups
            .iter()
            .map(|g| &g.name)
            .chain(self.command_groups.iter().map(|g| &g.name))
        {
            crate::hosts::validate_name(name)?;
        }
        let host_ids = self
            .hosts
            .iter()
            .map(|h| h.id.as_str())
            .collect::<HashSet<_>>();
        let group_ids = self
            .groups
            .iter()
            .map(|g| g.id.as_str())
            .collect::<HashSet<_>>();
        for host in &self.hosts {
            host.config.clone().normalize()?;
            if host.config.credential_id.is_some()
                || host
                    .config
                    .ssh
                    .proxy
                    .as_ref()
                    .is_some_and(|p| p.credential_id.is_some() || p.username.is_some())
            {
                return Err(Error::Validation("备份不能包含凭据引用"));
            }
            if host
                .config
                .group_id
                .as_ref()
                .is_some_and(|id| !group_ids.contains(id.as_str()))
            {
                return Err(Error::Validation("备份主机分组引用不存在"));
            }
            let mut seen = HashSet::from([host.id.as_str()]);
            let mut jump = host.config.ssh.jump_host_id.as_deref();
            while let Some(id) = jump {
                if !host_ids.contains(id) || seen.len() >= 5 || !seen.insert(id) {
                    return Err(Error::Validation("备份跳板链缺失、循环或过长"));
                }
                jump = self
                    .hosts
                    .iter()
                    .find(|h| h.id == id)
                    .and_then(|h| h.config.ssh.jump_host_id.as_deref());
            }
        }
        for e in &self.entries {
            e.input.validate()?;
            if e.input
                .group_id
                .as_ref()
                .is_some_and(|id| !self.command_groups.iter().any(|g| g.id == *id))
            {
                return Err(Error::Validation("备份命令分组不存在"));
            }
        }
        Ok(())
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewItem {
    pub id: String,
    pub kind: &'static str,
    pub name: String,
    pub detail: String,
    pub duplicate: bool,
    pub blocked: bool,
    pub warnings: Vec<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupPreview {
    pub version: u32,
    pub items: Vec<PreviewItem>,
    pub warnings: Vec<String>,
}
#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ConflictPolicy {
    Skip,
    Copy,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RestoreInput {
    pub text: String,
    pub selected: Vec<String>,
    pub conflict: ConflictPolicy,
    pub restore_preferences: bool,
    pub confirmed: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreResult {
    pub hosts: usize,
    pub entries: usize,
    pub skipped: usize,
    pub preferences_restored: bool,
    pub warnings: Vec<String>,
}
