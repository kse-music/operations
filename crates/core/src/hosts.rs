use std::net::IpAddr;

use crate::Error;
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthType {
    Password,
    PrivateKey,
    Agent,
}
impl AuthType {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Password => "password",
            Self::PrivateKey => "private_key",
            Self::Agent => "agent",
        }
    }
    pub fn parse(value: &str) -> Result<Self, Error> {
        match value {
            "password" => Ok(Self::Password),
            "private_key" => Ok(Self::PrivateKey),
            "agent" => Ok(Self::Agent),
            _ => Err(Error::Validation("认证方式不受支持")),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostInput {
    /// Empty means the UI displays the address and non-default SSH port.
    pub name: String,
    pub hostname: String,
    pub port: u16,
    pub username: String,
    pub auth_type: AuthType,
    pub credential_id: Option<String>,
    pub group_id: Option<String>,
    pub tags: Vec<String>,
    pub description: String,
    pub favorite: bool,
    pub connect_timeout_secs: u16,
    #[serde(default)]
    pub ssh: crate::connection::SshOptions,
}

pub fn validate_name(name: &str) -> Result<(), Error> {
    if name.trim().is_empty() || name.chars().count() > 128 || name.chars().any(char::is_control) {
        return Err(Error::Validation("名称须为 1–128 个字符，且不含控制字符"));
    }
    Ok(())
}

pub fn normalize_hostname(host: &str) -> Result<String, Error> {
    let host = host.trim();
    if let Ok(ip) = host.parse::<IpAddr>() {
        return Ok(ip.to_string());
    }
    let dns = host.strip_suffix('.').unwrap_or(host);
    if dns.is_empty()
        || dns.len() > 253
        || !dns.is_ascii()
        || dns.bytes().all(|b| b.is_ascii_digit() || b == b'.')
        || !dns.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && label
                    .as_bytes()
                    .first()
                    .is_some_and(u8::is_ascii_alphanumeric)
                && label
                    .as_bytes()
                    .last()
                    .is_some_and(u8::is_ascii_alphanumeric)
                && label
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-')
        })
    {
        return Err(Error::Validation(
            "地址须为有效 IP 或 ASCII 域名；不要包含协议或端口",
        ));
    }
    Ok(dns.to_ascii_lowercase())
}

impl HostInput {
    pub fn display_name(&self) -> String {
        if !self.name.trim().is_empty() {
            self.name.trim().to_owned()
        } else if self.port == 22 {
            self.hostname.clone()
        } else if self.hostname.contains(':') {
            format!("[{}]:{}", self.hostname, self.port)
        } else {
            format!("{}:{}", self.hostname, self.port)
        }
    }

