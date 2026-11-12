//! One-file copies with frozen source/target snapshots, using the existing queue and SFTP commits.
use super::*;
use std::{future::Future, pin::Pin};

#[derive(Clone, Debug)]
pub enum CopySource {
    Local { path: String },
    Remote { session: String, path: String },
}
#[derive(Clone)]
enum Snapshot {
    Local(std::fs::Metadata),
    Remote(FileAttributes),
}
#[derive(Clone)]
pub struct PreparedCopy {
    pub source: CopySource,
    pub destination: String,
    pub bytes: u64,
    pub overwrite: bool,
    pub target_exists: bool,
    local_destination: Option<PathBuf>,
    session: String,
    source_before: Snapshot,
    target_before: Option<FileAttributes>,
    pub(super) attempted_commit: Arc<AtomicBool>,
    pub(super) checksum: Arc<Mutex<Option<String>>>,
}
impl PreparedCopy {
    pub(super) fn source_session(&self) -> Option<&str> {
        match &self.source {
            CopySource::Remote { session, .. } => Some(session),
            _ => None,
        }
    }
    pub fn may_have_committed(&self) -> bool {
        self.attempted_commit.load(Ordering::Acquire)
    }
    pub fn sha256(&self) -> Result<Option<String>, Error> {
        Ok(locked(&self.checksum)?.clone())
    }
}
pub trait CopyGuard: Send + Sync {
    fn check(&self) -> Pin<Box<dyn Future<Output = Result<(), Error>> + Send + '_>>;
}
#[derive(Clone)]
pub struct CopyHandle {
    task: Arc<Task>,
}
impl CopyHandle {
    pub fn info(&self) -> Result<TransferInfo, Error> {
        self.task.snapshot()
    }
    pub fn cancel(&self) -> Result<(), Error> {
        self.task.cancel()
    }
    pub async fn cancel_and_wait(&self) -> Result<(), Error> {
        self.cancel()?;
        tokio::time::timeout(std::time::Duration::from_secs(35), async {
            loop {
                let notified = self.task.done.notified();
                if !self.info()?.unfinished() {
                    return Ok::<_, Error>(());
                }
                notified.await;
            }
        })
        .await
        .map_err(|_| {
            fail(
                "TRANSFER_SHUTDOWN_TIMEOUT",
                "传输仍在安全收尾，请等待后重试关闭",
            )
        })?
    }
}
pub(super) struct Job {
    pub plan: PreparedCopy,
    pub(super) guard: Mutex<Option<Arc<dyn CopyGuard>>>,
}
impl Job {
    pub(super) fn release(&self) {
        match self.guard.lock() {
            Ok(mut guard) => {
                guard.take();
            }
            Err(_) => tracing::error!(
                operation = "copy_guard_release",
                "copy authorization lock poisoned"
            ),
        }
    }
}

async fn local_file(path: &str) -> Result<(PathBuf, std::fs::Metadata), Error> {
    valid_path(path)?;
    let path = PathBuf::from(path);
    if !path.is_absolute()
        || path.components().any(|p| {
            matches!(
                p,
                std::path::Component::ParentDir | std::path::Component::CurDir
            )
        })
    {
        return Err(Error::Validation("本机源文件须为不含 . 或 .. 的绝对路径"));
    }
    for ancestor in path.ancestors() {
        if local::link(
            &tokio::fs::symlink_metadata(ancestor)
                .await
                .map_err(local::io)?,
        ) {
            return Err(fail("TRANSFER_LINK", "本机路径不能包含符号链接或重解析点"));
        }
    }
    let meta = tokio::fs::symlink_metadata(&path)
        .await
        .map_err(local::io)?;
    if !meta.is_file() {
        return Err(Error::Validation("本阶段仅传输单个普通文件"));
    }
    let path = tokio::fs::canonicalize(path).await.map_err(local::io)?;
    Ok((path, meta))
}

