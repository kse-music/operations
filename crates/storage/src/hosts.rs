use super::{Database, storage_error};

#[cfg(test)]
mod tests;
use rusqlite::{Connection, OptionalExtension, Row, TransactionBehavior, params};
use serverdeck_core::{
    Error,
    hosts::*,
    openssh::{ImportCandidate, ImportPreview},
};
use uuid::Uuid;

const HOST_COLUMNS: &str = "id,name,hostname,port,username,auth_type,credential_id,group_id,tags,description,favorite,connect_timeout_secs,created_at,updated_at,ssh_options";

fn decode_error<E: std::error::Error + Send + Sync + 'static>(error: E) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(error))
}
fn host_row(row: &Row<'_>) -> rusqlite::Result<Host> {
    Ok(Host {
        id: row.get(0)?,
        config: HostInput {
            name: row.get(1)?,
            hostname: row.get(2)?,
            port: row.get(3)?,
            username: row.get(4)?,
            auth_type: AuthType::parse(&row.get::<_, String>(5)?).map_err(decode_error)?,
            credential_id: row.get(6)?,
            group_id: row.get(7)?,
            tags: serde_json::from_str(&row.get::<_, String>(8)?).map_err(decode_error)?,
            description: row.get(9)?,
            favorite: row.get(10)?,
            connect_timeout_secs: row.get(11)?,
            ssh: serde_json::from_str(&row.get::<_, String>(14)?).map_err(decode_error)?,
        },
        created_at: row.get(12)?,
        updated_at: row.get(13)?,
    })
}
fn one_host(connection: &Connection, id: &str) -> Result<Host, Error> {
    connection
        .query_row(
            &format!("SELECT {HOST_COLUMNS} FROM hosts WHERE id=?1"),
            [id],
            host_row,
        )
        .optional()
        .map_err(storage_error)?
        .ok_or(Error::NotFound)
}
fn validate_links(connection: &Connection, input: &HostInput) -> Result<(), Error> {
    if let Some(proxy) = &input.ssh.proxy
        && let Some(id) = &proxy.credential_id
    {
        let kind = connection
            .query_row("SELECT kind FROM credentials WHERE id=?1", [id], |r| {
                r.get::<_, String>(0)
            })
            .optional()
            .map_err(storage_error)?;
        if kind.as_deref() != Some("password") {
            return Err(Error::Validation("代理认证须引用安全密码凭据"));
        }
    }
    if let Some(id) = &input.ssh.jump_host_id {
        one_host(connection, id)?;
    }
    if let Some(id) = &input.credential_id {
        let kind = connection
            .query_row("SELECT kind FROM credentials WHERE id=?1", [id], |r| {
                r.get::<_, String>(0)
            })
            .optional()
            .map_err(storage_error)?;
        if kind.as_deref() != Some(input.auth_type.as_str()) {
            return Err(Error::Validation("凭据不存在或认证类型不匹配"));
        }
    }
    if let Some(id) = &input.group_id
        && !connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM host_groups WHERE id=?1)",
                [id],
                |r| r.get::<_, bool>(0),
            )
            .map_err(storage_error)?
    {
        return Err(Error::Validation("分组不存在"));
    }
    Ok(())
}
fn insert_host(connection: &Connection, input: &HostInput) -> Result<Host, Error> {
    validate_links(connection, input)?;
    let id = Uuid::new_v4().to_string();
    validate_jump_chain(connection, &id, input)?;
    connection.execute("INSERT INTO hosts(id,name,hostname,port,username,auth_type,credential_id,group_id,tags,description,favorite,connect_timeout_secs,ssh_options) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",
        params![id,input.name,input.hostname,input.port,input.username,input.auth_type.as_str(),input.credential_id,input.group_id,serde_json::to_string(&input.tags).map_err(storage_error)?,input.description,input.favorite,input.connect_timeout_secs,serde_json::to_string(&input.ssh).map_err(storage_error)?]).map_err(storage_error)?;
    one_host(connection, &id)
}
fn validate_jump_chain(connection: &Connection, id: &str, input: &HostInput) -> Result<(), Error> {
    let mut seen = std::collections::HashSet::from([id.to_owned()]);
    let mut next = input.ssh.jump_host_id.clone();
    while let Some(id) = next {
        if seen.len() >= 5 || !seen.insert(id.clone()) {
            return Err(Error::Validation("跳板链不能循环，最多 4 个跳板"));
        }
        next = one_host(connection, &id)?.config.ssh.jump_host_id;
    }
    Ok(())
}

