use super::*;

struct Output {
    pending: Vec<u8>,
    returned: bool,
}
pub(super) struct Route {
    marker: Vec<u8>,
    output: Mutex<Output>,
    sender: mpsc::Sender<Vec<u8>>,
    closed: CancellationToken,
    finished: AtomicBool,
}
impl Route {
    pub(super) async fn forward(&self, bytes: &[u8]) -> Result<(Vec<u8>, bool), Error> {
        let (hidden, normal, returned) = {
            let mut output = locked(&self.output)?;
            if output.returned {
                return Ok((bytes.to_vec(), false));
            }
            output.pending.extend_from_slice(bytes);
            if let Some(at) = output
                .pending
                .windows(self.marker.len())
                .position(|b| b == self.marker)
            {
                let after = at + self.marker.len();
                let normal = output.pending.split_off(after);
                let hidden = std::mem::take(&mut output.pending);
                output.returned = true;
                self.finished.store(true, Ordering::Release);
                (hidden, normal, true)
            } else {
                let keep = (1..self.marker.len())
                    .rev()
                    .find(|&n| output.pending.ends_with(&self.marker[..n]))
                    .unwrap_or(0);
                let end = output.pending.len() - keep;
                let tail = output.pending.split_off(end);
                let hidden = std::mem::replace(&mut output.pending, tail);
                (hidden, vec![], false)
            }
        };
        if !hidden.is_empty() {
            tokio::select! {
                result = self.sender.send(hidden) => result.map_err(|_| failure("SSH_UPLOAD_CLOSED", "上传接收任务已关闭"))?,
                _ = self.closed.cancelled() => return Err(Error::NotFound),
            }
        }
        Ok((normal, returned))
    }
}

/// Exclusive, bounded binary I/O in the original terminal. Incomplete recovery
/// closes that session rather than exposing queued payload to its Shell.
pub struct TerminalTransfer {
    control: Arc<Control>,
    route: Arc<Route>,
    output: mpsc::Receiver<Vec<u8>>,
}
impl TerminalTransfer {
    pub fn abort(&self) {
        self.control.cancel.cancel();
    }
    pub async fn send(&self, bytes: &[u8]) -> Result<(), Error> {
        for block in bytes.chunks(64 * 1024) {
            tokio::select! {
                result = self.control.input.send(block.to_vec()) => result.map_err(|_| Error::NotFound)?,
                _ = self.control.cancel.cancelled() => return Err(Error::NotFound),
            }
        }
        Ok(())
    }
    pub async fn recv(&mut self) -> Result<Vec<u8>, Error> {
        tokio::select! {
            value = self.output.recv() => value.ok_or(Error::NotFound),
            _ = self.control.cancel.cancelled() => Err(Error::NotFound),
        }
    }
}
impl Drop for TerminalTransfer {
    fn drop(&mut self) {
        if !self.route.finished.load(Ordering::Acquire) {
            self.control.cancel.cancel();
        }
        if let Ok(mut current) = self.control.transfer.lock()
            && current
                .as_ref()
                .is_some_and(|r| Arc::ptr_eq(r, &self.route))
        {
            current.take();
        }
    }
}
impl Engine {
    pub fn terminal_transfer(&self, id: &str, nonce: &str) -> Result<TerminalTransfer, Error> {
        if nonce.len() != 32 || !nonce.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(Error::Validation("上传随机标识无效"));
        }
        self.terminal_connected(id)?;
        let control = self.control(id)?;
        let mut current = locked(&control.transfer)?;
        if current.is_some() {
            return Err(Error::Busy);
        }
        let (sender, output) = mpsc::channel(8);
        let route = Arc::new(Route {
            marker: format!("\x1eSDU:{nonce}:RETURN\x1f").into_bytes(),
            output: Mutex::new(Output {
                pending: vec![],
                returned: false,
            }),
            sender,
            closed: control.cancel.clone(),
            finished: AtomicBool::new(false),
        });
        *current = Some(route.clone());
        drop(current);
        Ok(TerminalTransfer {
            control,
            route,
            output,
        })
    }
}