impl Transfers {
    pub async fn prepare_copy(
        &self,
        source: CopySource,
        session: &str,
        directory: &str,
        overwrite: bool,
    ) -> Result<PreparedCopy, Error> {
        remote_absolute(directory)?;
        let trimmed = directory.trim_end_matches('/');
        let directory = if trimmed.is_empty() { "/" } else { trimmed };
        let target = Remote::connect(&self.engine, session).await?;
        if target.canonical(directory).await? != directory
            || remote::kind(&target.attrs(directory).await?) != EntryKind::Directory
        {
            return Err(Error::Validation("目标须为无链接的规范绝对目录"));
        }
        let (source, source_before, bytes, name) = match source {
            CopySource::Local { path } => {
                let (path, meta) = local_file(&path).await?;
                let name = path
                    .file_name()
                    .and_then(|v| v.to_str())
                    .ok_or(Error::Validation("源文件名不是 Unicode"))?
                    .to_owned();
                local::validate_name(&name)?;
                let bytes = meta.len();
                (
                    CopySource::Local {
                        path: local::text(&path)?,
                    },
                    Snapshot::Local(meta),
                    bytes,
                    name,
                )
            }
            CopySource::Remote { session: src, path } => {
                remote_absolute(&path)?;
                let remote = Remote::connect(&self.engine, &src).await?;
                let attrs = remote.attrs(&path).await?;
                if remote.canonical(&path).await? != path || remote::kind(&attrs) != EntryKind::File
                {
                    return Err(Error::Validation("远程源须为无链接的普通文件"));
                }
                let bytes = attrs
                    .size
                    .ok_or_else(|| fail("SFTP_ATTRIBUTES", "源文件大小未知"))?;
                let name = path
                    .rsplit('/')
                    .next()
                    .ok_or(Error::Validation("源文件名无效"))?
                    .to_owned();
                local::validate_name(&name)?;
                (
                    CopySource::Remote { session: src, path },
                    Snapshot::Remote(attrs),
                    bytes,
                    name,
                )
            }
        };
        let destination = remote_join(directory, &name)?;
        if matches!(&source,CopySource::Remote {session:src,path} if src == session && path == &destination)
        {
            return Err(Error::Validation("源文件与目标相同"));
        }
        let expected = target.optional_attrs(&destination).await?;
        if let Some(attrs) = &expected {
            if remote::kind(attrs) != EntryKind::File {
                return Err(Error::Validation("不能覆盖目录、链接或特殊文件"));
            }
            if !overwrite {
                return Err(fail(
                    "FILE_CONFLICT",
                    "目标已存在，须重新准备并明确选择覆盖",
                ));
            }
            if !target.atomic {
                return Err(fail("SFTP_ATOMIC_UNSUPPORTED", "目标不支持原子覆盖"));
            }
            target.writable(&destination).await?;
        }
        Ok(PreparedCopy {
            source,
            destination,
            bytes,
            overwrite,
            target_exists: expected.is_some(),
            local_destination: None,
            session: session.into(),
            source_before,
            target_before: expected,
            attempted_commit: Arc::default(),
            checksum: Arc::default(),
        })
    }
    pub async fn prepare_download_copy(
        &self,
        session: &str,
        source: &str,
        destination: &str,
    ) -> Result<PreparedCopy, Error> {
        remote_absolute(source)?;
        valid_path(destination)?;
        let target = PathBuf::from(destination);
        if !target.is_absolute()
            || target.components().any(|p| {
                matches!(
                    p,
                    std::path::Component::CurDir | std::path::Component::ParentDir
                )
            })
        {
            return Err(Error::Validation("本机下载目标须为规范绝对文件路径"));
        }
        local::validate_name(
            target
                .file_name()
                .and_then(|name| name.to_str())
                .ok_or(Error::Validation("下载文件名无效"))?,
        )?;
        let parent = target
            .parent()
            .ok_or(Error::Validation("下载目标无父目录"))?;
        ensure_local_parent(parent).await?;
        match tokio::fs::symlink_metadata(&target).await {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
            Err(error) => return Err(local::io(error)),
            Ok(_) => {
                return Err(fail(
                    "FILE_CONFLICT",
                    "本机下载目标已存在，请选择其他文件名",
                ));
            }
        }
        let remote = Remote::connect(&self.engine, session).await?;
        let attrs = remote.attrs(source).await?;
        if remote.canonical(source).await? != source || remote::kind(&attrs) != EntryKind::File {
            return Err(Error::Validation("下载源须为无链接的普通文件"));
        }
        let bytes = attrs
            .size
            .ok_or_else(|| fail("SFTP_ATTRIBUTES", "源文件大小未知"))?;
        Ok(PreparedCopy {
            source: CopySource::Remote {
                session: session.into(),
                path: source.into(),
            },
            destination: local::text(&target)?,
            bytes,
            overwrite: false,
            target_exists: false,
            local_destination: Some(target),
            session: session.into(),
            source_before: Snapshot::Remote(attrs),
            target_before: None,
            attempted_commit: Arc::default(),
            checksum: Arc::default(),
        })
    }
    pub fn start_copy(
        &self,
        plan: PreparedCopy,
        guard: Arc<dyn CopyGuard>,
    ) -> Result<CopyHandle, Error> {
        let source = match &plan.source {
            CopySource::Local { path } | CopySource::Remote { path, .. } => path.clone(),
        };
        let input = TransferInput {
            session_id: plan.session.clone(),
            direction: if plan.local_destination.is_some() {
                Direction::Download
            } else {
                Direction::Upload
            },
            sources: vec![source],
            destination: match &plan.local_destination {
                Some(path) => local::text(path.parent().ok_or(Error::Validation("目标无父目录"))?)?,
                None => {
                    remote_parent(&plan.destination).ok_or(Error::Validation("目标无父目录"))?
                }
            },
            conflict: if plan.overwrite {
                ConflictPolicy::Overwrite
            } else {
                ConflictPolicy::Fail
            },
            confirm_overwrite: plan.overwrite,
        };
        self.enqueue(
            input,
            false,
            Some(Job {
                plan,
                guard: Mutex::new(Some(guard)),
            }),
        )
        .map(|(_, task)| CopyHandle { task })
    }
}

