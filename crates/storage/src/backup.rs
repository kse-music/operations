use crate::{Database, storage_error};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serverdeck_core::{Error, backup::*, hosts::HostGroup, product::WindowGeometry};
use std::collections::{HashMap, HashSet};
use uuid::Uuid;
fn names(c: &Connection, table: &str) -> Result<HashSet<String>, Error> {
    let sql = match table {
        "hosts" => "SELECT name FROM hosts",
        _ => return Err(Error::Validation("未知备份类型")),
    };
    c.prepare(sql)
        .map_err(storage_error)?
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(storage_error)?
        .map(|r| r.map(|s| s.to_lowercase()).map_err(storage_error))
        .collect()
}
fn unique_name(name: &str, used: &mut HashSet<String>) -> String {
    if used.insert(name.to_lowercase()) {
        return name.into();
    }
    for n in 1u32.. {
        let candidate = format!(
            "{} 恢复副本 {n}",
            name.chars().take(105).collect::<String>()
        );
        if used.insert(candidate.to_lowercase()) {
            return candidate;
        }
    }
    unreachable!()
}
fn read(c: &Connection) -> Result<Backup, Error> {
    let groups = c
        .prepare("SELECT id,name,sort_order,parent_id FROM host_groups")
        .map_err(storage_error)?
        .query_map([], |r| {
            Ok(HostGroup {
                id: r.get(0)?,
                name: r.get(1)?,
                sort_order: r.get(2)?,
                parent_id: r.get(3)?,
            })
        })
        .map_err(storage_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(storage_error)?;
    let ids = c
        .prepare("SELECT id FROM hosts ORDER BY name,id")
        .map_err(storage_error)?
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(storage_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(storage_error)?;
    let mut hosts = Vec::new();
    for id in ids {
        let mut config = crate::hosts::one_host(c, &id)?.config;
        config.credential_id = None;
        let proxy_auth_required = config
            .ssh
            .proxy
            .as_ref()
            .is_some_and(|p| p.credential_id.is_some() || p.username.is_some());
        if let Some(p) = config.ssh.proxy.as_mut() {
            p.username = None;
            p.credential_id = None;
        }
        hosts.push(BackupHost {
            id,
            config,
            proxy_auth_required,
        });
    }
    let config: String = c
        .query_row(
            "SELECT value FROM application_settings WHERE key='app_config'",
            [],
            |r| r.get(0),
        )
        .optional()
        .map_err(storage_error)?
        .unwrap_or(
            serde_json::to_string(&serverdeck_core::AppConfig::default()).map_err(storage_error)?,
        );
    let mut preferences: serverdeck_core::AppConfig =
        serde_json::from_str(&config).map_err(storage_error)?;
    if preferences
        .product
        .ssh_defaults
        .proxy
        .as_ref()
        .is_some_and(|p| p.credential_id.is_some())
    {
        preferences.product.ssh_defaults.proxy = None;
    }
    Ok(Backup {
        format: "serverdeck-backup".into(),
        version: 3,
        groups,
        hosts,
        legacy_content_ignored: false,
        preferences,
    })
}
fn preview(c: &Connection, b: &Backup) -> Result<BackupPreview, Error> {
    let existing = read(c)?;
    let mut items = Vec::new();
    for h in &b.hosts {
        let duplicate = existing.hosts.iter().any(|e| {
            (!h.config.name.is_empty() && e.config.name.eq_ignore_ascii_case(&h.config.name))
                || (e.config.hostname == h.config.hostname
                    && e.config.port == h.config.port
                    && e.config.username == h.config.username)
        });
        let mut warnings = vec![];
        if h.config.auth_type != serverdeck_core::hosts::AuthType::Agent {
            warnings.push("恢复后需重新关联安全凭据".into());
        }
        if h.proxy_auth_required {
            warnings.push(
                "认证代理凭据不在备份中；此主机禁止直接恢复，请手动配置，避免匿名降级".into(),
            );
        }
        if h.config.ssh.jump_host_id.is_some() {
            warnings.push("跳板必须同时选中或能匹配本地同端点主机；不允许静默改为直连".into());
        }
        items.push(PreviewItem {
            id: h.id.clone(),
            kind: "host",
            name: h.config.display_name(),
            detail: format!(
                "{}@{}:{}",
                h.config.username, h.config.hostname, h.config.port
            ),
            duplicate,
            blocked: h.proxy_auth_required,
            warnings,
        });
    }
    let mut warnings = Vec::new();
    if b.legacy_content_ignored {
        warnings.push("旧版命令库已不再支持，仅恢复主机与偏好。".into());
    }
    warnings.extend(vec!["只新增数据或跳过冲突，不覆盖已有主机；文件夹按名称与父目录合并；父目录冲突时拒绝恢复。".into(),"备份没有凭据、私钥路径、秘密参数值、信任记录、任务历史或可自动执行的计划。主机描述可能包含你自行填写的秘密，请自行审查。".into(),"恢复偏好需单独选择，将替换当前非敏感设置（包括新建主机的默认代理）；认证代理默认值不会导出。".into()]);
    Ok(BackupPreview {
        version: b.version,
        items,
        warnings,
    })
}
fn merge_host_groups(
    c: &Connection,
    groups: Vec<HostGroup>,
) -> Result<HashMap<String, String>, Error> {
    let mut map = HashMap::new();
    let mut pending = groups;
    while !pending.is_empty() {
        let mut rest = Vec::new();
        let mut progressed = false;
        for group in pending {
            if group
                .parent_id
                .as_ref()
                .is_some_and(|id| !map.contains_key(id))
            {
                rest.push(group);
                continue;
            }
            let parent = group.parent_id.as_ref().and_then(|id| map.get(id)).cloned();
            let existing = c
                .query_row(
                    "SELECT id,parent_id FROM host_groups WHERE name=?1 COLLATE NOCASE",
                    [&group.name],
                    |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?)),
                )
                .optional()
                .map_err(storage_error)?;
            let id = if let Some((id, old_parent)) = existing {
                if old_parent != parent {
                    return Err(Error::Validation(
                        "同名文件夹的父目录不同，请先调整本地文件夹名称后恢复",
                    ));
                }
                id
            } else {
                let id = Uuid::new_v4().to_string();
                c.execute(
                    "INSERT INTO host_groups(id,name,sort_order,parent_id) VALUES(?1,?2,?3,?4)",
                    params![id, group.name, group.sort_order, parent],
                )
                .map_err(storage_error)?;
                id
            };
            map.insert(group.id, id);
            progressed = true;
        }
        if !progressed {
            return Err(Error::Validation("备份文件夹的父目录缺失或存在循环"));
        }
        pending = rest;
    }
    Ok(map)
}

