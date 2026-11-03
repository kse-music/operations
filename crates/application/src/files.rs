use super::*;
use serverdeck_core::{
    files::*,
    terminal::{TerminalSession, TerminalSize},
};
use serverdeck_ssh::Sink;
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
    pub fn transfer_list(&self) -> Result<Vec<TransferInfo>, Error> {
        self.files.transfers.list()
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
                + self.terminal_uploads.pending().unwrap_or(1)
                + self.tasks.pending().unwrap_or(1)
                + self.automation.pending().unwrap_or(1),
            self.files.dirty_count(),
        )
    }
}