enum Reader {
    Local(tokio::fs::File),
    Remote(Arc<Remote>, String),
}
impl Reader {
    async fn open(engine: &serverdeck_ssh::Engine, plan: &PreparedCopy) -> Result<Self, Error> {
        match (&plan.source, &plan.source_before) {
            (CopySource::Local { path }, Snapshot::Local(expected)) => {
                let (canonical, actual) = local_file(path).await?;
                if local::text(&canonical)? != *path || !local::same(expected, &actual) {
                    return Err(Error::Conflict);
                }
                let file = tokio::fs::File::open(canonical).await.map_err(local::io)?;
                if !local::same(expected, &file.metadata().await.map_err(local::io)?) {
                    return Err(Error::Conflict);
                }
                Ok(Self::Local(file))
            }
            (CopySource::Remote { session, path }, Snapshot::Remote(expected)) => {
                let remote = Remote::connect(engine, session).await?;
                if remote.canonical(path).await? != *path
                    || !remote::same(expected, &remote.attrs(path).await?)
                {
                    return Err(Error::Conflict);
                }
                let handle = remote
                    .raw
                    .open(path, OpenFlags::READ, FileAttributes::default())
                    .await
                    .map_err(remote::map)?
                    .handle;
                Ok(Self::Remote(remote, handle))
            }
            _ => Err(Error::Validation("源快照不匹配")),
        }
    }
    async fn read(&mut self, offset: u64, buffer: &mut [u8]) -> Result<usize, Error> {
        match self {
            Self::Local(file) => file.read(buffer).await.map_err(local::io),
            Self::Remote(remote, handle) => match remote
                .raw
                .read(handle.as_str(), offset, buffer.len() as u32)
                .await
            {
                Ok(data) if data.data.len() <= buffer.len() => {
                    buffer[..data.data.len()].copy_from_slice(&data.data);
                    Ok(data.data.len())
                }
                Ok(_) => Err(fail("SFTP_FORMAT", "源返回的数据块超过请求大小")),
                Err(russh_sftp::client::error::Error::Status(status))
                    if status.status_code == russh_sftp::protocol::StatusCode::Eof =>
                {
                    Ok(0)
                }
                Err(error) => Err(remote::map(error)),
            },
        }
    }
    async fn verify(&self, plan: &PreparedCopy) -> Result<(), Error> {
        let same = match (self, &plan.source, &plan.source_before) {
            (Self::Local(file), CopySource::Local { path }, Snapshot::Local(expected)) => {
                let (canonical, actual) = local_file(path).await?;
                local::text(&canonical)? == *path
                    && local::same(expected, &actual)
                    && local::same(expected, &file.metadata().await.map_err(local::io)?)
            }
            (
                Self::Remote(remote, _),
                CopySource::Remote { path, .. },
                Snapshot::Remote(expected),
            ) => {
                remote.canonical(path).await? == *path
                    && remote::same(expected, &remote.attrs(path).await?)
            }
            _ => false,
        };
        if same {
            Ok(())
        } else {
            Err(fail(
                "TRANSFER_SOURCE_CHANGED",
                "源文件在准备或传输后已变化，未提交目标",
            ))
        }
    }
}

