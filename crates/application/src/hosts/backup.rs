use super::*;
use serde::{Deserialize, Deserializer};
use serverdeck_storage::hosts::{
    CredentialRecord,
    backup::{Directory, DirectoryEnvironment},
};
use std::{
    fs::File,
    io::{BufWriter, Read, Write},
    path::{Path, PathBuf},
};

const MAX_FILE_BYTES: u64 = 64 * 1024 * 1024;
const FORMAT: &str = "serverdeck-hosts";
const CURRENT_VERSION: u32 = 2;

// Only decoded/encoded at the native file boundary. Never an IPC response or a log value.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Backup {
    format: String,
    version: u32,
    directory: Directory<Zeroizing<String>>,
    #[serde(default, deserialize_with = "read_environment")]
    environment_tags: Option<DirectoryEnvironment>,
}

// Absence is the v1 representation. A present v2 payload must be an object.
fn read_environment<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<DirectoryEnvironment>, D::Error> {
    DirectoryEnvironment::deserialize(deserializer).map(Some)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostBackupResult {
    pub hosts: usize,
    pub groups: usize,
    pub skipped_hosts: usize,
    pub reused_groups: usize,
    pub agent_hosts: usize,
    pub missing_auth: usize,
}

impl Backup {
    fn summary(&self) -> HostBackupResult {
        HostBackupResult {
            hosts: self.directory.hosts.len(),
            groups: self.directory.groups.len(),
            skipped_hosts: 0,
            reused_groups: 0,
            agent_hosts: self
                .directory
                .hosts
                .iter()
                .filter(|h| h.config.auth_type == AuthType::Agent)
                .count(),
            missing_auth: self
                .directory
                .hosts
                .iter()
                .filter(|h| {
                    h.config.auth_type != AuthType::Agent && h.config.credential_id.is_none()
                })
                .count(),
        }
    }
}

fn io_error(error: impl std::error::Error + Send + Sync + 'static) -> Error {
    Error::Storage(Box::new(error))
}

fn portable_secret(
    store: &dyn SecretStore,
    record: &CredentialRecord,
) -> Result<Zeroizing<String>, Error> {
    let bytes = record
        .secret_ref
        .as_ref()
        .map(|reference| {
            store
                .read(reference)?
                .ok_or(Error::Validation("主机引用的系统凭据缺失，无法完成备份"))
        })
        .transpose()?;
    let text = bytes
        .as_deref()
        .map(|b| std::str::from_utf8(b).map_err(|_| Error::Validation("主机凭据编码无效")))
        .transpose()?;
    if let Some(path) = &record.public.key_path {
        return serverdeck_ssh::import_key_from_saved_path(path, text);
    }
    let value = text.ok_or(Error::Validation("主机凭据缺少密码或私钥"))?;
    match record.public.kind {
        AuthType::Password => {
            HostAuthenticationInput::validate_secret(value)?;
            Ok(Zeroizing::new(value.to_owned()))
        }
        AuthType::PrivateKey => serverdeck_ssh::import_private_key(value, None),
        AuthType::Agent => Err(Error::Validation("SSH Agent 没有可保存的凭据")),
    }
}

fn export(db: &Database, store: &dyn SecretStore, path: &Path) -> Result<HostBackupResult, Error> {
    if !path
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("sdhosts"))
    {
        return Err(Error::Validation("主机备份文件须使用 .sdhosts 扩展名"));
    }
    let mut secret_bytes = 0;
    let (directory, environment_tags) = db.export_host_directory(|record| {
        let value = portable_secret(store, record)?;
        secret_bytes += value.len() as u64;
        if secret_bytes > MAX_FILE_BYTES {
            return Err(Error::Validation("主机备份超过 64 MiB 大小限制"));
        }
        Ok(value)
    })?;
    let backup = Backup {
        format: FORMAT.into(),
        version: CURRENT_VERSION,
        directory,
        environment_tags: Some(environment_tags),
    };
    let parent = path.parent().ok_or(Error::Validation("请选择本地文件"))?;
    let mut file = tempfile::NamedTempFile::new_in(parent).map_err(io_error)?;
    {
        let mut writer = BufWriter::new(file.as_file_mut());
        serde_json::to_writer(&mut writer, &backup).map_err(io_error)?;
        writer.flush().map_err(io_error)?;
    }
    if file.as_file().metadata().map_err(io_error)?.len() > MAX_FILE_BYTES {
        return Err(Error::Validation("主机备份超过 64 MiB 大小限制"));
    }
    file.as_file().sync_all().map_err(io_error)?;
    file.persist(path).map_err(|e| io_error(e.error))?;
    Ok(backup.summary())
}

