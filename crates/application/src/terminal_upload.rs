use crate::Application;
use serverdeck_core::{
    Error,
    terminal::{TerminalUploadFile, TerminalUploadSelection},
};
use std::{
    collections::HashMap,
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::PathBuf,
    sync::{Arc, Mutex, MutexGuard},
    time::SystemTime,
};
mod drop;

const CHUNK: usize = 8192;
const MAX_FILES: usize = 100;

struct SelectedFile {
    file: File,
    size: u64,
    modified: SystemTime,
    chunk: usize,
}
struct Selection {
    token: String,
    files: Vec<Arc<Mutex<SelectedFile>>>,
    released: tokio::sync::watch::Sender<()>,
    drop_paths: Option<Vec<PathBuf>>,
    temporary: Option<tempfile::NamedTempFile>,
}
#[derive(Clone)]
pub(crate) struct TerminalUploads(
    Arc<Mutex<HashMap<String, Selection>>>,
    Arc<tokio::sync::Semaphore>,
    Arc<Mutex<drop::Grants>>,
);
impl Default for TerminalUploads {
    fn default() -> Self {
        Self(
            Arc::default(),
            Arc::new(tokio::sync::Semaphore::new(32)),
            Arc::default(),
        )
    }
}

fn locked<T>(value: &Mutex<T>) -> Result<MutexGuard<'_, T>, Error> {
    value.lock().map_err(|_| Error::Conflict)
}
fn io_error(error: std::io::Error) -> Error {
    tracing::warn!(operation = "terminal_upload_read", error = %error, "local upload file operation failed");
    Error::Connection {
        code: "LOCAL_UPLOAD_IO",
        message: "无法读取选中的上传文件，请检查文件是否变化或被占用",
        source: Some(Box::new(error)),
    }
}
impl TerminalUploads {
    fn begin(&self, id: &str) -> Result<String, Error> {
        let mut selections = locked(&self.0)?;
        if selections.contains_key(id) || selections.len() >= 32 {
            return Err(Error::Busy);
        }
        let token = uuid::Uuid::new_v4().to_string();
        selections.insert(
            id.to_owned(),
            Selection {
                token: token.clone(),
                files: vec![],
                released: tokio::sync::watch::channel(()).0,
                drop_paths: None,
                temporary: None,
            },
        );
        Ok(token)
    }
    fn released(&self, id: &str, token: &str) -> Result<tokio::sync::watch::Receiver<()>, Error> {
        Ok(locked(&self.0)?
            .get(id)
            .filter(|s| s.token == token)
            .ok_or(Error::NotFound)?
            .released
            .subscribe())
    }
    fn select(
        &self,
        id: &str,
        token: &str,
        paths: Vec<PathBuf>,
    ) -> Result<TerminalUploadSelection, Error> {
        if paths.len() > MAX_FILES {
            return Err(Error::Validation("ZMODEM 每次最多选择 100 个文件"));
        }
        let mut files = Vec::with_capacity(paths.len());
        let mut details = Vec::with_capacity(paths.len());
        for path in paths {
            let file = File::open(&path).map_err(io_error)?;
            let metadata = file.metadata().map_err(io_error)?;
            if !metadata.is_file() || metadata.len() > u32::MAX as u64 {
                return Err(Error::Validation("ZMODEM 仅支持小于 4 GiB 的普通文件"));
            }
            let name = path
                .file_name()
                .and_then(|s| s.to_str())
                .filter(|s| {
                    !s.is_empty() && !s.chars().any(|c| c.is_control() || c == '/' || c == '\\')
                })
                .ok_or(Error::Validation("上传文件名无效，请重命名后重试"))?
                .to_owned();
            details.push(TerminalUploadFile {
                name,
                size: metadata.len(),
            });
            files.push(Arc::new(Mutex::new(SelectedFile {
                file,
                size: metadata.len(),
                modified: metadata.modified().map_err(io_error)?,
                chunk: CHUNK,
            })));
        }
        let mut selections = locked(&self.0)?;
        let selection = selections
            .get_mut(id)
            .filter(|s| s.token == token)
            .ok_or(Error::NotFound)?;
        selection.files = files;
        Ok(TerminalUploadSelection {
            token: token.to_owned(),
            files: details,
        })
    }
    fn read(&self, id: &str, token: &str, index: usize, offset: u64) -> Result<Vec<u8>, Error> {
        let file = locked(&self.0)?
            .get(id)
            .filter(|s| s.token == token)
            .and_then(|s| s.files.get(index))
            .cloned()
            .ok_or(Error::NotFound)?;
        let mut selected = locked(&file)?;
        let metadata = selected.file.metadata().map_err(io_error)?;
        if metadata.len() != selected.size
            || metadata.modified().map_err(io_error)? != selected.modified
        {
            return Err(Error::Validation("上传文件已变化，请取消后重新选择"));
        }
        if offset > selected.size {
            return Err(Error::Validation("上传文件偏移超出文件大小"));
        }
        let mut data = vec![0; selected.chunk.min((selected.size - offset) as usize)];
        selected
            .file
            .seek(SeekFrom::Start(offset))
            .map_err(io_error)?;
        selected.file.read_exact(&mut data).map_err(io_error)?;
        Ok(data)
    }
    pub(crate) fn release(&self, id: &str, token: &str) -> Result<(), Error> {
        let mut selections = locked(&self.0)?;
        if selections.get(id).is_some_and(|s| s.token == token) {
            selections.remove(id);
        }
        Ok(())
    }
    pub(crate) fn clear(&self) -> Result<(), Error> {
        locked(&self.0)?.clear();
        locked(&self.2)?.clear();
        Ok(())
    }
    pub(crate) fn pending(&self) -> Result<usize, Error> {
        Ok(locked(&self.0)?.len())
    }
}

