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
pub struct DirectoryEnvironment {
    tags: Vec<EnvironmentTag>,
    assignments: Vec<DirectoryAssignment>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DirectoryAssignment {
    host_id: String,
    tag_id: String,
}

// The initial catalog shipped by migration 012, before users can customize it.
const INITIAL_TAGS: [(&str, &str, EnvironmentTagColor); 3] = [
    ("production", "生产", EnvironmentTagColor::Red),
    ("staging", "预发", EnvironmentTagColor::Amber),
    ("testing", "测试", EnvironmentTagColor::Blue),
];

impl DirectoryEnvironment {
    fn validate(&self, hosts: &[DirectoryHost]) -> Result<(), Error> {
        let mut tag_ids = HashSet::new();
        let mut names = HashSet::new();
        for tag in &self.tags {
            let name = normalize_environment_tag_name(&tag.name)?;
            if name != tag.name
                || !(Uuid::parse_str(&tag.id).is_ok()
                    || INITIAL_TAGS.iter().any(|(id, _, _)| *id == tag.id))
                || !tag_ids.insert(tag.id.as_str())
                || !names.insert(name.to_ascii_lowercase())
            {
                return Err(Error::Validation("备份中的环境标签无效或重复"));
            }
        }
        let host_ids: HashSet<_> = hosts.iter().map(|host| host.id.as_str()).collect();
        let mut assigned = HashSet::new();
        for assignment in &self.assignments {
            if !host_ids.contains(assignment.host_id.as_str())
                || !tag_ids.contains(assignment.tag_id.as_str())
                || !assigned.insert(assignment.host_id.as_str())
            {
                return Err(Error::Validation("备份中的环境标签分配无效或重复"));
            }
        }
        Ok(())
    }

    fn merge<'a>(&'a self, tx: &Connection) -> Result<HashMap<&'a str, String>, Error> {
        let mut local = environment::read(tx)?.tags;
        let pristine = local.len() == INITIAL_TAGS.len()
            && local
                .iter()
                .all(|tag| INITIAL_TAGS.contains(&(tag.id.as_str(), tag.name.as_str(), tag.color)))
            && tx
                .query_row("SELECT NOT EXISTS (SELECT 1 FROM hosts)", [], |row| {
                    row.get::<_, bool>(0)
                })
                .map_err(storage_error)?;
        if pristine {
            // Only an empty, uncustomized installation takes the complete catalog.
            tx.execute("DELETE FROM host_environment_tags", [])
                .map_err(storage_error)?;
            local.clear();
        }
        let local: HashMap<_, _> = local
            .iter()
            .map(|tag| (tag.name.to_ascii_lowercase(), tag))
            .collect();
        let mut tag_ids = HashMap::new();
        for tag in &self.tags {
            let id = if let Some(existing) = local.get(&tag.name.to_ascii_lowercase()) {
                if existing.color != tag.color {
                    return Err(Error::Validation(
                        "本机有同名异色的环境标签，请先调整标签名称或颜色再导入",
                    ));
                }
                existing.id.clone()
            } else {
                let id = if pristine {
                    tag.id.clone()
                } else {
                    Uuid::new_v4().to_string()
                };
                tx.execute(
                    "INSERT INTO host_environment_tags(id,name,color) VALUES(?1,?2,?3)",
                    params![id, tag.name, tag.color.as_str()],
                )
                .map_err(storage_error)?;
                id
            };
            tag_ids.insert(tag.id.as_str(), id);
        }
        self.assignments
            .iter()
            .map(|assignment| {
                let tag_id = tag_ids
                    .get(assignment.tag_id.as_str())
                    .ok_or(Error::Validation("备份中的环境标签分配无效或重复"))?;
                Ok((assignment.host_id.as_str(), tag_id.clone()))
            })
            .collect()
    }
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

