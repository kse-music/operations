use crate::{Database, storage_error};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serverdeck_core::{
    Error,
    automation::{Entry, Group},
    backup::*,
    hosts::HostGroup,
    product::WindowGeometry,
};
use std::collections::{HashMap, HashSet};
use uuid::Uuid;
fn names(c: &Connection, table: &str) -> Result<HashSet<String>, Error> {
    let sql = match table {
        "hosts" => "SELECT name FROM hosts",
        "entries" => "SELECT json_extract(document,'$.name') FROM automation_entries",
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
        .prepare("SELECT id,name,sort_order FROM host_groups")
        .map_err(storage_error)?
        .query_map([], |r| {
            Ok(HostGroup {
                id: r.get(0)?,
                name: r.get(1)?,
                sort_order: r.get(2)?,
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
    let command_groups = c
        .prepare("SELECT id,name FROM automation_groups")
        .map_err(storage_error)?
        .query_map([], |r| {
            Ok(Group {
                id: r.get(0)?,
                name: r.get(1)?,
            })
        })
        .map_err(storage_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(storage_error)?;
    let docs = c
        .prepare("SELECT document FROM automation_entries")
        .map_err(storage_error)?
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(storage_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(storage_error)?;
    let entries = docs
        .into_iter()
        .map(|d| {
            let e: Entry = serde_json::from_str(&d).map_err(storage_error)?;
            Ok(BackupEntry {
                id: e.id,
                input: e.input,
            })
        })
        .collect::<Result<Vec<_>, Error>>()?;
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
        version: 1,
        groups,
        hosts,
        command_groups,
        entries,
        preferences,
    })
}
fn preview(c: &Connection, b: &Backup) -> Result<BackupPreview, Error> {
    let existing = read(c)?;
    let mut items = Vec::new();
    for h in &b.hosts {
        let duplicate = existing.hosts.iter().any(|e| {
            e.config.name.eq_ignore_ascii_case(&h.config.name)
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
            name: h.config.name.clone(),
            detail: format!(
                "{}@{}:{}",
                h.config.username, h.config.hostname, h.config.port
            ),
            duplicate,
            blocked: h.proxy_auth_required,
            warnings,
        });
    }
    for e in &b.entries {
        items.push(PreviewItem {
            id: e.id.clone(),
            kind: "entry",
            name: e.input.name.clone(),
            detail: format!("{:?} / {:?}", e.input.kind, e.input.risk),
            duplicate: existing
                .entries
                .iter()
                .any(|x| x.input.name.eq_ignore_ascii_case(&e.input.name)),
            blocked: false,
            warnings: vec![],
        });
    }
    Ok(BackupPreview{version:b.version,items,warnings:vec!["只新增数据或跳过冲突，不覆盖已有主机/条目；分组按名称合并。".into(),"备份没有凭据、私钥路径、秘密参数值、信任记录、任务历史或可自动执行的计划。正文/描述/普通默认值可能包含你自行填写的秘密，请自行审查。".into(),"恢复偏好需单独选择，将替换当前非敏感设置（包括新建主机的默认代理）；认证代理默认值不会导出。".into()]})
}
fn merge_groups(
    c: &Connection,
    groups: impl IntoIterator<Item = (String, String, i64)>,
    commands: bool,
) -> Result<HashMap<String, String>, Error> {
    let mut map = HashMap::new();
    for (old, name, order) in groups {
        let sql = if commands {
            "SELECT id FROM automation_groups WHERE name=?1 COLLATE NOCASE"
        } else {
            "SELECT id FROM host_groups WHERE name=?1 COLLATE NOCASE"
        };
        let existing = c
            .query_row(sql, [&name], |r| r.get::<_, String>(0))
            .optional()
            .map_err(storage_error)?;
        let id = if let Some(id) = existing {
            id
        } else {
            if commands
                && c.query_row("SELECT count(*) FROM automation_groups", [], |r| {
                    r.get::<_, u32>(0)
                })
                .map_err(storage_error)?
                    >= 64
            {
                return Err(Error::Validation("恢复后命令分组超过 64 个"));
            }
            let id = Uuid::new_v4().to_string();
            if commands {
                c.execute(
                    "INSERT INTO automation_groups(id,name) VALUES(?1,?2)",
                    params![id, name],
                )
                .map_err(storage_error)?;
            } else {
                c.execute(
                    "INSERT INTO host_groups(id,name,sort_order) VALUES(?1,?2,?3)",
                    params![id, name, order],
                )
                .map_err(storage_error)?;
            }
            id
        };
        map.insert(old, id);
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
        if selected.len() > 5256
            || selected.iter().any(|id| {
                !b.hosts.iter().any(|h| h.id == *id) && !b.entries.iter().any(|e| e.id == *id)
            })
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
            entries: 0,
            skipped: 0,
            preferences_restored: input.restore_preferences,
            warnings: vec![],
        };
        let host_groups = merge_groups(
            &tx,
            b.groups
                .into_iter()
                .map(|g| (g.id, g.name, i64::from(g.sort_order))),
            false,
        )?;
        let command_groups = merge_groups(
            &tx,
            b.command_groups.into_iter().map(|g| (g.id, g.name, 0)),
            true,
        )?;
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
                config.name = unique_name(&config.name, &mut host_names);
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
        let mut entry_names = names(&tx, "entries")?;
        let mut count = tx
            .query_row("SELECT count(*) FROM automation_entries", [], |r| {
                r.get::<_, u32>(0)
            })
            .map_err(storage_error)?;
        for e in b.entries.into_iter().filter(|e| selected.contains(&e.id)) {
            if input.conflict == ConflictPolicy::Skip
                && entry_names.contains(&e.input.name.to_lowercase())
            {
                result.skipped += 1;
                continue;
            }
            if count >= 256 {
                return Err(Error::Validation("恢复后命令/脚本库超过 256 条"));
            }
            count += 1;
            let mut data = e.input;
            data.name = unique_name(&data.name, &mut entry_names);
            data.group_id = data
                .group_id
                .and_then(|id| command_groups.get(&id).cloned());
            data.validate()?;
            let record = Entry {
                id: Uuid::new_v4().to_string(),
                revision: 1,
                input: data,
                updated_at: std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0),
            };
            tx.execute(
                "INSERT INTO automation_entries(id,revision,group_id,document) VALUES(?1,1,?2,?3)",
                params![
                    record.id,
                    record.input.group_id,
                    serde_json::to_string(&record).map_err(storage_error)?
                ],
            )
            .map_err(storage_error)?;
            result.entries += 1;
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
