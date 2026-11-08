//! Device-local profile selection. Copying runs only before any profile writer opens.
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use serverdeck_core::{Error, StorageInfo, StoragePreview};
use sha2::{Digest, Sha256};

pub const LOCATOR: &str = "storage-location.json";
const RESERVE: u64 = 16 * 1024 * 1024;

fn io(error: impl std::error::Error + Send + Sync + 'static) -> Error {
    Error::Storage(Box::new(error))
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Locations {
    pub data: PathBuf,
    pub logs: PathBuf,
    pub webview: PathBuf,
}

impl Locations {
    pub fn unified(root: PathBuf) -> Self {
        Self {
            logs: root.join("logs"),
            webview: root.join("webview"),
            data: root,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Entry {
    source: PathBuf,
    relative: PathBuf,
    bytes: u64,
    digest: String,
    directory: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum Phase {
    Pending,
    Copied,
    Committed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Migration {
    id: uuid::Uuid,
    source: Locations,
    target: Locations,
    phase: Phase,
    files: Vec<Entry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct State {
    version: u8,
    active: Locations,
    migration: Option<Migration>,
    notice: Option<String>,
}

pub struct Profile {
    locator: PathBuf,
    state: State,
}

// Never traverse a symlink, junction or other Windows reparse point, including ancestors.
pub fn check_path(path: &Path) -> Result<(), Error> {
    if !path.is_absolute() {
        return Err(Error::Validation("存储目录必须是本地绝对路径"));
    }
    for ancestor in path.ancestors() {
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
                    return Err(Error::Validation("存储迁移不接受符号链接或重解析点"));
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
            Err(error) => return Err(io(error)),
        }
    }
    Ok(())
}

fn normalized(path: &Path) -> Result<PathBuf, Error> {
    check_path(path)?;
    let mut existing = path;
    let mut suffix = Vec::new();
    while !existing.try_exists().map_err(io)? {
        suffix.push(
            existing
                .file_name()
                .ok_or(Error::Validation("目录路径无效"))?
                .to_owned(),
        );
        existing = existing.parent().ok_or(Error::Validation("目录路径无效"))?;
    }
    let mut result = fs::canonicalize(existing).map_err(io)?;
    for part in suffix.into_iter().rev() {
        result.push(part);
    }
    // Windows extended path syntax is an implementation detail, not a displayed preference.
    #[cfg(windows)]
    let result = PathBuf::from(
        result
            .to_string_lossy()
            .strip_prefix(r"\\?\")
            .unwrap_or(&result.to_string_lossy()),
    );
    Ok(result)
}

fn key(path: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        PathBuf::from(path.to_string_lossy().to_lowercase())
    }
    #[cfg(not(windows))]
    {
        path.to_owned()
    }
}

fn within(path: &Path, root: &Path) -> bool {
    key(path).starts_with(key(root))
}

fn ensure_capacity(bytes: u64, available: u64) -> Result<(), Error> {
    let required = bytes
        .checked_add(RESERVE)
        .ok_or(Error::Validation("迁移数据过大"))?;
    if available < required {
        return Err(Error::Validation(
            "目标磁盘空间不足，需容纳数据副本及额外 16 MiB",
        ));
    }
    Ok(())
}

fn hash(path: &Path) -> Result<(u64, String), Error> {
    check_path(path)?;
    let mut attempts = 0;
    let mut file = loop {
        match File::open(path) {
            Ok(file) => break file,
            Err(error) if matches!(error.raw_os_error(), Some(32 | 33)) && attempts < 30 => {
                attempts += 1;
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            Err(error) => return Err(io(error)),
        }
    };
    let mut hasher = Sha256::new();
    let mut size = 0;
    let mut buffer = [0; 64 * 1024];
    loop {
        let count = file.read(&mut buffer).map_err(io)?;
        if count == 0 {
            break;
        }
        size += count as u64;
        hasher.update(&buffer[..count]);
    }
    Ok((size, format!("{:x}", hasher.finalize())))
}

impl Profile {
    pub fn open(locator: PathBuf, defaults: Locations) -> Result<Self, Error> {
        check_path(&locator)?;
        let state = if locator.try_exists().map_err(io)? {
            let size = fs::metadata(&locator).map_err(io)?.len();
            if size > 32 * 1024 * 1024 {
                return Err(Error::Validation("目录迁移状态文件过大"));
            }
            let state: State =
                serde_json::from_slice(&fs::read(&locator).map_err(io)?).map_err(io)?;
            if state.version != 1 {
                return Err(Error::Validation("目录配置版本不受支持"));
            }
            state
        } else {
            State {
                version: 1,
                active: Locations::unified(defaults.data),
                migration: None,
                notice: None,
            }
        };
        let mut profile = Self { locator, state };
        profile.validate_state()?;
        if let Some(job) = profile.state.migration.clone() {
            match job.phase {
                Phase::Pending => {
                    let source = job.source.clone();
                    if let Err(error) = profile.copy_pending(job) {
                        tracing::error!(operation="storage_migrate", error=%error, "profile copy failed; retaining source");
                        profile.state.notice = Some(format!(
                            "数据迁移未完成：{error}。继续使用旧目录，旧数据未删除。"
                        ));
                        profile.state.migration = None;
                        profile.state.active = source;
                        profile.persist()?;
                    }
                }
                Phase::Copied => {
                    // A previous candidate never acknowledged successful initialization.
                    profile.state.active = job.source;
                    profile.state.migration = None;
                    profile.state.notice = Some("新目录上次未完成启动，已恢复旧目录；目标副本保留，请检查后重新选择空目录。".into());
                    profile.persist()?;
                }
                Phase::Committed => (),
            }
        }
        if profile.locator.try_exists().map_err(io)? {
            check_path(&profile.state.active.data)?;
            if !profile
                .state
                .active
                .data
                .join("serverdeck.sqlite3")
                .is_file()
            {
                return Err(Error::Validation(
                    "已配置的数据目录不可访问或数据库缺失；请恢复该目录后重试",
                ));
            }
        }
        Ok(profile)
    }

    pub fn locations(&self) -> &Locations {
        &self.state.active
    }

    pub fn record_initialized(&self) -> Result<(), Error> {
        self.persist()
    }

    pub fn info(&self) -> StorageInfo {
        let p = &self.state.active;
        StorageInfo {
            root_directory: p.data.to_string_lossy().into_owned(),
            database_path: p
                .data
                .join("serverdeck.sqlite3")
                .to_string_lossy()
                .into_owned(),
            plugin_directory: p.data.join("plugins").to_string_lossy().into_owned(),
            log_directory: p.logs.to_string_lossy().into_owned(),
            webview_directory: p.webview.to_string_lossy().into_owned(),
            notice: self.state.notice.clone(),
        }
    }

    fn persist(&self) -> Result<(), Error> {
        check_path(&self.locator)?;
        let parent = self
            .locator
            .parent()
            .ok_or(Error::Validation("目录配置路径无效"))?;
        fs::create_dir_all(parent).map_err(io)?;
        let mut temporary = tempfile::NamedTempFile::new_in(parent).map_err(io)?;
        serde_json::to_writer(&mut temporary, &self.state).map_err(io)?;
        temporary.flush().map_err(io)?;
        if temporary.as_file().metadata().map_err(io)?.len() > 32 * 1024 * 1024 {
            return Err(Error::Validation("目录迁移清单过大，未改变当前目录"));
        }
        temporary.as_file().sync_all().map_err(io)?;
        temporary.persist(&self.locator).map_err(|e| io(e.error))?;
        Ok(())
    }

    fn validate_state(&self) -> Result<(), Error> {
        for p in [
            &self.state.active.data,
            &self.state.active.logs,
            &self.state.active.webview,
        ] {
            check_path(p)?;
        }
        if let Some(job) = &self.state.migration {
            if job.target != Locations::unified(job.target.data.clone()) {
                return Err(Error::Validation("迁移目标布局无效"));
            }
            for p in [
                &job.source.data,
                &job.source.logs,
                &job.source.webview,
                &job.target.data,
            ] {
                check_path(p)?;
            }
            for source in [&job.source.data, &job.source.logs, &job.source.webview] {
                if within(&job.target.data, source) || within(source, &job.target.data) {
                    return Err(Error::Validation("迁移状态中新旧目录存在嵌套"));
                }
            }
            let mut seen = BTreeSet::new();
            for entry in &job.files {
                if self.relative(&job.source, &entry.source)? != entry.relative {
                    return Err(Error::Validation("迁移清单路径无效"));
                }
                if !seen.insert(key(&entry.source)) || key(&entry.source) == key(&self.locator) {
                    return Err(Error::Validation("迁移清单包含重复或受保护文件"));
                }
            }
        }
        Ok(())
    }

    fn target(&self, path: &Path) -> Result<PathBuf, Error> {
        if self.state.migration.is_some() {
            return Err(Error::Validation(
                "上一次迁移尚未完成，请先重启或处理清理提示",
            ));
        }
        if path
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
        {
            return Err(Error::Validation("目录路径不能包含 .."));
        }
        let target = normalized(path)?;
        if key(&target) == key(&normalized(&self.state.active.data)?) {
            return Ok(target);
        }
        for source in [
            &self.state.active.data,
            &self.state.active.logs,
            &self.state.active.webview,
        ] {
            let source = normalized(source)?;
            if within(&target, &source) || within(&source, &target) {
                return Err(Error::Validation("新旧存储目录不能相互包含"));
            }
        }
        if within(&self.locator, &target)
            && key(self
                .locator
                .parent()
                .ok_or(Error::Validation("目录配置无效"))?)
                != key(&target)
        {
            return Err(Error::Validation("目标不能包含系统目录定位文件的父目录"));
        }
        if target.parent().is_none() || target.file_name().is_none() {
            return Err(Error::Validation(
                "请选择应用专用子目录，不能使用磁盘根目录",
            ));
        }
        if target.try_exists().map_err(io)? {
            if !target.is_dir() {
                return Err(Error::Validation("目标必须是目录"));
            }
            for item in fs::read_dir(&target).map_err(io)? {
                let item = item.map_err(io)?;
                if key(&item.path()) != key(&self.locator) {
                    return Err(Error::Validation(
                        "目标目录必须为空，不会覆盖或合并已有数据",
                    ));
                }
            }
        }
        Ok(target)
    }

    fn relative(&self, paths: &Locations, source: &Path) -> Result<PathBuf, Error> {
        if key(source) == key(&paths.data) {
            return Ok(PathBuf::new());
        }
        let (root, prefix) = if within(source, &paths.logs) {
            (&paths.logs, "logs")
        } else if within(source, &paths.webview)
            && (key(&paths.webview) != key(&paths.data)
                || !source
                    .strip_prefix(&paths.data)
                    .map_err(io)?
                    .starts_with("plugins")
                    && source
                        .file_name()
                        .is_some_and(|n| !n.to_string_lossy().starts_with("serverdeck.sqlite3")))
        {
            (&paths.webview, "webview")
        } else if within(source, &paths.data) {
            (&paths.data, "")
        } else {
            return Err(Error::Validation("迁移文件超出应用目录"));
        };
        let relative = source.strip_prefix(root).map_err(io)?;
        if relative
            .components()
            .any(|c| !matches!(c, std::path::Component::Normal(_)))
        {
            return Err(Error::Validation("迁移文件路径无效"));
        }
        Ok(PathBuf::from(prefix).join(relative))
    }

    fn inventory(&self, paths: &Locations, digest: bool) -> Result<Vec<Entry>, Error> {
        let mut files = BTreeMap::new();
        let mut visited = BTreeSet::new();
        let mut pending = vec![
            paths.data.clone(),
            paths.logs.clone(),
            paths.webview.clone(),
        ];
        while let Some(path) = pending.pop() {
            check_path(&path)?;
            if !visited.insert(key(&path)) || !path.try_exists().map_err(io)? {
                continue;
            }
            if key(&path) == key(&self.locator) {
                continue;
            }
            let metadata = fs::symlink_metadata(&path).map_err(io)?;
            if metadata.is_dir() {
                let relative = self.relative(paths, &path)?;
                if files
                    .insert(
                        key(&relative),
                        Entry {
                            source: path.clone(),
                            relative,
                            bytes: 0,
                            digest: String::new(),
                            directory: true,
                        },
                    )
                    .is_some()
                {
                    return Err(Error::Validation("迁移目录存在同名冲突"));
                }
                for entry in fs::read_dir(&path).map_err(io)? {
                    pending.push(entry.map_err(io)?.path());
                }
            } else if metadata.is_file() {
                let relative = self.relative(paths, &path)?;
                let (bytes, digest) = if digest {
                    hash(&path)?
                } else {
                    (metadata.len(), String::new())
                };
                if files
                    .insert(
                        key(&relative),
                        Entry {
                            source: path,
                            relative,
                            bytes,
                            digest,
                            directory: false,
                        },
                    )
                    .is_some()
                {
                    return Err(Error::Validation("迁移目录存在同名冲突"));
                }
            } else {
                return Err(Error::Validation("迁移仅支持普通文件和目录"));
            }
        }
        Ok(files.into_values().collect())
    }

    pub fn preview(&self, path: &Path) -> Result<StoragePreview, Error> {
        let target = self.target(path)?;
        let files = self.inventory(&self.state.active, false)?;
        let bytes = files.iter().try_fold(0u64, |total, e| {
            total
                .checked_add(e.bytes)
                .ok_or(Error::Validation("迁移数据过大"))
        })?;
        let mut ancestor = target.as_path();
        while !ancestor.try_exists().map_err(io)? {
            ancestor = ancestor.parent().ok_or(Error::Validation("目标目录无效"))?;
        }
        let available_bytes = fs2::available_space(ancestor).map_err(io)?;
        // Check write access without creating the requested target directory.
        let probe = tempfile::Builder::new()
            .prefix(".serverdeck-write-check-")
            .tempfile_in(ancestor)
            .map_err(io)?;
        probe.close().map_err(io)?;
        ensure_capacity(bytes, available_bytes)?;
        Ok(StoragePreview {
            target_directory: target.to_string_lossy().into_owned(),
            bytes,
            available_bytes,
            unfinished_tasks: 0,
            dirty_documents: 0,
        })
    }

    pub fn prepare(&mut self, path: &Path) -> Result<bool, Error> {
        let preview = self.preview(path)?;
        let target = PathBuf::from(preview.target_directory);
        if key(&target) == key(&normalized(&self.state.active.data)?) {
            return Ok(false);
        }
        let previous = self.state.clone();
        self.state.migration = Some(Migration {
            id: uuid::Uuid::new_v4(),
            source: self.state.active.clone(),
            target: Locations::unified(target),
            phase: Phase::Pending,
            files: Vec::new(),
        });
        self.state.notice = None;
        if let Err(error) = self.persist() {
            self.state = previous;
            return Err(error);
        }
        Ok(true)
    }

    fn staging(job: &Migration) -> Result<PathBuf, Error> {
        Ok(job
            .target
            .data
            .parent()
            .ok_or(Error::Validation("目标路径无效"))?
            .join(format!(".serverdeck-migration-{}", job.id)))
    }

    fn copy_pending(&mut self, mut job: Migration) -> Result<(), Error> {
        let staging = Self::staging(&job)?;
        check_path(&staging)?;
        // Recheck destination after the old process exits, before any overwrite is possible.
        let pending = self.state.migration.take();
        let preview = self.preview(&job.target.data);
        self.state.migration = pending;
        preview?;
        let files = self.inventory(&job.source, true)?;
        if !job.files.is_empty()
            && serde_json::to_vec(&files).map_err(io)?
                != serde_json::to_vec(&job.files).map_err(io)?
        {
            return Err(Error::Validation("中断后旧数据已变化，迁移暂存副本已保留"));
        }
        job.files = files;
        self.state.migration = Some(job.clone());
        self.persist()?;
        fs::create_dir_all(&staging).map_err(io)?;
        let staged = self.inventory(&Locations::unified(staging.clone()), true)?;
        for entry in staged {
            if !job.files.iter().any(|expected| {
                expected.relative == entry.relative
                    && expected.bytes == entry.bytes
                    && expected.digest == entry.digest
            }) {
                return Err(Error::Validation("迁移暂存文件校验失败，已保留旧数据"));
            }
        }
        for entry in &job.files {
            let destination = staging.join(&entry.relative);
            if entry.directory {
                fs::create_dir_all(&destination).map_err(io)?;
                continue;
            }
            if let Some(parent) = destination.parent() {
                fs::create_dir_all(parent).map_err(io)?;
            }
            check_path(&destination)?;
            if destination.try_exists().map_err(io)? {
                continue;
            }
            let mut input = File::open(&entry.source).map_err(io)?;
            let mut output = File::options()
                .write(true)
                .create_new(true)
                .open(&destination)
                .map_err(io)?;
            std::io::copy(&mut input, &mut output).map_err(io)?;
            output.sync_all().map_err(io)?;
            if hash(&destination)? != (entry.bytes, entry.digest.clone()) {
                return Err(Error::Validation("迁移文件校验失败"));
            }
        }
        serverdeck_storage::Database::verify_file(&staging.join("serverdeck.sqlite3"))?;
        // Persist the complete manifest before exposing the copied tree.
        job.phase = Phase::Copied;
        self.state.migration = Some(job.clone());
        self.persist()?;
        if key(&job.target.data.join(LOCATOR)) == key(&self.locator)
            && self.locator.try_exists().map_err(io)?
        {
            // Returning to the default location: retain its locator throughout publication.
            // Existing directories/files are never merged or overwritten.
            for entry in fs::read_dir(&staging).map_err(io)? {
                let entry = entry.map_err(io)?;
                let destination = job.target.data.join(entry.file_name());
                check_path(&destination)?;
                if destination.try_exists().map_err(io)? {
                    return Err(Error::Validation("目标目录在迁移期间发生变化"));
                }
                if entry.file_type().map_err(io)?.is_dir() {
                    fs::rename(entry.path(), destination).map_err(io)?;
                } else {
                    let temporary = tempfile::TempPath::try_from_path(entry.path()).map_err(io)?;
                    if let Err(error) = temporary.persist_noclobber(destination) {
                        let source = error.error;
                        error.path.keep().map_err(io)?;
                        return Err(io(source));
                    }
                }
            }
            fs::remove_dir(&staging).map_err(io)?;
        } else {
            if job.target.data.try_exists().map_err(io)? {
                // Only an empty target may be removed. A concurrently created file makes this fail.
                fs::remove_dir(&job.target.data).map_err(io)?;
            }
            fs::rename(&staging, &job.target.data).map_err(io)?;
        }
        self.state.active = job.target;
        self.state.notice = Some("数据已迁入新目录；启动确认完成后自动清理旧副本。".into());
        self.persist()
    }

    /// Called only after Rust initialization and the main UI bootstrap both succeed.
    pub fn ready(&mut self) -> Result<StorageInfo, Error> {
        let Some(mut job) = self.state.migration.clone() else {
            return Ok(self.info());
        };
        if job.phase == Phase::Pending {
            return Err(Error::Busy);
        }
        if job.phase == Phase::Copied {
            let previous = self.state.clone();
            job.phase = Phase::Committed;
            self.state.migration = Some(job.clone());
            if let Err(error) = self.persist() {
                self.state = previous;
                return Err(error);
            }
            // Once committed, never roll back to a partially cleaned source.
        }
        match self.cleanup(&job) {
            Ok(()) => {
                self.state.migration = None;
                self.state.notice = Some("数据迁移完成，旧副本已清理。".into());
            }
            Err(error) => {
                tracing::warn!(operation="storage_cleanup", error=%error, "source cleanup pending");
                self.state.notice = Some(format!(
                    "新目录已启用，旧副本清理未完成：{error}。下次启动重试。"
                ));
            }
        }
        self.persist()?;
        Ok(self.info())
    }

    fn cleanup(&self, job: &Migration) -> Result<(), Error> {
        let mut directories = BTreeSet::new();
        for entry in &job.files {
            if self.relative(&job.source, &entry.source)? != entry.relative {
                return Err(Error::Validation("旧文件清单无效"));
            }
            check_path(&entry.source)?;
            if entry.directory {
                directories.insert(entry.source.clone());
                continue;
            }
            if !entry.source.try_exists().map_err(io)? {
                continue;
            }
            if hash(&entry.source)? != (entry.bytes, entry.digest.clone()) {
                return Err(Error::Validation("旧目录文件已变化，已保留该文件"));
            }
            fs::remove_file(&entry.source).map_err(io)?;
            let mut parent = entry.source.parent();
            while let Some(path) = parent {
                if ![&job.source.data, &job.source.logs, &job.source.webview]
                    .iter()
                    .any(|root| within(path, root))
                {
                    break;
                }
                directories.insert(path.to_owned());
                parent = path.parent();
            }
        }
        let mut directories: Vec<_> = directories.into_iter().collect();
        directories.sort_by_key(|p| std::cmp::Reverse(p.components().count()));
        for directory in directories {
            check_path(&directory)?;
            match fs::remove_dir(&directory) {
                Ok(()) => (),
                Err(e)
                    if matches!(
                        e.kind(),
                        std::io::ErrorKind::NotFound | std::io::ErrorKind::DirectoryNotEmpty
                    ) => {}
                Err(e) => return Err(io(e)),
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests;
