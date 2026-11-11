use crate::Error;
use serde_json::{Value, json};
use serverdeck_plugin_sdk::platform::{Message, Role};

pub struct Fitted {
    pub messages: Vec<Message>,
    pub warnings: Vec<String>,
    pub input_tokens: usize,
}

fn measure(
    messages: &[Message],
    model: &Value,
    limit: usize,
    stream: bool,
) -> Result<(bool, usize), Error> {
    let output = model["config"]["maxOutputTokens"].as_u64().unwrap_or(2048);
    let window = model["config"]["contextWindowTokens"]
        .as_u64()
        .unwrap_or(131072);
    let mut wire = json!({"model":model["config"]["model"],"messages":messages,"max_completion_tokens":output,"stream":stream,"store":false});
    if stream
        && !matches!(
            model["config"]["provider"].as_str(),
            Some("local_codex" | "local_claude_code")
        )
    {
        wire["stream_options"] = json!({"include_usage":true});
    }
    let input = serde_json::to_vec(&wire)
        .map_err(|e| Error::Worker(Box::new(e)))?
        .len()
        .saturating_add(64);
    let bytes = serde_json::to_vec(messages)
        .map_err(|e| Error::Worker(Box::new(e)))?
        .len();
    Ok((
        bytes <= limit && (input as u64).saturating_add(output) <= window,
        input,
    ))
}

fn reduce_rows(value: &mut Value, field: &str, omitted: &str, keep: usize) -> bool {
    let Some(rows) = value.get_mut(field).and_then(Value::as_array_mut) else {
        return false;
    };
    let removed = rows.len().saturating_sub(keep);
    if removed == 0 {
        return false;
    }
    rows.truncate(keep);
    value[omitted] = json!(
        value[omitted]
            .as_u64()
            .unwrap_or(0)
            .saturating_add(removed as u64)
    );
    true
}

fn reduce_section(value: &mut Value, keep: usize) -> bool {
    // Failure reasons and complete-result counts are mandatory, not optional detail.
    if !value.is_object() || value["available"] == false || value["success"] == false {
        return false;
    }
    let mut changed = reduce_rows(value, "records", "omittedRecords", keep);
    if keep == 0 && !value["detail"].is_null() {
        value["detail"] = Value::Null;
        value["omittedDetails"] = json!(true);
        changed = true;
    }
    if keep == 0
        && value["output"]
            .as_str()
            .is_some_and(|text| !text.is_empty())
    {
        let bytes = value["output"].as_str().map_or(0, str::len);
        value["output"] = json!("");
        value["omittedBytes"] = json!(bytes);
        changed = true;
    }
    changed
}

fn reduce_payload(value: &mut Value, keep: usize) -> bool {
    let mut changed = false;
    if let Some(hosts) = value
        .get_mut("context")
        .and_then(|context| context.get_mut("hosts"))
        .and_then(Value::as_array_mut)
    {
        for host in hosts {
            for key in ["processes", "docker", "services", "ports", "selectedLog"] {
                if let Some(section) = host.get_mut(key) {
                    changed |= reduce_section(section, keep);
                }
            }
            if let Some(metrics) = host.get_mut("metrics") {
                changed |= reduce_rows(metrics, "disks", "omittedDisks", keep);
                changed |= reduce_rows(metrics, "network", "omittedNetwork", keep);
            }
        }
    }
    if let Some(assets) = value
        .get_mut("context")
        .and_then(|context| context.get_mut("assets"))
    {
        changed |= reduce_rows(assets, "records", "omittedRecords", keep);
    }
    if let Some(results) = value
        .get_mut("untrustedToolResults")
        .and_then(Value::as_array_mut)
    {
        for result in results {
            if let Some(value) = result.get_mut("result") {
                changed |= reduce_section(value, keep);
            }
        }
    }
    changed
}

fn question_index(messages: &[Message]) -> Option<usize> {
    messages.iter().rposition(|message| {
        matches!(message.role, Role::User)
            && serde_json::from_str::<Value>(&message.content)
                .is_ok_and(|value| value["question"].is_string() && value["context"].is_object())
    })
}

