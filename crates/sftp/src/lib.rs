mod editor;
mod local;
mod remote;
mod transfer;
use remote::Remote;
use serverdeck_core::{Error, files::*};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;
pub use transfer::Transfers;

pub(crate) fn fail(code: &'static str, message: &'static str) -> Error {
    Error::Connection {
        code,
        message,
        source: None,
    }
}
pub(crate) fn locked<T>(value: &Mutex<T>) -> Result<std::sync::MutexGuard<'_, T>, Error> {
    value
        .lock()
        .map_err(|_| fail("FILES_STATE", "文件管理状态不可用"))
}
type Mutations = Arc<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>>;
#[derive(Clone)]
pub struct Files {
    engine: serverdeck_ssh::Engine,
    browsers: Arc<Mutex<HashMap<String, Arc<Remote>>>>,
    documents: Arc<Mutex<HashMap<String, editor::Document>>>,
    slots: Arc<Semaphore>,
    mutations: Mutations,
    stopping: Arc<std::sync::atomic::AtomicBool>,
    pub transfers: Transfers,
}
impl Files {
    pub fn new(engine: serverdeck_ssh::Engine, concurrency: u8) -> Self {
        let mutations: Mutations = Arc::default();
        Self {
            transfers: Transfers::new(engine.clone(), concurrency, mutations.clone()),
            engine,
            browsers: Arc::default(),
            documents: Arc::default(),
            slots: Arc::new(Semaphore::new(4)),
            mutations,
            stopping: Arc::default(),
        }
    }
    async fn slot(&self) -> Result<tokio::sync::OwnedSemaphorePermit, Error> {
        if self.stopping.load(std::sync::atomic::Ordering::Acquire) {
            return Err(Error::ShuttingDown);
        }
        let permit = tokio::time::timeout(
            std::time::Duration::from_secs(3),
            self.slots.clone().acquire_owned(),
        )
        .await
        .map_err(|_| Error::Busy)?
        .map_err(|_| Error::ShuttingDown)?;
        if self.stopping.load(std::sync::atomic::Ordering::Acquire) {
            return Err(Error::ShuttingDown);
        }
        Ok(permit)
    }
    async fn client(&self, id: &str) -> Result<Arc<Remote>, Error> {
        self.engine.session_info(id)?;
        {
            let mut browsers = locked(&self.browsers)?;
            browsers.retain(|_, r| {
                !r.owner_closed.is_cancelled() && !r.transport_closed.is_cancelled()
            });
            if let Some(remote) = browsers.get(id) {
                return Ok(remote.clone());
            }
        }
        let remote = Remote::connect(&self.engine, id).await?;
        Ok(locked(&self.browsers)?
            .entry(id.into())
            .or_insert(remote)
            .clone())
    }
    pub(crate) fn mutation(&self, id: &str) -> Result<Arc<tokio::sync::Mutex<()>>, Error> {
        let host = self.engine.session_info(id)?.host_id;
        Ok(locked(&self.mutations)?.entry(host).or_default().clone())
    }
    pub async fn list(&self, id: &str, path: &str) -> Result<DirectoryListing, Error> {
        let _permit = self.slot().await?;
        let remote = self.client(id).await?;
        guard(&remote, remote.listing(path)).await
    }
    pub async fn local_list(&self, path: Option<String>) -> Result<DirectoryListing, Error> {
        let _permit = self.slot().await?;
        local::listing(path).await
    }
    pub async fn properties(&self, id: &str, path: &str) -> Result<FileEntry, Error> {
        let _permit = self.slot().await?;
        let remote = self.client(id).await?;
        let attrs = guard(&remote, remote.attrs(path)).await?;
        Ok(remote::entry(
            path.rsplit('/').next().unwrap_or(path).into(),
            path.into(),
            &attrs,
        ))
    }
    /// Resolve on the existing SFTP lease so capability callers can enforce canonical path scopes.
    pub async fn canonical_path(&self, id: &str, path: &str) -> Result<String, Error> {
        remote_absolute(path)?;
        let _permit = self.slot().await?;
        let remote = self.client(id).await?;
        guard(&remote, remote.canonical(path)).await
    }
    pub async fn action(&self, id: &str, action: RemoteAction) -> Result<(), Error> {
        let _permit = self.slot().await?;
        let remote = self.client(id).await?;
        let mutation = self.mutation(id)?;
        let _mutation = mutation.lock().await;
        let operation = async {
            match action {
                RemoteAction::Mkdir { path } => {
                    remote_absolute(&path)?;
                    remote.mkdir(&path).await
                }
                RemoteAction::Rename { path, destination } => {
                    remote_absolute(&path)?;
                    remote_absolute(&destination)?;
                    if path.trim_end_matches('/').is_empty() {
                        return Err(Error::Validation("不能重命名远程根目录"));
                    }
                    if remote.optional_attrs(&destination).await?.is_some() {
                        return Err(Error::Conflict);
                    }
                    remote.replace(&path, &destination, false).await
                }
                RemoteAction::Remove {
                    paths,
                    recursive,
                    confirmed,
                } => {
                    if !confirmed || paths.is_empty() || paths.len() > 256 {
                        return Err(Error::Validation("删除须确认 1–256 个明确路径"));
                    }
                    for path in &paths {
                        remote_absolute(path)?;
                        if path.trim_end_matches('/').is_empty() {
                            return Err(Error::Validation("不能删除远程根目录"));
                        }
                    }
                    for path in paths {
                        remove_tree(&remote, &path, recursive).await?;
                    }
                    Ok(())
                }
            }
        };
        guard(&remote, operation).await
    }
    pub async fn close(&self, id: &str, cancel_transfers: bool) -> Result<(), Error> {
        if locked(&self.documents)?
            .values()
            .any(|d| d.public.session_id == id && d.dirty)
        {
            return Err(fail(
                "EDITOR_DIRTY",
                "请先保存文档或在编辑器中确认放弃修改，再断开文件连接",
            ));
        }
        if self.transfers.session_unfinished(id)? > 0 && !cancel_transfers {
            return Err(fail(
                "TRANSFERS_ACTIVE",
                "此连接仍有传输，请明确选择取消后断开或继续后台传输",
            ));
        }
        self.transfers.cancel_session(id).await?;
        locked(&self.browsers)?.remove(id);
        locked(&self.documents)?.retain(|_, d| d.public.session_id != id);
        self.engine.close(id).await
    }
    pub fn check_user_switch(&self, id: &str) -> Result<(), Error> {
        if locked(&self.documents)?
            .values()
            .any(|d| d.public.session_id == id)
        {
            return Err(fail(
                "EDITOR_OPEN",
                "请先保存并关闭此连接的编辑文档，再切换 SFTP 用户",
            ));
        }
        if self.transfers.session_unfinished(id)? > 0 {
            return Err(fail(
                "TRANSFERS_ACTIVE",
                "请等待或取消此连接的传输，再切换 SFTP 用户",
            ));
        }
        Ok(())
    }
    pub async fn shutdown(&self) {
        self.stopping
            .store(true, std::sync::atomic::Ordering::Release);
        self.transfers.shutdown().await;
        if tokio::time::timeout(
            std::time::Duration::from_secs(35),
            self.slots.acquire_many(4),
        )
        .await
        .is_err()
        {
            tracing::warn!(
                operation = "files_shutdown",
                "metadata requests did not drain before transport shutdown"
            );
        }
        if let Ok(mut browsers) = self.browsers.lock() {
            browsers.clear();
        }
        if let Ok(mut documents) = self.documents.lock() {
            documents.clear();
        }
    }
    pub fn reset_editors(&self) {
        if let Ok(mut documents) = self.documents.lock() {
            documents.clear();
        }
    }
    pub fn dirty_count(&self) -> usize {
        self.documents
            .lock()
            .map(|d| d.values().filter(|d| d.dirty).count())
            .unwrap_or(1)
    }
}
pub(crate) async fn guard<T>(
    remote: &Remote,
    future: impl std::future::Future<Output = Result<T, Error>>,
) -> Result<T, Error> {
    tokio::select! { result = future => result, _ = remote.owner_closed.cancelled() => Err(fail("SFTP_DISCONNECTED", "文件连接已关闭，传输可在重新连接后从头重试")), _ = remote.transport_closed.cancelled() => Err(fail("SFTP_DISCONNECTED", "SSH 连接已断开，请重新连接")) }
}
async fn remove_tree(remote: &Remote, root: &str, recursive: bool) -> Result<(), Error> {
    let mut stack = vec![(root.to_owned(), 0, false)];
    let mut count = 0;
    while let Some((path, depth, visited)) = stack.pop() {
        count += 1;
        if count > TREE_LIMIT * 2 || depth > 64 {
            return Err(fail(
                "SFTP_TREE_LIMIT",
                "递归删除超过 100000 项或 64 层，已停止",
            ));
        }
        let attrs = remote.attrs(&path).await?;
        if remote::kind(&attrs) != EntryKind::Directory {
            remote.raw.remove(path).await.map_err(remote::map)?;
            continue;
        }
        // Do not traverse symlink redirections introduced under the selected tree.
        if remote.canonical(&path).await? != path {
            return Err(fail(
                "SFTP_PATH_CHANGED",
                "目录路径包含链接或已变化，递归删除已停止",
            ));
        }
        if visited || !recursive {
            remote.raw.rmdir(path).await.map_err(remote::map)?;
            continue;
        }
        let children = remote.entries(&path).await?;
        stack.push((path.clone(), depth, true));
        for (name, _) in children {
            stack.push((remote_join(&path, &name)?, depth + 1, false));
        }
    }
    Ok(())
}
