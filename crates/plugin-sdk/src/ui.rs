use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeSet;
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Label {
    Text(String),
    Translated(Translations),
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Translations {
    #[serde(rename = "zh-CN")]
    pub zh_cn: String,
    #[serde(rename = "en-US")]
    pub en_us: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Ui {
    pub ui_version: u32,
    pub title: Label,
    pub pages: Vec<Page>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Page {
    pub id: String,
    pub title: Label,
    pub initial_action: Option<String>,
    pub fields: Vec<Field>,
    pub actions: Vec<Action>,
    pub log: Option<Log>,
    #[serde(default)]
    pub surface: Option<Surface>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Surface {
    Monitor { sections: Vec<String> },
    Operations { sections: Vec<String> },
    Tool { tool: crate::tools::Tool },
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FieldKind {
    Text,
    Textarea,
    Checkbox,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Field {
    pub id: String,
    pub label: Label,
    pub kind: FieldKind,
    pub default: Value,
    #[serde(default)]
    pub readonly: bool,
    pub document_field: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Action {
    pub id: String,
    pub label: Label,
    #[serde(default)]
    pub discard_dirty: bool,
    pub enabled_when: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Log {
    pub resource_field: String,
    pub title: Label,
}
pub fn identifier(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c))
        && !matches!(id, "__proto__" | "prototype" | "constructor")
}
fn valid_sections(sections: &[String], allowed: &[&str]) -> bool {
    !sections.is_empty()
        && sections.len() <= allowed.len()
        && sections.iter().collect::<BTreeSet<_>>().len() == sections.len()
        && sections.iter().all(|s| allowed.contains(&s.as_str()))
}
impl Label {
    fn valid(&self) -> bool {
        fn valid(s: &str) -> bool {
            !s.trim().is_empty() && s.len() <= 256
        }
        match self {
            Self::Text(s) => valid(s),
            Self::Translated(t) => valid(&t.zh_cn) && valid(&t.en_us),
        }
    }
}
impl Ui {
    pub fn validate(&self) -> Result<(), &'static str> {
        if !matches!(self.ui_version, 1..=3)
            || !self.title.valid()
            || self.pages.is_empty()
            || self.pages.len() > 8
        {
            return Err("UI 版本、标题或页面数量无效");
        }
        let mut pages = BTreeSet::new();
        for page in &self.pages {
            if let Some(surface) = &page.surface {
                let valid = match surface {
                    Surface::Tool { .. } => self.ui_version == 3,
                    Surface::Monitor { sections } => {
                        matches!(self.ui_version, 2 | 3)
                            && valid_sections(sections, &["overview", "disks", "network"])
                    }
                    Surface::Operations { sections } => {
                        matches!(self.ui_version, 2 | 3)
                            && valid_sections(
                                sections,
                                &[
                                    "containers",
                                    "images",
                                    "processes",
                                    "ports",
                                    "services",
                                    "logs",
                                ],
                            )
                    }
                };
                if !valid
                    || page.actions.len() != 1
                    || page.actions[0].id != "bridge"
                    || !page.fields.is_empty()
                    || page.log.is_some()
                    || page.initial_action.is_some()
                {
                    return Err("标准视图需要匹配的 UI 版本、受支持的类型和 bridge 动作");
                }
            }
            if !identifier(&page.id)
                || !pages.insert(&page.id)
                || !page.title.valid()
                || page.fields.len() > 32
                || page.actions.len() > 32
            {
                return Err("UI 页面、字段或动作声明无效");
            }
            let mut fields = BTreeSet::new();
            let mut actions = BTreeSet::new();
            for field in &page.fields {
                if !identifier(&field.id)
                    || !fields.insert(&field.id)
                    || !field.label.valid()
                    || !(field.default.is_boolean()
                        || field.default.is_string()
                        || field.default.is_null())
                    || field.default.as_str().is_some_and(|s| s.len() > 32768)
                    || match field.kind {
                        FieldKind::Checkbox => !field.default.is_boolean(),
                        _ => !field.default.is_string() && !field.default.is_null(),
                    }
                    || field
                        .document_field
                        .as_ref()
                        .is_some_and(|s| !identifier(s))
                {
                    return Err("UI 字段类型、默认值或绑定无效");
                }
            }
            for action in &page.actions {
                if !identifier(&action.id)
                    || !actions.insert(&action.id)
                    || !action.label.valid()
                    || action.enabled_when.as_ref().is_some_and(|s| !identifier(s))
                {
                    return Err("UI 动作或条件声明无效");
                }
            }
            if page.initial_action.as_ref().is_some_and(|s| !identifier(s))
                || page
                    .log
                    .as_ref()
                    .is_some_and(|l| !identifier(&l.resource_field) || !l.title.valid())
            {
                return Err("UI 初始化动作或日志绑定无效");
            }
        }
        Ok(())
    }
}
