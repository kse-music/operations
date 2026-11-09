//! Ordered, immutable upgrades. One SQLite write lock covers backup and commit.
use super::{Database, config_migrations};
use rusqlite::{
    Connection, OpenFlags, OptionalExtension, TransactionBehavior,
    backup::{Backup, StepResult},
};
use serverdeck_core::{AppConfig, DATABASE_VERSION, Error};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, OpenOptions},
    path::{Path, PathBuf},
};

struct Migration {
    version: u32,
    name: &'static str,
    sql: &'static str,
}
const MIGRATIONS: &[Migration] = &[
    Migration {
        version: 1,
        name: "settings",
        sql: include_str!("../migrations/001_settings.sql"),
    },
    Migration {
        version: 2,
        name: "hosts",
        sql: include_str!("../migrations/002_hosts.sql"),
    },
    Migration {
        version: 3,
        name: "known_hosts",
        sql: include_str!("../migrations/003_known_hosts.sql"),
    },
    Migration {
        version: 4,
        name: "terminal_workspace",
        sql: include_str!("../migrations/004_terminal_workspace.sql"),
    },
    Migration {
        version: 5,
        name: "preserve_retired_tasks",
        sql: include_str!("../migrations/005_preserve_retired_tasks.sql"),
    },
    Migration {
        version: 6,
        name: "optional_host_name",
        sql: include_str!("../migrations/006_optional_host_name.sql"),
    },
    Migration {
        version: 7,
        name: "host_folders",
        sql: include_str!("../migrations/007_host_folders.sql"),
    },
    Migration {
        version: 8,
        name: "imported_private_keys",
        sql: include_str!("../migrations/008_imported_private_keys.sql"),
    },
    Migration {
        version: 9,
        name: "host_credentials",
        sql: include_str!("../migrations/009_host_credentials.sql"),
    },
    Migration {
        version: 10,
        name: "migration_history",
        sql: include_str!("../migrations/010_migration_history.sql"),
    },
];

pub(super) fn failure(stage: &'static str, source: Error) -> Error {
    let category = match &source {
        Error::Storage(error) if error.is::<rusqlite::Error>() => "sqlite",
        Error::Storage(error) if error.is::<std::io::Error>() => "io",
        Error::Storage(error) if error.is::<serde_json::Error>() => "config_json",
        _ => "data_contract",
    };
    let sql_code = match &source {
        Error::Storage(error) => match error.downcast_ref::<rusqlite::Error>() {
            Some(rusqlite::Error::SqliteFailure(code, _)) => Some(code.extended_code),
            _ => None,
        },
        _ => None,
    };
    let io_kind = match &source {
        Error::Storage(error) => error
            .downcast_ref::<std::io::Error>()
            .map(std::io::Error::kind),
        _ => None,
    };
    tracing::error!(
        operation = "data_upgrade",
        stage,
        category,
        sql_code,
        io_kind = ?io_kind,
        reason = %source,
        "local data upgrade failed"
    );
    Error::Migration {
        stage,
        source: Box::new(source),
    }
}

// The upgrade boundary records one safe diagnostic with its stage, instead of
// logging the same underlying failure again at every SQL/JSON conversion.
pub(super) fn storage_error<E: std::error::Error + Send + Sync + 'static>(error: E) -> Error {
    Error::Storage(Box::new(error))
}

