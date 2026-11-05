use super::*;
use tokio_util::sync::CancellationToken;

impl Application {
    pub(super) async fn ai_builtin_context(
        &self,
        binding: &Binding,
        context: &mut Value,
        warnings: &mut Vec<String>,
        cancel: &CancellationToken,
    ) -> Result<(), Error> {
        let id = &binding.session.id;
        context["server"] =
            json!({"hostname":binding.hostname,"username":binding.username,"port":binding.port});
        match self.monitors.sample_once(id, cancel).await {
            Ok(sample) => {
                context["system"] = json!(sample.system);
                context["metrics"] = json!({"sampledAt":sample.sampled_at,"uptime":sample.uptime,"load":sample.load,"cpus":sample.cpus,"memory":sample.memory,"disks":sample.disks,"network":sample.network,"warnings":sample.warnings});
            }
            Err(error) => unavailable(context, "metrics", binding, warnings, error),
        }
        for (key, request) in [
            ("processes", Request::Processes),
            ("docker", Request::Containers),
        ] {
            match self.operations_host.query(id, request).await {
                Ok(response) => {
                    if !response.success {
                        warnings.push(format!(
                            "主机 {} 的 {key} 读取失败：{}",
                            binding.session.host_id,
                            response.message.as_deref().unwrap_or("远端查询失败")
                        ));
                    }
                    context[key] =
                        serde_json::to_value(response).map_err(|e| Error::Worker(Box::new(e)))?;
                }
                Err(error) => unavailable(context, key, binding, warnings, error),
            }
        }
        match self.operations_host.system_log_excerpt(id).await {
            Ok(response) => {
                context["selectedLog"] =
                    json!({"source":{"kind":"system_journal"},"lines":100,"data":response});
            }
            Err(error) => unavailable(context, "selectedLog", binding, warnings, error),
        }
        // Optional data failures can be reported to the model, but an invalid connection cannot.
        self.ai_verify_binding(binding)
    }
}

fn unavailable(
    context: &mut Value,
    key: &str,
    binding: &Binding,
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
}
