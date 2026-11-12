use crate::remote::{self, Remote};
use crate::*;
use russh_sftp::protocol::{FileAttributes, OpenFlags};
use sha2::{Digest, Sha256};
use std::{
    collections::VecDeque,
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, AtomicU8, AtomicU64, Ordering},
    time::Instant,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    sync::Notify,
};
use uuid::Uuid;
mod copy;
pub use copy::{CopyGuard, CopyHandle, CopySource, PreparedCopy};

struct Task {
    input: TransferInput,
    copy: Option<copy::Job>,
    drag_export: bool,
    info: Mutex<TransferInfo>,
    cancel: CancellationToken,
    owner_closed: CancellationToken,
    started: Mutex<Option<Instant>>,
    skipped_bytes: AtomicU64,
    committing: AtomicBool,
    temporary: Mutex<Option<(bool, String)>>,
    done: Notify,
}
impl Task {
    fn cancel(&self) -> Result<(), Error> {
        let mut info = locked(&self.info)?;
        if !info.unfinished() {
            return Ok(());
        }
        self.cancel.cancel();
        if info.state == "queued" {
            info.state = "cancelled".into();
            info.message = Some("排队任务已取消".into());
            if let Some(job) = &self.copy {
                job.release();
            }
            self.done.notify_waiters();
        } else {
            info.state = "cancelling".into();
        }
        Ok(())
    }
    fn uses_session(&self, session: &str) -> bool {
        self.input.session_id == session
            || self
                .copy
                .as_ref()
                .is_some_and(|job| job.plan.source_session() == Some(session))
    }
    fn snapshot(&self) -> Result<TransferInfo, Error> {
        let mut info = locked(&self.info)?.clone();
        info.remaining_bytes = info
            .total_bytes
            .saturating_sub(info.transferred_bytes)
            .saturating_sub(self.skipped_bytes.load(Ordering::Relaxed));
        if info.unfinished()
            && let Some(started) = *locked(&self.started)?
        {
            let seconds = started.elapsed().as_secs_f64();
            if seconds > 0.0 {
                info.bytes_per_second = (info.transferred_bytes as f64 / seconds) as u64;
            }
        }
        Ok(info)
    }
    fn state(&self, value: &str) {
        if let Ok(mut info) = self.info.lock() {
            info.state = value.into();
        }
    }
    fn bytes(&self, n: usize) {
        if let Ok(mut info) = self.info.lock() {
            info.transferred_bytes = info.transferred_bytes.saturating_add(n as u64);
        }
    }
    fn skip(&self, bytes: u64) {
        self.skipped_bytes.fetch_add(bytes, Ordering::Relaxed);
        if let Ok(mut info) = self.info.lock() {
            info.skipped += 1;
        }
    }
    fn finished(&self) {
        if let Ok(mut info) = self.info.lock() {
            info.files_done += 1;
        }
    }
    fn temp(&self, remote: bool, path: String) -> Result<(), Error> {
        *locked(&self.temporary)? = Some((remote, path));
        Ok(())
    }
    fn clear_temp(&self) -> Result<(), Error> {
        locked(&self.temporary)?.take();
        Ok(())
    }
    fn check_cancel(&self) -> Result<(), Error> {
        if self.cancel.is_cancelled() {
            Err(fail("TRANSFER_CANCELLED", "任务已取消，已完成的文件保留"))
        } else if self.owner_closed.is_cancelled() {
            Err(fail(
                "SFTP_DISCONNECTED",
                "文件连接已关闭，请重新连接后从头重试",
            ))
        } else {
            Ok(())
        }
    }
}
struct Queue {
    tasks: VecDeque<Arc<Task>>,
    stopping: bool,
}
#[derive(Clone)]
pub struct Transfers {
    engine: serverdeck_ssh::Engine,
    queue: Arc<Mutex<Queue>>,
    concurrency: Arc<AtomicU8>,
    mutations: Mutations,
}
impl Transfers {
    pub(crate) fn new(
        engine: serverdeck_ssh::Engine,
        concurrency: u8,
        mutations: Mutations,
    ) -> Self {
        Self {
            engine,
            queue: Arc::new(Mutex::new(Queue {
                tasks: VecDeque::new(),
                stopping: false,
            })),
            concurrency: Arc::new(AtomicU8::new(concurrency.clamp(1, 6))),
            mutations,
        }
    }
    pub fn configure(&self, count: u8) {
        self.concurrency.store(count.clamp(1, 6), Ordering::Release);
        self.schedule();
    }
    pub fn start(&self, input: TransferInput) -> Result<TransferInfo, Error> {
        self.enqueue(input, false, None).map(|(info, _)| info)
    }
    fn enqueue(
        &self,
        input: TransferInput,
        drag_export: bool,
        copy: Option<copy::Job>,
    ) -> Result<(TransferInfo, Arc<Task>), Error> {
        input.validate()?;
        tokio::runtime::Handle::try_current()
            .map_err(|_| fail("TRANSFER_RUNTIME", "传输必须从异步工作线程提交"))?;
        let session = self.engine.session_info(&input.session_id)?;
        let owner_closed = self.engine.session_closed(&input.session_id)?;
        let info = TransferInfo {
            id: Uuid::new_v4().to_string(),
            host_id: session.host_id,
            session_id: input.session_id.clone(),
            direction: input.direction,
            state: "queued".into(),
            sources: input.sources.clone(),
            destination: input.destination.clone(),
            total_bytes: 0,
            transferred_bytes: 0,
            remaining_bytes: 0,
            bytes_per_second: 0,
            files_total: 0,
            files_done: 0,
            skipped: 0,
            message: None,
            recovery_paths: vec![],
        };
        let task = Arc::new(Task {
            input,
            copy,
            drag_export,
            info: Mutex::new(info.clone()),
            cancel: CancellationToken::new(),
            owner_closed,
            started: Mutex::new(None),
            skipped_bytes: AtomicU64::new(0),
            committing: AtomicBool::new(false),
            temporary: Mutex::new(None),
            done: Notify::new(),
        });
        {
            let mut queue = locked(&self.queue)?;
            if queue.stopping {
                return Err(Error::ShuttingDown);
            }
            if queue
                .tasks
                .iter()
                .filter(|t| t.snapshot().is_ok_and(|i| i.unfinished()))
                .count()
                >= 64
            {
                return Err(fail("TRANSFER_LIMIT", "最多 64 个排队或活动传输"));
            }
            while queue.tasks.len() >= 128 {
                if let Some(index) = queue
                    .tasks
                    .iter()
                    .position(|t| t.snapshot().is_ok_and(|i| !i.unfinished()))
                {
                    queue.tasks.remove(index);
                } else {
                    return Err(Error::Busy);
                }
            }
            queue.tasks.push_back(task.clone());
        }
        self.schedule();
        Ok((info, task))
    }
    pub async fn stage_drag_download(
        &self,
        session_id: String,
        sources: Vec<String>,
        destination: &Path,
    ) -> Result<(), serverdeck_core::IpcError> {
        let (_, task) = self.enqueue(
            TransferInput {
                session_id,
                direction: Direction::Download,
                sources,
                destination: local::text(destination)?,
                conflict: ConflictPolicy::Fail,
                confirm_overwrite: false,
            },
            true,
            None,
        )?;
        loop {
            let done = task.done.notified();
            let info = task.snapshot()?;
            if !info.unfinished() {
                return if info.state == "completed" {
                    Ok(())
                } else {
                    Err(serverdeck_core::IpcError {
                        code: "DRAG_DOWNLOAD_FAILED",
                        message: info.message.unwrap_or_else(|| "拖放下载未完成".into()),
                    })
                };
            }
            done.await;
        }
    }
    pub fn drag_download_names(
        session_id: &str,
        sources: Vec<String>,
    ) -> Result<Vec<String>, Error> {
        let input = TransferInput {
            session_id: session_id.into(),
            direction: Direction::Download,
            sources,
            destination: ".".into(),
            conflict: ConflictPolicy::Fail,
            confirm_overwrite: false,
        };
        input.validate()?;
        let mut names = std::collections::HashSet::new();
        input
            .sources
            .iter()
            .map(|source| {
                remote_absolute(source)?;
                let name = source.rsplit('/').next().unwrap_or_default();
                local::validate_name(name)?;
                if name.encode_utf16().count() >= 260 || !names.insert(name.to_lowercase()) {
                    return Err(Error::Validation(
                        "拖放文件名过长或在 Windows 下重名，请分开下载",
                    ));
                }
                Ok(name.to_owned())
            })
            .collect()
    }
    pub fn list(&self) -> Result<Vec<TransferInfo>, Error> {
        locked(&self.queue)?
            .tasks
            .iter()
            .filter_map(|task| match task.snapshot() {
                Ok(info) if task.drag_export && !info.unfinished() => None,
                result => Some(result),
            })
            .collect()
    }
    pub fn unfinished(&self) -> Result<usize, Error> {
        Ok(self.list()?.iter().filter(|i| i.unfinished()).count())
    }
    pub fn clear_host(&self, host_id: &str) -> Result<(), Error> {
        let mut queue = locked(&self.queue)?;
        let snapshots = queue
            .tasks
            .iter()
            .map(|task| task.snapshot())
            .collect::<Result<Vec<_>, _>>()?;
        if snapshots
            .iter()
            .any(|info| info.host_id == host_id && info.unfinished())
        {
            return Err(fail("TRANSFERS_ACTIVE", "请先取消并等待此主机的传输结束"));
        }
        let mut index = 0;
        queue.tasks.retain(|_| {
            let keep = snapshots[index].host_id != host_id;
            index += 1;
            keep
        });
        Ok(())
    }
    pub fn session_unfinished(&self, session: &str) -> Result<usize, Error> {
        let queue = locked(&self.queue)?;
        let mut count = 0;
        for task in &queue.tasks {
            if task.uses_session(session) && task.snapshot()?.unfinished() {
                count += 1;
            }
        }
        Ok(count)
    }
    pub fn cancel(&self, id: &str) -> Result<(), Error> {
        let queue = locked(&self.queue)?;
        let task = queue
            .tasks
            .iter()
            .find(|t| t.snapshot().is_ok_and(|i| i.id == id))
            .ok_or(Error::NotFound)?;
        task.cancel()
    }
    pub fn retry(
        &self,
        id: &str,
        session: &str,
        conflict: ConflictPolicy,
        confirmed: bool,
    ) -> Result<TransferInfo, Error> {
        let mut input = {
            let queue = locked(&self.queue)?;
            let task = queue
                .tasks
                .iter()
                .find(|t| t.snapshot().is_ok_and(|i| i.id == id))
                .ok_or(Error::NotFound)?;
            let info = task.snapshot()?;
            if task.copy.is_some() {
                return Err(Error::Validation(
                    "此任务须在原插件重新准备并确认，不能直接重试",
                ));
            }
            if task.drag_export
                || info.unfinished()
                || !["failed", "cancelled"].contains(&info.state.as_str())
            {
                return Err(Error::Validation("只能重试失败或取消的任务"));
            }
            if self.engine.session_info(session)?.host_id != info.host_id {
                return Err(Error::Validation("重试必须使用同一主机的新文件连接"));
            }
            task.input.clone()
        };
        input.session_id = session.into();
        input.conflict = conflict;
        input.confirm_overwrite = confirmed;
        self.start(input)
    }
    fn schedule(&self) {
        let mut selected = Vec::new();
        if let Ok(queue) = self.queue.lock() {
            if queue.stopping {
                return;
            }
            let mut active = HashMap::<String, usize>::new();
            let mut total = 0;
            for task in &queue.tasks {
                if let Ok(info) = task.snapshot()
                    && info.unfinished()
                    && info.state != "queued"
                {
                    *active.entry(info.host_id).or_default() += 1;
                    total += 1;
                }
            }
            for task in &queue.tasks {
                if let Ok(mut info) = task.info.lock() {
                    if info.state != "queued" {
                        continue;
                    }
                    if task.owner_closed.is_cancelled() {
                        info.state = "failed".into();
                        info.message = Some("文件连接已关闭，请重新连接后重试".into());
                        if let Some(job) = &task.copy {
                            job.release();
                        }
                        task.done.notify_waiters();
                        continue;
                    }
                    let count = active.entry(info.host_id.clone()).or_default();
                    if total < 12 && *count < usize::from(self.concurrency.load(Ordering::Acquire))
                    {
                        info.state = "scanning".into();
                        *count += 1;
                        total += 1;
                        selected.push(task.clone());
                    }
                }
            }
        }
        for task in selected {
            let manager = self.clone();
            tokio::spawn(async move {
                manager.run(task).await;
            });
        }
    }
    async fn run(&self, task: Arc<Task>) {
        if let Ok(mut started) = task.started.lock() {
            *started = Some(Instant::now());
        }
        let opened = tokio::select! {
            result=Remote::connect(&self.engine,&task.input.session_id)=>result,
            _=task.cancel.cancelled()=>Err(fail("TRANSFER_CANCELLED","任务已取消，未提交目标文件")),
            _=task.owner_closed.cancelled()=>Err(fail("SFTP_DISCONNECTED","文件连接已关闭")),
        };
        let mut cleanup_remote = None;
        let result = match opened {
            Ok(remote) => {
                cleanup_remote = Some(remote.clone());
                let operation = async {
                    if let Some(job) = &task.copy {
                        copy::run(&self.engine, &self.mutations, &task, &remote, job).await
                    } else {
                        self.copy_tree(&task, &remote).await
                    }
                };
                tokio::pin!(operation);
                tokio::select! {
                    result = &mut operation => result,
                    _ = task.cancel.cancelled() => { if task.copy.is_some() || task.committing.load(Ordering::Acquire) { operation.await } else { Err(fail("TRANSFER_CANCELLED", "任务已取消，已完成的文件保留")) } },
                    _ = remote.owner_closed.cancelled() => Err(fail("SFTP_DISCONNECTED", "文件连接已关闭，传输失败")),
                    _ = remote.transport_closed.cancelled() => Err(fail("SFTP_DISCONNECTED", "网络中断，传输失败；可重新连接后从头重试")),
                }
            }
            Err(error) => Err(error),
        };
        if let Some(job) = &task.copy {
            job.release();
        }
        let temporary = task.temporary.lock().ok().and_then(|mut t| t.take());
        let mut recovery = None;
        if let Some((remote_path, path)) = temporary {
            let cleaned = if remote_path {
                if let Some(remote) = &cleanup_remote {
                    match remote.raw.remove(&path).await {
                        Ok(_) => true,
                        Err(e) if remote::missing(&e) => true,
                        Err(_) => false,
                    }
                } else {
                    false
                }
            } else {
                match tokio::fs::remove_file(&path).await {
                    Ok(_) => true,
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => true,
                    Err(_) => false,
                }
            };
            if !cleaned {
                recovery = Some(path);
            }
        }
        let final_speed = task
            .snapshot()
            .map(|i| i.bytes_per_second)
            .unwrap_or_default();
        if let Ok(mut info) = task.info.lock() {
            info.bytes_per_second = final_speed;
            match result {
                Ok(()) => {
                    info.state = "completed".into();
                    info.message = Some(if info.files_total == 0 {
                        "目录传输完成，没有普通文件".into()
                    } else {
                        format!(
                            "传输完成，{} 个文件通过 SHA-256 校验，跳过 {} 个文件",
                            info.files_done, info.skipped
                        )
                    });
                }
                Err(error) => {
                    let error = serverdeck_core::IpcError::from(error);
                    info.state = if error.code == "TRANSFER_CANCELLED" {
                        "cancelled"
                    } else {
                        "failed"
                    }
                    .into();
                    info.message = Some(error.message);
                    tracing::warn!(
                        operation = "file_transfer",
                        code = error.code,
                        "file transfer ended without completion"
                    );
                }
            }
            if let Some(path) = recovery {
                info.recovery_paths.push(path);
                info.message = Some(format!(
                    "{}；临时文件清理失败，请查看恢复路径",
                    info.message.as_deref().unwrap_or_default()
                ));
            }
        }
        task.committing.store(false, Ordering::Release);
        task.done.notify_waiters();
        self.schedule();
    }
    pub async fn cancel_session(&self, session: &str) -> Result<(), Error> {
        let ids = {
            let queue = locked(&self.queue)?;
            queue
                .tasks
                .iter()
                .filter(|task| task.uses_session(session))
                .map(|task| task.snapshot())
                .collect::<Result<Vec<_>, _>>()?
                .into_iter()
                .filter(|info| info.unfinished())
                .map(|info| info.id)
                .collect::<Vec<_>>()
        };
        for id in ids {
            self.cancel(&id)?;
        }
        self.wait_session(Some(session)).await
    }
    async fn wait_session(&self, session: Option<&str>) -> Result<(), Error> {
        let tasks: Vec<_> = locked(&self.queue)?
            .tasks
            .iter()
            .filter(|t| {
                t.snapshot()
                    .is_ok_and(|i| i.unfinished() && session.is_none_or(|s| t.uses_session(s)))
            })
            .cloned()
            .collect();
        for task in tasks {
            tokio::time::timeout(std::time::Duration::from_secs(35), async {
                loop {
                    let done = task.done.notified();
                    if !task.snapshot()?.unfinished() {
                        return Ok::<_, Error>(());
                    }
                    done.await;
                }
            })
            .await
            .map_err(|_| {
                fail(
                    "TRANSFER_SHUTDOWN_TIMEOUT",
                    "传输清理超时，连接关闭后可能留下待清理临时文件",
                )
            })??;
        }
        Ok(())
    }
    pub async fn shutdown(&self) {
        let ids = if let Ok(mut queue) = self.queue.lock() {
            queue.stopping = true;
            queue
                .tasks
                .iter()
                .filter_map(|t| t.snapshot().ok().filter(|i| i.unfinished()).map(|i| i.id))
                .collect::<Vec<_>>()
        } else {
            vec![]
        };
        for id in ids {
            let _ = self.cancel(&id);
        }
        if self.wait_session(None).await.is_err() {
            tracing::warn!(
                operation = "transfer_shutdown",
                "transfer cleanup timed out"
            );
        }
    }
    async fn copy_tree(&self, task: &Task, remote: &Remote) -> Result<(), Error> {
        task.check_cancel()?;
        let items = plan(task, remote).await?;
        {
            let mut info = locked(&task.info)?;
            info.total_bytes = items
                .iter()
                .try_fold(0_u64, |n, i| n.checked_add(i.size))
                .ok_or(Error::Validation("传输总大小溢出"))?;
            info.files_total = items.iter().filter(|i| !i.directory).count();
        }
        let host = locked(&task.info)?.host_id.clone();
        let mutation = locked(&self.mutations)?.entry(host).or_default().clone();
        for item in items {
            task.check_cancel()?;
            task.state("running");
            if item.directory {
                let _mutation = mutation.lock().await;
                if task.input.direction == Direction::Upload {
                    match remote.optional_attrs(&item.remote).await? {
                        Some(attrs) if remote::kind(&attrs) == EntryKind::Directory => (),
                        Some(_) => return Err(Error::Conflict),
                        None => remote.mkdir(&item.remote).await?,
                    }
                    if remote.canonical(&item.remote).await? != item.remote {
                        return Err(fail("SFTP_PATH_CHANGED", "目标目录变为符号链接，已停止"));
                    }
                } else {
                    match tokio::fs::symlink_metadata(&item.local).await {
                        Ok(meta) if meta.is_dir() && !local::link(&meta) => (),
                        Ok(_) => return Err(Error::Conflict),
                        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                            tokio::fs::create_dir(&item.local)
                                .await
                                .map_err(local::io)?
                        }
                        Err(e) => return Err(local::io(e)),
                    }
                }
                continue;
            }
            if task.input.direction == Direction::Upload {
                upload(task, remote, &mutation, item).await?;
            } else {
                download(task, remote, &mutation, item).await?;
            }
        }
        Ok(())
    }
}
struct Item {
    local: PathBuf,
    remote: String,
    source_link: Option<String>,
    directory: bool,
    size: u64,
    attrs: Option<FileAttributes>,
}
fn push_plan(
    stack: &mut Vec<(PathBuf, String, usize)>,
    item: (PathBuf, String, usize),
    bytes: &mut usize,
) -> Result<(), Error> {
    *bytes += local::text(&item.0)?.len() + item.1.len();
    if *bytes > 8 * 1024 * 1024 {
        return Err(fail(
            "TRANSFER_TREE_LIMIT",
            "递归路径数据超过 8 MiB，请选择较小目录分批传输",
        ));
    }
    stack.push(item);
    Ok(())
}
async fn plan(task: &Task, remote: &Remote) -> Result<Vec<Item>, Error> {
    let mut result = Vec::new();
    let mut stack = Vec::new();
    let mut planned_bytes = 0usize;
    if task.input.direction == Direction::Upload {
        let destination = remote.canonical(&task.input.destination).await?;
        if remote::kind(&remote.attrs(&destination).await?) != EntryKind::Directory {
            return Err(Error::Validation("上传目标须为目录"));
        }
        for source in &task.input.sources {
            let source = PathBuf::from(source);
            let meta = tokio::fs::symlink_metadata(&source)
                .await
                .map_err(local::io)?;
            if local::link(&meta) {
                return Err(fail("TRANSFER_LINK", "传输不跟随本地符号链接或重解析点"));
            }
            let name = source
                .file_name()
                .and_then(|v| v.to_str())
                .ok_or(Error::Validation("不能传输本地卷根目录或非 Unicode 名称"))?;
            let target = remote_join(&destination, name)?;
            let source = tokio::fs::canonicalize(source).await.map_err(local::io)?;
            push_plan(&mut stack, (source, target, 0), &mut planned_bytes)?;
        }
    } else {
        let destination = tokio::fs::canonicalize(&task.input.destination)
            .await
            .map_err(local::io)?;
        if !tokio::fs::metadata(&destination)
            .await
            .map_err(local::io)?
            .is_dir()
        {
            return Err(Error::Validation("下载目标须为本地目录"));
        }
        for source in &task.input.sources {
            remote_absolute(source)?;
            let name = source.rsplit('/').next().unwrap_or_default();
            local::validate_name(name)?;
            push_plan(
                &mut stack,
                (destination.join(name), source.clone(), 0),
                &mut planned_bytes,
            )?;
        }
    }
    while let Some((local, path, depth)) = stack.pop() {
        task.check_cancel()?;
        if result.len() >= TREE_LIMIT || depth > 64 {
            return Err(fail(
                "TRANSFER_TREE_LIMIT",
                "递归传输超过 100000 项或 64 层",
            ));
        }
        if task.input.direction == Direction::Upload {
            let meta = tokio::fs::symlink_metadata(&local)
                .await
                .map_err(local::io)?;
            if local::link(&meta) || (!meta.is_file() && !meta.is_dir()) {
                return Err(fail("TRANSFER_LINK", "不传输符号链接、重解析点或特殊文件"));
            }
            if meta.is_dir() {
                let mut directory = tokio::fs::read_dir(&local).await.map_err(local::io)?;
                while let Some(entry) = directory.next_entry().await.map_err(local::io)? {
                    let name = entry
                        .file_name()
                        .into_string()
                        .map_err(|_| fail("LOCAL_ENCODING", "目录包含非 Unicode 名称"))?;
                    if stack.len() + result.len() >= TREE_LIMIT {
                        return Err(fail("TRANSFER_TREE_LIMIT", "传输项目过多"));
                    }
                    push_plan(
                        &mut stack,
                        (entry.path(), remote_join(&path, &name)?, depth + 1),
                        &mut planned_bytes,
                    )?;
                }
            }
            result.push(Item {
                local,
                remote: path,
                source_link: None,
                directory: meta.is_dir(),
                size: if meta.is_file() { meta.len() } else { 0 },
                attrs: None,
            });
        } else {
            let mut attrs = remote.attrs(&path).await?;
            let (path, source_link) = if depth == 0 && remote::kind(&attrs) == EntryKind::Symlink {
                let target = remote.canonical(&path).await?;
                attrs = remote.attrs(&target).await?;
                if remote::kind(&attrs) != EntryKind::File {
                    return Err(fail("TRANSFER_LINK", "只能下载指向普通文件的符号链接"));
                }
                (target, Some(path))
            } else {
                (path, None)
            };
            let kind = remote::kind(&attrs);
            if task.drag_export && kind != EntryKind::File {
                return Err(fail(
                    "TRANSFER_LINK",
                    "拖到 Windows 的项目须为普通文件或文件链接",
                ));
            }
            if !matches!(kind, EntryKind::File | EntryKind::Directory) {
                return Err(fail("TRANSFER_LINK", "不递归跟随远程链接或下载特殊文件"));
            }
            if kind == EntryKind::Directory {
                if remote.canonical(&path).await? != path {
                    return Err(fail("SFTP_PATH_CHANGED", "源目录包含链接或路径发生变化"));
                }
                for (name, _) in remote.entries(&path).await? {
                    local::validate_name(&name)?;
                    if stack.len() + result.len() >= TREE_LIMIT {
                        return Err(fail("TRANSFER_TREE_LIMIT", "传输项目过多"));
                    }
                    push_plan(
                        &mut stack,
                        (local.join(&name), remote_join(&path, &name)?, depth + 1),
                        &mut planned_bytes,
                    )?;
                }
            }
            let size = if kind == EntryKind::File {
                attrs
                    .size
                    .ok_or_else(|| fail("SFTP_ATTRIBUTES", "服务器未返回文件大小"))?
            } else {
                0
            };
            result.push(Item {
                local,
                remote: path,
                source_link,
                directory: kind == EntryKind::Directory,
                size,
                attrs: Some(attrs),
            });
        }
    }
    Ok(result)
}
async fn upload(
    task: &Task,
    remote: &Remote,
    mutation: &tokio::sync::Mutex<()>,
    item: Item,
) -> Result<(), Error> {
    let mut target = item.remote;
    let expected = {
        let _mutation = mutation.lock().await;
        let mut existing = remote.optional_attrs(&target).await?;
        if let Some(attrs) = &existing {
            if remote::kind(attrs) != EntryKind::File {
                return Err(fail(
                    "FILE_CONFLICT",
                    "目标不是普通文件，拒绝覆盖链接或目录",
                ));
            }
            match task.input.conflict {
                ConflictPolicy::Skip => {
                    task.skip(item.size);
                    return Ok(());
                }
                ConflictPolicy::Fail => return Err(Error::Conflict),
                ConflictPolicy::Rename => {
                    let original = target.clone();
                    for n in 1..=1000 {
                        target = format!("{original} ({n})");
                        if remote.optional_attrs(&target).await?.is_none() {
                            break;
                        }
                        if n == 1000 {
                            return Err(Error::Conflict);
                        }
                    }
                    existing = None;
                }
                ConflictPolicy::Overwrite => {
                    if !remote.atomic {
                        return Err(fail("SFTP_ATOMIC_UNSUPPORTED", "服务器不支持原子覆盖"));
                    }
                    remote.writable(&target).await?;
                }
            }
        }
        existing
    };
    let parent = remote_parent(&target).ok_or(Error::Validation("上传目标无父目录"))?;
    if remote.canonical(&parent).await? != parent {
        return Err(fail("SFTP_PATH_CHANGED", "上传目标父目录包含链接或已改变"));
    }
    let temp = remote_join(&parent, &format!(".serverdeck-{}.part", Uuid::new_v4()))?;
    let handle = remote.stage(&temp).await?;
    task.temp(true, temp.clone())?;
    let before = tokio::fs::symlink_metadata(&item.local)
        .await
        .map_err(local::io)?;
    if local::link(&before) || !before.is_file() || before.len() != item.size {
        return Err(Error::Conflict);
    }
    let mut file = tokio::fs::File::open(&item.local)
        .await
        .map_err(local::io)?;
    let mut digest = Sha256::new();
    let mut offset = 0;
    let mut buffer = vec![0; 32768];
    loop {
        task.check_cancel()?;
        let n = file.read(&mut buffer).await.map_err(local::io)?;
        if n == 0 {
            break;
        }
        if offset + n as u64 > item.size {
            return Err(Error::Conflict);
        }
        remote
            .raw
            .write(&handle, offset, buffer[..n].to_vec())
            .await
            .map_err(remote::map)?;
        digest.update(&buffer[..n]);
        offset += n as u64;
        task.bytes(n);
    }
    if offset != item.size || !local::same(&before, &file.metadata().await.map_err(local::io)?) {
        return Err(Error::Conflict);
    }
    remote.close_write(handle).await?;
    task.state("verifying");
    if format!("{:x}", digest.finalize()) != remote.hash(&temp).await? {
        return Err(fail("TRANSFER_HASH", "上传 SHA-256 校验失败，未替换目标"));
    }
    if let Some(attrs) = &expected {
        remote.preserve(&temp, attrs).await?;
    }
    task.check_cancel()?;
    let _mutation = mutation.lock().await;
    let actual = remote.optional_attrs(&target).await?;
    if !same_optional(expected.as_ref(), actual.as_ref())
        || remote.canonical(&parent).await? != parent
    {
        return Err(Error::Conflict);
    }
    task.committing.store(true, Ordering::Release);
    remote.replace(&temp, &target, expected.is_some()).await?;
    task.clear_temp()?;
    task.finished();
    task.committing.store(false, Ordering::Release);
    Ok(())
}
fn same_optional(a: Option<&FileAttributes>, b: Option<&FileAttributes>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(a), Some(b)) => remote::same(a, b),
        _ => false,
    }
}
async fn download(
    task: &Task,
    remote: &Remote,
    mutation: &tokio::sync::Mutex<()>,
    item: Item,
) -> Result<(), Error> {
    if let Some(link) = &item.source_link
        && remote.canonical(link).await? != item.remote
    {
        return Err(fail(
            "TRANSFER_SOURCE_CHANGED",
            "远程链接目标已变化，未提交下载",
        ));
    }
    let mut target = item.local;
    let expected = {
        let _mutation = mutation.lock().await;
        let mut existing = match tokio::fs::symlink_metadata(&target).await {
            Ok(m) => Some(m),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(local::io(e)),
        };
        if let Some(meta) = &existing {
            if local::link(meta) || !meta.is_file() {
                return Err(fail("FILE_CONFLICT", "本地目标是链接或目录，拒绝替换"));
            }
            match task.input.conflict {
                ConflictPolicy::Skip => {
                    task.skip(item.size);
                    return Ok(());
                }
                ConflictPolicy::Fail => return Err(Error::Conflict),
                ConflictPolicy::Rename => {
                    let original = target
                        .file_name()
                        .and_then(|v| v.to_str())
                        .ok_or(Error::Validation("本地名称无效"))?
                        .to_owned();
                    for n in 1..=1000 {
                        target.set_file_name(format!("{original} ({n})"));
                        match tokio::fs::symlink_metadata(&target).await {
                            Err(e) if e.kind() == std::io::ErrorKind::NotFound => break,
                            Err(e) => return Err(local::io(e)),
                            Ok(_) if n == 1000 => return Err(Error::Conflict),
                            _ => (),
                        }
                    }
                    existing = None;
                }
                ConflictPolicy::Overwrite => {
                    tokio::fs::OpenOptions::new()
                        .write(true)
                        .open(&target)
                        .await
                        .map_err(local::io)?;
                }
            }
        }
        existing
    };
    let parent = target
        .parent()
        .ok_or(Error::Validation("下载目标无父目录"))?
        .to_owned();
    ensure_local_parent(&parent).await?;
    let temp_parent = parent.clone();
    let temporary = tokio::task::spawn_blocking(move || {
        tempfile::Builder::new()
            .prefix(".serverdeck-")
            .suffix(".part")
            .tempfile_in(temp_parent)
    })
    .await
    .map_err(|e| Error::Worker(Box::new(e)))?
    .map_err(local::io)?;
    let (file, temp_path) = temporary.into_parts();
    let temp_name = local::text(&temp_path)?;
    task.temp(false, temp_name.clone())?;
    let mut file = tokio::fs::File::from_std(file);
    let before = item.attrs.ok_or(Error::Validation("缺少源文件属性"))?;
    let handle = remote
        .raw
        .open(&item.remote, OpenFlags::READ, FileAttributes::default())
        .await
        .map_err(remote::map)?
        .handle;
    if !remote::same(
        &before,
        &remote.raw.fstat(&handle).await.map_err(remote::map)?.attrs,
    ) {
        return Err(Error::Conflict);
    }
    let mut digest = Sha256::new();
    let mut offset = 0;
    while offset < item.size {
        task.check_cancel()?;
        let data = remote
            .raw
            .read(&handle, offset, (item.size - offset).min(32768) as u32)
            .await
            .map_err(remote::map)?
            .data;
        if data.is_empty() || data.len() > 32768 || offset + data.len() as u64 > item.size {
            return Err(fail(
                "TRANSFER_SOURCE_CHANGED",
                "源文件长度改变或响应无效，未提交下载",
            ));
        }
        file.write_all(&data).await.map_err(local::io)?;
        digest.update(&data);
        offset += data.len() as u64;
        task.bytes(data.len());
    }
    remote.raw.close(handle).await.map_err(remote::map)?;
    file.flush().await.map_err(local::io)?;
    file.sync_all().await.map_err(local::io)?;
    drop(file);
    task.state("verifying");
    let hash = format!("{:x}", digest.finalize());
    if hash != local::hash(Path::new(&temp_name)).await?
        || hash != remote.hash(&item.remote).await?
        || !remote::same(&before, &remote.attrs(&item.remote).await?)
    {
        return Err(fail(
            "TRANSFER_HASH",
            "下载 SHA-256 校验失败或源文件已改变，未替换目标",
        ));
    }
    if let Some(link) = &item.source_link
        && remote.canonical(link).await? != item.remote
    {
        return Err(fail(
            "TRANSFER_SOURCE_CHANGED",
            "远程链接目标已变化，未提交下载",
        ));
    }
    task.check_cancel()?;
    let _mutation = mutation.lock().await;
    ensure_local_parent(&parent).await?;
    let now = match tokio::fs::symlink_metadata(&target).await {
        Ok(m) => Some(m),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(local::io(e)),
    };
    match (&expected, &now) {
        (None, None) => (),
        (Some(a), Some(b)) if local::same(a, b) && !local::link(b) => (),
        _ => return Err(Error::Conflict),
    }
    if let Some(meta) = &expected {
        tokio::fs::set_permissions(&temp_name, meta.permissions())
            .await
            .map_err(local::io)?;
    }
    if let Some(job) = &task.copy {
        let guard = locked(&job.guard)?
            .as_ref()
            .cloned()
            .ok_or_else(|| fail("TRANSFER_CANCELLED", "传输授权已释放"))?;
        guard.check().await?;
        job.plan.attempted_commit.store(true, Ordering::Release);
    }
    task.committing.store(true, Ordering::Release);
    let overwrite = expected.is_some();
    tokio::task::spawn_blocking(move || {
        if overwrite {
            temp_path.persist(&target)
        } else {
            temp_path.persist_noclobber(&target)
        }
    })
    .await
    .map_err(|e| Error::Worker(Box::new(e)))?
    .map_err(|e| local::io(e.error))?;
    task.clear_temp()?;
    task.finished();
    if let Some(job) = &task.copy {
        *locked(&job.plan.checksum)? = Some(hash);
        let guard = locked(&job.guard)?
            .as_ref()
            .cloned()
            .ok_or_else(|| fail("TRANSFER_CANCELLED", "传输授权已释放"))?;
        guard.check().await?;
    }
    task.committing.store(false, Ordering::Release);
    Ok(())
}
async fn ensure_local_parent(parent: &Path) -> Result<(), Error> {
    // Every generated child directory is checked; no links/junctions are followed during download.
    let mut path = Some(parent);
    while let Some(current) = path {
        if local::link(
            &tokio::fs::symlink_metadata(current)
                .await
                .map_err(local::io)?,
        ) {
            return Err(fail(
                "LOCAL_PATH_CHANGED",
                "下载路径含链接或重解析点，已停止",
            ));
        }
        path = current.parent();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn synchronous_submission_returns_a_safe_error_instead_of_panicking() {
        let directory = tempfile::tempdir().expect("directory");
        let db = serverdeck_storage::Database::open(directory.path().join("db")).expect("database");
        let queue = Transfers::new(serverdeck_ssh::Engine::new(db), 3, Arc::default());
        let input = TransferInput {
            session_id: Uuid::new_v4().to_string(),
            direction: Direction::Upload,
            sources: vec!["source".into()],
            destination: "/tmp".into(),
            conflict: ConflictPolicy::Fail,
            confirm_overwrite: false,
        };
        let error = queue.start(input).expect_err("no runtime");
        assert_eq!(
            serverdeck_core::IpcError::from(error).code,
            "TRANSFER_RUNTIME"
        );
        assert!(queue.list().expect("list").is_empty());
    }
}
