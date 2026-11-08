use crate::{Error, connection::SshOptions};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProductPreferences {
    pub language: String,
    pub download_directory: Option<String>,
    pub ssh_defaults: SshOptions,
    pub shortcuts: BTreeMap<String, String>,
}
impl Default for ProductPreferences {
    fn default() -> Self {
        Self {
            language: "zh-CN".into(),
            download_directory: None,
            ssh_defaults: SshOptions::default(),
            shortcuts: [("search", "Ctrl+K"), ("settings", "Ctrl+,")]
                .map(|(k, v)| (k.into(), v.into()))
                .into(),
        }
    }
}
impl ProductPreferences {
    pub fn validate(&self) -> Result<(), Error> {
        if self.language != "zh-CN" {
            return Err(Error::Validation("当前界面语言仅支持简体中文"));
        }
        if let Some(path) = &self.download_directory
            && (path.len() > 4096
                || path.chars().any(char::is_control)
                || !std::path::Path::new(path).is_absolute())
        {
            return Err(Error::Validation("下载目录须为有效的本地绝对路径"));
        }
        self.ssh_defaults.clone().normalize()?;
        if self.ssh_defaults.jump_host_id.is_some() {
            return Err(Error::Validation("全局默认不设置跳板，请在主机配置中选择"));
        }
        let mut seen = HashSet::new();
        if self.shortcuts.len() != 2 {
            return Err(Error::Validation("全局快捷键定义不完整"));
        }
        for key in ["search", "settings"] {
            let value = self
                .shortcuts
                .get(key)
                .ok_or(Error::Validation("全局快捷键定义不完整"))?;
            // Global bindings always include Ctrl and cannot consume terminal control keys.
            let parts = value.split('+').collect::<Vec<_>>();
            let last = parts.last().copied().unwrap_or("");
            if parts.first() != Some(&"Ctrl")
                || parts.len() < 2
                || parts.len() > 3
                || (parts.len() == 3 && parts[1] != "Shift")
                || last.len() != 1
                || !last
                    .bytes()
                    .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b',')
                || (parts.len() == 2
                    && ["C", "V", "Z", "A", "D", "L", "R", "W", "T"].contains(&last))
                || !seen.insert(value)
            {
                return Err(Error::Validation(
                    "快捷键须为不重复的 Ctrl+[Shift+]字母/数字/逗号，且不占用常用终端控制键",
                ));
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WindowGeometry {
    pub width: f64,
    pub height: f64,
    pub maximized: bool,
}
impl WindowGeometry {
    pub fn validate(&self) -> Result<(), Error> {
        if !self.width.is_finite()
            || !self.height.is_finite()
            || !(900.0..=7680.0).contains(&self.width)
            || !(600.0..=4320.0).contains(&self.height)
        {
            return Err(Error::Validation("窗口尺寸超出支持范围"));
        }
        Ok(())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionStatus {
    pub hostname: String,
    pub port: u16,
    pub username: String,
    pub id: String,
    pub host_id: String,
    pub transport_id: String,
    pub route_host_ids: Vec<String>,
    pub kind: &'static str,
    pub state: &'static str,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundSnapshot {
    pub connections: Vec<ConnectionStatus>,
}