pub struct CredentialRecord {
    pub public: Credential,
    pub secret_ref: Option<String>,
}

fn credential_record(connection: &Connection, id: &str) -> Result<CredentialRecord, Error> {
    connection.query_row("SELECT id,name,kind,key_path,secret_ref,revision,(SELECT count(*) FROM hosts WHERE credential_id=credentials.id OR json_extract(ssh_options,'$.proxy.credentialId')=credentials.id) FROM credentials WHERE id=?1", [id], |row| {
        let secret_ref: Option<String> = row.get(4)?;
        Ok(CredentialRecord { public: Credential { id:row.get(0)?,name:row.get(1)?,kind:AuthType::parse(&row.get::<_,String>(2)?).map_err(decode_error)?,key_path:row.get(3)?,has_secret:secret_ref.is_some(),revision:row.get(5)?,host_count:row.get(6)? },secret_ref })
    }).optional().map_err(storage_error)?.ok_or(Error::NotFound)
}

impl Database {
    pub fn host(&self, id: &str) -> Result<Host, Error> {
        one_host(&self.connect()?, id)
    }
    pub fn catalog(&self) -> Result<Catalog, Error> {
        let mut connection = self.connect()?;
        let tx = connection.transaction().map_err(storage_error)?;
        let hosts = tx
            .prepare(&format!(
                "SELECT {HOST_COLUMNS} FROM hosts ORDER BY name COLLATE NOCASE,id"
            ))
            .map_err(storage_error)?
            .query_map([], host_row)
            .map_err(storage_error)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(storage_error)?;
        let groups = tx.prepare("SELECT id,name,sort_order,parent_id FROM host_groups ORDER BY sort_order,name COLLATE NOCASE,id").map_err(storage_error)?
            .query_map([], |r| Ok(HostGroup{id:r.get(0)?,name:r.get(1)?,sort_order:r.get(2)?,parent_id:r.get(3)?})).map_err(storage_error)?.collect::<rusqlite::Result<Vec<_>>>().map_err(storage_error)?;
        let ids = tx
            .prepare("SELECT id FROM credentials ORDER BY name COLLATE NOCASE,id")
            .map_err(storage_error)?
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(storage_error)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(storage_error)?;
        let credentials = ids
            .iter()
            .map(|id| credential_record(&tx, id).map(|r| r.public))
            .collect::<Result<_, _>>()?;
        let pending_secret_deletions = tx
            .query_row("SELECT count(*) FROM secret_gc", [], |r| r.get(0))
            .map_err(storage_error)?;
        tx.commit().map_err(storage_error)?;
        Ok(Catalog {
            hosts,
            groups,
            credentials,
            pending_secret_deletions,
        })
    }
    pub fn host_create(&self, input: HostInput) -> Result<Host, Error> {
        let input = input.normalize()?;
        let mut connection = self.connect()?;
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_error)?;
        let host = insert_host(&tx, &input)?;
        tx.commit().map_err(storage_error)?;
        Ok(host)
    }
    pub fn host_update(&self, id: &str, input: HostInput) -> Result<Host, Error> {
        let input = input.normalize()?;
        let mut connection = self.connect()?;
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_error)?;
        validate_links(&tx, &input)?;
        validate_jump_chain(&tx, id, &input)?;
        let count = tx.execute("UPDATE hosts SET name=?2,hostname=?3,port=?4,username=?5,auth_type=?6,credential_id=?7,group_id=?8,tags=?9,description=?10,favorite=?11,connect_timeout_secs=?12,ssh_options=?13,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?1",params![id,input.name,input.hostname,input.port,input.username,input.auth_type.as_str(),input.credential_id,input.group_id,serde_json::to_string(&input.tags).map_err(storage_error)?,input.description,input.favorite,input.connect_timeout_secs,serde_json::to_string(&input.ssh).map_err(storage_error)?]).map_err(storage_error)?;
        if count == 0 {
            return Err(Error::NotFound);
        }
        let host = one_host(&tx, id)?;
        tx.commit().map_err(storage_error)?;
        Ok(host)
    }
    pub fn host_delete(&self, id: &str) -> Result<(), Error> {
        let mut connection = self.connect()?;
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_error)?;
        if tx.query_row("SELECT EXISTS(SELECT 1 FROM hosts WHERE json_extract(ssh_options,'$.jumpHostId')=?1)",[id],|r|r.get::<_,bool>(0)).map_err(storage_error)?{return Err(Error::Validation("此主机仍被用作跳板，请先修改关联主机的跳板设置"));}
        if tx
            .execute("DELETE FROM hosts WHERE id=?1", [id])
            .map_err(storage_error)?
            == 0
        {
            return Err(Error::NotFound);
        }
        tx.commit().map_err(storage_error)?;
        Ok(())
    }
    pub fn host_copy(&self, id: &str) -> Result<Host, Error> {
        let mut input = one_host(&self.connect()?, id)?.config;
        input.name = format!(
            "{} 副本",
            input.display_name().chars().take(120).collect::<String>()
        );
        self.host_create(input)
    }
    pub fn group_save(&self, id: Option<&str>, input: GroupInput) -> Result<HostGroup, Error> {
        let name = input.name.trim();
        validate_name(name)?;
        let mut connection = self.connect()?;
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_error)?;
        if tx.query_row("SELECT EXISTS(SELECT 1 FROM host_groups WHERE name=?1 COLLATE NOCASE AND id != coalesce(?2,''))",params![name,id],|r|r.get::<_,bool>(0)).map_err(storage_error)? { return Err(Error::Conflict); }
        let group_id = id
            .map(str::to_owned)
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        let mut seen = std::collections::HashSet::from([group_id.clone()]);
        let mut parent = input.parent_id.clone();
        while let Some(parent_id) = parent {
            if !seen.insert(parent_id.clone()) {
                return Err(Error::Validation("文件夹不能移动到自身或其子文件夹中"));
            }
            parent = tx
                .query_row(
                    "SELECT parent_id FROM host_groups WHERE id=?1",
                    [&parent_id],
                    |r| r.get::<_, Option<String>>(0),
                )
                .optional()
                .map_err(storage_error)?
                .ok_or(Error::Validation("父文件夹不存在"))?;
        }
        let count = if id.is_some() {
            tx.execute(
                "UPDATE host_groups SET name=?2,sort_order=?3,parent_id=?4 WHERE id=?1",
                params![group_id, name, input.sort_order, input.parent_id],
            )
        } else {
            tx.execute(
                "INSERT INTO host_groups(id,name,sort_order,parent_id) VALUES(?1,?2,?3,?4)",
                params![group_id, name, input.sort_order, input.parent_id],
            )
        }
        .map_err(storage_error)?;
        if count == 0 {
            return Err(Error::NotFound);
        }
        tx.commit().map_err(storage_error)?;
        Ok(HostGroup {
            id: group_id,
            name: name.into(),
            sort_order: input.sort_order,
            parent_id: input.parent_id,
        })
    }
    pub fn group_delete(&self, id: &str) -> Result<(), Error> {
        let mut connection = self.connect()?;
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_error)?;
        let parent: Option<String> = tx
            .query_row("SELECT parent_id FROM host_groups WHERE id=?1", [id], |r| {
                r.get(0)
            })
            .optional()
            .map_err(storage_error)?
            .ok_or(Error::NotFound)?;
        tx.execute(
            "UPDATE hosts SET group_id=?2 WHERE group_id=?1",
            params![id, parent],
        )
        .map_err(storage_error)?;
        tx.execute(
            "UPDATE host_groups SET parent_id=?2 WHERE parent_id=?1",
            params![id, parent],
        )
        .map_err(storage_error)?;
        tx.execute("DELETE FROM host_groups WHERE id=?1", [id])
            .map_err(storage_error)?;
        tx.commit().map_err(storage_error)?;
        Ok(())
    }
    pub fn credential_record(&self, id: &str) -> Result<CredentialRecord, Error> {
        credential_record(&self.connect()?, id)
    }
    pub fn credential_save(
        &self,
        id: &str,
        previous: Option<u32>,
        name: &str,
        kind: AuthType,
        key_path: Option<&str>,
        reference: Option<&str>,
    ) -> Result<Credential, Error> {
        validate_name(name)?;
        let mut connection = self.connect()?;
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_error)?;
        if let Some(revision) = previous {
            let old = credential_record(&tx, id)?;
            if old.public.revision != revision || old.public.kind != kind {
                return Err(Error::Conflict);
            }
            tx.execute("UPDATE credentials SET name=?2,key_path=?3,secret_ref=?4,revision=revision+1 WHERE id=?1",params![id,name,key_path,reference]).map_err(storage_error)?;
            if old.secret_ref.as_deref() != reference
                && let Some(old) = old.secret_ref
            {
                tx.execute(
                    "INSERT OR IGNORE INTO secret_gc(reference) VALUES(?1)",
                    [old],
                )
                .map_err(storage_error)?;
            }
        } else {
            tx.execute(
                "INSERT INTO credentials(id,name,kind,key_path,secret_ref) VALUES(?1,?2,?3,?4,?5)",
                params![id, name, kind.as_str(), key_path, reference],
            )
            .map_err(storage_error)?;
        }
        if let Some(reference) = reference {
            tx.execute("DELETE FROM secret_gc WHERE reference=?1", [reference])
                .map_err(storage_error)?;
        }
        let record = credential_record(&tx, id)?.public;
        tx.commit().map_err(storage_error)?;
        Ok(record)
    }
    pub fn credential_delete(&self, id: &str, detach_hosts: bool) -> Result<(), Error> {
        if self.connect()?.query_row("SELECT EXISTS(SELECT 1 FROM application_settings WHERE key='app_config' AND json_extract(value,'$.product.sshDefaults.proxy.credentialId')=?1)",[id],|r|r.get::<_,bool>(0)).map_err(storage_error)? {return Err(Error::Validation("全局默认代理仍引用此凭据，请先修改全局设置，再删除凭据"));}
        let mut connection = self.connect()?;
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_error)?;
        let record = credential_record(&tx, id)?;
        if record.public.host_count > 0 && !detach_hosts {
            return Err(Error::Conflict);
        }
        if let Some(reference) = record.secret_ref {
            tx.execute(
                "INSERT OR IGNORE INTO secret_gc(reference) VALUES(?1)",
                [reference],
            )
            .map_err(storage_error)?;
        }
        tx.execute("DELETE FROM credentials WHERE id=?1", [id])
            .map_err(storage_error)?;
        tx.execute("UPDATE hosts SET ssh_options=json_set(ssh_options,'$.proxy.credentialId',NULL) WHERE json_extract(ssh_options,'$.proxy.credentialId')=?1",[id]).map_err(storage_error)?;
        tx.commit().map_err(storage_error)?;
        Ok(())
    }
    pub fn queue_secret_gc(&self, reference: &str) -> Result<(), Error> {
        self.connect()?
            .execute(
                "INSERT OR IGNORE INTO secret_gc(reference) VALUES(?1)",
                [reference],
            )
            .map_err(storage_error)?;
        Ok(())
    }
    pub fn pending_secret_gc(&self) -> Result<Vec<String>, Error> {
        self.connect()?
            .prepare("SELECT reference FROM secret_gc")
            .map_err(storage_error)?
            .query_map([], |r| r.get(0))
            .map_err(storage_error)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(storage_error)
    }
    pub fn complete_secret_gc(&self, reference: &str) -> Result<(), Error> {
        self.connect()?
            .execute("DELETE FROM secret_gc WHERE reference=?1", [reference])
            .map_err(storage_error)?;
        Ok(())
    }
    pub fn annotate_duplicates(&self, preview: &mut ImportPreview) -> Result<(), Error> {
        let connection = self.connect()?;
        let definitions: Vec<_> = preview
            .candidates
            .iter()
            .map(|c| (c.alias.clone(), c.host.clone()))
            .collect();
        for candidate in &mut preview.candidates {
            candidate.duplicate = duplicate(&connection, &candidate.host)?;
            if let Some(alias) = &candidate.jump_alias {
                match resolve_jump(&connection, alias, &definitions) {
                    Err(Error::Validation(reason)) => {
                        candidate.blocked = true;
                        candidate.warnings.push(reason.into());
                    }
                    Err(error) => return Err(error),
                    Ok(None)
                        if !definitions
                            .iter()
                            .any(|(name, _)| name.eq_ignore_ascii_case(alias)) =>
                    {
                        candidate.blocked = true;
                        candidate
                            .warnings
                            .push("跳板别名未出现在配置或现有主机中".into());
                    }
                    _ => {}
                }
            }
        }
        Ok(())
    }
    pub fn import_hosts(
        &self,
        candidates: Vec<ImportCandidate>,
        selected: &[String],
        group_id: Option<String>,
    ) -> Result<Mutation<Vec<Host>>, Error> {
        if selected.is_empty() || selected.len() > 500 {
            return Err(Error::Validation("请选择 1–500 个主机"));
        }
        if selected
            .iter()
            .any(|alias| !candidates.iter().any(|c| &c.alias == alias && !c.blocked))
        {
            return Err(Error::Validation("选择中包含无效或被阻止的条目"));
        }
        let mut connection = self.connect()?;
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_error)?;
        let mut hosts = Vec::new();
        let mut warnings = Vec::new();
        let definitions: Vec<_> = candidates
            .iter()
            .map(|c| (c.alias.clone(), c.host.clone()))
            .collect();
        let mut pending: Vec<_> = candidates
            .into_iter()
            .filter(|c| selected.contains(&c.alias))
            .collect();
        while !pending.is_empty() {
            let mut ready = None;
            for (index, candidate) in pending.iter().enumerate() {
                if let Some(alias) = &candidate.jump_alias
                    && resolve_jump(&tx, alias, &definitions)?.is_none()
                {
                    continue;
                }
                ready = Some(index);
                break;
            }
            let index = ready.ok_or(Error::Validation(
                "跳板未选择、别名不明确或存在循环；导入已回滚",
            ))?;
            let mut candidate = pending.remove(index);
            if duplicate(&tx, &candidate.host)? {
                warnings.push(format!("{} 已存在，已跳过", candidate.alias));
                continue;
            }
            candidate.host.group_id = group_id.clone();
            candidate.host.ssh.jump_host_id = candidate
                .jump_alias
                .as_ref()
                .map(|alias| {
                    resolve_jump(&tx, alias, &definitions)
                        .and_then(|id| id.ok_or(Error::Validation("跳板主机不存在")))
                })
                .transpose()?;
            if let Some(path) = candidate.identity_file {
                let id = Uuid::new_v4().to_string();
                tx.execute(
                    "INSERT INTO credentials(id,name,kind,key_path) VALUES(?1,?2,'private_key',?3)",
                    params![
                        id,
                        format!(
                            "{} 私钥",
                            candidate.alias.chars().take(120).collect::<String>()
                        ),
                        path
                    ],
                )
                .map_err(storage_error)?;
                candidate.host.credential_id = Some(id);
            }
            let input = candidate.host.normalize()?;
            hosts.push(insert_host(&tx, &input)?);
        }
        tx.commit().map_err(storage_error)?;
        Ok(Mutation {
            value: hosts,
            warnings,
        })
    }
}
fn duplicate(connection: &Connection, host: &HostInput) -> Result<bool, Error> {
    connection.query_row("SELECT EXISTS(SELECT 1 FROM hosts WHERE (?1 != '' AND name=?1 COLLATE NOCASE) OR (hostname=?2 COLLATE NOCASE AND port=?3 AND username=?4))",params![host.name,host.hostname,host.port,host.username],|r|r.get(0)).map_err(storage_error)
}
fn resolve_jump(
    connection: &Connection,
    name: &str,
    definitions: &[(String, HostInput)],
) -> Result<Option<String>, Error> {
    let id = jump_id(connection, name)?;
    if let Some(id) = &id
        && let Some((_, expected)) = definitions
            .iter()
            .find(|(alias, _)| alias.eq_ignore_ascii_case(name))
    {
        let existing = one_host(connection, id)?;
        if !existing
            .config
            .hostname
            .eq_ignore_ascii_case(&expected.hostname)
            || existing.config.port != expected.port
            || existing.config.username != expected.username
        {
            return Err(Error::Validation(
                "同名跳板的地址、端口或用户名与配置不同，请先明确选择正确主机",
            ));
        }
    }
    Ok(id)
}
fn jump_id(connection: &Connection, name: &str) -> Result<Option<String>, Error> {
    let ids = connection
        .prepare("SELECT id FROM hosts WHERE name=?1 COLLATE NOCASE LIMIT 2")
        .map_err(storage_error)?
        .query_map([name], |r| r.get::<_, String>(0))
        .map_err(storage_error)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(storage_error)?;
    if ids.len() > 1 {
        return Err(Error::Validation("跳板别名匹配多个主机，请使用唯一名称"));
    }
    Ok(ids.into_iter().next())
}