/// Check ancestors as well as the leaf; never write a backup through a link.
pub(super) fn check_path(path: &Path) -> Result<(), Error> {
    for ancestor in path.ancestors() {
        if ancestor.as_os_str().is_empty() {
            continue;
        }
        match fs::symlink_metadata(ancestor) {
            Ok(metadata) => {
                #[cfg(windows)]
                let linked = {
                    use std::os::windows::fs::MetadataExt;
                    metadata.file_attributes() & 0x400 != 0
                };
                #[cfg(not(windows))]
                let linked = metadata.file_type().is_symlink();
                if linked {
                    return Err(Error::Validation(
                        "数据库及升级备份路径不能包含链接或重解析点",
                    ));
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
            Err(error) => return Err(storage_error(error)),
        }
    }
    Ok(())
}

pub(super) fn integrity(connection: &Connection) -> Result<(), Error> {
    let result: String = connection
        .pragma_query_value(None, "quick_check", |row| row.get(0))
        .map_err(storage_error)?;
    if result != "ok" {
        return Err(Error::Validation("数据库完整性检查失败，未提交升级"));
    }
    if connection
        .query_row("PRAGMA foreign_key_check", [], |_| Ok(()))
        .optional()
        .map_err(storage_error)?
        .is_some()
    {
        return Err(Error::Validation("数据库外键检查失败，未提交升级"));
    }
    Ok(())
}

/// The caller must already hold BEGIN IMMEDIATE, before making any changes.
/// A separate read-only source captures committed pages, including a live WAL.
pub(super) fn backup(database: &Database, version: u32) -> Result<PathBuf, Error> {
    let folder = database
        .path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("migration-backups");
    check_path(&folder)?;
    fs::create_dir_all(&folder).map_err(storage_error)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&folder, fs::Permissions::from_mode(0o700)).map_err(storage_error)?;
    }
    let name = database
        .path
        .file_name()
        .unwrap_or_default()
        .to_string_lossy();
    let path = folder.join(format!(
        "{name}.before-schema-{version}-{}.sqlite3",
        uuid::Uuid::new_v4()
    ));
    let partial = path.with_extension("sqlite3.partial");
    let mut options = OpenOptions::new();
    options.read(true).write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options.open(&partial).map_err(storage_error)?;
    let source = Connection::open_with_flags(&database.path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(storage_error)?;
    let mut destination = Connection::open_with_flags(&partial, OpenFlags::SQLITE_OPEN_READ_WRITE)
        .map_err(storage_error)?;
    {
        let backup = Backup::new(&source, &mut destination).map_err(storage_error)?;
        if !matches!(backup.step(-1).map_err(storage_error)?, StepResult::Done) {
            return Err(Error::Busy);
        }
    }
    integrity(&destination)?;
    let saved: u32 = destination
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(storage_error)?;
    if saved != version {
        return Err(Error::Conflict);
    }
    destination
        .close()
        .map_err(|(_, error)| storage_error(error))?;
    file.sync_all().map_err(storage_error)?;
    drop(file);
    publish_backup(&partial, &path)?;
    #[cfg(unix)]
    fs::File::open(&folder)
        .and_then(|folder| folder.sync_all())
        .map_err(storage_error)?;
    Ok(path)
}

fn publish_backup(partial: &Path, destination: &Path) -> Result<(), Error> {
    let mut pending = tempfile::TempPath::try_from_path(partial).map_err(storage_error)?;
    // A failed publish must retain the incomplete/diagnostic file. noclobber
    // guarantees that even a concurrently created destination is not replaced.
    pending.disable_cleanup(true);
    pending
        .persist_noclobber(destination)
        .map_err(|error| storage_error(error.error))
}

fn checksum(migration: &Migration) -> String {
    format!(
        "{:x}",
        Sha256::digest(migration.sql.replace("\r\n", "\n").as_bytes())
    )
}

fn history(connection: &Connection, version: u32) -> Result<(), Error> {
    if version < 10 {
        return Ok(());
    }
    let mut statement = connection
        .prepare("SELECT version,name,checksum FROM schema_migrations ORDER BY version")
        .map_err(storage_error)?;
    let records = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, u32>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(storage_error)?;
    let mut found = std::collections::BTreeSet::new();
    for record in records {
        let (number, name, saved) = record.map_err(storage_error)?;
        let migration = MIGRATIONS
            .iter()
            .find(|migration| migration.version == number)
            .ok_or(Error::Validation("数据库迁移历史包含未知步骤"))?;
        if number > version || name != migration.name || saved != checksum(migration) {
            return Err(Error::Validation(
                "数据库迁移历史校验失败，请勿修改已应用的迁移脚本",
            ));
        }
        found.insert(number);
    }
    if (10..=version).any(|number| !found.contains(&number)) {
        return Err(Error::Validation("数据库迁移历史不完整"));
    }
    Ok(())
}

pub(super) fn verify(connection: &Connection) -> Result<(), Error> {
    let version: u32 = connection
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(storage_error)?;
    if version == 0 || version > DATABASE_VERSION {
        return Err(Error::UnsupportedDatabase(version));
    }
    integrity(connection)?;
    history(connection, version)?;
    if let Some(raw) = config_raw(connection)? {
        config_migrations::app_config(&raw)?;
    }
    Ok(())
}

fn config_raw(connection: &Connection) -> Result<Option<String>, Error> {
    connection
        .query_row(
            "SELECT value FROM application_settings WHERE key='app_config'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(storage_error)
}

fn check_rebuilds(connection: &Connection, version: u32) -> Result<(), Error> {
    for (needed, table, columns) in [
        (
            (2..6).contains(&version),
            "hosts",
            "id name hostname port username auth_type credential_id group_id tags description favorite connect_timeout_secs created_at updated_at",
        ),
        (
            (2..8).contains(&version),
            "credentials",
            "id name kind key_path secret_ref revision",
        ),
    ] {
        if !needed {
            continue;
        }
        let mut expected = columns
            .split_whitespace()
            .map(str::to_owned)
            .collect::<std::collections::BTreeSet<_>>();
        if table == "hosts" && version >= 4 {
            expected.insert("ssh_options".into());
        }
        let actual = connection
            .prepare(&format!("PRAGMA table_info({table})"))
            .map_err(storage_error)?
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(storage_error)?
            .collect::<Result<std::collections::BTreeSet<_>, _>>()
            .map_err(storage_error)?;
        if actual != expected {
            return Err(Error::Validation(
                "待重建的数据表含未知字段或缺少字段，原数据保留",
            ));
        }
        let mut statement = connection.prepare("SELECT type,name,sql FROM sqlite_master WHERE tbl_name=?1 AND type IN ('index','trigger') AND sql IS NOT NULL").map_err(storage_error)?;
        let objects = statement
            .query_map([table], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(storage_error)?;
        for object in objects {
            let (kind, name, sql) = object.map_err(storage_error)?;
            let column = match (table, name.as_str()) {
                ("hosts", "hosts_group") => "group_id",
                ("hosts", "hosts_credential") => "credential_id",
                ("hosts", "hosts_endpoint") => "hostname,port,username",
                _ => {
                    return Err(Error::Validation(
                        "待重建的数据表含自定义索引或触发器，原数据保留",
                    ));
                }
            };
            let normalize = |sql: &str| {
                sql.chars()
                    .filter(|ch| !ch.is_whitespace())
                    .flat_map(char::to_lowercase)
                    .collect::<String>()
            };
            if kind != "index"
                || normalize(&sql)
                    != normalize(&format!("CREATE INDEX {name} ON {table}({column})"))
            {
                return Err(Error::Validation(
                    "待重建的数据表索引定义已变化，原数据保留",
                ));
            }
        }
    }
    Ok(())
}

pub(super) fn upgrade(database: &Database, connection: &mut Connection) -> Result<(), Error> {
    upgrade_with(database, connection, MIGRATIONS)
}

fn upgrade_with(
    database: &Database,
    connection: &mut Connection,
    migrations: &[Migration],
) -> Result<(), Error> {
    // Rebuilds must preserve referencing rows. FK validation is mandatory before commit;
    // normal application connections always have foreign_keys=ON.
    connection
        .pragma_update(None, "foreign_keys", false)
        .map_err(storage_error)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(storage_error)?;
    let version: u32 = transaction
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(storage_error)?;
    if version > DATABASE_VERSION {
        return Err(Error::UnsupportedDatabase(version));
    }
    if version == 0 {
        let tables: u32 = transaction.query_row("SELECT count(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'", [], |row| row.get(0)).map_err(storage_error)?;
        if tables != 0 {
            return Err(Error::UnsupportedDatabase(0));
        }
    }
    history(&transaction, version).map_err(|error| failure("迁移历史", error))?;
    let raw = if version == 0 {
        None
    } else {
        config_raw(&transaction)?
    };
    let config = match raw.as_deref() {
        Some(raw) => config_migrations::app_config(raw).map_err(|error| match error {
            Error::UnsupportedConfig(_) => error,
            error => failure("应用配置检查", error),
        })?,
        None => AppConfig::default(),
    };
    let config_changed = match raw.as_deref() {
        Some(raw) => serde_json::from_str::<AppConfig>(raw).ok().as_ref() != Some(&config),
        None => true,
    };
    let upgrading = version < DATABASE_VERSION || config_changed;
    if !upgrading {
        return Ok(());
    }
    if version != 0 {
        integrity(&transaction).map_err(|error| failure("升级前完整性检查", error))?;
        check_rebuilds(&transaction, version).map_err(|error| failure("结构兼容性检查", error))?;
        backup(database, version).map_err(|error| failure("升级前备份", error))?;
    }
    let pending: Vec<_> = migrations
        .iter()
        .filter(|migration| migration.version > version)
        .collect();
    for migration in &pending {
        transaction
            .execute_batch(migration.sql)
            .map_err(|error| failure("数据库结构", storage_error(error)))?;
    }
    for migration in pending {
        transaction
            .execute(
                "INSERT INTO schema_migrations(version,name,checksum) VALUES(?1,?2,?3)",
                rusqlite::params![migration.version, migration.name, checksum(migration)],
            )
            .map_err(|error| failure("迁移历史写入", storage_error(error)))?;
    }
    if config_changed {
        let config = serde_json::to_string(&config).map_err(storage_error)?;
        transaction.execute("INSERT INTO application_settings(key,value) VALUES('app_config',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [config])
            .map_err(|error| failure("应用配置", storage_error(error)))?;
    }
    integrity(&transaction).map_err(|error| failure("升级后完整性检查", error))?;
    transaction
        .pragma_update(None, "user_version", DATABASE_VERSION)
        .map_err(storage_error)?;
    transaction
        .commit()
        .map_err(|error| failure("事务提交", storage_error(error)))?;
    tracing::info!(
        operation = "data_upgrade",
        from = version,
        to = DATABASE_VERSION,
        config_changed,
        "local data upgraded"
    );
    Ok(())
}

#[cfg(test)]
mod tests;
