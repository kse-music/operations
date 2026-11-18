use super::*;
use serde::{Deserialize, Serialize};
use std::{fs::File, io::Write};
use tokio::io::{AsyncSeekExt, BufReader};

#[derive(Clone)]
pub(crate) struct Store(PathBuf);

// Only the basename of a local record is derived from the connection/target.
// Remote paths are always constructed under the canonical destination.
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    version: u8,
    id: Uuid,
    uid: u32,
    stamp: String,
}

pub(super) struct Checkpoint {
    record: Record,
    path: PathBuf,
    _lock: File,
    directory: String,
    pub(super) partial: String,
}

async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, Error> + Send + 'static,
) -> Result<T, Error> {
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| Error::Worker(Box::new(e)))?
}

fn lock(file: &File) -> Result<(), Error> {
    file.try_lock().map_err(|e| match e {
        std::fs::TryLockError::WouldBlock => Error::Busy,
        std::fs::TryLockError::Error(e) => local::io(e),
    })
}

fn directory(parent: &str, id: Uuid) -> Result<String, Error> {
    remote_join(
        parent,
        &format!(".serverdeck-{:x}.upload", Sha256::digest(id.as_bytes())),
    )
}

impl Store {
    pub(crate) fn new(directory: PathBuf) -> Self {
        Self(directory)
    }
    pub(super) async fn prepare(
        &self,
        task: &Task,
        remote: &Remote,
        target: &str,
        source: &Path,
        before: &std::fs::Metadata,
        expected: Option<&FileAttributes>,
    ) -> Result<Option<(Checkpoint, Option<FileAttributes>)>, Error> {
        let parent = remote_parent(target).ok_or(Error::Conflict)?;
        let key = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&(&remote.file_identity, target)).map_err(encoding)?)
        );
        let stamp = format!(
            "{:x}",
            Sha256::digest(
                serde_json::to_vec(&(
                    local::text(source)?,
                    before.len(),
                    before.modified().map_err(local::io)?,
                    expected.map(|a| (a.size, a.mtime, a.permissions, a.uid, a.gid))
                ))
                .map_err(encoding)?
            )
        );
        let root = self.0.clone();
        let path = self.0.join(format!("{key}.json"));
        let read_path = path.clone();
        let previous = blocking(move || {
            std::fs::DirBuilder::new()
                .recursive(true)
                .create(&root)
                .map_err(local::io)?;
            let meta = std::fs::symlink_metadata(&root).map_err(local::io)?;
            if local::link(&meta) || !meta.is_dir() {
                return Err(Error::Conflict);
            }
            let meta = match std::fs::symlink_metadata(&read_path) {
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
                result => result.map_err(local::io)?,
            };
            if local::link(&meta) || !meta.is_file() || meta.len() > 1024 {
                return Err(Error::Conflict);
            }
            let file = std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .open(read_path)
                .map_err(local::io)?;
            lock(&file)?;
            let record: Record =
                serde_json::from_reader(std::io::Read::take(&file, 1025)).map_err(encoding)?;
            if record.version != 1 {
                return Err(Error::Validation("不支持的上传恢复记录版本"));
            }
            Ok(Some((record, file)))
        })
        .await?;
        if let Some((record, file)) = previous {
            let old = Checkpoint::new(record, path.clone(), file, &parent)?;
            if old.directory_exists(remote).await? {
                if let Some(attrs) = remote.optional_attrs(&old.partial).await? {
                    old.check_file(remote, &attrs).await?;
                    let size = attrs.size.ok_or(Error::Conflict)?;
                    let compatible = old.record.stamp == stamp && size <= before.len();
                    if !compatible {
                        wait_for_restart(task, target, size).await?;
                    }
                    task.check_cancel()?;
                    if !same_optional(expected, remote.optional_attrs(target).await?.as_ref())
                        || !local::same(
                            before,
                            &tokio::fs::symlink_metadata(source)
                                .await
                                .map_err(local::io)?,
                        )
                    {
                        return Err(Error::Conflict);
                    }
                    old.verify(remote, &attrs).await?;
                    if compatible {
                        return Ok(Some((old, Some(attrs))));
                    }
                    task.check_cancel()?;
                    remote.raw.remove(&old.partial).await.map_err(remote::map)?;
                }
                old.remove_directory(remote).await?;
            }
            old.forget().await?;
        }
        task.check_cancel()?;
        if remote.canonical(&parent).await? != parent {
            return Err(Error::Conflict);
        }
        let id = Uuid::new_v4();
        let dir = directory(&parent, id)?;
        match remote.mkdir_with_permissions(&dir, 0o700).await {
            Ok(()) => (),
            Err(Error::Connection {
                code: "SFTP_PERMISSION" | "SFTP_UNSUPPORTED",
                ..
            }) => return Ok(None),
            Err(error) => return Err(error),
        }
        let create = async {
            let attrs = remote.attrs(&dir).await?;
            if remote.canonical(&dir).await? != dir
                || matches!(remote::kind(&attrs), EntryKind::Symlink | EntryKind::File)
            {
                return Err(Error::Conflict);
            }
            let Some(uid) = attrs.uid.filter(|_| {
                remote::kind(&attrs) == EntryKind::Directory
                    && attrs.permissions.is_some_and(|mode| mode & 0o077 == 0)
            }) else {
                return Ok(None);
            };
            let record = Record {
                version: 1,
                id,
                uid,
                stamp,
            };
            let dest = path.clone();
            let bytes = serde_json::to_vec(&record).map_err(encoding)?;
            let file = blocking(move || {
                let mut tmp =
                    tempfile::NamedTempFile::new_in(dest.parent().ok_or(Error::Conflict)?)
                        .map_err(local::io)?;
                tmp.write_all(&bytes)
                    .and_then(|()| tmp.as_file().sync_all())
                    .map_err(local::io)?;
                lock(tmp.as_file())?;
                tmp.persist_noclobber(dest).map_err(|e| local::io(e.error))
            })
            .await?;
            Ok(Some((Checkpoint::new(record, path, file, &parent)?, None)))
        }
        .await;
        if !matches!(create, Ok(Some(_)))
            && let Err(e) = async {
                if remote.canonical(&parent).await? != parent
                    || remote.canonical(&dir).await? != dir
                {
                    return Err(Error::Conflict);
                }
                remote
                    .raw
                    .rmdir(&dir)
                    .await
                    .map_err(remote::map)
                    .map(|_| ())
            }
            .await
        {
            tracing::warn!(operation="upload_resume_directory_cleanup", error=%e, "could not remove empty upload directory");
            locked(&task.info)?.recovery_paths.push(dir);
        }
        create
    }
}

