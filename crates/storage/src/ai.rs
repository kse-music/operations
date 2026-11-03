use super::*;
use serde::{Deserialize, Serialize};
use serverdeck_core::ai::{Config, Model, validate_model_name};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelRecord {
    pub id: String,
    pub name: String,
    pub config: Config,
    pub secret_ref: Option<String>,
    pub revision: String,
}
impl ModelRecord {
    pub fn public(&self) -> Model {
        Model {
            id: self.id.clone(),
            name: self.name.clone(),
            revision: self.revision.clone(),
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
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Legacy {
    config: Config,
    secret_ref: Option<String>,
    revision: String,
}

fn read(connection: &Connection) -> Result<Registry, Error> {
    let value: Option<String> = connection
        .query_row(
            "SELECT value FROM application_settings WHERE key='ai_models'",
            [],
            |r| r.get(0),
        )
        .optional()
        .map_err(storage_error)?;
    if let Some(value) = value {
        let registry: Registry = serde_json::from_str(&value).map_err(storage_error)?;
        if registry.version != 1 {
            return Err(Error::Validation("模型列表版本不受当前应用支持"));
        }
        return Ok(registry);
    }
    let legacy: Option<String> = connection
        .query_row(
            "SELECT value FROM application_settings WHERE key='ai_config'",
            [],
            |r| r.get(0),
        )
        .optional()
        .map_err(storage_error)?;
    let mut registry = Registry {
        version: 1,
        models: vec![],
    };
    if let Some(legacy) = legacy {
        let old: Legacy = serde_json::from_str(&legacy).map_err(storage_error)?;
        old.config.validate()?;
        registry.models.push(ModelRecord {
            id: uuid::Uuid::new_v4().to_string(),
            name: "默认模型".into(),
            config: old.config,
            secret_ref: old.secret_ref,
            revision: old.revision,
        });
        write(connection, &registry)?;
        connection
            .execute("DELETE FROM application_settings WHERE key='ai_config'", [])
            .map_err(storage_error)?;
    }
    Ok(registry)
}
fn write(connection: &Connection, registry: &Registry) -> Result<(), Error> {
    let value = serde_json::to_string(registry).map_err(storage_error)?;
    connection.execute("INSERT INTO application_settings(key,value) VALUES('ai_models',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')",[value]).map_err(storage_error)?;
    Ok(())
}
impl Database {
    pub fn ai_models(&self) -> Result<Vec<ModelRecord>, Error> {
        // Serializes legacy conversion without putting AI on the application startup path.
        let mut connection = self.connect()?;
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_error)?;
        let registry = read(&tx)?;
        tx.commit().map_err(storage_error)?;
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
        record: ModelRecord,
        previous: Option<&str>,
    ) -> Result<ModelRecord, Error> {
        record.config.validate()?;
        validate_model_name(&record.name)?;
        let mut connection = self.connect()?;
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_error)?;
        let mut registry = read(&tx)?;
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
        let mut registry = read(&tx)?;
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
