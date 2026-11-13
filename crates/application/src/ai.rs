use super::*;
use serverdeck_ai::{failure, provider};
use serverdeck_core::{ai::*, hosts::Mutation};
use serverdeck_storage::ai::ModelRecord;
use zeroize::Zeroizing;

impl Application {
    pub async fn ai_local_codex_status(&self) -> Result<LocalCodexStatus, Error> {
        self.ai_local_status(LOCAL_CODEX_MODEL_ID).await
    }
    pub async fn ai_local_claude_code_status(&self) -> Result<LocalClaudeCodeStatus, Error> {
        self.ai_local_status(LOCAL_CLAUDE_CODE_MODEL_ID).await
    }
    async fn ai_local_status(&self, id: &'static str) -> Result<LocalCodexStatus, Error> {
        let (provider, name) = local_source(id).ok_or(Error::Validation("本地智能体来源无效"))?;
        let consent = self
            .blocking(move |db| db.ai_local_consent(provider))
            .await?;
        let directory = self.data_directory.join("local-tools");
        let executable = match provider {
            Provider::LocalClaudeCode => serverdeck_ai::claude::executable(Some(&directory))?,
            _ => serverdeck_ai::codex::executable(Some(&directory))?,
        };
        let installed = executable.is_some();
        let install_supported = serverdeck_ai::local_tools::supported();
        if !installed {
            return Ok(LocalCodexStatus {
                installed,
                install_supported,
                authorized: consent.authorized,
                model: None,
                message: format!("尚未安装{name}，请先下载安装工具。"),
            });
        }
        if !consent.authorized {
            return Ok(LocalCodexStatus {
                installed,
                install_supported,
                authorized: false,
                model: None,
                message: format!("请先授权使用{name}配置与登录信息"),
            });
        }
        match self.ai_credentials(id.into()).await {
            Ok((record, _)) => {
                let mut model = record.public();
                model.has_key = true;
                Ok(LocalCodexStatus {
                    installed,
                    install_supported,
                    authorized: true,
                    model: Some(model),
                    message: format!("已连接{name}，使用已有配置与登录状态"),
                })
            }
            Err(error) => {
                let error = serverdeck_core::IpcError::from(error);
                let message = match executable.as_deref() {
                    Some(path)
                        if cfg!(windows)
                            && matches!(error.code, "AI_CODEX_AUTH" | "AI_CLAUDE_AUTH") =>
                    {
                        local_login_hint(provider, path)
                    }
                    _ => error.message,
                };
                Ok(LocalCodexStatus {
                    installed,
                    install_supported,
                    authorized: true,
                    model: None,
                    message,
                })
            }
        }
    }
    pub async fn ai_local_tool_install(
        &self,
        model_id: String,
        request_id: String,
    ) -> Result<(), Error> {
        if self.shutting_down.load(Ordering::Acquire) {
            return Err(Error::ShuttingDown);
        }
        let (provider, _) = local_source(&model_id).ok_or(Error::Validation("本地工具来源无效"))?;
        self.local_tool_installer
            .install(
                &self.data_directory.join("local-tools"),
                provider,
                request_id,
            )
            .await
    }
    pub fn ai_local_tool_install_cancel(&self, request_id: &str) -> Result<(), Error> {
        self.local_tool_installer.cancel(request_id)
    }
    pub async fn ai_local_codex_authorize(&self, authorized: bool) -> Result<(), Error> {
        self.ai_local_authorize(LOCAL_CODEX_MODEL_ID, authorized)
            .await
    }
    pub async fn ai_local_claude_code_authorize(&self, authorized: bool) -> Result<(), Error> {
        self.ai_local_authorize(LOCAL_CLAUDE_CODE_MODEL_ID, authorized)
            .await
    }
    async fn ai_local_authorize(&self, id: &'static str, authorized: bool) -> Result<(), Error> {
        let (provider, _) = local_source(id).ok_or(Error::Validation("本地智能体来源无效"))?;
        self.blocking(move |db| db.ai_local_authorize(provider, authorized))
            .await?;
        self.models_runtime.revoke_model(id)?;
        Ok(())
    }
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
        self.models_runtime.test_model(&config, &key, binding).await
    }
    pub async fn ai_models(&self) -> Result<Vec<Model>, Error> {
        self.blocking(|db| Ok(db.ai_models()?.iter().map(ModelRecord::public).collect()))
            .await
    }
    pub async fn ai_model_save(&self, input: ModelInput) -> Result<Mutation<Model>, Error> {
        input.validate()?;
        provider::endpoint(&input.config)?;
        let secrets = self.secrets.clone();
        let models = self.models_runtime.clone();
        let result = self
            .blocking(move |db| {
                let old = input.id.as_deref().map(|id| db.ai_model(id)).transpose()?;
                check_model_edit(&input, old.as_ref())?;
                if old.as_ref().is_none_or(|m| m.config != input.config) || input.api_key.is_some()
                {
                    let key = model_key(&input, old.as_ref(), secrets.as_ref())?;
                    let binding = serverdeck_ai::ModelTestBinding::new(&input, &key)?;
                    models.consume_model_test(input.test_id.as_deref(), &binding)?;
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
                    created_at: None,
                    id: input.id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
                    name: input.name.trim().into(),
                    config: input.config,
                    secret_ref: reference,
                    revision: uuid::Uuid::new_v4().to_string(),
                };
                // On commit failure the new immutable secret stays in durable GC for retry.
                let record = db.ai_model_save(record, input.expected_revision.as_deref())?;
                Ok(Mutation {
                    value: record.public(),
                    warnings: super::hosts::cleanup(&db, secrets.as_ref()),
                })
            })
            .await?;
        self.models_runtime.revoke_model(&result.value.id)?;
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
        self.models_runtime.revoke_model(&id)?;
        Ok(result)
    }
    pub(crate) async fn ai_credentials(
        &self,
        model_id: String,
    ) -> Result<(ModelRecord, Zeroizing<Vec<u8>>), Error> {
        if let Some((provider, name)) = local_source(&model_id) {
            let consent = self
                .blocking(move |db| db.ai_local_consent(provider))
                .await?;
            if !consent.authorized {
                return Err(failure(
                    if provider == Provider::LocalClaudeCode {
                        "AI_CLAUDE_CONSENT"
                    } else {
                        "AI_CODEX_CONSENT"
                    },
                    "尚未授权使用此本地模型来源，请到平台模型设置中授权",
                ));
            }
            let directory = self.data_directory.join("local-tools");
            let snapshot = match provider {
                Provider::LocalClaudeCode => {
                    serverdeck_ai::claude::snapshot_with_directory(Some(&directory)).await?
                }
                _ => serverdeck_ai::codex::snapshot_with_directory(Some(&directory)).await?,
            };
            let current = self
                .blocking(move |db| db.ai_local_consent(provider))
                .await?;
            if !current.authorized || current.revision != consent.revision {
                return Err(Error::Conflict);
            }
            return Ok((
                ModelRecord {
                    created_at: None,
                    id: model_id,
                    name: name.into(),
                    config: snapshot.config,
                    secret_ref: None,
                    revision: format!("{}:{}", consent.revision, snapshot.revision),
                },
                snapshot.runtime,
            ));
        }
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
}
fn local_login_hint(provider: Provider, executable: &std::path::Path) -> String {
    let path = executable.to_string_lossy();
    let path = if let Some(unc) = path.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{unc}")
    } else {
        path.strip_prefix(r"\\?\").unwrap_or(&path).to_owned()
    };
    let path = path.replace('\'', "''");
    let command = if provider == Provider::LocalClaudeCode {
        "auth login"
    } else {
        "login"
    };
    format!(
        "工具尚未登录。请在 PowerShell 运行：& '{path}' {command}，或完成已有服务配置，然后重新检测。"
    )
}
fn local_source(id: &str) -> Option<(Provider, &'static str)> {
    match id {
        LOCAL_CODEX_MODEL_ID => Some((Provider::LocalCodex, "本地 Codex")),
        LOCAL_CLAUDE_CODE_MODEL_ID => Some((Provider::LocalClaudeCode, "本地 Claude Code")),
        _ => None,
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

#[cfg(test)]
mod model_fixture;
#[cfg(test)]
mod tests;
