use crate::Error;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TerminalTheme {
    Deck,
    Light,
    Nord,
    Solarized,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CursorStyle {
    Block,
    Bar,
    Underline,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct TerminalPreferences {
    pub font_family: String,
    pub line_height: u16,
    pub scrollback: u32,
    pub theme: TerminalTheme,
    pub cursor_style: CursorStyle,
    pub cursor_blink: bool,
    pub quick_copy_paste: bool,
    pub paste_confirm_chars: u32,
    pub shortcuts: BTreeMap<String, String>,
}
impl Default for TerminalPreferences {
    fn default() -> Self {
        Self {
            font_family: "Cascadia Mono, Consolas, monospace".into(),
            line_height: 100,
            scrollback: 5000,
            theme: TerminalTheme::Deck,
            cursor_style: CursorStyle::Block,
            cursor_blink: true,
            quick_copy_paste: false,
            paste_confirm_chars: 4096,
            shortcuts: default_shortcuts(),
        }
    }
}
pub fn default_shortcuts() -> BTreeMap<String, String> {
    [
        ("copy", "Ctrl+Shift+C"),
        ("paste", "Ctrl+Shift+V"),
        ("find", "Ctrl+Shift+F"),
        ("splitRows", "Ctrl+Shift+H"),
        ("splitColumns", "Ctrl+Shift+E"),
        ("newTab", "Ctrl+Shift+T"),
        ("closePane", "Ctrl+Shift+W"),
        ("nextTab", "Ctrl+Shift+Right"),
        ("previousTab", "Ctrl+Shift+Left"),
        ("zoomIn", "Ctrl+Shift+="),
        ("zoomOut", "Ctrl+Shift+-"),
    ]
    .into_iter()
    .map(|(a, k)| (a.into(), k.into()))
    .collect()
}
impl TerminalPreferences {
    pub fn validate(&self) -> Result<(), Error> {
        if self.font_family.trim().is_empty()
            || self.font_family.len() > 256
            || self
                .font_family
                .chars()
                .any(|c| !(c.is_alphanumeric() || " ,_-'\"".contains(c)))
        {
            return Err(Error::Validation("字体名称无效或过长"));
        }
        if !(100..=200).contains(&self.line_height)
            || self.scrollback > 20000
            || !(256..=65536).contains(&self.paste_confirm_chars)
        {
            return Err(Error::Validation(
                "行高须为 100–200%，历史 0–20000 行，大粘贴阈值 256–65536 字符",
            ));
        }
        let defaults = default_shortcuts();
        if self.shortcuts.len() != defaults.len()
            || self.shortcuts.keys().any(|k| !defaults.contains_key(k))
        {
            return Err(Error::Validation("快捷键操作集合无效"));
        }
        let mut used = HashSet::new();
        for key in self.shortcuts.values() {
            let fields: Vec<_> = key.split('+').collect();
            let Some((last, modifiers)) = fields.split_last() else {
                return Err(Error::Validation("快捷键无效"));
            };
            let mods: HashSet<_> = modifiers.iter().copied().collect();
            let canonical: Vec<_> = ["Ctrl", "Meta", "Alt", "Shift"]
                .into_iter()
                .filter(|modifier| mods.contains(modifier))
                .collect();
            let safe = (mods.contains("Ctrl") && mods.contains("Shift"))
                || (mods.contains("Meta") && mods.contains("Shift"))
                || (mods.contains("Ctrl") && mods.contains("Alt"));
            let key_ok = (last.len() == 1
                && last.bytes().all(|b| {
                    b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'=' || b == b'-'
                }))
                || ["Left", "Right", "Up", "Down"].contains(last);
            if !safe
                || !key_ok
                || mods.len() != modifiers.len()
                || modifiers != canonical.as_slice()
                || mods
                    .iter()
                    .any(|m| !["Ctrl", "Shift", "Alt", "Meta"].contains(m))
                || !used.insert(key)
            {
                return Err(Error::Validation(
                    "快捷键须唯一，并含 Ctrl+Shift、Meta+Shift 或 Ctrl+Alt，保留远端常用组合键",
                ));
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TerminalSize {
    pub cols: u32,
    pub rows: u32,
}
impl TerminalSize {
    pub fn validate(self) -> Result<Self, Error> {
        if !(2..=500).contains(&self.cols) || !(1..=300).contains(&self.rows) {
            return Err(Error::Validation("终端尺寸须在 2–500 列、1–300 行内"));
        }
        Ok(self)
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalTerminalSession {
    pub id: String,
    pub shell: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSession {
    pub id: String,
    pub transport_id: String,
    pub host_id: String,
    pub route_host_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum TerminalEvent {
    State {
        state: &'static str,
        code: Option<&'static str>,
        message: Option<String>,
    },
    Trust {
        hostname: String,
        port: u16,
        algorithm: String,
        fingerprint: String,
    },
    Data {
        sequence: u64,
        data: Vec<u8>,
    },
    Exit {
        status: Option<u32>,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalUploadFile {
    pub name: String,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalUploadSelection {
    pub token: String,
    pub files: Vec<TerminalUploadFile>,
}

#[cfg(test)]
mod preference_tests {
    use super::*;
    #[test]
    fn default_preferences_are_safe_and_configurable() {
        let mut preferences = TerminalPreferences::default();
        preferences.validate().expect("defaults");
        preferences.scrollback = 20000;
        preferences.line_height = 150;
        preferences.theme = TerminalTheme::Nord;
        preferences.validate().expect("preferences");
        preferences.shortcuts.insert("copy".into(), "Ctrl+C".into());
        assert!(preferences.validate().is_err());
        preferences = TerminalPreferences::default();
        preferences
            .shortcuts
            .insert("paste".into(), "Ctrl+Shift+C".into());
        assert!(preferences.validate().is_err());
        preferences = TerminalPreferences::default();
        preferences.scrollback = 20001;
        assert!(preferences.validate().is_err());
        preferences = TerminalPreferences::default();
        preferences
            .shortcuts
            .insert("copy".into(), "Shift+Ctrl+C".into());
        assert!(preferences.validate().is_err());
    }
    #[test]
    fn old_settings_receive_new_defaults_without_resetting_existing_values() {
        let mut value = serde_json::to_value(crate::AppConfig::default()).expect("serialize");
        value.as_object_mut().expect("object").remove("terminal");
        value["terminalFontSize"] = 18.into();
        let config: crate::AppConfig = serde_json::from_value(value).expect("old config");
        assert_eq!(config.terminal_font_size, 18);
        assert_eq!(config.terminal, TerminalPreferences::default());
    }
    #[test]
    fn quick_copy_paste_defaults_off_for_existing_settings_and_roundtrips() {
        let mut value = serde_json::to_value(TerminalPreferences::default()).expect("serialize");
        value
            .as_object_mut()
            .expect("object")
            .remove("quickCopyPaste");
        value["scrollback"] = 1234.into();
        let mut preferences: TerminalPreferences =
            serde_json::from_value(value).expect("existing preferences");
        assert!(!preferences.quick_copy_paste);
        assert_eq!(preferences.scrollback, 1234);
        preferences.quick_copy_paste = true;
        preferences.validate().expect("enabled preferences");
        let value = serde_json::to_value(&preferences).expect("serialize enabled");
        assert_eq!(value["quickCopyPaste"], true);
        assert_eq!(
            serde_json::from_value::<TerminalPreferences>(value).expect("roundtrip"),
            preferences
        );
    }
}