fn encoding(e: serde_json::Error) -> Error {
    Error::Storage(Box::new(e))
}

impl Checkpoint {
    fn new(record: Record, path: PathBuf, file: File, parent: &str) -> Result<Self, Error> {
        let directory = directory(parent, record.id)?;
        let partial = remote_join(&directory, &format!("{}.part", record.id))?;
        Ok(Self {
            record,
            path,
            _lock: file,
            directory,
            partial,
        })
    }
    async fn directory_exists(&self, remote: &Remote) -> Result<bool, Error> {
        let parent = remote_parent(&self.directory).ok_or(Error::Conflict)?;
        if remote.canonical(&parent).await? != parent {
            return Err(Error::Conflict);
        }
        let Some(a) = remote.optional_attrs(&self.directory).await? else {
            return Ok(false);
        };
        if remote::kind(&a) != EntryKind::Directory
            || a.uid != Some(self.record.uid)
            || a.permissions.map(|p| p & 0o077) != Some(0)
            || remote.canonical(&self.directory).await? != self.directory
        {
            return Err(fail(
                "TRANSFER_RESUME_PATH",
                "暂存目录的路径、属主或权限已改变",
            ));
        }
        Ok(true)
    }
    pub(super) async fn verify_new_handle(
        &self,
        remote: &Remote,
        handle: &str,
    ) -> Result<(), Error> {
        let attrs = remote.raw.fstat(handle).await.map_err(remote::map)?.attrs;
        if attrs.uid != Some(self.record.uid) || attrs.size != Some(0) {
            return Err(Error::Conflict);
        }
        self.verify(remote, &attrs).await
    }
    async fn check_file(&self, remote: &Remote, a: &FileAttributes) -> Result<(), Error> {
        if remote::kind(a) != EntryKind::File
            || remote.canonical(&self.partial).await? != self.partial
        {
            return Err(fail("TRANSFER_RESUME_PATH", "上传暂存路径已改变，拒绝使用"));
        }
        Ok(())
    }
    pub(super) async fn verify(
        &self,
        remote: &Remote,
        expected: &FileAttributes,
    ) -> Result<(), Error> {
        if !self.directory_exists(remote).await? {
            return Err(Error::Conflict);
        }
        let attrs = remote.attrs(&self.partial).await?;
        self.check_file(remote, &attrs).await?;
        if !remote::same(&attrs, expected) {
            return Err(Error::Conflict);
        }
        Ok(())
    }
    async fn remove_directory(&self, remote: &Remote) -> Result<(), Error> {
        if self.directory_exists(remote).await? {
            remote
                .raw
                .rmdir(&self.directory)
                .await
                .map_err(remote::map)?;
        }
        Ok(())
    }
    async fn forget(self) -> Result<(), Error> {
        blocking(move || {
            let _guard = self._lock;
            std::fs::remove_file(self.path).map_err(local::io)
        })
        .await
    }
    pub(super) async fn committed(self, remote: &Remote, task: &Task) -> Result<(), Error> {
        let (path, cleanup) = match self.remove_directory(remote).await {
            Err(e) => (self.directory, Err(e)),
            Ok(()) => {
                let path = self.path.display().to_string();
                (path, self.forget().await)
            }
        };
        if let Err(error) = cleanup {
            tracing::warn!(operation="upload_resume_cleanup", %error, "file committed, recovery metadata cleanup failed");
            locked(&task.info)?.recovery_paths.push(path);
        }
        Ok(())
    }
}

