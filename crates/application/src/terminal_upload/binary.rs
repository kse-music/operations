use super::*;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serverdeck_core::terminal::{
    TerminalDropPhase as Phase, TerminalDropPrepared, TerminalDropProgress, TerminalDropResult,
};
use serverdeck_ssh::TerminalTransfer;
use sha2::{Digest, Sha256};
use std::{
    collections::VecDeque,
    time::{Duration, Instant},
};
use tokio_util::sync::CancellationToken;

pub(super) const BLOCK: usize = 4 * 1024 * 1024;
const WINDOW: usize = 2;
const DEADLINE: Duration = Duration::from_secs(30);
pub type ProgressSink = Arc<dyn Fn(TerminalDropProgress) -> bool + Send + Sync>;

trait Wire: Send {
    fn send(&mut self, bytes: &[u8])
    -> impl std::future::Future<Output = Result<(), Error>> + Send;
    fn recv(&mut self) -> impl std::future::Future<Output = Result<Vec<u8>, Error>> + Send;
}
impl Wire for TerminalTransfer {
    async fn send(&mut self, bytes: &[u8]) -> Result<(), Error> {
        TerminalTransfer::send(self, bytes).await
    }
    async fn recv(&mut self) -> Result<Vec<u8>, Error> {
        TerminalTransfer::recv(self).await
    }
}

fn protocol() -> Error {
    Error::Validation("上传接收端响应无效，已关闭终端以隔离未确认的数据")
}
#[derive(Default)]
struct Frames {
    pending: Vec<u8>,
    frames: VecDeque<String>,
}
impl Frames {
    fn push(&mut self, bytes: &[u8], nonce: &str) -> Result<(), Error> {
        let prefix = format!("\x1eSDU:{nonce}:").into_bytes();
        self.pending.extend_from_slice(bytes);
        loop {
            let Some(at) = self.pending.windows(prefix.len()).position(|b| b == prefix) else {
                let keep = (1..prefix.len())
                    .rev()
                    .find(|&n| self.pending.ends_with(&prefix[..n]))
                    .unwrap_or(0);
                self.pending.drain(..self.pending.len() - keep);
                return Ok(());
            };
            self.pending.drain(..at);
            let Some(end) = self.pending[prefix.len()..].iter().position(|&b| b == 31) else {
                if self.pending.len() > 16384 {
                    return Err(protocol());
                }
                return Ok(());
            };
            let end = prefix.len() + end;
            let frame = std::str::from_utf8(&self.pending[prefix.len()..end])
                .map_err(|_| protocol())?
                .to_owned();
            if frame.len() > 16384 || self.frames.len() >= 32 {
                return Err(protocol());
            }
            self.frames.push_back(frame);
            self.pending.drain(..=end);
        }
    }
    async fn next(&mut self, io: &mut impl Wire, nonce: &str) -> Result<String, Error> {
        loop {
            if let Some(frame) = self.frames.pop_front() {
                return Ok(frame);
            }
            self.push(&io.recv().await?, nonce)?;
        }
    }
}
fn text(value: &str) -> Result<String, Error> {
    String::from_utf8(STANDARD.decode(value).map_err(|_| protocol())?).map_err(|_| protocol())
}
struct Progress {
    value: TerminalDropProgress,
    started: Option<Instant>,
    last: Instant,
    sink: ProgressSink,
    cancel: CancellationToken,
}
impl Progress {
    fn emit(&mut self, phase: Phase, force: bool) {
        let changed = self.value.phase != phase;
        self.value.phase = phase;
        let elapsed = self.started.map_or(Duration::ZERO, |s| s.elapsed());
        self.value.elapsed_seconds = elapsed.as_secs();
        self.value.bytes_per_second = if phase == Phase::Uploading && !elapsed.is_zero() {
            (self.value.sent as f64 / elapsed.as_secs_f64()) as u64
        } else {
            0
        };
        if changed || force || self.last.elapsed() >= Duration::from_millis(100) {
            self.last = Instant::now();
            if !(self.sink)(self.value.clone()) {
                self.cancel.cancel();
            }
        }
    }
}
struct Grant {
    uploads: TerminalUploads,
    id: String,
    token: String,
}
impl Drop for Grant {
    fn drop(&mut self) {
        if let Err(error) = self.uploads.release(&self.id, &self.token) {
            tracing::warn!(operation="terminal_binary_release", error=%error);
        }
    }
}
impl Application {
    pub fn terminal_upload_cancel_drop(&self, id: &str, token: &str) -> Result<(), Error> {
        let selections = locked(&self.terminal_uploads.0)?;
        if let Some(selection) = selections.get(id).filter(|s| s.token == token) {
            selection.cancel_drop.cancel();
            selection.released.send_replace(());
        }
        Ok(())
    }
    pub async fn terminal_upload_run_drop(
        &self,
        id: String,
        token: String,
        confirmed: bool,
        sink: ProgressSink,
    ) -> Result<TerminalDropResult, Error> {
        if !confirmed {
            return Err(Error::Validation("拖放上传须用户确认"));
        }
        self.terminals.terminal_connected(&id)?;
        let (cancel, items) = {
            let mut selections = locked(&self.terminal_uploads.0)?;
            let selected = selections
                .get_mut(&id)
                .filter(|s| s.token == token)
                .ok_or(Error::NotFound)?;
            if selected.running_drop {
                return Err(Error::Busy);
            }
            let items = selected.drop_paths.as_ref().ok_or(Error::NotFound)?.len();
            selected.running_drop = true;
            (selected.cancel_drop.clone(), items)
        };
        let _grant = Grant {
            uploads: self.terminal_uploads.clone(),
            id: id.clone(),
            token: token.clone(),
        };
        let mut progress = Progress {
            value: TerminalDropProgress {
                phase: Phase::Preparing,
                sent: 0,
                size: 0,
                bytes_per_second: 0,
                elapsed_seconds: 0,
                uid: None,
                username: None,
                directory: None,
            },
            started: None,
            last: Instant::now(),
            sink,
            cancel: cancel.clone(),
        };
        progress.emit(Phase::Preparing, true);
        let prepared = match self
            .terminal_upload_prepare_drop(id.clone(), token.clone(), true)
            .await
        {
            Ok(prepared) => prepared,
            Err(_) if cancel.is_cancelled() => {
                return Ok(TerminalDropResult {
                    code: Some("CANCELLED".into()),
                    committed: 0,
                    recovery: None,
                });
            }
            Err(error) => return Err(error),
        };
        if cancel.is_cancelled() {
            return Ok(TerminalDropResult {
                code: Some("CANCELLED".into()),
                committed: 0,
                recovery: None,
            });
        }
        progress.value.size = prepared.size;
        progress.emit(Phase::Starting, true);
        let mut io = self.terminals.terminal_transfer(&id, &prepared.nonce)?;
        let result = transfer(
            &self.terminal_uploads,
            &id,
            &token,
            items,
            &prepared,
            &mut io,
            &mut progress,
        )
        .await;
        if let Err(error) = &result {
            io.abort();
            tracing::warn!(operation="terminal_binary_upload", error=%error, "binary upload did not complete safely");
        }
        result
    }
}

