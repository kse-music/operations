//! Persistent upgrades are explicit; current IPC/config DTOs remain strict.
use super::migrations::storage_error;
use serde_json::{Value, json};
use serverdeck_core::{AppConfig, CONFIG_VERSION, Error};

// Value normally accepts duplicate object keys. A migration must not select one
// silently, including in nested settings that will be rewritten.
pub(super) fn json(raw: &str) -> Result<Value, Error> {
    struct Unique(Value);
    impl<'de> serde::Deserialize<'de> for Unique {
        fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
            struct Visitor;
            impl<'de> serde::de::Visitor<'de> for Visitor {
                type Value = Unique;
                fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                    formatter.write_str("不含重复字段的 JSON")
                }
                fn visit_bool<E: serde::de::Error>(self, value: bool) -> Result<Unique, E> {
                    Ok(Unique(value.into()))
                }
                fn visit_i64<E: serde::de::Error>(self, value: i64) -> Result<Unique, E> {
                    Ok(Unique(value.into()))
                }
                fn visit_u64<E: serde::de::Error>(self, value: u64) -> Result<Unique, E> {
                    Ok(Unique(value.into()))
                }
                fn visit_f64<E: serde::de::Error>(self, value: f64) -> Result<Unique, E> {
                    serde_json::Number::from_f64(value)
                        .map(|number| Unique(Value::Number(number)))
                        .ok_or_else(|| E::custom("JSON 数值无效"))
                }
                fn visit_str<E: serde::de::Error>(self, value: &str) -> Result<Unique, E> {
                    Ok(Unique(value.into()))
                }
                fn visit_unit<E: serde::de::Error>(self) -> Result<Unique, E> {
                    Ok(Unique(Value::Null))
                }
                fn visit_seq<A: serde::de::SeqAccess<'de>>(
                    self,
                    mut sequence: A,
                ) -> Result<Unique, A::Error> {
                    let mut result = Vec::new();
                    while let Some(Unique(value)) = sequence.next_element()? {
                        result.push(value);
                    }
                    Ok(Unique(Value::Array(result)))
                }
                fn visit_map<A: serde::de::MapAccess<'de>>(
                    self,
                    mut map: A,
                ) -> Result<Unique, A::Error> {
                    let mut result = serde_json::Map::new();
                    while let Some(key) = map.next_key::<String>()? {
                        if result.contains_key(&key) {
                            return Err(serde::de::Error::custom("配置 JSON 包含重复字段"));
                        }
                        let Unique(value) = map.next_value()?;
                        result.insert(key, value);
                    }
                    Ok(Unique(Value::Object(result)))
                }
            }
            deserializer.deserialize_any(Visitor)
        }
    }
    serde_json::from_str::<Unique>(raw)
        .map(|Unique(value)| value)
        .map_err(storage_error)
}

pub(super) fn app_config(raw: &str) -> Result<AppConfig, Error> {
    let mut value = json(raw)?;
    let version = value
        .get("version")
        .and_then(Value::as_u64)
        .and_then(|version| u32::try_from(version).ok())
        .ok_or(Error::Validation("应用配置缺少有效版本，未执行升级"))?;
    match version {
        1 => {
            let object = value
                .as_object_mut()
                .ok_or(Error::Validation("应用配置须为对象"))?;
            // Freeze historical defaults; future product defaults must not change
            // how the same v1 data upgrades. Each step targets one fixed version.
            let defaults = json(include_str!("../migrations/app_config_v1_defaults.json"))?;
            // These fields were optional in the recorded v1 contract. Do not fill
            // required core fields, replace explicit values/nulls or drop unknown keys.
            for key in [
                "interfaceFontSize",
                "transferConcurrency",
                "terminal",
                "product",
            ] {
                object.entry(key).or_insert_with(|| defaults[key].clone());
            }
            if object["interfaceFontSize"] == "extraSmall" {
                object.insert("interfaceFontSize".into(), json!("small"));
            }
            for key in ["terminal", "product"] {
                if let Some(fields) = object.get_mut(key).and_then(Value::as_object_mut)
                    && let Some(defaults) = defaults[key].as_object()
                {
                    for (name, default) in defaults {
                        fields
                            .entry(name.clone())
                            .or_insert_with(|| default.clone());
                    }
                }
            }
            if let Some(fields) = value
                .pointer_mut("/product/sshDefaults")
                .and_then(Value::as_object_mut)
                && let Some(defaults) = defaults["product"]["sshDefaults"].as_object()
            {
                for (name, default) in defaults {
                    fields
                        .entry(name.clone())
                        .or_insert_with(|| default.clone());
                }
            }
            // Retired values remain in the complete pre-upgrade SQLite backup.
            if let Some(shortcuts) = value
                .pointer_mut("/product/shortcuts")
                .and_then(Value::as_object_mut)
            {
                shortcuts.remove("tasks");
            }
            value["version"] = json!(2);
        }
        CONFIG_VERSION => (),
        other => return Err(Error::UnsupportedConfig(other)),
    }
    let config: AppConfig = serde_json::from_value(value).map_err(storage_error)?;
    config.validate()?;
    Ok(config)
}