async fn wait_for_restart(task: &Task, target: &str, partial_bytes: u64) -> Result<(), Error> {
    let (send, receive) = tokio::sync::oneshot::channel();
    {
        let mut info = locked(&task.info)?;
        task.check_cancel()?;
        *locked(&task.restart_confirmation)? = Some(send);
        info.state = "awaitingRestart".into();
        info.restart_prompt = Some(UploadRestartPrompt {
            token: Uuid::new_v4().to_string(),
            target: target.into(),
            partial_bytes,
        });
    }
    tokio::select! {
        result = receive => result.map_err(|_| Error::Conflict),
        _ = task.cancel.cancelled() => Err(fail("TRANSFER_CANCELLED", "已取消，保留上传断点")),
    }
}

// Inspect a bounded window in file order. A later successful write can extend the
// remote length past a missing block. Rewrite from the first unequal block.
pub(super) async fn prefix(
    task: &Task,
    remote: &Remote,
    handle: &str,
    size: u64,
    file: &mut BufReader<tokio::fs::File>,
    digest: &mut Sha256,
) -> Result<u64, Error> {
    let mut offset = 0u64;
    let mut local_bytes = vec![0; remote::IO_CHUNK];
    while offset < size {
        task.check_cancel()?;
        let mut reads = Vec::new();
        let mut next = offset;
        while next < size && reads.len() < remote::IO_WINDOW {
            let len = (size - next).min(remote::IO_CHUNK as u64) as usize;
            reads.push(remote.read_range(handle, next, len, Some(&task.cancel)));
            next += len as u64;
        }
        let data = futures_util::future::join_all(reads)
            .await
            .into_iter()
            .collect::<Result<Vec<_>, _>>()?;
        task.check_cancel()?;
        let start = offset;
        for block in data {
            file.read_exact(&mut local_bytes[..block.len()])
                .await
                .map_err(local::io)?;
            if local_bytes[..block.len()] != block {
                file.seek(std::io::SeekFrom::Start(offset))
                    .await
                    .map_err(local::io)?;
                locked(&task.info)?.resumed_bytes += offset - start;
                return Ok(offset);
            }
            digest.update(&block);
            offset += block.len() as u64;
        }
        locked(&task.info)?.resumed_bytes += offset - start;
    }
    Ok(offset)
}
