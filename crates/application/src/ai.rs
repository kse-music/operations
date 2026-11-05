use super::*;
use serde_json::{Value, json};
use serverdeck_ai::{Binding, failure, provider, redact::Redactor};
use serverdeck_core::{
    ai::*,
    hosts::Mutation,
    ops::{Request, Response},
};
use serverdeck_storage::ai::ModelRecord;
use zeroize::Zeroizing;
mod agent;
mod context;
mod routing;

impl Application {
    pub async fn ai_model_test(&self, input: ModelInput) -> Result<ModelTest, Error> {
        input.validate()?;
        provider::endpoint(&input.config)?;
        let secrets = self.secrets.clone();
        let (config, key, binding) = self
            .blocking(move |db| {
                let old = input.id.as_deref().map(|id| db.ai_model(id)).transpose()?;
                check_model_edit(&input, old.as_ref())?;
                let key = model_key(&input, old.as_ref(), secrets.as_ref())?;
                let binding = serverdeck_ai::ModelTestBinding::new(&input, &key)?;
                Ok((input.config, key, binding))
            })
            .await?;
        self.assistant.test_model(&config, &key, binding).await
    }
    pub async fn ai_models(&self) -> Result<Vec<Model>, Error> {
        self.blocking(|db| Ok(db.ai_models()?.iter().map(ModelRecord::public).collect()))
            .await
    }
    pub async fn ai_model_save(&self, input: ModelInput) -> Result<Mutation<Model>, Error> {
        input.validate()?;
        provider::endpoint(&input.config)?;
        let secrets = self.secrets.clone();
        let assistant = self.assistant.clone();
        let result = self
            .blocking(move |db| {
                let old = input.id.as_deref().map(|id| db.ai_model(id)).transpose()?;
                check_model_edit(&input, old.as_ref())?;
                if old.as_ref().is_none_or(|m| m.config != input.config) || input.api_key.is_some()
                {
                    let key = model_key(&input, old.as_ref(), secrets.as_ref())?;
                    let binding = serverdeck_ai::ModelTestBinding::new(&input, &key)?;
                    assistant.consume_model_test(input.test_id.as_deref(), &binding)?;
                }
                let reference = if input.api_key.is_some() {
                    Some(uuid::Uuid::new_v4().to_string())
                } else if input.clear_key {
                    None
                } else {
                    old.as_ref().and_then(|m| m.secret_ref.clone())
                };
                if let (Some(key), Some(reference)) = (&input.api_key, &reference) {
                    db.queue_secret_gc(reference)?;
                    secrets.write(reference, key.as_bytes())?;
                }
                let record = ModelRecord {
                    id: input.id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
                    name: input.name.trim().into(),
                    config: input.config,
                    secret_ref: reference,
                    revision: uuid::Uuid::new_v4().to_string(),
                };
                // On commit failure the new immutable secret stays in durable GC for explicit cleanup.
                let record = db.ai_model_save(record, input.expected_revision.as_deref())?;
                Ok(Mutation {
                    value: record.public(),
                    warnings: super::hosts::cleanup(&db, secrets.as_ref()),
                })
            })
            .await?;
        self.assistant.revoke_model(&result.value.id)?;
        Ok(result)
    }
    pub async fn ai_model_delete(&self, input: ModelDeleteInput) -> Result<Mutation<()>, Error> {
        if !input.confirmed {
            return Err(Error::Validation("删除模型及其系统凭据需要明确确认"));
        }
        let secrets = self.secrets.clone();
        let id = input.id.clone();
        let result = self
            .blocking(move |db| {
                db.ai_model_delete(&input.id, &input.expected_revision)?;
                Ok(Mutation {
                    value: (),
                    warnings: super::hosts::cleanup(&db, secrets.as_ref()),
                })
            })
            .await?;
        self.assistant.revoke_model(&id)?;
        Ok(result)
    }
    async fn ai_credentials(
        &self,
        model_id: String,
    ) -> Result<(ModelRecord, Zeroizing<Vec<u8>>), Error> {
        let secrets = self.secrets.clone();
        self.blocking(move |db| {
            let record = db.ai_model(&model_id)?;
            provider::endpoint(&record.config)?;
            let reference = record.secret_ref.as_ref().ok_or(Error::Validation(
                "所选模型尚未设置 API Key，请到模型管理中编辑",
            ))?;
            let key = secrets
                .read(reference)?
                .ok_or(Error::Validation("系统凭据库中没有 AI Key，请重新保存"))?;
            Ok((record, key))
        })
        .await
    }
    fn ai_binding(&self, id: &str) -> Result<Binding, Error> {
        let profile = self.terminals.ops_profile(id)?;
        let session = self.terminals.session_info(id)?;
        let endpoint = self
            .terminals
            .connection_status()?
            .into_iter()
            .find(|s| s.id == id)
            .ok_or(Error::NotFound)?;
        Ok(Binding {
            session,
            profile,
            hostname: endpoint.hostname,
            username: endpoint.username,
            port: endpoint.port,
        })
    }
    fn ai_verify_binding(&self, binding: &Binding) -> Result<(), Error> {
        let current = self.ai_binding(&binding.session.id)?;
        if current.session.host_id != binding.session.host_id
            || current.session.transport_id != binding.session.transport_id
            || current.profile != binding.profile
        {
            return Err(Error::Conflict);
        }
        Ok(())
    }
    pub async fn ai_prepare(&self, input: PrepareInput) -> Result<Preview, Error> {
        self.ai_prepare_context(input, None).await
    }
    pub(crate) async fn ai_prepare_builtin(
        &self,
        mut input: PrepareInput,
        cancel: &tokio_util::sync::CancellationToken,
    ) -> Result<Preview, Error> {
        input.auto_hosts = true;
        input.mask_addresses = true;
        input.selection = ContextSelection {
            server: true,
            metrics: false,
            processes: false,
            docker: false,
            log: None,
            log_lines: 100,
        };
        tokio::select! {
            biased;
            _ = cancel.cancelled() => Err(failure("PLUGIN_CANCELLED", "插件请求已取消")),
            result = self.ai_prepare_context(input, Some(cancel)) => result,
        }
    }
    async fn ai_prepare_context(
        &self,
        input: PrepareInput,
        automatic: Option<&tokio_util::sync::CancellationToken>,
    ) -> Result<Preview, Error> {
        validate_history(&input.history)?;
        if input.question.trim().is_empty() || input.question.len() > 8192 {
            return Err(Error::Validation("问题须为 1–8192 字节"));
        }
        let selection = &input.selection;
        if input.redact_values.len() > 32 {
            return Err(Error::Validation("自定义脱敏值最多 32 项"));
        }
        let needs_server = selection.server
            || selection.metrics
            || selection.processes
            || selection.docker
            || selection.log.is_some();
        if input.session_ids.len() > 8
            || (!input.session_ids.is_empty() && input.session_id.is_some())
        {
            return Err(Error::Validation(
                "最多关联八个主机连接，且不能混用单连接参数",
            ));
        }
        if needs_server
            && input.session_id.is_none()
            && input.session_ids.is_empty()
            && !input.auto_hosts
        {
            return Err(Error::Validation(
                "所选上下文需要当前服务器的已验证 SSH 运维连接",
            ));
        }
        if selection.log.is_some() && !(1..=200).contains(&selection.log_lines) {
            return Err(Error::Validation("日志范围须为 1–200 行"));
        }
        let (record, key) = self.ai_credentials(input.model_id).await?;
        if input
            .expected_model_revision
            .as_ref()
            .is_some_and(|r| r != &record.revision)
        {
            return Err(Error::Conflict);
        }
        let ids: Vec<_> = input
            .session_id
            .iter()
            .chain(input.session_ids.iter())
            .collect();
        let mut seen = std::collections::HashSet::new();
        let bindings = ids
            .into_iter()
            .map(|id| {
                let b = self.ai_binding(id)?;
                if !seen.insert(b.session.host_id.clone()) {
                    return Err(Error::Validation("同一主机不能重复关联"));
                }
                Ok(b)
            })
            .collect::<Result<Vec<_>, Error>>()?;
        let mut values = input.redact_values;
        // Never echo the configured key into a request/answer, even if pasted into logs.
        if let Ok(key) = std::str::from_utf8(&key) {
            values.push(Zeroizing::new(key.to_owned()));
        }
        let redactor = Redactor::new(input.mask_addresses, values)?;
        let inventory = if input.auto_hosts {
            Some(
                self.blocking(|db| Ok(routing::assets(&db.catalog()?)))
                    .await?,
            )
        } else {
            None
        };
        if let Some(assets) = &inventory
            && bindings.iter().any(|b| {
                !assets.iter().any(|a| {
                    a.id == b.session.host_id
                        && a.hostname == b.hostname
                        && a.port == b.port
                        && a.username == b.username
                })
            })
        {
            return Err(Error::Conflict);
        }
        let mut host_contexts = Vec::new();
        let mut warnings = Vec::new();
        let plan = context::Plan::for_question(&input.question, &input.history);
        for binding in &bindings {
            let mut context = json!({});
            let id = &binding.session.id;
            if input.auto_hosts {
                context["matchedHost"] = json!({"hostId":binding.session.host_id,"hostname":binding.hostname,"username":binding.username,"port":binding.port,"connected":true});
            }
            if let Some(cancel) = automatic {
                let (mut collected, notices) = self
                    .ai_builtin_context(binding, &plan, &redactor, cancel)
                    .await?;
                collected["matchedHost"] = context["matchedHost"].take();
                warnings.extend(notices);
                host_contexts.push(collected);
                continue;
            }
            if selection.server {
                context["server"] = json!({"hostname":binding.hostname,"username":binding.username,"port":binding.port});
            }
            if selection.server || selection.metrics {
                let snapshot = match self.latest_monitor_snapshot(&binding.session.host_id) {
                    Ok(snapshot) => snapshot,
                    Err(Error::NotFound) => None,
                    Err(error) => return Err(error),
                };
                // Only reuse a current sample with the same actual endpoint and SSH transport.
                let monitor_session = snapshot
                    .as_ref()
                    .and_then(|s| self.terminals.session_info(&s.session_id).ok());
                let sample = snapshot
                    .as_ref()
                    .filter(|s| {
                        ["running", "partial", "paused", "sampling"].contains(&s.state.as_str())
                    })
                    .filter(|_| {
                        monitor_session
                            .as_ref()
                            .is_some_and(|s| s.transport_id == binding.session.transport_id)
                    })
                    .and_then(|s| s.sample.as_ref())
                    .filter(|s| {
                        std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .is_ok_and(|t| {
                                t.as_millis().saturating_sub(s.sampled_at as u128) <= 60_000
                            })
                    });
                if let Some(sample) = sample {
                    if selection.server {
                        context["system"] = json!(sample.system);
                    }
                    if selection.metrics {
                        context["metrics"] = json!({"sampledAt":sample.sampled_at,"uptime":sample.uptime,"load":sample.load,"cpus":sample.cpus,"memory":sample.memory,"disks":sample.disks,"network":sample.network,"warnings":sample.warnings});
                    }
                } else if selection.metrics {
                    return Err(failure(
                        "AI_METRICS_UNAVAILABLE",
                        "当前服务器没有同一连接的有效监控快照，请先打开服务器监控",
                    ));
                } else {
                    warnings.push(
                        "当前没有同一连接的系统监控快照，只包含已授权的 SSH 端点信息。".into(),
                    );
                }
            }
            if selection.processes {
                context["processes"] =
                    response_value(self.operations_host.query(id, Request::Processes).await?)?;
            }
            if selection.docker {
                context["docker"] =
                    response_value(self.operations_host.query(id, Request::Containers).await?)?;
            }
            if let Some(log) = &selection.log {
                context["selectedLog"] = json!({"source":log,"lines":selection.log_lines,"data":response_value(self.operations_host.log_excerpt(id,log.clone(),selection.log_lines).await?)?});
            }
            self.ai_verify_binding(binding)?;
            host_contexts.push(context);
        }
        let mut context = if host_contexts.len() == 1 {
            host_contexts.remove(0)
        } else if host_contexts.is_empty() {
            json!({})
        } else {
            json!({"hosts":host_contexts})
        };
        if let Some(inventory) = inventory {
            // Routing has already used the catalog. Diagnostic requests only need
            // metadata for the selected hosts, not every unrelated saved asset.
            let inventory = if automatic.is_some() {
                inventory
                    .into_iter()
                    .filter(|asset| {
                        bindings
                            .iter()
                            .any(|binding| binding.session.host_id == asset.id)
                    })
                    .collect()
            } else {
                inventory
            };
            context["associatedAssets"] =
                serde_json::to_value(inventory).map_err(|e| Error::Worker(Box::new(e)))?;
        }
        let binding = if bindings.len() == 1 {
            bindings.first().cloned()
        } else {
            None
        };
        let related_bindings = if bindings.len() > 1 { bindings } else { vec![] };
        let warnings = warnings
            .into_iter()
            .map(|value| redactor.text(&value))
            .collect();
        let mut prepared = serverdeck_ai::PreparedContext {
            related_bindings,
            history: input.history,
            model_id: record.id,
            revision: record.revision,
            config: record.config,
            question: input.question,
            context,
            binding,
            redactor,
            warnings,
        };
        if automatic.is_some() {
            context::fit_budget(&mut prepared)?;
        }
        self.assistant.prepare(prepared)
    }
    pub async fn ai_send(&self, id: String, confirmed: bool) -> Result<Answer, Error> {
        if !confirmed {
            return Err(Error::Validation("请明确发送此问题"));
        }
        for binding in self.assistant.preview_bindings(&id)? {
            self.ai_verify_binding(&binding)?;
        }
        let model_id = self.assistant.preview_model_id(&id)?;
        let (record, key) = self.ai_credentials(model_id).await?;
        self.assistant
            .send(&id, &record.revision, &key, confirmed)
            .await
    }
    pub async fn ai_execute(&self, input: ExecuteInput) -> Result<Execution, Error> {
        let _permit = self.assistant.execution_slot()?;
        let binding = self.assistant.execution_binding(&input.proposal_id)?;
        self.ai_verify_binding(&binding)?;
        let (request, redactor) = self.assistant.take_command(input)?;
        let response = self
            .operations_host
            .query(&binding.session.id, request)
            .await?;
        let success = response.success;
        let mut data = serde_json::to_value(&response).map_err(|e| Error::Worker(Box::new(e)))?;
        redactor.value(&mut data);
        let output = serde_json::to_string_pretty(&data).map_err(|e| Error::Worker(Box::new(e)))?;
        Ok(Execution {
            success,
            output,
            agent: None,
        })
    }
    pub fn ai_cancel(&self, id: &str) -> Result<(), Error> {
        self.assistant.cancel(id)
    }
}
fn check_model_edit(input: &ModelInput, old: Option<&ModelRecord>) -> Result<(), Error> {
    if old.map(|m| m.revision.as_str()) != input.expected_revision.as_deref() {
        return Err(Error::Conflict);
    }
    if old.is_some_and(|m| m.config.base_url != input.config.base_url && m.secret_ref.is_some())
        && input.api_key.is_none()
        && !input.clear_key
    {
        return Err(Error::Validation(
            "变更 API 地址时须重新输入 Key 或明确清除，防止将原 Key 发给其他服务",
        ));
    }
    Ok(())
}
fn model_key(
    input: &ModelInput,
    old: Option<&ModelRecord>,
    secrets: &dyn SecretStore,
) -> Result<Zeroizing<Vec<u8>>, Error> {
    if input.clear_key {
        return Err(Error::Validation(
            "测试模型需要 API Key，请取消清除并填写 Key",
        ));
    }
    if let Some(key) = &input.api_key {
        return Ok(Zeroizing::new(key.as_bytes().to_vec()));
    }
    let reference = old
        .and_then(|m| m.secret_ref.as_deref())
        .ok_or(Error::Validation("请填写 API Key 后测试模型"))?;
    secrets
        .read(reference)?
        .ok_or(Error::Validation("系统凭据库中没有 AI Key，请重新填写"))
}
#[cfg(test)]
fn clone_model_input(input: &ModelInput) -> ModelInput {
    ModelInput {
        id: input.id.clone(),
        expected_revision: input.expected_revision.clone(),
        name: input.name.clone(),
        config: input.config.clone(),
        api_key: input.api_key.clone(),
        clear_key: input.clear_key,
        test_id: input.test_id.clone(),
    }
}
fn response_value(response: Response) -> Result<Value, Error> {
    if !response.success {
        return Err(failure(
            "AI_CONTEXT_QUERY",
            "授权的上下文查询失败，请在服务器管理中核对权限和工具状态",
        ));
    }
    serde_json::to_value(response).map_err(|e| Error::Worker(Box::new(e)))
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod protocol_tests;
