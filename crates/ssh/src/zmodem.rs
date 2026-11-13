use super::*;

pub const ZMODEM_INPUT_LIMIT: usize = 256 * 1024;

async fn send_chunks(
    input: &mpsc::Sender<Vec<u8>>,
    closed: &CancellationToken,
    data: &[u8],
) -> Result<(), Error> {
    for chunk in data.chunks(16 * 1024) {
        tokio::select! {
            biased;
            _ = closed.cancelled() => return Err(Error::NotFound),
            result = input.send(chunk.to_vec()) => result.map_err(|_| Error::NotFound)?,
        }
    }
    Ok(())
}

impl Engine {
    /// The application must validate the native file grant before admitting a batch.
    /// Keep the ordinary terminal's queue and its per-entry byte bound unchanged.
    pub async fn terminal_upload_input(&self, id: &str, data: &[u8]) -> Result<(), Error> {
        if data.is_empty() || data.len() > ZMODEM_INPUT_LIMIT {
            return Err(Error::Validation("ZMODEM 输入批次须为 1–262144 字节"));
        }
        self.terminal_connected(id)?;
        let control = self.control(id)?;
        if locked(&control.transfer)?.is_some() {
            return Err(Error::Busy);
        }
        let result = tokio::time::timeout(
            Duration::from_secs(30),
            send_chunks(&control.input, &control.cancel, data),
        )
        .await
        .unwrap_or_else(|_| {
            Err(failure(
                "SSH_UPLOAD_TIMEOUT",
                "ZMODEM 输入等待超时，终端已关闭",
            ))
        });
        if result.is_err() {
            // A partially admitted batch must never become ordinary Shell input.
            control.cancel.cancel();
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn batches_preserve_bytes_and_wait_for_bounded_queue_capacity() {
        let (sender, mut receiver) = mpsc::channel(1);
        let closed = CancellationToken::new();
        let data: Vec<u8> = (0..ZMODEM_INPUT_LIMIT).map(|i| i as u8).collect();
        let send = send_chunks(&sender, &closed, &data);
        let receive = async {
            let mut actual = Vec::new();
            while actual.len() < data.len() {
                let chunk = receiver.recv().await.expect("chunk");
                assert!(chunk.len() <= 16 * 1024);
                actual.extend(chunk);
            }
            actual
        };
        let (sent, actual) = tokio::join!(send, receive);
        sent.expect("send");
        assert_eq!(actual, data);
    }

    #[tokio::test]
    async fn cancellation_stops_a_batch_waiting_for_capacity() {
        let (sender, mut receiver) = mpsc::channel(1);
        let closed = CancellationToken::new();
        sender.send(vec![1]).await.expect("fill queue");
        let data = vec![2; 32768];
        let send = send_chunks(&sender, &closed, &data);
        let cancel = async {
            tokio::task::yield_now().await;
            closed.cancel();
        };
        let (result, ()) = tokio::join!(send, cancel);
        assert!(matches!(result, Err(Error::NotFound)));
        assert_eq!(receiver.recv().await, Some(vec![1]));
        assert!(receiver.try_recv().is_err());
    }
}