fn import(db: &Database, store: &dyn SecretStore, path: &Path) -> Result<HostBackupResult, Error> {
    let file = File::open(path).map_err(io_error)?;
    let metadata = file.metadata().map_err(io_error)?;
    if !metadata.is_file() || metadata.len() > MAX_FILE_BYTES {
        return Err(Error::Validation("请选择 64 MiB 以内的主机备份文件"));
    }
    let mut bytes = Zeroizing::new(Vec::with_capacity(metadata.len() as usize));
    file.take(MAX_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(io_error)?;
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err(Error::Validation("主机备份超过 64 MiB 大小限制"));
    }
    let mut backup: Backup = serde_json::from_slice(&bytes).map_err(|e| Error::Connection {
        code: "HOST_BACKUP_FORMAT",
        message: "主机备份格式无效或版本不受支持",
        source: Some(Box::new(e)),
    })?;
    drop(bytes);
    if backup.format != FORMAT
        || !matches!(
            (backup.version, &backup.environment_tags),
            (1, None) | (2, Some(_))
        )
    {
        return Err(Error::Validation("主机备份格式或版本不受支持"));
    }
    for key in &backup.directory.trusted_keys {
        serverdeck_ssh::validate_saved_host_key(&key.public_key, &key.fingerprint)?;
    }
    let mut references = Vec::with_capacity(backup.directory.credentials.len());
    for credential in &mut backup.directory.credentials {
        match credential.kind {
            AuthType::Password => HostAuthenticationInput::validate_secret(&credential.value)?,
            AuthType::PrivateKey => {
                credential.value = serverdeck_ssh::import_private_key(&credential.value, None)?
            }
            AuthType::Agent => return Err(Error::Validation("备份凭据类型无效")),
        }
        references.push(new_secret_reference(credential.value.as_bytes())?);
    }
    let result = match db.import_host_directory(
        &backup.directory,
        backup.environment_tags.as_ref(),
        &references,
        |reference| store.read(reference),
        |reference, value| store.write(reference, value.as_bytes()),
    ) {
        Ok(result) => result,
        Err(error) => {
            for reference in &references {
                if db
                    .collect_pending_secret(reference, || store.delete(reference))
                    .is_err()
                {
                    tracing::warn!(
                        operation = "host_backup_cleanup",
                        "pending credential cleanup will be retried"
                    );
                }
            }
            return Err(error);
        }
    };
    Ok(HostBackupResult {
        hosts: result.hosts,
        groups: result.groups,
        skipped_hosts: result.skipped_hosts,
        reused_groups: result.reused_groups,
        agent_hosts: result.agent_hosts,
        missing_auth: result.missing_auth,
    })
}

impl Application {
    pub async fn host_backup_export(&self, path: PathBuf) -> Result<HostBackupResult, Error> {
        let store = self.secrets.clone();
        self.blocking(move |db| export(&db, store.as_ref(), &path))
            .await
    }
    pub async fn host_backup_import(&self, path: PathBuf) -> Result<HostBackupResult, Error> {
        let store = self.secrets.clone();
        self.blocking(move |db| import(&db, store.as_ref(), &path))
            .await
    }
}