impl Database {
    pub fn backup_export(&self) -> Result<String, Error> {
        let mut c = self.connect()?;
        let tx = c.transaction().map_err(storage_error)?;
        let b = read(&tx)?;
        b.validate()?;
        let text = serde_json::to_string_pretty(&b).map_err(storage_error)?;
        if text.len() > 8 * 1024 * 1024 {
            return Err(Error::Validation("备份超过 8 MiB，请减少库内容后导出"));
        }
        Ok(text)
    }
    pub fn backup_preview(&self, text: &str) -> Result<BackupPreview, Error> {
        let b = Backup::parse(text)?;
        let mut c = self.connect()?;
        let tx = c.transaction().map_err(storage_error)?;
        preview(&tx, &b)
    }
    pub fn backup_restore(&self, input: RestoreInput) -> Result<RestoreResult, Error> {
        if !input.confirmed {
            return Err(Error::Validation("恢复必须预览并明确确认"));
        }
        let b = Backup::parse(&input.text)?;
        let selected = input.selected.into_iter().collect::<HashSet<_>>();
        if selected.len() > 5000
            || selected
                .iter()
                .any(|id| !b.hosts.iter().any(|h| h.id == *id))
        {
            return Err(Error::Validation("选择的恢复条目无效"));
        }
        let mut c = self.connect()?;
        let tx = c
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_error)?;
        let p = preview(&tx, &b)?;
        if p.items
            .iter()
            .any(|i| i.blocked && selected.contains(&i.id))
        {
            return Err(Error::Validation(
                "所选主机含需要重新配置的认证代理，不允许匿名恢复",
            ));
        }
        let mut result = RestoreResult {
            hosts: 0,
            skipped: 0,
            preferences_restored: input.restore_preferences,
            warnings: p.warnings,
        };
        let host_groups = merge_host_groups(&tx, b.groups)?;
        let current = read(&tx)?;
        let mut host_map = HashMap::new();
        let mut host_names = names(&tx, "hosts")?;
        let mut pending = b
            .hosts
            .iter()
            .filter(|h| selected.contains(&h.id))
            .collect::<Vec<_>>();
        // Skipped duplicates can still serve as an explicitly matching jump endpoint.
        for h in &b.hosts {
            if (!selected.contains(&h.id) || input.conflict == ConflictPolicy::Skip)
                && let Some(old) = current.hosts.iter().find(|old| {
                    old.id == h.id
                        && serde_json::to_value(&old.config).ok()
                            == serde_json::to_value(&h.config).ok()
                })
            {
                host_map.insert(h.id.clone(), old.id.clone());
            }
        }
        while !pending.is_empty() {
            let mut progressed = false;
            let mut rest = Vec::new();
            for h in pending {
                let duplicate = p
                    .items
                    .iter()
                    .find(|i| i.id == h.id)
                    .is_some_and(|i| i.duplicate);
                if duplicate && input.conflict == ConflictPolicy::Skip {
                    result.skipped += 1;
                    progressed = true;
                    continue;
                }
                if h.config
                    .ssh
                    .jump_host_id
                    .as_ref()
                    .is_some_and(|id| !host_map.contains_key(id))
                {
                    rest.push(h);
                    continue;
                }
                let mut config = h.config.clone();
                if !config.name.is_empty() {
                    config.name = unique_name(&config.name, &mut host_names);
                }
                config.group_id = config.group_id.and_then(|id| host_groups.get(&id).cloned());
                config.ssh.jump_host_id = config
                    .ssh
                    .jump_host_id
                    .and_then(|id| host_map.get(&id).cloned());
                let saved = crate::hosts::insert_host(&tx, &config.normalize()?)?;
                host_map.insert(h.id.clone(), saved.id);
                result.hosts += 1;
                progressed = true;
            }
            if !progressed {
                return Err(Error::Validation(
                    "所选主机的跳板缺失，请一并选择跳板或先配置匹配端点",
                ));
            }
            pending = rest;
        }
        if input.restore_preferences {
            tx.execute("INSERT INTO application_settings(key,value) VALUES('app_config',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[serde_json::to_string(&b.preferences).map_err(storage_error)?]).map_err(storage_error)?;
        }
        tx.commit().map_err(storage_error)?;
        result.warnings.push(
            "恢复未创建任何连接或计划；密码/私钥主机需重新关联安全凭据并核对主机指纹。".into(),
        );
        Ok(result)
    }
    pub fn window_geometry(&self) -> Result<Option<WindowGeometry>, Error> {
        let s = self
            .connect()?
            .query_row(
                "SELECT value FROM application_settings WHERE key='window_geometry'",
                [],
                |r| r.get::<_, String>(0),
            )
            .optional()
            .map_err(storage_error)?;
        s.map(|s| {
            let g: WindowGeometry = serde_json::from_str(&s).map_err(storage_error)?;
            g.validate()?;
            Ok(g)
        })
        .transpose()
    }
    pub fn save_window_geometry(&self, g: WindowGeometry) -> Result<(), Error> {
        g.validate()?;
        self.connect()?.execute("INSERT INTO application_settings(key,value) VALUES('window_geometry',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[serde_json::to_string(&g).map_err(storage_error)?]).map_err(storage_error)?;
        Ok(())
    }
}