#[derive(Default)]
pub struct DirectoryImportResult {
    pub hosts: usize,
    pub groups: usize,
    pub skipped_hosts: usize,
    pub reused_groups: usize,
    pub agent_hosts: usize,
    pub missing_auth: usize,
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

fn matching_host(
    connection: &Connection,
    input: &HostInput,
    claimed: Option<&HashSet<String>>,
    tag_id: Option<&str>,
    mut credentials_match: impl FnMut(Option<&str>, Option<&str>) -> Result<bool, Error>,
) -> Result<Option<String>, Error> {
    let mut statement = connection
        .prepare_cached(&format!(
            "SELECT {HOST_COLUMNS} FROM hosts
             LEFT JOIN host_environment_assignments AS a ON a.host_id=hosts.id
             WHERE hostname=?1 AND port=?2 AND username=?3
             ORDER BY (?4 AND a.tag_id IS ?5) DESC, (?4 AND a.tag_id IS NULL) DESC, hosts.id"
        ))
        .map_err(storage_error)?;
    let candidates = statement
        .query_map(
            params![
                input.hostname,
                input.port,
                input.username,
                claimed.is_some(),
                tag_id
            ],
            host_row,
        )
        .map_err(storage_error)?;
    let proxy_credential = input
        .ssh
        .proxy
        .as_ref()
        .and_then(|p| p.credential_id.as_deref());
    for candidate in candidates {
        let Host { id, mut config, .. } = candidate.map_err(storage_error)?;
        if claimed.is_some_and(|ids| ids.contains(&id)) {
            continue;
        }
        // Match the configuration independently of the local IDs assigned to its credentials.
        let login = std::mem::replace(&mut config.credential_id, input.credential_id.clone());
        let proxy = config.ssh.proxy.as_mut().and_then(|proxy| {
            std::mem::replace(
                &mut proxy.credential_id,
                proxy_credential.map(str::to_owned),
            )
        });
        if config == *input
            && credentials_match(input.credential_id.as_deref(), login.as_deref())?
            && credentials_match(proxy_credential, proxy.as_deref())?
        {
            return Ok(Some(id));
        }
    }
    Ok(None)
}

impl Database {
    pub fn export_host_directory<T>(
        &self,
        mut read: impl FnMut(&CredentialRecord) -> Result<T, Error>,
    ) -> Result<(Directory<T>, DirectoryEnvironment), Error> {
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
        let EnvironmentTags { tags, assignments } = environment::read(&tx)?;
        tx.commit().map_err(storage_error)?;
        Ok((
            Directory {
                groups,
                hosts,
                credentials,
                trusted_keys,
            },
            DirectoryEnvironment {
                tags,
                assignments: assignments
                    .into_iter()
                    .map(|(host_id, tag_id)| DirectoryAssignment { host_id, tag_id })
                    .collect(),
            },
        ))
    }

