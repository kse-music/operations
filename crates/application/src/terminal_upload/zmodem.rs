use super::*;

impl TerminalUploads {
    fn zmodem_grant(
        &self,
        id: &str,
        token: &str,
    ) -> Result<
        (
            tokio::sync::watch::Receiver<()>,
            Arc<tokio::sync::Semaphore>,
        ),
        Error,
    > {
        let selections = locked(&self.0)?;
        let selection = selections
            .get(id)
            .filter(|selection| {
                selection.token == token
                    && selection.drop_paths.is_none()
                    && !selection.running_drop
                    && selection.temporary.is_none()
            })
            .ok_or(Error::NotFound)?;
        Ok((
            selection.released.subscribe(),
            selection.zmodem_writer.clone(),
        ))
    }
}

impl Application {
    pub async fn terminal_zmodem_read(
        &self,
        id: String,
        token: String,
        index: usize,
        offset: u64,
    ) -> Result<Vec<u8>, Error> {
        self.terminal_uploads.zmodem_grant(&id, &token)?;
        self.terminal_upload_read(id, token, index, offset).await
    }

    pub async fn terminal_zmodem_write(
        &self,
        id: String,
        token: String,
        data: Vec<u8>,
    ) -> Result<(), Error> {
        if data.is_empty() || data.len() > serverdeck_ssh::ZMODEM_INPUT_LIMIT {
            return Err(Error::Validation("ZMODEM 输入批次须为 1–262144 字节"));
        }
        let (mut released, writer) = self.terminal_uploads.zmodem_grant(&id, &token)?;
        let _permit = writer.try_acquire_owned().map_err(|_| Error::Busy)?;
        let result = tokio::select! {
            biased;
            _ = released.changed() => Err(Error::NotFound),
            result = self.terminals.terminal_upload_input(&id, &data) => result,
        };
        if result.is_err()
            && let Err(error) = self.terminals.close(&id).await
        {
            tracing::warn!(operation = "terminal_zmodem_close", error = %error);
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn binary_grants_reject_other_sessions_tokens_and_drop_authorizations() {
        let uploads = TerminalUploads::default();
        let token = uploads.begin("rz").expect("grant");
        let (mut released, writer) = uploads.zmodem_grant("rz", &token).expect("subscribe");
        let writing = writer.clone().try_acquire_owned().expect("one writer");
        assert!(writer.clone().try_acquire_owned().is_err());
        drop(writing);
        assert!(writer.try_acquire_owned().is_ok());
        assert!(uploads.zmodem_grant("other", &token).is_err());
        assert!(uploads.zmodem_grant("rz", "forged").is_err());
        uploads.release("rz", &token).expect("release");
        assert!(released.changed().await.is_err());
        assert!(uploads.zmodem_grant("rz", &token).is_err());
        let drop_token = uploads.begin("drop").expect("drop grant");
        locked(&uploads.0)
            .expect("selections")
            .get_mut("drop")
            .expect("selection")
            .drop_paths = Some(vec![]);
        assert!(uploads.zmodem_grant("drop", &drop_token).is_err());
        {
            let mut selections = locked(&uploads.0).expect("selections");
            let selection = selections.get_mut("drop").expect("selection");
            selection.drop_paths = None;
            selection.running_drop = true;
        }
        assert!(uploads.zmodem_grant("drop", &drop_token).is_err());
    }
}
