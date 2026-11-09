use super::*;
use sha2::{Digest, Sha256};

// Only a digest is retained; neither credentials nor model output become a saved setting.
#[derive(PartialEq)]
pub struct ModelTestBinding([u8; 32]);
impl ModelTestBinding {
    pub fn new(input: &ModelInput, key: &[u8]) -> Result<Self, Error> {
        let metadata = serde_json::to_vec(&serde_json::json!([
            input.id,
            input.expected_revision,
            input.config
        ]))
        .map_err(|e| Error::Worker(Box::new(e)))?;
        let mut hash = Sha256::new();
        hash.update(metadata);
        hash.update([0]);
        hash.update(key);
        Ok(Self(hash.finalize().into()))
    }
}

pub(super) struct TestReceipt {
    pub at: Instant,
    binding: ModelTestBinding,
}
impl Models {
    pub async fn test_model(
        &self,
        config: &Config,
        key: &[u8],
        binding: ModelTestBinding,
    ) -> Result<ModelTest, Error> {
        if self.stop.is_cancelled() {
            return Err(Error::ShuttingDown);
        }
        let _permit = self.slots.try_acquire().map_err(|_| Error::Busy)?;
        let started = Instant::now();
        // Fixed, visible purpose. No server data, history, tools, or executable suggestions.
        let body = serde_json::json!({
            "model": config.model,
            "messages": [{"role":"user","content":"ServerDeck connection test. Reply OK."}],
            "max_completion_tokens": 256,
            "stream": false,
            "store": false
        });
        tokio::select! {
            result = OpenAiCompatible.complete(config, key, &body) => { result?; },
            _ = self.stop.cancelled() => return Err(Error::ShuttingDown),
        }
        self.record_model_test(binding, started.elapsed().as_millis() as u64)
    }
    fn record_model_test(
        &self,
        binding: ModelTestBinding,
        elapsed_ms: u64,
    ) -> Result<ModelTest, Error> {
        let mut state = lock(&self.state)?;
        state.prune();
        if state.tests.len() >= 32 {
            return Err(Error::Busy);
        }
        let id = uuid::Uuid::new_v4().to_string();
        state.tests.insert(
            id.clone(),
            TestReceipt {
                at: Instant::now(),
                binding,
            },
        );
        Ok(ModelTest {
            id,
            elapsed_ms,
            expires_in_seconds: 300,
        })
    }
    pub fn consume_model_test(
        &self,
        id: Option<&str>,
        binding: &ModelTestBinding,
    ) -> Result<(), Error> {
        let mut state = lock(&self.state)?;
        state.prune();
        let receipt = id.and_then(|id| state.tests.remove(id));
        if receipt.is_none_or(|t| t.binding != *binding) {
            return Err(Error::Validation(
                "请先测试当前模型配置，测试通过后五分钟内保存",
            ));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn input(config: Config) -> ModelInput {
        ModelInput {
            id: None,
            expected_revision: None,
            name: "test".into(),
            config,
            api_key: Some(zeroize::Zeroizing::new("test-key".into())),
            clear_key: false,
            test_id: None,
        }
    }
    #[test]
    fn receipts_expire_and_do_not_accept_another_binding_or_replay() {
        let assistant = Models::default();
        let input = input(Config {
            model: "fixture".into(),
            ..Default::default()
        });
        let binding = || ModelTestBinding::new(&input, b"test-key").unwrap();
        let receipt = assistant.record_model_test(binding(), 1).unwrap();
        lock(&assistant.state)
            .unwrap()
            .tests
            .get_mut(&receipt.id)
            .unwrap()
            .at = Instant::now() - Duration::from_secs(301);
        assert!(
            assistant
                .consume_model_test(Some(&receipt.id), &binding())
                .is_err()
        );
        let receipt = assistant.record_model_test(binding(), 1).unwrap();
        assert!(
            assistant
                .consume_model_test(Some(&receipt.id), &binding())
                .is_ok()
        );
        assert!(
            assistant
                .consume_model_test(Some(&receipt.id), &binding())
                .is_err()
        );
        let receipt = assistant.record_model_test(binding(), 1).unwrap();
        assert!(
            assistant
                .consume_model_test(
                    Some(&receipt.id),
                    &ModelTestBinding::new(&input, b"other-key").unwrap()
                )
                .is_err()
        );
    }
    #[tokio::test]
    async fn failed_http_protocol_and_tool_responses_never_issue_receipts() {
        for (status, body) in [
            ("401 Unauthorized", "{}"),
            ("503 Unavailable", "{}"),
            ("200 OK", "not-json"),
            (
                "200 OK",
                r#"{"choices":[{"message":{"content":"OK","tool_calls":[{}]},"finish_reason":"stop"}]}"#,
            ),
        ] {
            let assistant = Models::default();
            let (config, http, _) = crate::tests::http_fixture(status, body.into(), false).await;
            let input = input(config);
            assert!(
                assistant
                    .test_model(
                        &input.config,
                        b"test-key",
                        ModelTestBinding::new(&input, b"test-key").unwrap()
                    )
                    .await
                    .is_err()
            );
            http.await.unwrap();
            assert!(lock(&assistant.state).unwrap().tests.is_empty());
        }
    }
}