    pub fn import_host_directory<T: AsRef<[u8]>, R: AsRef<[u8]>>(
        &self,
        directory: &Directory<T>,
        environment: Option<&DirectoryEnvironment>,
        references: &[String],
        mut read: impl FnMut(&str) -> Result<Option<R>, Error>,
        mut write: impl FnMut(&str, &T) -> Result<(), Error>,
    ) -> Result<DirectoryImportResult, Error> {
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
        if let Some(environment) = environment {
            environment.validate(&directory.hosts)?;
        }
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
        let assignments = environment
            .map(|environment| environment.merge(&tx))
            .transpose()?
            .unwrap_or_default();
        let mut result = DirectoryImportResult::default();
        let mut groups = HashMap::new();
        for index in group_order {
            let group = &directory.groups[index];
            validate_name(&group.name)?;
            let mut parent = group.parent_id.clone();
            remap(&groups, &mut parent)?;
            let existing: Option<(String, Option<String>)> = tx
                .query_row(
                    "SELECT id,parent_id FROM host_groups WHERE name=?1",
                    [&group.name],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()
                .map_err(storage_error)?;
            let id = if let Some((id, existing_parent)) = existing {
                if parent != existing_parent {
                    return Err(Error::Validation("同名文件夹位于不同路径，未导入主机备份"));
                }
                result.reused_groups += 1;
                id
            } else {
                let id = Uuid::new_v4().to_string();
                tx.execute(
                    "INSERT INTO host_groups(id,name,sort_order,parent_id) VALUES(?1,?2,?3,?4)",
                    params![id, group.name, group.sort_order, parent],
                )
                .map_err(storage_error)?;
                result.groups += 1;
                id
            };
            groups.insert(group.id.as_str(), id);
        }
        let mut endpoints = directory
            .hosts
            .iter()
            .map(|host| Ok((normalize_hostname(&host.config.hostname)?, host.config.port)))
            .collect::<Result<HashSet<_>, Error>>()?;
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

        let mut credentials = HashMap::new();
        let mut imported_credentials = HashMap::new();
        for (credential, reference) in directory.credentials.iter().zip(references) {
            validate_name(&credential.name)?;
            if Uuid::parse_str(&credential.id).is_err() || credential.kind == AuthType::Agent {
                return Err(Error::Validation("备份凭据无效"));
            }
            let id = Uuid::new_v4().to_string();
            tx.execute("INSERT INTO credentials(id,name,kind,host_managed,secret_ref) VALUES(?1,?2,?3,?4,?5)",
                params![id,credential.name,credential.kind.as_str(),credential.host_managed,reference]).map_err(storage_error)?;
            credentials.insert(credential.id.as_str(), id.clone());
            imported_credentials.insert(id, (credential, reference));
        }
        let mut compared_credentials = HashMap::new();
        let mut credentials_match = |incoming: Option<&str>, local: Option<&str>| {
            if incoming == local {
                return Ok(true);
            }
            let (Some(incoming), Some(local)) = (incoming, local) else {
                return Ok(false);
            };
            let key = (incoming.to_owned(), local.to_owned());
            if let Some(&matches) = compared_credentials.get(&key) {
                return Ok(matches);
            }
            let (incoming, _) = imported_credentials
                .get(incoming)
                .ok_or(Error::Validation("备份中的关联记录缺失"))?;
            let matches = if let Some((other, _)) = imported_credentials.get(local) {
                incoming.kind == other.kind && incoming.value.as_ref() == other.value.as_ref()
            } else {
                let other = credential_record(&tx, local)?;
                if other.public.kind == incoming.kind
                    && other.public.key_path.is_none()
                    && let Some(reference) = other.secret_ref
                {
                    read(&reference)?
                        .is_some_and(|secret| secret.as_ref() == incoming.value.as_ref())
                } else {
                    false
                }
            };
            compared_credentials.insert(key, matches);
            Ok(matches)
        };

        let mut hosts = HashMap::new();
        let mut claimed = HashSet::new();
        let mut installed_credentials = HashSet::new();
        for index in host_order {
            let host = &directory.hosts[index];
            let mut input = host.config.clone().normalize()?;
            remap(&groups, &mut input.group_id)?;
            remap(&hosts, &mut input.ssh.jump_host_id)?;
            remap(&credentials, &mut input.credential_id)?;
            if let Some(proxy) = &mut input.ssh.proxy {
                remap(&credentials, &mut proxy.credential_id)?;
            }
            let tag_id = assignments.get(host.id.as_str()).map(String::as_str);
            let id = if let Some(id) = matching_host(
                &tx,
                &input,
                environment.map(|_| &claimed),
                tag_id,
                &mut credentials_match,
            )? {
                result.skipped_hosts += 1;
                id
            } else {
                let id = insert_host(&tx, &input)?.id;
                result.hosts += 1;
                result.agent_hosts += usize::from(input.auth_type == AuthType::Agent);
                result.missing_auth += usize::from(
                    input.auth_type != AuthType::Agent && input.credential_id.is_none(),
                );
                installed_credentials.extend(input.credential_id);
                installed_credentials.extend(input.ssh.proxy.and_then(|proxy| proxy.credential_id));
                id
            };
            // Each v2 host can carry its own assignment, even when configurations match.
            if environment.is_some() {
                claimed.insert(id.clone());
            }
            if let Some(tag_id) = tag_id {
                tx.execute(
                    "INSERT INTO host_environment_assignments(host_id,tag_id) VALUES(?1,?2)
                     ON CONFLICT(host_id) DO NOTHING",
                    params![id, tag_id],
                )
                .map_err(storage_error)?;
            }
            hosts.insert(host.id.as_str(), id);
        }
        for (id, (credential, reference)) in imported_credentials {
            if tx
                .execute("DELETE FROM secret_gc WHERE reference=?1", [reference])
                .map_err(storage_error)?
                != 1
            {
                return Err(Error::Conflict);
            }
            if installed_credentials.contains(&id) {
                write(reference, &credential.value)?;
            } else {
                tx.execute("DELETE FROM credentials WHERE id=?1", [&id])
                    .map_err(storage_error)?;
            }
        }
        tx.commit().map_err(storage_error)?;
        Ok(result)
    }
}