impl Application {
    pub fn terminal_upload_target(&self, id: &str) -> Result<String, Error> {
        let target = self
            .terminals
            .connection_status()?
            .into_iter()
            .find(|c| c.id == id && c.kind == "terminal" && c.state == "connected")
            .ok_or(Error::NotFound)?;
        Ok(format!(
            "{}@{}:{}",
            target.username, target.hostname, target.port
        ))
    }
    // Only the trusted native picker calls select; the read IPC never accepts a path.
    pub fn terminal_upload_begin(&self, id: &str) -> Result<String, Error> {
        if self
            .shutting_down
            .load(std::sync::atomic::Ordering::Acquire)
        {
            return Err(Error::ShuttingDown);
        }
        let closed = self.terminals.terminal_connected(id)?;
        let token = self.terminal_uploads.begin(id)?;
        let mut released = self.terminal_uploads.released(id, &token)?;
        let uploads = self.terminal_uploads.clone();
        let session = id.to_owned();
        let grant = token.clone();
        tokio::spawn(async move {
            tokio::select! {
                _ = released.changed() => {},
                _ = closed.cancelled() => {
                    if let Err(error) = uploads.release(&session, &grant) {
                        tracing::error!(operation = "terminal_upload_release", error = %error);
                    }
                }
            }
        });
        Ok(token)
    }
    pub async fn terminal_upload_select(
        &self,
        id: String,
        token: String,
        paths: Vec<PathBuf>,
    ) -> Result<TerminalUploadSelection, Error> {
        self.terminals.terminal_connected(&id)?;
        let uploads = self.terminal_uploads.clone();
        tokio::task::spawn_blocking(move || uploads.select(&id, &token, paths))
            .await
            .map_err(|e| Error::Worker(Box::new(e)))?
    }
    pub async fn terminal_upload_read(
        &self,
        id: String,
        token: String,
        index: usize,
        offset: u64,
    ) -> Result<Vec<u8>, Error> {
        self.terminals.terminal_connected(&id)?;
        let uploads = self.terminal_uploads.clone();
        let permit = uploads
            .1
            .clone()
            .try_acquire_owned()
            .map_err(|_| Error::Busy)?;
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            uploads.read(&id, &token, index, offset)
        })
        .await
        .map_err(|e| Error::Worker(Box::new(e)))?
    }
    pub fn terminal_upload_release(&self, id: &str, token: &str) -> Result<(), Error> {
        self.terminal_uploads.release(id, token)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_binary_in_bounded_chunks_and_scopes_grants() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("中文 文件.bin");
        let data: Vec<u8> = (0..20000).map(|i| (i % 256) as u8).collect();
        std::fs::write(&path, &data).expect("fixture");
        let uploads = TerminalUploads::default();
        let token = uploads.begin("session").expect("begin");
        assert!(matches!(uploads.begin("session"), Err(Error::Busy)));
        let selection = uploads
            .select("session", &token, vec![path])
            .expect("select");
        assert_eq!(selection.files[0].name, "中文 文件.bin");
        assert_eq!(selection.files[0].size, data.len() as u64);
        let mut actual = vec![];
        while actual.len() < data.len() {
            let part = uploads
                .read("session", &token, 0, actual.len() as u64)
                .expect("read");
            assert!(part.len() <= CHUNK);
            actual.extend(part);
        }
        assert_eq!(actual, data);
        assert!(
            uploads
                .read("session", &token, 0, 20000)
                .expect("EOF")
                .is_empty()
        );
        assert!(uploads.read("other", &token, 0, 0).is_err());
        assert!(uploads.read("session", "forged", 0, 0).is_err());
        assert!(uploads.read("session", &token, 1, 0).is_err());
        assert!(uploads.read("session", &token, 0, 20001).is_err());
        uploads.release("session", &token).expect("release");
        assert!(uploads.read("session", &token, 0, 0).is_err());
    }

    #[test]
    fn cancelled_picker_cannot_grant_files_to_a_replacement() {
        let uploads = TerminalUploads::default();
        let old = uploads.begin("session").expect("begin");
        uploads.release("session", &old).expect("release");
        let new = uploads.begin("session").expect("replacement");
        assert!(uploads.select("session", &old, vec![]).is_err());
        uploads.release("session", &old).expect("stale release");
        assert_eq!(uploads.pending().expect("pending"), 1);
        uploads
            .select("session", &new, vec![])
            .expect("new selection");
    }

    #[test]
    fn rejects_directories_excess_files_and_changed_files() {
        let dir = tempfile::tempdir().expect("tempdir");
        let uploads = TerminalUploads::default();
        let token = uploads.begin("session").expect("begin");
        assert!(
            uploads
                .select("session", &token, vec![dir.path().to_owned()])
                .is_err()
        );
        assert!(
            uploads
                .select("session", &token, vec![dir.path().to_owned(); 101])
                .is_err()
        );
        let path = dir.path().join("changed.bin");
        std::fs::write(&path, b"old").expect("fixture");
        uploads
            .select("session", &token, vec![path.clone()])
            .expect("select");
        std::fs::write(&path, b"changed").expect("change");
        assert!(uploads.read("session", &token, 0, 0).is_err());
        uploads.clear().expect("clear");
        assert_eq!(uploads.pending().expect("pending"), 0);
    }
}