    pub fn normalize(mut self) -> Result<Self, Error> {
        self.ssh.normalize_host()?;
        self.name = self.name.trim().to_owned();
        if !self.name.is_empty() {
            validate_name(&self.name)?;
        }
        self.hostname = normalize_hostname(&self.hostname)?;
        self.username = self.username.trim().to_owned();
        if self.username.is_empty()
            || self.username.len() > 128
            || self
                .username
                .chars()
                .any(|c| c.is_whitespace() || c.is_control())
        {
            return Err(Error::Validation(
                "用户名不能为空、超过 128 字节或包含空白/控制字符",
            ));
        }
        if self.port == 0 {
            return Err(Error::Validation("端口须为 1–65535"));
        }
        if !(1..=120).contains(&self.connect_timeout_secs) {
            return Err(Error::Validation("连接超时须为 1–120 秒"));
        }
        if self.description.len() > 8192 || self.description.contains('\0') {
            return Err(Error::Validation("备注过长或包含非法字符"));
        }
        if self.tags.len() > 32 {
            return Err(Error::Validation("每台主机最多 32 个标签"));
        }
        self.tags = self
            .tags
            .into_iter()
            .map(|tag| tag.trim().to_owned())
            .collect();
        if self.tags.iter().any(|tag| {
            tag.is_empty() || tag.chars().count() > 64 || tag.chars().any(char::is_control)
        }) {
            return Err(Error::Validation("标签须为 1–64 个字符"));
        }
        self.tags.sort();
        self.tags.dedup();
        if self.auth_type == AuthType::Agent && self.credential_id.is_some() {
            return Err(Error::Validation(
                "SSH Agent 使用系统代理，不关联密码或私钥凭据",
            ));
        }
        Ok(self)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Host {
    pub id: String,
    #[serde(flatten)]
    pub config: HostInput,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GroupInput {
    pub name: String,
    pub sort_order: i32,
    #[serde(default)]
    pub parent_id: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostGroup {
    pub id: String,
    pub name: String,
    pub sort_order: i32,
    #[serde(default)]
    pub parent_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Credential {
    pub id: String,
    pub name: String,
    pub kind: AuthType,
    pub key_path: Option<String>,
    pub has_secret: bool,
    pub host_count: u32,
    pub revision: u32,
}

// Input-only. No Debug or Serialize: secrets must never be returned or logged.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CredentialInput {
    pub name: String,
    pub kind: AuthType,
    pub key_path: Option<String>,
    pub key_data: Option<Zeroizing<String>>,
    pub secret: Option<Zeroizing<String>>,
    pub clear_secret: bool,
}
impl CredentialInput {
    pub fn validate(&self) -> Result<(), Error> {
        validate_name(&self.name)?;
        if self.kind == AuthType::Agent {
            return Err(Error::Validation("Agent 无需创建凭据"));
        }
        if (self.key_path.is_some() || self.key_data.is_some()) && self.kind != AuthType::PrivateKey
        {
            return Err(Error::Validation("密码凭据不能包含私钥"));
        }
        if let Some(path) = &self.key_path
            && (self.key_data.is_some()
                || path.trim().is_empty()
                || path.len() > 4096
                || path.chars().any(char::is_control))
        {
            return Err(Error::Validation("旧式私钥路径无效或与导入文件冲突"));
        }
        if self
            .key_data
            .as_ref()
            .is_some_and(|key| key.is_empty() || key.len() > 1024 * 1024)
        {
            return Err(Error::Validation("私钥文件须为 1 字节至 1 MiB"));
        }
        if self.key_data.is_some() && self.clear_secret {
            return Err(Error::Validation("导入私钥时不能同时清除旧口令"));
        }
        if self
            .secret
            .as_ref()
            .is_some_and(|s| s.len() > 2048 || s.is_empty())
        {
            return Err(Error::Validation("秘密须为 1–2048 字节；留空表示保持不变"));
        }
        if self.clear_secret && self.secret.is_some() {
            return Err(Error::Validation("不能同时替换和清除秘密"));
        }
        Ok(())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Mutation<T> {
    pub value: T,
    pub warnings: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Catalog {
    pub hosts: Vec<Host>,
    pub groups: Vec<HostGroup>,
    pub credentials: Vec<Credential>,
    pub pending_secret_deletions: u32,
}

#[cfg(test)]
mod tests {
    use super::*;
    pub fn host() -> HostInput {
        HostInput {
            ssh: Default::default(),
            name: "主机".into(),
            hostname: "Example.COM".into(),
            port: 22,
            username: "ops".into(),
            auth_type: AuthType::Agent,
            credential_id: None,
            group_id: None,
            tags: vec![],
            description: String::new(),
            favorite: false,
            connect_timeout_secs: 15,
        }
    }
    #[test]
    fn host_names_are_optional_but_named_hosts_still_validate() {
        for name in ["", "   "] {
            let mut input = host();
            input.name = name.into();
            let normalized = input.normalize().expect("unnamed host");
            assert!(normalized.name.is_empty());
            assert_eq!(normalized.display_name(), "example.com");
            let mut custom_port = normalized.clone();
            custom_port.port = 2222;
            assert_eq!(custom_port.display_name(), "example.com:2222");
            custom_port.hostname = "2001:db8::1".into();
            assert_eq!(custom_port.display_name(), "[2001:db8::1]:2222");
            custom_port.port = 22;
            assert_eq!(custom_port.display_name(), "2001:db8::1");
        }
        let mut named = host();
        named.name = "  生产  ".into();
        assert_eq!(named.normalize().expect("named").display_name(), "生产");
        for name in ["x".repeat(129), "bad\0name".into()] {
            let mut invalid = host();
            invalid.name = name;
            assert!(invalid.normalize().is_err());
        }
        assert!(
            validate_name("").is_err(),
            "group/credential names remain required"
        );
    }

    #[test]
    fn validates_ips_dns_ports_and_user_input() {
        assert_eq!(host().normalize().expect("host").hostname, "example.com");
        for address in ["::1", "127.0.0.1", "host-1.local", "example.com."] {
            assert!(normalize_hostname(address).is_ok());
        }
        for address in [
            "https://example.com",
            "example.com:22",
            "999.0.0.1",
            "-bad.com",
            "a..b",
            "",
            "bad host",
        ] {
            assert!(normalize_hostname(address).is_err(), "{address}");
        }
        let mut invalid = host();
        invalid.port = 0;
        assert!(invalid.normalize().is_err());
        let mut invalid = host();
        invalid.username = "a b".into();
        assert!(invalid.normalize().is_err());
        let mut invalid = host();
        invalid.tags = vec!["".into()];
        assert!(invalid.normalize().is_err());
    }
}
