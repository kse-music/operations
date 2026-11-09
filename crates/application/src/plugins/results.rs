use super::{
    state::{self, Call, failure},
    *,
};
use base64::Engine as _;
use serde_json::{Value, json};
use serverdeck_plugin_core::permissions::denied;
use std::time::{Duration, Instant};
const CHUNK: usize = 32768;
const INLINE_RESULT: usize = 1024;
const RESULT_LIMIT: usize = 1024 * 1024;
impl Application {
    pub(super) fn plugin_result(&self, call: &Call, value: Value) -> Result<Value, Error> {
        let bytes = serde_json::to_vec(&value).map_err(|e| Error::Worker(Box::new(e)))?;
        if bytes.len() <= INLINE_RESULT {
            return Ok(value);
        }
        if bytes.len() > RESULT_LIMIT {
            return Err(failure(
                "PLUGIN_OUTPUT_LIMIT",
                "平台数据超过 1 MiB，请缩小范围",
            ));
        }
        let mut data = self.plugin_host.lock()?;
        data.results
            .retain(|_, result| result.at.elapsed() < Duration::from_secs(60));
        if data.results.len() >= 8
            || data
                .results
                .values()
                .filter(|result| result.plugin == call.id)
                .count()
                >= 2
            || data
                .results
                .values()
                .map(|result| result.bytes.len())
                .sum::<usize>()
                + bytes.len()
                > 8 * 1024 * 1024
        {
            return Err(Error::Busy);
        }
        let id = uuid::Uuid::new_v4().to_string();
        let count = bytes.len().div_ceil(CHUNK);
        let length = bytes.len();
        data.results.insert(
            id.clone(),
            state::ResultData {
                owner: call.owner.clone(),
                plugin: call.id.clone(),
                generation: call.generation.clone(),
                bytes,
                at: Instant::now(),
            },
        );
        Ok(json!({"__pluginResult":{"id":id,"chunks":count,"bytes":length}}))
    }

    pub(super) fn plugin_result_read(
        &self,
        call: &Call,
        result_id: &str,
        chunk: u32,
    ) -> Result<Value, Error> {
        let data = self.plugin_host.lock()?;
        let result = data.results.get(result_id).ok_or(Error::NotFound)?;
        if result.plugin != call.id
            || result.owner != call.owner
            || result.generation != call.generation
            || result.at.elapsed() >= Duration::from_secs(60)
        {
            return Err(denied());
        }
        let offset = (chunk as usize).checked_mul(CHUNK).ok_or_else(denied)?;
        if offset >= result.bytes.len() {
            return Err(Error::Validation("结果分块超出范围"));
        }
        Ok(
            json!({"chunk":chunk,"dataBase64":base64::engine::general_purpose::STANDARD.encode(&result.bytes[offset..(offset+CHUNK).min(result.bytes.len())])}),
        )
    }
    pub(super) fn plugin_result_close(&self, call: &Call, result_id: &str) -> Result<Value, Error> {
        let mut data = self.plugin_host.lock()?;
        if let Some(result) = data.results.get(result_id) {
            if result.plugin != call.id
                || result.generation != call.generation
                || result.owner != call.owner
            {
                return Err(denied());
            }
            data.results.remove(result_id);
        }
        Ok(Value::Null)
    }
}