pub fn fit(messages: Vec<Message>, model: &Value, limit: usize) -> Result<Fitted, Error> {
    fit_transport(messages, model, limit, false)
}
pub fn fit_stream(messages: Vec<Message>, model: &Value, limit: usize) -> Result<Fitted, Error> {
    fit_transport(messages, model, limit, true)
}
fn fit_transport(
    mut messages: Vec<Message>,
    model: &Value,
    limit: usize,
    stream: bool,
) -> Result<Fitted, Error> {
    let mut reduced = false;
    let mut dropped = 0;
    let (mut fits, mut input_tokens) = measure(&messages, model, limit, stream)?;
    for keep in [3, 0] {
        if fits {
            break;
        }
        let mut changed = false;
        let start = question_index(&messages).unwrap_or(messages.len());
        for message in &mut messages[start..] {
            if !matches!(message.role, Role::User) {
                continue;
            }
            if let Ok(mut payload) = serde_json::from_str::<Value>(&message.content)
                && reduce_payload(&mut payload, keep)
            {
                message.content = payload.to_string();
                changed = true;
            }
        }
        if changed {
            reduced = true;
            (fits, input_tokens) = measure(&messages, model, limit, stream)?;
        }
    }
    while !fits {
        // Only remove old, complete user/assistant chat turns preceding the current
        // question. Never remove system policy, the question or a tool-result pair.
        let question = question_index(&messages);
        if question.is_none_or(|index| index < 3)
            || !matches!(messages[1].role, Role::User)
            || !matches!(messages[2].role, Role::Assistant)
        {
            return Err(Error::Validation(
                "问题、必需统计和失败信息超过模型请求预算，请缩小问题或主机范围",
            ));
        }
        messages.drain(1..3);
        dropped += 1;
        let index = question.ok_or(Error::Validation("当前问题上下文缺失"))? - 2;
        let mut value: Value = serde_json::from_str(&messages[index].content)
            .map_err(|e| Error::Worker(Box::new(e)))?;
        value["context"]["omittedHistoryTurns"] = json!(
            value["context"]["omittedHistoryTurns"]
                .as_u64()
                .unwrap_or(0)
                .saturating_add(1)
        );
        messages[index].content = value.to_string();
        (fits, input_tokens) = measure(&messages, model, limit, stream)?;
    }
    let mut warnings = Vec::new();
    if reduced {
        warnings.push("上下文明细因请求预算已省略；完整统计、主机归属和采集失败仍保留。".into());
    }
    if dropped > 0 {
        warnings.push(format!(
            "请求预算不足，已省略 {dropped} 个最早的完整对话轮次。"
        ));
    }
    Ok(Fitted {
        messages,
        warnings,
        input_tokens,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message(role: Role, content: &str) -> Message {
        Message {
            role,
            content: content.into(),
        }
    }

    #[test]
    fn stream_budget_counts_the_actual_transport_fields_before_sending() {
        let mut model = json!({"config":{"provider":"openai_compatible","model":"fixture","contextWindowTokens":10000,"maxOutputTokens":256}});
        let messages = vec![
            message(Role::System, "policy"),
            message(Role::User, "question"),
        ];
        let (_, base) = measure(&messages, &model, 44000, false).unwrap();
        let (_, stream) = measure(&messages, &model, 44000, true).unwrap();
        let wire = json!({"model":"fixture","messages":messages,"max_completion_tokens":256,"stream":true,"stream_options":{"include_usage":true},"store":false});
        assert_eq!(stream, serde_json::to_vec(&wire).unwrap().len() + 64);
        assert!(stream > base);
        model["config"]["contextWindowTokens"] = json!(base + 256);
        assert!(fit(messages.clone(), &model, 44000).is_ok());
        assert!(fit_stream(messages, &model, 44000).is_err());
    }
    #[test]
    fn compresses_current_optional_details_before_history_and_preserves_tool_failures() {
        let history = json!({"question":"old","context":{"hosts":[{"docker":{"records":["unchanged historical text"]}}]}}).to_string();
        let payload = json!({"question":"current","context":{"hosts":[{"hostId":"host","docker":{"available":true,"summary":{"total":20},"records":vec!["x".repeat(400);20],"omittedRecords":0}}]}});
        let tool = json!({"untrustedToolResults":[{"result":{"success":false,"records":["failure evidence"],"message":"query failed","detail":{"reason":"preserve me"}}},{"result":{"success":true,"totalRecords":20,"records":vec!["y".repeat(400);20],"omittedRecords":0}}]});
        let messages = vec![
            message(Role::System, "policy"),
            message(Role::User, &history),
            message(Role::Assistant, "previous answer"),
            message(Role::User, &payload.to_string()),
            message(Role::Assistant, "query"),
            message(Role::User, &tool.to_string()),
        ];
        let fitted = fit(
            messages,
            &json!({"config":{"contextWindowTokens":5000,"maxOutputTokens":1024}}),
            44000,
        )
        .unwrap();
        assert_eq!(
            fitted.messages.len(),
            6,
            "optional details must go before complete history turns"
        );
        assert_eq!(
            fitted.messages[1].content, history,
            "history must remain unmodified"
        );
        let current: Value = serde_json::from_str(&fitted.messages[3].content).unwrap();
        assert_eq!(
            current["context"]["hosts"][0]["docker"]["summary"]["total"],
            20
        );
        let results: Value = serde_json::from_str(&fitted.messages[5].content).unwrap();
        assert_eq!(
            results["untrustedToolResults"][0],
            tool["untrustedToolResults"][0]
        );
        assert!(
            results["untrustedToolResults"][1]["result"]["omittedRecords"]
                .as_u64()
                .unwrap()
                > 0
        );
        assert!(fitted.input_tokens + 1024 <= 5000);
    }

    #[test]
    fn drops_old_json_history_as_complete_turns_without_confusing_it_with_current_context() {
        for old in [
            "[]".to_owned(),
            json!({"question":"old","context":{"hosts":[]},"large":"\\\"".repeat(2000)})
                .to_string(),
        ] {
            let messages = vec![
                message(Role::System, "policy"),
                message(Role::User, &old),
                message(Role::Assistant, &"a".repeat(5000)),
                message(
                    Role::User,
                    r#"{"question":"current","context":{"hosts":[],"omittedHistoryTurns":2}}"#,
                ),
            ];
            let fitted = fit(
                messages,
                &json!({"config":{"contextWindowTokens":4096,"maxOutputTokens":1024}}),
                44000,
            )
            .unwrap();
            assert_eq!(fitted.messages.len(), 2);
            let current: Value = serde_json::from_str(&fitted.messages[1].content).unwrap();
            assert_eq!(current["question"], "current");
            assert_eq!(current["context"]["omittedHistoryTurns"], 3);
        }
    }
}
