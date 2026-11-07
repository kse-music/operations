pub mod ai;
pub mod monitor;
pub mod ops;
pub mod product;
use serde::{Deserialize, Serialize};

pub mod connection;
pub mod files;
pub mod hosts;
pub mod identity;
pub mod openssh;
pub mod terminal;
pub mod workspace;

pub const CONFIG_VERSION: u32 = 1;
pub const DATABASE_VERSION: u32 = 9;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{message}")]
    Connection {
        code: &'static str,
        message: &'static str,
        #[source]
        source: Option<Box<dyn std::error::Error + Send + Sync>>,
    },
    #[error("配置项无效：{0}")]
    Validation(&'static str),
    #[error("配置版本 {0} 不受当前应用支持")]
    UnsupportedConfig(u32),
    #[error("数据库版本 {0} 高于当前应用支持版本")]
    UnsupportedDatabase(u32),
    #[error("本地存储操作失败")]
    Storage(#[source] Box<dyn std::error::Error + Send + Sync>),
    #[error("本地操作正忙，请稍后重试")]
    Busy,
    #[error("后台任务执行失败")]
    Worker(#[source] Box<dyn std::error::Error + Send + Sync>),
    #[error("应用正在退出")]
    ShuttingDown,
    #[error("记录不存在或已被删除")]
    NotFound,
    #[error("数据已变化或存在关联，请刷新后重试")]
    Conflict,
    #[error("系统安全凭据库不可用，未保存秘密。请检查系统凭据服务或解锁钥匙串")]
    SecureStore(#[source] Box<dyn std::error::Error + Send + Sync>),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum Theme {
    #[default]
    Dark,
    Light,
    System,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum LogLevel {
    Error,
    Warn,
    #[default]
    Info,
    Debug,
}

impl LogLevel {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Error => "error",
            Self::Warn => "warn",
            Self::Info => "info",
            Self::Debug => "debug",
        }
    }
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum InterfaceFontSize {
    #[serde(alias = "extraSmall")]
    Small,
    #[default]
    Standard,
    Large,
    ExtraLarge,
    UltraLarge,
}

/// Versioned, non-sensitive preferences. Never add credentials to this DTO.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppConfig {
    pub version: u32,
    pub theme: Theme,
    #[serde(default)]
    pub interface_font_size: InterfaceFontSize,
    pub sidebar_width: u16,
    pub terminal_font_size: u8,
    #[serde(default)]
    pub terminal: terminal::TerminalPreferences,
    pub connect_timeout_secs: u16,
    pub monitor_interval_secs: u8,
    #[serde(default = "files::default_concurrency")]
    pub transfer_concurrency: u8,
    pub log_level: LogLevel,
    #[serde(default)]
    pub product: product::ProductPreferences,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            version: CONFIG_VERSION,
            theme: Theme::Dark,
            interface_font_size: InterfaceFontSize::Standard,
            sidebar_width: 248,
            terminal_font_size: 16,
            terminal: Default::default(),
            connect_timeout_secs: 15,
            monitor_interval_secs: 3,
            transfer_concurrency: files::default_concurrency(),
            log_level: LogLevel::Info,
            product: Default::default(),
        }
    }
}

