use super::*;
use tokio_util::sync::CancellationToken;
mod summary;
use summary::{bound_strings, has_omissions, summarize};

#[derive(Debug, Default, PartialEq)]
pub(super) struct Plan {
    metrics: bool,
    processes: bool,
    docker: bool,
    journal: bool,
    services: bool,
    ports: bool,
    logs: bool,
}
impl Plan {
    fn classify(question: &str) -> Self {
        let q = question.to_lowercase();
        let has = |words: &[&str]| words.iter().any(|word| q.contains(word));
        let docker = has(&["docker", "container", "容器", "compose", "swarm"]);
        let processes = has(&["process", "进程", "线程", "pid"])
            || (has(&["cpu", "内存", "memory", "负载", "load"])
                && has(&["高", "排查", "为什么", "原因", "why", "high"]));
        let metrics = has(&[
            "cpu",
            "负载",
            "load",
            "内存",
            "memory",
            "磁盘",
            "disk",
            "空间",
            "网络",
            "network",
            "带宽",
            "流量",
            "uptime",
            "运行时间",
            "系统信息",
            "系统版本",
            "操作系统",
            "内核",
            "几核",
        ]);
        let logs = has(&["日志", "journal", "logs", "log "]);
        let services = has(&["systemd", "systemctl", ".service"])
            || (!docker && q.replace("服务器", "").contains("服务"));
        let ports = has(&["端口", "port", "监听"]);
        let health = !docker
            && !processes
            && !metrics
            && !services
            && !ports
            && !logs
            && has(&[
                "健康",
                "性能",
                "卡顿",
                "缓慢",
                "很慢",
                "无响应",
                "故障",
                "排查",
                "diagnos",
                "服务器状态",
                "主机状态",
                "运行状况",
            ]);
        Self {
            metrics: metrics || health,
            processes: processes || health,
            docker,
            journal: logs && (!docker || has(&["系统日志", "systemd", "journal"])),
            services,
            ports,
            logs,
        }
    }
    pub(super) fn for_question(question: &str, history: &[ChatMessage]) -> Self {
        let mut plan = Self::classify(question);
        // Only an ambiguous follow-up inherits the last user's domain. An explicit
        // new topic must not accumulate all domains seen in the conversation.
        if !plan.metrics
            && !plan.processes
            && !plan.docker
            && !plan.services
            && !plan.ports
            && ((plan.logs
                && !["系统日志", "systemd", "journal"]
                    .iter()
                    .any(|word| question.to_lowercase().contains(word)))
                || [
                    "那",
                    "它",
                    "这些",
                    "继续",
                    "刚才",
                    "其中",
                    "再看",
                    "them",
                    "what about",
                ]
                .iter()
                .any(|word| question.to_lowercase().contains(word)))
            && let Some(previous) = history
                .iter()
                .rev()
                .filter(|message| matches!(message.role, ChatRole::User))
                .map(|message| Self::classify(&message.content))
                .find(|plan| {
                    plan.metrics || plan.processes || plan.docker || plan.services || plan.ports
                })
        {
            plan.metrics = previous.metrics;
            plan.processes = previous.processes;
            plan.docker = previous.docker;
            plan.services = previous.services;
            plan.ports = previous.ports;
            plan.journal = plan.logs && !plan.docker;
        }
        plan
    }
    fn sources(&self) -> Vec<&'static str> {
        [
            (self.metrics, "metrics"),
            (self.processes, "processes"),
            (self.docker, "docker"),
            (self.journal, "selectedLog"),
            (self.services, "services"),
            (self.ports, "ports"),
        ]
        .into_iter()
        .filter_map(|(enabled, name)| enabled.then_some(name))
        .collect()
    }
}