pub(super) async fn run(
    engine: &serverdeck_ssh::Engine,
    mutations: &Mutations,
    task: &Task,
    target: &Remote,
    job: &Job,
) -> Result<(), Error> {
    let plan = &job.plan;
    let guard = locked(&job.guard)?
        .as_ref()
        .cloned()
        .ok_or_else(|| fail("TRANSFER_CANCELLED", "传输授权已释放"))?;
    guard.check().await?;
    if let Some(local) = &plan.local_destination {
        let (path, before) = match (&plan.source, &plan.source_before) {
            (CopySource::Remote { path, .. }, Snapshot::Remote(before)) => (path, before),
            _ => return Err(Error::Validation("下载源快照不匹配")),
        };
        if target.canonical(path).await? != *path
            || !remote::same(before, &target.attrs(path).await?)
        {
            return Err(Error::Conflict);
        }
        {
            let mut info = locked(&task.info)?;
            info.total_bytes = plan.bytes;
            info.files_total = 1;
            info.state = "running".into();
        }
        let host = engine.session_info(&plan.session)?.host_id;
        let mutation = locked(mutations)?.entry(host).or_default().clone();
        let operation = download(
            task,
            target,
            &mutation,
            Item {
                local: local.clone(),
                remote: path.clone(),
                source_link: None,
                directory: false,
                size: plan.bytes,
                attrs: Some(before.clone()),
            },
        );
        tokio::pin!(operation);
        loop {
            tokio::select! {
                result = &mut operation => return result,
                _ = tokio::time::sleep(std::time::Duration::from_millis(500)) => {
                    if let Err(error) = guard.check().await {
                        if task.committing.load(Ordering::Acquire) { operation.await?; }
                        return Err(error);
                    }
                }
            }
        }
    }
    let parent = remote_parent(&plan.destination).ok_or(Error::Validation("目标无父目录"))?;
    if target.canonical(&parent).await? != parent
        || !same_optional(
            plan.target_before.as_ref(),
            target.optional_attrs(&plan.destination).await?.as_ref(),
        )
    {
        return Err(Error::Conflict);
    }
    let mut source = Reader::open(engine, plan).await?;
    {
        let mut info = locked(&task.info)?;
        info.total_bytes = plan.bytes;
        info.files_total = 1;
        info.state = "running".into();
    }
    let temp = remote_join(&parent, &format!(".serverdeck-{}.part", Uuid::new_v4()))?;
    let handle = target.stage(&temp).await?;
    task.temp(true, temp.clone())?;
    let mut buffer = vec![0; 32768];
    let mut offset = 0u64;
    let mut digest = Sha256::new();
    let mut checked = Instant::now();
    loop {
        task.check_cancel()?;
        if checked.elapsed() >= std::time::Duration::from_millis(500) {
            guard.check().await?;
            checked = Instant::now();
        }
        let n = source.read(offset, &mut buffer).await?;
        if n == 0 {
            break;
        }
        if offset.saturating_add(n as u64) > plan.bytes {
            return Err(Error::Conflict);
        }
        target
            .raw
            .write(&handle, offset, buffer[..n].to_vec())
            .await
            .map_err(remote::map)?;
        digest.update(&buffer[..n]);
        offset += n as u64;
        task.bytes(n);
    }
    if offset != plan.bytes {
        return Err(Error::Conflict);
    }
    source.verify(plan).await?;
    if let Reader::Remote(remote, handle) = &source {
        remote
            .raw
            .close(handle.clone())
            .await
            .map_err(remote::map)?;
    }
    target.close_write(handle).await?;
    task.state("verifying");
    let checksum = format!("{:x}", digest.finalize());
    if checksum != target.hash(&temp).await? {
        return Err(fail("TRANSFER_HASH", "中转 SHA-256 校验失败，目标未替换"));
    }
    if let Some(attrs) = &plan.target_before {
        target.preserve(&temp, attrs).await?;
    }
    let host = engine.session_info(&plan.session)?.host_id;
    let mutation = locked(mutations)?.entry(host).or_default().clone();
    let _mutation = mutation.lock().await;
    source.verify(plan).await?;
    if target.canonical(&parent).await? != parent
        || !same_optional(
            plan.target_before.as_ref(),
            target.optional_attrs(&plan.destination).await?.as_ref(),
        )
    {
        return Err(Error::Conflict);
    }
    guard.check().await?;
    task.check_cancel()?;
    task.committing.store(true, Ordering::Release);
    plan.attempted_commit.store(true, Ordering::Release);
    target
        .replace(&temp, &plan.destination, plan.target_exists)
        .await?;
    task.clear_temp()?;
    task.finished();
    guard.check().await?;
    *locked(&plan.checksum)? = Some(checksum);
    task.committing.store(false, Ordering::Release);
    Ok(())
}
