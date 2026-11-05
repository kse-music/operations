use super::*;

pub(super) fn summarize(key: &str, mut response: Response) -> Value {
    let total = response.records.len();
    let mut summary = json!({"total":total});
    let fields: &[&str] = match key {
        "docker" => {
            let mut states = std::collections::BTreeMap::<String, usize>::new();
            for record in &response.records {
                let state = record["State"].as_str().unwrap_or("unknown").to_lowercase();
                // Only known enum values become keys; remote text cannot grow the map.
                let state = if [
                    "running",
                    "paused",
                    "restarting",
                    "exited",
                    "created",
                    "dead",
                    "removing",
                ]
                .contains(&state.as_str())
                {
                    state.as_str()
                } else {
                    "unknown"
                };
                *states.entry(state.into()).or_default() += 1;
            }
            summary["states"] = json!(states);
            summary["running"] = json!(states.get("running").copied().unwrap_or(0));
            summary["scope"] = json!("当前 Docker daemon 的全部容器，非 Compose/Swarm 服务数量");
            &["ID", "Names", "Image", "State", "Status", "Ports"]
        }
        "processes" => {
            response.records.sort_by(|a, b| {
                b["cpu"]
                    .as_f64()
                    .unwrap_or(0.0)
                    .total_cmp(&a["cpu"].as_f64().unwrap_or(0.0))
            });
            summary["order"] = json!("CPU 降序，仅明细限量，总数未截断");
            &["pid", "user", "cpu", "memory", "elapsed", "command"]
        }
        "services" => {
            for state in ["active", "inactive", "failed"] {
                summary[state] = json!(
                    response
                        .records
                        .iter()
                        .filter(|record| record["active"] == state)
                        .count()
                );
            }
            summary["scope"] = json!("system 作用域的 systemd 服务单元");
            response
                .records
                .sort_by_key(|record| record["active"] != "failed");
            &["unit", "load", "active", "sub", "description", "enabled"]
        }
        _ => &["protocol", "state", "local", "peer", "process"],
    };
    let mut records = Vec::new();
    let mut detail_bytes = 0;
    let mut truncated = false;
    for record in response.records.iter().take(12) {
        let mut row = json!({});
        for field in fields {
            if let Some(value) = record.get(*field) {
                row[*field] = value.clone();
            }
        }
        truncated |= bound_strings(&mut row, 256);
        let bytes = row.to_string().len();
        if detail_bytes + bytes > 4096 {
            break;
        }
        detail_bytes += bytes;
        records.push(row);
    }
    json!({"available":true,"summary":summary,"omittedRecords":total-records.len(),"records":records,"truncatedFields":truncated,"message":response.message.map(|text| clipped(&text,512))})
}

fn clipped(text: &str, limit: usize) -> String {
    if text.len() <= limit {
        return text.to_owned();
    }
    let mut end = limit;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}[已省略]", &text[..end])
}
pub(super) fn bound_strings(value: &mut Value, limit: usize) -> bool {
    match value {
        Value::String(text) if text.len() > limit => {
            *text = clipped(text, limit);
            true
        }
        Value::Array(values) => values.iter_mut().fold(false, |changed, value| {
            bound_strings(value, limit) | changed
        }),
        Value::Object(values) => values.values_mut().fold(false, |changed, value| {
            bound_strings(value, limit) | changed
        }),
        _ => false,
    }
}
pub(super) fn has_omissions(value: &Value) -> bool {
    match value {
        Value::Object(fields) => fields.iter().any(|(key, value)| {
            ((key.starts_with("omitted") && value.as_u64().is_some_and(|count| count > 0))
                || (key == "truncatedFields" && value == true))
                || has_omissions(value)
        }),
        Value::Array(values) => values.iter().any(has_omissions),
        Value::String(text) => text.ends_with("[已省略]"),
        _ => false,
    }
}

pub(in crate::ai) fn fit_budget(input: &mut serverdeck_ai::PreparedContext) -> Result<(), Error> {
    if serverdeck_ai::request_size(input)? <= serverdeck_ai::REQUEST_LIMIT_BYTES {
        return Ok(());
    }
    // Preserve summaries and failures for every host, dropping optional details.
    strip_details(&mut input.context);
    input.context["collectionBudget"] = json!("请求预算不足，明细已省略，保留统计和不可用原因");
    input
        .warnings
        .push("为控制请求大小，本轮已省略明细，保留各主机统计和读取失败原因。".into());
    let mut omitted_turns = 0;
    while serverdeck_ai::request_size(input)? > serverdeck_ai::REQUEST_LIMIT_BYTES
        && input.history.len() >= 2
    {
        input.history.drain(..2);
        omitted_turns += 1;
        input.context["omittedHistoryTurns"] = json!(omitted_turns);
    }
    if omitted_turns > 0 {
        input.warnings.push(format!(
            "请求预算不足，已省略最早的 {omitted_turns} 轮历史对话。"
        ));
    }
    Ok(()) // Final send boundary still rejects oversized mandatory content.
}
fn strip_details(context: &mut Value) {
    if let Some(hosts) = context.get_mut("hosts").and_then(Value::as_array_mut) {
        for host in hosts {
            strip_details(host);
        }
        return;
    }
    for key in ["docker", "processes", "services", "ports"] {
        if let Some(records) = context
            .get_mut(key)
            .and_then(|source| source.get_mut("records"))
            .and_then(Value::as_array_mut)
        {
            records.clear();
            context[key]["omittedRecords"] = context[key]["summary"]["total"].clone();
        }
    }
    if let Some(metrics) = context
        .get_mut("metrics")
        .filter(|value| value.get("sampledAt").is_some())
    {
        metrics["disks"] = json!([]);
        metrics["omittedDisks"] = metrics["diskTotal"].clone();
        metrics["network"] = json!([]);
        metrics["omittedNetwork"] = metrics["networkTotal"].clone();
    }
    if let Some(output) = context["selectedLog"]["output"].as_str() {
        let omitted =
            context["selectedLog"]["omittedBytes"].as_u64().unwrap_or(0) + output.len() as u64;
        context["selectedLog"]["output"] = json!("");
        context["selectedLog"]["omittedBytes"] = json!(omitted);
    }
}
