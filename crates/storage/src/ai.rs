use super::*;
use serde::{Deserialize, Serialize};
use serverdeck_core::ai::{Config, Model, Provider, validate_model_name};

#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LocalAiConsent {
    pub authorized: bool,
    pub revision: String,
}
pub type LocalCodexConsent = LocalAiConsent;

fn local_consent_key(provider: Provider) -> Result<&'static str, Error> {
    match provider {
        Provider::LocalCodex => Ok("ai_local_codex"),
        Provider::LocalClaudeCode => Ok("ai_local_claude_code"),
        _ => Err(Error::Validation("本地智能体来源无效")),
    }
}

impl Database {
    pub fn ai_local_codex_consent(&self) -> Result<LocalCodexConsent, Error> {
        self.ai_local_consent(Provider::LocalCodex)
    }
    pub fn ai_local_codex_authorize(&self, authorized: bool) -> Result<(), Error> {
        self.ai_local_authorize(Provider::LocalCodex, authorized)
    }
    pub fn ai_local_consent(&self, provider: Provider) -> Result<LocalAiConsent, Error> {
        let value: Option<String> = self
            .connect()?
            .query_row(
                "SELECT value FROM application_settings WHERE key=?1",
                [local_consent_key(provider)?],
                |row| row.get(0),
            )
            .optional()
            .map_err(storage_error)?;
        value
            .map(|value| serde_json::from_str(&value).map_err(storage_error))
            .transpose()
            .map(Option::unwrap_or_default)
    }
    pub fn ai_local_authorize(&self, provider: Provider, authorized: bool) -> Result<(), Error> {
        let value = serde_json::to_string(&LocalAiConsent {
            authorized,
            revision: uuid::Uuid::new_v4().to_string(),
        })
        .map_err(storage_error)?;
        self.connect()?.execute("INSERT INTO application_settings(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [local_consent_key(provider)?, &value]).map_err(storage_error)?;
        Ok(())
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelRecord {
    pub id: String,
    pub name: String,
    pub config: Config,
    pub secret_ref: Option<String>,
    pub revision: String,
    #[serde(deserialize_with = "Option::deserialize")]
    pub created_at: Option<String>,
}
impl ModelRecord {
    pub fn public(&self) -> Model {
        Model {
            id: self.id.clone(),
            name: self.name.clone(),
            revision: self.revision.clone(),
            created_at: self.created_at.clone(),
            config: self.config.clone(),
            has_key: self.secret_ref.is_some(),
        }
    }
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Registry {
    version: u32,
    models: Vec<ModelRecord>,
}
const REGISTRY_VERSION: u32 = 3;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ModelRecordV2 {
    id: String,
    name: String,
    config: Config,
    secret_ref: Option<String>,
    revision: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RegistryV2 {
    version: u32,
    models: Vec<ModelRecordV2>,
}
impl RegistryV2 {
    fn upgrade(self) -> Result<Registry, Error> {
        if self.version != 2 {
            return Err(Error::Validation("模型配置升级路径不完整，未修改原数据"));
        }
        Ok(Registry {
            version: 3,
            models: self
                .models
                .into_iter()
                .map(|model| ModelRecord {
                    id: model.id,
                    name: model.name,
                    config: model.config,
                    secret_ref: model.secret_ref,
                    revision: model.revision,
                    // Historical registries did not record registration times.
                    created_at: None,
                })
                .collect(),
        })
    }
}

fn upgrade_model_config(value: &mut serde_json::Value) -> Result<(), Error> {
    let fields = value
        .as_object_mut()
        .ok_or(Error::Validation("模型配置须为对象"))?;
    fields
        .entry("contextWindowTokens")
        .or_insert_with(|| serde_json::json!(131_072));
    fields.remove("inputPricePerMillion");
    fields.remove("outputPricePerMillion");
    let config: Config = serde_json::from_value(value.clone()).map_err(storage_error)?;
    config.validate()
}

fn read(database: &Database, connection: &Connection) -> Result<Registry, Error> {
    let value: Option<String> = connection
        .query_row(
            "SELECT value FROM application_settings WHERE key='ai_models'",
            [],
            |r| r.get(0),
        )
        .optional()
        .map_err(storage_error)?;
    let upgraded = if let Some(value) = value {
        let mut value = super::config_migrations::json(&value)?;
        match value["version"].as_u64() {
            Some(version) if version == u64::from(REGISTRY_VERSION) => {
                let registry: Registry = serde_json::from_value(value).map_err(storage_error)?;
                for model in &registry.models {
                    if let Some(time) = &model.created_at {
                        let valid: bool = connection
                            .query_row(
                                "SELECT strftime('%Y-%m-%dT%H:%M:%fZ',?1) IS ?1",
                                [time],
                                |row| row.get(0),
                            )
                            .map_err(storage_error)?;
                        if !valid {
                            return Err(Error::Validation("模型注册时间格式无效"));
                        }
                    }
                }
                return Ok(registry);
            }
            Some(1) => {
                let models = value
                    .get_mut("models")
                    .and_then(serde_json::Value::as_array_mut)
                    .ok_or(Error::Validation("模型列表格式无效"))?;
                for model in models {
                    let config = model
                        .get_mut("config")
                        .ok_or(Error::Validation("模型配置缺失"))?;
                    upgrade_model_config(config)?;
                }
                value["version"] = serde_json::json!(2);
                serde_json::from_value::<RegistryV2>(value)
                    .map_err(storage_error)?
                    .upgrade()?
            }
            Some(2) => serde_json::from_value::<RegistryV2>(value)
                .map_err(storage_error)?
                .upgrade()?,
            _ => return Err(Error::Validation("模型列表版本不受当前应用支持")),
        }
    } else {
        let legacy: Option<String> = connection
            .query_row(
                "SELECT value FROM application_settings WHERE key='ai_config'",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(storage_error)?;
        let Some(legacy) = legacy else {
            return Ok(Registry {
                version: REGISTRY_VERSION,
                models: vec![],
            });
        };
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Legacy {
            config: Config,
            secret_ref: Option<String>,
            revision: String,
        }
        let mut value = super::config_migrations::json(&legacy)?;
        let config = value
            .get_mut("config")
            .ok_or(Error::Validation("模型配置缺失"))?;
        upgrade_model_config(config)?;
        let legacy: Legacy = serde_json::from_value(value).map_err(storage_error)?;
        RegistryV2 {
            version: 2,
            models: vec![ModelRecordV2 {
                id: uuid::Uuid::new_v4().to_string(),
                name: "默认模型".into(),
                config: legacy.config,
                secret_ref: legacy.secret_ref,
                revision: legacy.revision,
            }],
        }
        .upgrade()?
    };
    if upgraded.version != REGISTRY_VERSION {
        return Err(Error::Validation("模型配置升级路径不完整，未修改原数据"));
    }
    // All callers hold a write transaction. Keep AI failures isolated from startup;
    // the legacy row and the verified full database backup retain the original.
    super::migrations::backup(database, serverdeck_core::DATABASE_VERSION)
        .map_err(|error| super::migrations::failure("模型配置备份", error))?;
    write(connection, &upgraded)?;
    Ok(upgraded)
}
fn write(connection: &Connection, registry: &Registry) -> Result<(), Error> {
    let value = serde_json::to_string(registry).map_err(storage_error)?;
    connection.execute("INSERT INTO application_settings(key,value) VALUES('ai_models',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')",[value]).map_err(storage_error)?;
    Ok(())
}
impl Database {
    pub fn ai_models(&self) -> Result<Vec<ModelRecord>, Error> {
        let mut connection = self.connect()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_error)?;
        let registry = read(self, &transaction)?;
        transaction.commit().map_err(storage_error)?;
        Ok(registry.models)
    }
    pub fn ai_model(&self, id: &str) -> Result<ModelRecord, Error> {
        self.ai_models()?
            .into_iter()
            .find(|m| m.id == id)
            .ok_or(Error::NotFound)
    }
    pub fn ai_model_save(
        &self,
        mut record: ModelRecord,
        previous: Option<&str>,
    ) -> Result<ModelRecord, Error> {
        record.config.validate()?;
        validate_model_name(&record.name)?;
        let mut connection = self.connect()?;
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_error)?;
        let mut registry = read(self, &tx)?;
        if registry
            .models
            .iter()
            .any(|m| m.id != record.id && m.name.to_lowercase() == record.name.to_lowercase())
        {
            return Err(Error::Validation("模型名称已存在，请使用不同名称"));
        }
        match registry.models.iter_mut().find(|m| m.id == record.id) {
            Some(old) => {
                if Some(old.revision.as_str()) != previous {
                    return Err(Error::Conflict);
                }
                record.created_at = old.created_at.clone();
                if old.secret_ref != record.secret_ref
                    && let Some(reference) = &old.secret_ref
                {
                    tx.execute(
                        "INSERT OR IGNORE INTO secret_gc(reference) VALUES(?1)",
                        [reference],
                    )
                    .map_err(storage_error)?;
                }
                *old = record.clone();
            }
            None if previous.is_some() => return Err(Error::NotFound),
            None => {
                if registry.models.len() >= 100 {
                    return Err(Error::Validation("最多注册 100 个模型"));
                }
                record.created_at = Some(
                    tx.query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now')", [], |row| {
                        row.get(0)
                    })
                    .map_err(storage_error)?,
                );
                registry.models.push(record.clone());
            }
        }
        if let Some(reference) = &record.secret_ref {
            tx.execute("DELETE FROM secret_gc WHERE reference=?1", [reference])
                .map_err(storage_error)?;
        }
        write(&tx, &registry)?;
        tx.commit().map_err(storage_error)?;
        Ok(record)
    }
    pub fn ai_model_delete(&self, id: &str, revision: &str) -> Result<(), Error> {
        let mut connection = self.connect()?;
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_error)?;
        let mut registry = read(self, &tx)?;
        let index = registry
            .models
            .iter()
            .position(|m| m.id == id)
            .ok_or(Error::NotFound)?;
        if registry.models[index].revision != revision {
            return Err(Error::Conflict);
        }
        let old = registry.models.remove(index);
        if let Some(reference) = old.secret_ref {
            tx.execute(
                "INSERT OR IGNORE INTO secret_gc(reference) VALUES(?1)",
                [reference],
            )
            .map_err(storage_error)?;
        }
        write(&tx, &registry)?;
        tx.commit().map_err(storage_error)
    }
}