impl Application {
    pub(super) async fn ai_builtin_context(
        &self,
        binding: &Binding,
        plan: &Plan,
        redactor: &Redactor,
        cancel: &CancellationToken,
    ) -> Result<(Value, Vec<String>), Error> {
        let mut context = json!({});
        let mut warnings = Vec::new();
        let id = &binding.session.id;
        context["server"] =
            json!({"hostname":binding.hostname,"username":binding.username,"port":binding.port});
        context["collection"] = json!({"sources":plan.sources(),"policy":"仅采集本轮问题相关数据；未列出的来源未采集，不能推断其状态"});
        if plan.metrics {
            match self.monitors.sample_once(id, cancel).await {
                Ok(sample) => {
                    context["system"] = json!(sample.system);
                    let mut disks = sample.disks;
                    disks.sort_by(|a, b| {
                        b.usage
                            .partial_cmp(&a.usage)
                            .unwrap_or(std::cmp::Ordering::Equal)
                    });
                    let disk_total = disks.len();
                    let network_total = sample.network.len();
                    context["metrics"] = json!({"sampledAt":sample.sampled_at,"uptime":sample.uptime,"load":sample.load,
                    "cpu":sample.cpus.iter().find(|cpu| cpu.name == "cpu"),"memory":sample.memory,
                    "diskTotal":disk_total,"disks":disks.into_iter().take(8).collect::<Vec<_>>(),"omittedDisks":disk_total.saturating_sub(8),
                    "networkTotal":network_total,"network":sample.network.into_iter().take(8).collect::<Vec<_>>(),"omittedNetwork":network_total.saturating_sub(8),"warnings":sample.warnings});
                    redactor.value(&mut context["system"]);
                    redactor.value(&mut context["metrics"]);
                    bound_strings(&mut context["system"], 256);
                    bound_strings(&mut context["metrics"], 256);
                }
                Err(error) => unavailable(
                    &mut context,
                    "metrics",
                    binding,
                    redactor,
                    &mut warnings,
                    error,
                ),
            }
        }
        for (enabled, key, request) in [
            (plan.processes, "processes", Request::Processes),
            (plan.docker, "docker", Request::Containers),
            (
                plan.services,
                "services",
                Request::Services {
                    scope: serverdeck_core::ops::Scope::System,
                },
            ),
            (plan.ports, "ports", Request::Ports),
        ] {
            if !enabled {
                continue;
            }
            if cancel.is_cancelled() {
                return Err(failure("PLUGIN_CANCELLED", "插件请求已取消"));
            }
            match self.operations_host.query(id, request).await {
                Ok(mut response) if response.success => {
                    // Redact before shortening fields so a partial credential is
                    // never made unrecognizable to the final redaction pass.
                    for record in &mut response.records {
                        redactor.value(record);
                    }
                    response.message = response.message.map(|message| redactor.text(&message));
                    context[key] = summarize(key, response);
                }
                Ok(response) => {
                    warnings.push(format!(
                        "主机 {} 的 {key} 读取失败：{}",
                        binding.session.host_id,
                        response.message.as_deref().unwrap_or("远端查询失败")
                    ));
                    context[key] =
                        json!({"available":false,"code":response.code,"message":response.message});
                    redactor.value(&mut context[key]);
                    bound_strings(&mut context[key], 512);
                }
                Err(error) => {
                    unavailable(&mut context, key, binding, redactor, &mut warnings, error)
                }
            }
        }
        if plan.journal {
            match self.operations_host.system_log_excerpt(id).await {
                Ok(response) => {
                    let output = response
                        .detail
                        .as_ref()
                        .and_then(|value| value["output"].as_str())
                        .unwrap_or("");
                    let output = redactor.text(output);
                    let mut start = output.len().saturating_sub(4096);
                    while !output.is_char_boundary(start) {
                        start += 1;
                    }
                    context["selectedLog"] = json!({"available":true,"source":{"kind":"system_journal"},"maxQueriedLines":100,
                    "output":&output[start..],"omittedBytes":start,"scope":"系统 journal 最近片段，非完整日志"});
                }
                Err(error) => unavailable(
                    &mut context,
                    "selectedLog",
                    binding,
                    redactor,
                    &mut warnings,
                    error,
                ),
            }
        } else if plan.logs && plan.docker {
            warnings.push("本轮仅采集容器状态，未读取容器日志；日志证据可在 Docker 管理的对应容器日志中查看。".into());
        }
        if has_omissions(&context) {
            warnings.push(format!(
                "主机 {} 的上下文已汇总，部分明细或日志已省略；完整查询计数保留，省略范围已标注。",
                binding.session.host_id
            ));
        }
        // Optional data failures can be reported to the model, but an invalid connection cannot.
        self.ai_verify_binding(binding)?;
        Ok((context, warnings))
    }
}

fn unavailable(
    context: &mut Value,
    key: &str,
    binding: &Binding,
    redactor: &Redactor,
    warnings: &mut Vec<String>,
    error: Error,
) {
    let error = serverdeck_core::IpcError::from(error);
    tracing::warn!(
        operation = "assistant_context",
        field = key,
        code = error.code,
        "context unavailable"
    );
    warnings.push(format!(
        "主机 {} 的 {key} 不可用：{}",
        binding.session.host_id, error.message
    ));
    context[key] = json!({"available":false,"error":error});
    redactor.value(&mut context[key]);
    bound_strings(&mut context[key], 512);
}

pub(super) use summary::fit_budget;
#[cfg(test)]
mod tests;
