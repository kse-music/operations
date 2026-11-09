use super::*;
use serverdeck_core::{
    files::*,
    terminal::{TerminalSession, TerminalSize},
};
use serverdeck_ssh::Sink;
#[cfg(test)]
mod tests;
impl Application {
    pub fn file_connections(&self) -> Result<Vec<TerminalSession>, Error> {
        self.terminals.file_connections()
    }
    pub async fn files_open(&self, host_id: String, sink: Sink) -> Result<TerminalSession, Error> {
        let secrets = self.secrets.clone();
        let (host, plan) = self
            .blocking(move |db| super::terminal::connection_plan(&db, secrets.as_ref(), &host_id))
            .await?;
        if self.shutting_down.load(Ordering::Acquire) {
            return Err(Error::ShuttingDown);
        }
        self.terminals.open_file_plan(host, plan, sink)
    }
    pub async fn files_switch_user(
        &self,
        id: String,
        user: Option<SftpUser>,
    ) -> Result<FileUserSession, Error> {
        if let Some(user) = &user {
            user.validate()?;
        } else if !self.terminals.file_is_elevated(&id)? {
            return Err(Error::Validation("SFTP 已使用原登录用户"));
        }
        self.files.check_user_switch(&id)?;
        let old = self.terminals.session_info(&id)?;
        let secrets = self.secrets.clone();
        let engine = self.terminals.clone();
        let source = id.clone();
        let (host, plan) = self
            .blocking(move |db| {
                let (host, plan) =
                    super::terminal::connection_plan(&db, secrets.as_ref(), &old.host_id)?;
                if engine.lease_profile(&source)? != plan.signature()? {
                    return Err(Error::Conflict);
                }
                Ok((host, plan))
            })
            .await?;
        if self.shutting_down.load(Ordering::Acquire) {
            return Err(Error::ShuttingDown);
        }
        let (sender, mut events) = tokio::sync::mpsc::channel(16);
        let session = self.terminals.open_file_user_plan(
            host,
            plan,
            Arc::new(move |event| sender.try_send(event).is_ok()),
            user,
        )?;
        let prepared = async {
            tokio::time::timeout(std::time::Duration::from_secs(30), async {
                while let Some(event) = events.recv().await {
                    match event {
                        serverdeck_core::terminal::TerminalEvent::State {
                            state: "connected",
                            ..
                        } => return Ok(()),
                        serverdeck_core::terminal::TerminalEvent::State {
                            state: "failed" | "closed",
                            ..
                        }
                        | serverdeck_core::terminal::TerminalEvent::Trust { .. } => {
                            return Err(Error::Validation(
                                "文件连接已失效，请重新连接主机后切换用户",
                            ));
                        }
                        _ => (),
                    }
                }
                Err(Error::Validation("文件连接已关闭"))
            })
            .await
            .map_err(|_| Error::Validation("切换用户连接超时，原文件连接保留"))??;
            let listing = self.files.list(&session.id, ".").await?;
            self.files.check_user_switch(&id)?;
            self.files.close(&id, false).await?;
            Ok(listing)
        }
        .await;
        match prepared {
            Ok(listing) => Ok(FileUserSession { session, listing }),
            Err(error) => {
                if let Err(cleanup) = self.files.close(&session.id, false).await {
                    tracing::warn!(operation = "sftp_switch_cleanup", error = %cleanup, "failed to close candidate SFTP lease");
                }
                Err(error)
            }
        }
    }
    pub async fn file_terminal(
        &self,
        host_id: String,
        action: FileTerminalAction,
        size: TerminalSize,
        sink: Sink,
    ) -> Result<TerminalSession, Error> {
        action.command()?;
        let secrets = self.secrets.clone();
        let (host, plan) = self
            .blocking(move |db| super::terminal::connection_plan(&db, secrets.as_ref(), &host_id))
            .await?;
        if self.shutting_down.load(Ordering::Acquire) {
            return Err(Error::ShuttingDown);
        }
        self.terminals
            .open_file_terminal_plan(host, plan, size, sink, action)
    }
    pub async fn files_list(&self, id: &str, path: &str) -> Result<DirectoryListing, Error> {
        self.files.list(id, path).await
    }
    pub async fn files_local(&self, path: Option<String>) -> Result<DirectoryListing, Error> {
        self.files.local_list(path).await
    }
    pub async fn files_properties(&self, id: &str, path: &str) -> Result<FileEntry, Error> {
        self.files.properties(id, path).await
    }
    pub async fn files_action(&self, id: &str, action: RemoteAction) -> Result<(), Error> {
        self.files.action(id, action).await
    }
    pub async fn files_close(&self, id: &str, cancel: bool) -> Result<(), Error> {
        self.files.close(id, cancel).await
    }
    pub fn transfer_start(&self, input: TransferInput) -> Result<TransferInfo, Error> {
        if self.shutting_down.load(Ordering::Acquire) {
            return Err(Error::ShuttingDown);
        }
        self.files.transfers.start(input)
    }
    #[cfg(windows)]
    pub fn drag_download_names(
        &self,
        session_id: &str,
        sources: Vec<String>,
    ) -> Result<Vec<String>, Error> {
        if self.shutting_down.load(Ordering::Acquire) {
            return Err(Error::ShuttingDown);
        }
        if !self
            .file_connections()?
            .iter()
            .any(|session| session.id == session_id)
        {
            return Err(Error::Validation("拖放下载需要有效的 SFTP 文件连接"));
        }
        serverdeck_sftp::Transfers::drag_download_names(session_id, sources)
    }
    #[cfg(windows)]
    pub async fn stage_drag_download(
        &self,
        session_id: String,
        sources: Vec<String>,
        destination: &std::path::Path,
    ) -> Result<(), serverdeck_core::IpcError> {
        if self.shutting_down.load(Ordering::Acquire) {
            return Err(Error::ShuttingDown.into());
        }
        self.files
            .transfers
            .stage_drag_download(session_id, sources, destination)
            .await
    }
    pub fn transfer_list(&self) -> Result<Vec<TransferInfo>, Error> {
        self.files.transfers.list()
    }
    pub fn transfer_clear_host(&self, host_id: &str) -> Result<(), Error> {
        self.files.transfers.clear_host(host_id)
    }
    pub fn transfer_cancel(&self, id: &str) -> Result<(), Error> {
        self.files.transfers.cancel(id)
    }
    pub fn transfer_retry(
        &self,
        id: &str,
        session: &str,
        policy: ConflictPolicy,
        confirmed: bool,
    ) -> Result<TransferInfo, Error> {
        if self.shutting_down.load(Ordering::Acquire) {
            return Err(Error::ShuttingDown);
        }
        self.files.transfers.retry(id, session, policy, confirmed)
    }
    pub async fn text_read(&self, id: &str, path: &str) -> Result<TextDocument, Error> {
        self.files.read_text(id, path).await
    }
    pub async fn text_save(&self, input: SaveText) -> Result<SaveResult, Error> {
        self.files.save_text(input).await
    }
    pub fn text_dirty(&self, token: &str, dirty: bool) -> Result<(), Error> {
        self.files.editor_dirty(token, dirty)
    }
    pub fn text_close(&self, token: &str, discard: bool) -> Result<(), Error> {
        self.files.close_editor(token, discard)
    }
    pub fn exit_pending(&self) -> (usize, usize) {
        (
            self.files.transfers.unfinished().unwrap_or(1)
                + self.terminal_uploads.pending().unwrap_or(1),
            self.files.dirty_count(),
        )
    }
}
