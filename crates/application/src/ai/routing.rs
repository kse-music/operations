use super::*;
use serverdeck_ai::routing::{local_choice, validate_choice};
use serverdeck_core::hosts::Catalog;

pub(super) fn assets(catalog: &Catalog) -> Vec<HostAsset> {
    catalog
        .hosts
        .iter()
        .map(|h| HostAsset {
            id: h.id.clone(),
            name: h.config.name.clone(),
            hostname: h.config.hostname.clone(),
            port: h.config.port,
            username: h.config.username.clone(),
            group: catalog
                .groups
                .iter()
                .find(|g| Some(&g.id) == h.config.group_id.as_ref())
                .map(|g| g.name.clone()),
        })
        .collect()
}
impl Application {
    pub async fn ai_resolve_hosts(&self, input: ResolveHostsInput) -> Result<HostRoute, Error> {
        if input.question.trim().is_empty()
            || input.question.len() > 8192
            || input.previous_host_ids.len() > 8
            || input.previous_host_ids.iter().any(|id| id.len() > 64)
            || input.redact_values.len() > 32
            || uuid::Uuid::parse_str(&input.request_id).is_err()
        {
            return Err(Error::Validation("主机匹配输入无效"));
        }
        let assets = self.blocking(|db| Ok(assets(&db.catalog()?))).await?;
        let (record, local_key) = if is_local_model(&input.model_id) {
            let (record, key) = self.ai_credentials(input.model_id).await?;
            (record, Some(key))
        } else {
            let id = input.model_id;
            (self.blocking(move |db| db.ai_model(&id)).await?, None)
        };
        let choice = if let Some(choice) =
            local_choice(&input.question, &assets, &input.previous_host_ids)
        {
            choice
        } else {
            let key = match local_key {
                Some(key) => key,
                None => {
                    let reference = record
                        .secret_ref
                        .clone()
                        .ok_or(Error::Validation("所选模型尚未设置 API Key"))?;
                    let secrets = self.secrets.clone();
                    self.blocking(move |_| {
                        secrets
                            .read(&reference)?
                            .ok_or(Error::Validation("系统凭据库中没有 AI Key"))
                    })
                    .await?
                }
            };
            let mut values = input.redact_values;
            if let Ok(value) = std::str::from_utf8(&key) {
                values.push(Zeroizing::new(value.into()));
            }
            let redactor = Redactor::new(input.mask_addresses, values)?;
            let mut metadata =
                serde_json::to_value(&assets).map_err(|e| Error::Worker(Box::new(e)))?;
            redactor.value(&mut metadata);
            if metadata.to_string().len() > 64 * 1024 {
                return Err(Error::Validation(
                    "资产目录过大，请在问题中明确主机名称或地址",
                ));
            }
            self.assistant
                .resolve_hosts(
                    &record.id,
                    &input.request_id,
                    &record.config,
                    &key,
                    json!({"question":redactor.text(&input.question),"assets":metadata,"previousHostIds":input.previous_host_ids}),
                )
                .await?
        };
        validate_choice(&choice, &assets)?;
        Ok(HostRoute {
            host_ids: choice.host_ids,
            message: choice.message,
            model_revision: record.revision,
        })
    }
}