impl AppConfig {
    pub fn validate(&self) -> Result<(), Error> {
        self.terminal.validate()?;
        self.product.validate()?;
        if !(1..=6).contains(&self.transfer_concurrency) {
            return Err(Error::Validation("每主机并发传输须为 1–6"));
        }
        if self.version != CONFIG_VERSION {
            return Err(Error::UnsupportedConfig(self.version));
        }
        if !(200..=400).contains(&self.sidebar_width) {
            return Err(Error::Validation("侧边栏宽度须为 200–400"));
        }
        if !(10..=32).contains(&self.terminal_font_size) {
            return Err(Error::Validation("终端字号须为 10–32"));
        }
        if !(1..=120).contains(&self.connect_timeout_secs) {
            return Err(Error::Validation("连接超时须为 1–120 秒"));
        }
        if ![3, 5, 10, 30].contains(&self.monitor_interval_secs) {
            return Err(Error::Validation("监控间隔须为 3、5、10 或 30 秒"));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Bootstrap {
    pub app_version: String,
    pub database_version: u32,
    pub data_directory: String,
    pub log_directory: String,
    pub config: AppConfig,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub storage: Option<StorageInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageInfo {
    pub root_directory: String,
    pub database_path: String,
    pub plugin_directory: String,
    pub log_directory: String,
    pub webview_directory: String,
    pub notice: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoragePreview {
    pub target_directory: String,
    pub bytes: u64,
    pub available_bytes: u64,
    pub unfinished_tasks: usize,
    pub dirty_documents: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IpcError {
    pub code: &'static str,
    pub message: String,
}

impl From<Error> for IpcError {
    fn from(error: Error) -> Self {
        let code = match &error {
            Error::Connection { code, .. } => code,
            Error::Validation(_) => "VALIDATION",
            Error::UnsupportedConfig(_) | Error::UnsupportedDatabase(_) => "VERSION_UNSUPPORTED",
            Error::Storage(_) => "STORAGE",
            Error::Busy => "BUSY",
            Error::Worker(_) => "WORKER",
            Error::ShuttingDown => "SHUTTING_DOWN",
            Error::NotFound => "NOT_FOUND",
            Error::Conflict => "CONFLICT",
            Error::SecureStore(_) => "SECURE_STORE_UNAVAILABLE",
        };
        Self {
            code,
            message: error.to_string(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_rejects_invalid_ranges_and_future_versions() {
        assert!(AppConfig::default().validate().is_ok());
        for config in [
            AppConfig {
                version: 2,
                ..Default::default()
            },
            AppConfig {
                sidebar_width: 199,
                ..Default::default()
            },
            AppConfig {
                terminal_font_size: 33,
                ..Default::default()
            },
            AppConfig {
                connect_timeout_secs: 0,
                ..Default::default()
            },
            AppConfig {
                monitor_interval_secs: 4,
                ..Default::default()
            },
        ] {
            assert!(config.validate().is_err());
        }
    }

    #[test]
    fn config_contract_rejects_unknown_fields() {
        let mut json = serde_json::to_value(AppConfig::default()).expect("serialize");
        json["password"] = "must not be accepted".into();
        assert!(serde_json::from_value::<AppConfig>(json).is_err());
    }

    #[test]
    fn interface_font_size_defaults_for_legacy_configs_and_rejects_unknown_values() {
        let mut json = serde_json::to_value(AppConfig::default()).expect("serialize");
        assert_eq!(json["interfaceFontSize"], "standard");
        json.as_object_mut()
            .expect("config object")
            .remove("interfaceFontSize");
        let legacy: AppConfig = serde_json::from_value(json.clone()).expect("read legacy config");
        assert_eq!(legacy.interface_font_size, InterfaceFontSize::Standard);
        assert_eq!(legacy.terminal_font_size, 16);

        json["interfaceFontSize"] = "extraSmall".into();
        let former: AppConfig = serde_json::from_value(json.clone()).expect("read former level");
        assert_eq!(former.interface_font_size, InterfaceFontSize::Small);
        assert_eq!(
            serde_json::to_value(former).expect("serialize migrated level")["interfaceFontSize"],
            "small"
        );

        json["interfaceFontSize"] = "extraLarge".into();
        let large: AppConfig = serde_json::from_value(json.clone()).expect("read extra large");
        assert_eq!(large.interface_font_size, InterfaceFontSize::ExtraLarge);
        json["interfaceFontSize"] = "ultraLarge".into();
        let largest: AppConfig = serde_json::from_value(json.clone()).expect("read ultra large");
        assert_eq!(largest.interface_font_size, InterfaceFontSize::UltraLarge);
        json["interfaceFontSize"] = "huge".into();
        assert!(serde_json::from_value::<AppConfig>(json).is_err());
    }

    #[test]
    fn sidebar_width_contract_requires_integer_logical_pixels() {
        let mut json = serde_json::to_value(AppConfig::default()).expect("serialize");
        json["sidebarWidth"] = serde_json::json!(299.5);
        assert!(serde_json::from_value::<AppConfig>(json.clone()).is_err());
        json["sidebarWidth"] = 300.into();
        let config: AppConfig = serde_json::from_value(json).expect("integer sidebar width");
        assert_eq!(config.sidebar_width, 300);
        config.validate().expect("valid sidebar width");
    }

    #[test]
    fn error_source_is_retained_without_crossing_the_ipc_boundary() {
        let error = Error::Storage(Box::new(std::io::Error::other(
            "sensitive internal payload",
        )));
        assert!(std::error::Error::source(&error).is_some());
        let json = serde_json::to_string(&IpcError::from(error)).expect("serialize error");
        assert!(json.contains("STORAGE"));
        assert!(!json.contains("sensitive internal payload"));
    }
}
