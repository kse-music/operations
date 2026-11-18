use super::*;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashMap, HashSet};

// T belongs to the application file codec. SQLite only receives fresh local references.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Directory<T> {
    pub groups: Vec<HostGroup>,
    pub hosts: Vec<DirectoryHost>,
    pub credentials: Vec<DirectoryCredential<T>>,
    pub trusted_keys: Vec<TrustedKey>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DirectoryHost {
    pub id: String,
    pub config: HostInput,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DirectoryCredential<T> {
    pub id: String,
    pub name: String,
    pub kind: AuthType,
    pub host_managed: bool,
    pub value: T,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TrustedKey {
    pub hostname: String,
    pub port: u16,
    pub public_key: String,
    pub fingerprint: String,
    pub trusted_at: String,
}

fn credential_ids(hosts: &[DirectoryHost]) -> BTreeSet<&str> {
    hosts
        .iter()
        .flat_map(|host| {
            let config = &host.config;
            [
                config.credential_id.as_deref(),
                config
                    .ssh
                    .proxy
                    .as_ref()
                    .and_then(|p| p.credential_id.as_deref()),
            ]
        })
        .flatten()
        .collect()
}

// Parents precede children even when the exported list was sorted by display name.
fn dependency_order<'a>(
    items: impl Iterator<Item = (&'a str, Option<&'a str>)>,
) -> Result<Vec<usize>, Error> {
    let mut children: HashMap<&str, Vec<usize>> = HashMap::new();
    let mut ids = Vec::new();
    let mut seen = HashSet::new();
    let mut ready = Vec::new();
    for (index, (id, parent)) in items.enumerate() {
        if Uuid::parse_str(id).is_err() || !seen.insert(id) {
            return Err(Error::Validation("备份中的标识无效或重复"));
        }
        ids.push(id);
        if let Some(parent) = parent {
            children.entry(parent).or_default().push(index);
        } else {
            ready.push(index);
        }
    }
    let mut pos = 0;
    while pos < ready.len() {
        if let Some(descendants) = children.remove(ids[ready[pos]]) {
            ready.extend(descendants);
        }
        pos += 1;
    }
    if ready.len() != ids.len() {
        return Err(Error::Validation("备份中的目录或跳板关联缺失或循环"));
    }
    Ok(ready)
}

fn remap(map: &HashMap<&str, String>, id: &mut Option<String>) -> Result<(), Error> {
    if let Some(value) = id {
        *value = map
            .get(value.as_str())
            .ok_or(Error::Validation("备份中的关联记录缺失"))?
            .clone();
    }
    Ok(())
}

impl Database {
    pub fn export_host_directory<T>(
        &self,
        mut read: impl FnMut(&CredentialRecord) -> Result<T, Error>,
    ) -> Result<Directory<T>, Error> {
        let mut conn = self.connect()?;
        let tx = conn.transaction().map_err(storage_error)?;
        let (hosts, groups) = directory_rows(&tx)?;
        let hosts: Vec<_> = hosts
            .into_iter()
            .map(|h| DirectoryHost {
                id: h.id,
                config: h.config,
            })
            .collect();
        let mut credentials = Vec::new();
        for id in credential_ids(&hosts) {
            let record = credential_record(&tx, id)?;
            let value = read(&record)?;
            credentials.push(DirectoryCredential {
                id: record.public.id,
                name: record.public.name,
                kind: record.public.kind,
                host_managed: record.host_managed,
                value,
            });
        }
        let trusted_keys = tx.prepare("SELECT k.hostname,k.port,k.public_key,k.fingerprint,k.trusted_at
            FROM ssh_known_hosts k WHERE EXISTS (SELECT 1 FROM hosts h WHERE h.hostname=k.hostname AND h.port=k.port)
            ORDER BY k.hostname,k.port").map_err(storage_error)?
            .query_map([], |row| Ok(TrustedKey { hostname: row.get(0)?, port: row.get(1)?, public_key: row.get(2)?,
                fingerprint: row.get(3)?, trusted_at: row.get(4)? })).map_err(storage_error)?
            .collect::<rusqlite::Result<Vec<_>>>().map_err(storage_error)?;
        tx.commit().map_err(storage_error)?;
        Ok(Directory {
            groups,
            hosts,
            credentials,
            trusted_keys,
        })
    }

    pub fn import_host_directory<T>(
        &self,
        directory: &Directory<T>,
        references: &[String],
        mut write: impl FnMut(&str, &T) -> Result<(), Error>,
    ) -> Result<(), Error> {
        let group_order = dependency_order(
            directory
                .groups
                .iter()
                .map(|g| (g.id.as_str(), g.parent_id.as_deref())),
        )?;
        let host_order = dependency_order(
            directory
                .hosts
                .iter()
                .map(|h| (h.id.as_str(), h.config.ssh.jump_host_id.as_deref())),
        )?;
        let used = credential_ids(&directory.hosts);
        if used.len() != directory.credentials.len()
            || references.len() != used.len()
            || used
                != directory
                    .credentials
                    .iter()
                    .map(|c| c.id.as_str())
                    .collect()
        {
            return Err(Error::Validation("备份的凭据与主机引用不一致"));
        }
        // Persist recovery intents before writing any OS entries. Hold the subsequent write
        // transaction through installation so another importer cannot change links or trust.
        let mut conn = self.connect()?;
        let intent = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_error)?;
        for reference in references {
            intent
                .execute("INSERT INTO secret_gc(reference) VALUES(?1)", [reference])
                .map_err(storage_error)?;
        }
        intent.commit().map_err(storage_error)?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_error)?;
        let mut groups = HashMap::new();
        for index in group_order {
            let group = &directory.groups[index];
            validate_name(&group.name)?;
            let mut parent = group.parent_id.clone();
            remap(&groups, &mut parent)?;
            let id = Uuid::new_v4().to_string();
            if tx.execute("INSERT INTO host_groups(id,name,sort_order,parent_id) VALUES(?1,?2,?3,?4) ON CONFLICT(name) DO NOTHING",
                params![id,group.name,group.sort_order,parent]).map_err(storage_error)? == 0 {
                return Err(Error::Validation("文件夹名称冲突，未导入主机备份"));
            }
            groups.insert(group.id.as_str(), id);
        }
        let mut credentials = HashMap::new();
        for (credential, reference) in directory.credentials.iter().zip(references) {
            validate_name(&credential.name)?;
            if Uuid::parse_str(&credential.id).is_err() || credential.kind == AuthType::Agent {
                return Err(Error::Validation("备份凭据无效"));
            }
            let id = Uuid::new_v4().to_string();
            tx.execute("INSERT INTO credentials(id,name,kind,host_managed,secret_ref) VALUES(?1,?2,?3,?4,?5)",
                params![id,credential.name,credential.kind.as_str(),credential.host_managed,reference]).map_err(storage_error)?;
            credentials.insert(credential.id.as_str(), id);
        }
        let mut endpoints = HashSet::new();
        for host in &directory.hosts {
            let addr = normalize_hostname(&host.config.hostname)?;
            if endpoints.insert((addr.clone(), host.config.port))
                && tx
                    .query_row(
                        "SELECT EXISTS(SELECT 1 FROM hosts WHERE hostname=?1 AND port=?2)",
                        params![addr, host.config.port],
                        |row| row.get::<_, bool>(0),
                    )
                    .map_err(storage_error)?
            {
                return Err(Error::Validation(
                    "主机地址和端口与现有记录冲突，未导入主机备份",
                ));
            }
        }
        let mut hosts = HashMap::new();
        for index in host_order {
            let host = &directory.hosts[index];
            let mut input = host.config.clone().normalize()?;
            remap(&groups, &mut input.group_id)?;
            remap(&hosts, &mut input.ssh.jump_host_id)?;
            remap(&credentials, &mut input.credential_id)?;
            if let Some(proxy) = &mut input.ssh.proxy {
                remap(&credentials, &mut proxy.credential_id)?;
            }
            hosts.insert(host.id.as_str(), insert_host(&tx, &input)?.id);
        }
        for key in &directory.trusted_keys {
            if !endpoints.remove(&(key.hostname.clone(), key.port)) {
                return Err(Error::Validation("备份的主机指纹与导入主机不匹配或重复"));
            }
            tx.execute(
                "INSERT INTO ssh_known_hosts(hostname,port,public_key,fingerprint,trusted_at)
                VALUES(?1,?2,?3,?4,?5) ON CONFLICT(hostname,port) DO NOTHING",
                params![
                    key.hostname,
                    key.port,
                    key.public_key,
                    key.fingerprint,
                    key.trusted_at
                ],
            )
            .map_err(storage_error)?;
            let matches: bool = tx.query_row("SELECT public_key=?3 AND fingerprint=?4 FROM ssh_known_hosts WHERE hostname=?1 AND port=?2",
                params![key.hostname,key.port,key.public_key,key.fingerprint], |row| row.get(0)).map_err(storage_error)?;
            if !matches {
                return Err(Error::Validation(
                    "备份指纹与本机信任记录冲突，未导入主机备份",
                ));
            }
        }
        for (credential, reference) in directory.credentials.iter().zip(references) {
            if tx
                .execute("DELETE FROM secret_gc WHERE reference=?1", [reference])
                .map_err(storage_error)?
                != 1
            {
                return Err(Error::Conflict);
            }
            write(reference, &credential.value)?;
        }
        tx.commit().map_err(storage_error)
    }
}