async fn send(io: &mut impl Wire, bytes: &[u8]) -> Result<(), Error> {
    tokio::time::timeout(DEADLINE, io.send(bytes))
        .await
        .map_err(|_| Error::Validation("终端上传发送超时，已关闭会话以隔离未确认的数据"))?
}
#[allow(clippy::too_many_arguments)]
async fn transfer(
    uploads: &TerminalUploads,
    id: &str,
    token: &str,
    items: usize,
    prepared: &TerminalDropPrepared,
    io: &mut impl Wire,
    progress: &mut Progress,
) -> Result<TerminalDropResult, Error> {
    send(io, prepared.command.as_bytes()).await?;
    let mut frames = Frames::default();
    let mut ready = false;
    let mut offset = 0;
    let mut pending = VecDeque::new();
    let mut cancel_sent = false;
    let mut finish_sent = false;
    let mut commit_sent = false;
    let mut result: Option<TerminalDropResult> = None;
    let mut local_error = false;
    let mut digest = Sha256::new();
    let mut deadline = tokio::time::Instant::now() + DEADLINE;
    loop {
        if ready && result.is_none() {
            if progress.cancel.is_cancelled() && !cancel_sent {
                send(io, b"C").await?;
                cancel_sent = true;
                progress.emit(Phase::Cancelling, true);
            }
            while !cancel_sent && !finish_sent && pending.len() < WINDOW && offset < prepared.size {
                let read_uploads = uploads.clone();
                let read_id = id.to_owned();
                let read_token = token.to_owned();
                let mut hasher = std::mem::take(&mut digest);
                let read = tokio::task::spawn_blocking(move || {
                    let bytes = read_uploads.read(&read_id, &read_token, 0, offset)?;
                    hasher.update(&bytes);
                    Ok::<_, Error>((bytes, hasher))
                })
                .await
                .map_err(|e| Error::Worker(Box::new(e)))?;
                let bytes = match read {
                    Ok((bytes, hasher))
                        if bytes.len() == BLOCK.min((prepared.size - offset) as usize) =>
                    {
                        digest = hasher;
                        bytes
                    }
                    error => {
                        tracing::warn!(operation="terminal_binary_source", error=?error.as_ref().err(), "local upload source changed or could not be read");
                        local_error = true;
                        progress.cancel.cancel();
                        break;
                    }
                };
                if progress.cancel.is_cancelled() {
                    break;
                }
                send(io, format!("D{:07}", bytes.len()).as_bytes()).await?;
                // Finish a declared frame even when cancellation arrives. The
                // following control byte must never land inside binary payload.
                send(io, &bytes).await?;
                offset += bytes.len() as u64;
                pending.push_back(offset);
                deadline = tokio::time::Instant::now() + DEADLINE;
            }
            if progress.cancel.is_cancelled() && !cancel_sent {
                continue;
            }
            if !cancel_sent && !finish_sent && pending.is_empty() && offset == prepared.size {
                // Recheck the open source after the last data read as well, so
                // a modification during that read cannot pass into commit.
                let source = uploads.clone();
                let source_id = id.to_owned();
                let source_token = token.to_owned();
                let valid = tokio::task::spawn_blocking(move || {
                    source.read(&source_id, &source_token, 0, offset)
                })
                .await
                .map_err(|e| Error::Worker(Box::new(e)))?;
                if let Err(error) = valid {
                    tracing::warn!(operation="terminal_binary_source", error=%error, "local upload source changed before verification");
                    local_error = true;
                    progress.cancel.cancel();
                    continue;
                }
                if progress.cancel.is_cancelled() {
                    continue;
                }
                send(
                    io,
                    format!("F{:x}", std::mem::take(&mut digest).finalize()).as_bytes(),
                )
                .await?;
                finish_sent = true;
                progress.emit(Phase::Verifying, true);
            }
        }
        let frame = tokio::select! {
            frame = frames.next(io, &prepared.nonce) => frame?,
            _ = progress.cancel.cancelled(), if ready && !cancel_sent && result.is_none() => continue,
            _ = tokio::time::sleep_until(deadline) => return Err(Error::Validation("等待上传接收端响应超时，已关闭会话以隔离未确认的数据")),
            _ = tokio::time::sleep(Duration::from_millis(500)) => { progress.emit(progress.value.phase, true); continue; }
        };
        deadline = tokio::time::Instant::now()
            + if finish_sent && !cancel_sent && result.is_none() {
                Duration::from_secs(300)
            } else {
                DEADLINE
            };
        let parts: Vec<_> = frame.split(':').collect();
        match parts.as_slice() {
            ["READY", uid, user, directory] if !ready && result.is_none() => {
                if uid.is_empty() || !uid.bytes().all(|b| b.is_ascii_digit()) {
                    return Err(protocol());
                }
                let username = text(user)?;
                let directory = text(directory)?;
                if username.chars().any(char::is_control)
                    || !directory.starts_with('/')
                    || !directory.ends_with('\n')
                {
                    return Err(protocol());
                }
                progress.value.uid = Some((*uid).to_owned());
                progress.value.username = (!username.is_empty()).then_some(username);
                progress.value.directory = Some(directory[..directory.len() - 1].to_owned());
                progress.started = Some(Instant::now());
                ready = true;
                progress.emit(Phase::Uploading, true);
            }
            ["ACK", value] if ready && result.is_none() => {
                let count: u64 = value.parse().map_err(|_| protocol())?;
                if pending.pop_front() != Some(count) {
                    return Err(protocol());
                }
                let first = progress.value.sent == 0;
                progress.value.sent = count;
                progress.emit(
                    if cancel_sent {
                        Phase::Cancelling
                    } else {
                        Phase::Uploading
                    },
                    first,
                );
            }
            ["VERIFYING"] if finish_sent && result.is_none() => {
                progress.emit(
                    if cancel_sent {
                        Phase::Cancelling
                    } else {
                        Phase::Verifying
                    },
                    true,
                );
            }
            ["COMMIT_READY"] if finish_sent && result.is_none() && !commit_sent => {
                if !cancel_sent && !progress.cancel.is_cancelled() {
                    send(io, b"K").await?;
                    commit_sent = true;
                }
            }
            ["COMMITTING"] if commit_sent && result.is_none() => {
                progress.emit(Phase::Committing, true);
            }
            ["FAIL", code, _] if result.is_none() => {
                if *code == "STREAM" {
                    return Err(Error::Validation(
                        "远端二进制接收长度或帧边界异常，已关闭此会话以隔离未确认的数据",
                    ));
                }
                progress.cancel.cancel();
            }
            ["DONE", count]
                if commit_sent
                    && pending.is_empty()
                    && progress.value.sent == prepared.size
                    && result.is_none() =>
            {
                let committed = count.parse::<usize>().map_err(|_| protocol())?;
                if committed != items {
                    return Err(protocol());
                }
                result = Some(TerminalDropResult {
                    code: None,
                    committed,
                    recovery: None,
                });
                send(io, b"R").await?;
            }
            ["ERROR", code, count] | ["ERROR", code, count, _] => {
                let committed = count.parse::<usize>().map_err(|_| protocol())?;
                if committed > items {
                    return Err(protocol());
                }
                let recovery = parts.get(3).map(|v| text(v)).transpose()?;
                if result.is_some() && *code != "TTY_RESTORE" {
                    return Err(protocol());
                }
                if *code == "TTY_RESTORE" {
                    return Err(Error::Validation("无法恢复终端设置，已关闭此会话"));
                }
                result = Some(TerminalDropResult {
                    code: Some(if local_error { "LOCAL_READ" } else { code }.to_string()),
                    committed,
                    recovery,
                });
                if ready {
                    send(io, b"R").await?;
                }
            }
            ["RETURN"] => return result.ok_or_else(protocol),
            _ => return Err(protocol()),
        }
    }
}

#[cfg(all(test, windows))]
mod ssh_tests;
#[cfg(test)]
mod tests;
