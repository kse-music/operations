use crate::{Error, hosts::normalize_hostname};
use serde::{Deserialize, Serialize};
use std::net::IpAddr;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProxyKind {
    Socks5,
    HttpConnect,
}
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProxySettings {
    pub kind: ProxyKind,
    pub hostname: String,
    pub port: u16,
    pub username: Option<String>,
    pub credential_id: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct SshOptions {
    pub auth_timeout_secs: u16,
    pub keepalive_interval_secs: u16,
    pub keepalive_count_max: u8,
    pub jump_host_id: Option<String>,
    pub proxy: Option<ProxySettings>,
}
impl Default for SshOptions {
    fn default() -> Self {
        Self {
            auth_timeout_secs: 15,
            keepalive_interval_secs: 15,
            keepalive_count_max: 3,
            jump_host_id: None,
            proxy: None,
        }
    }
}
impl SshOptions {
    pub fn normalize(&mut self) -> Result<(), Error> {
        if !(1..=120).contains(&self.auth_timeout_secs)
            || !(1..=3600).contains(&self.keepalive_interval_secs)
            || !(1..=10).contains(&self.keepalive_count_max)
        {
            return Err(Error::Validation(
                "认证超时须为 1–120 秒，Keepalive 间隔 1–3600 秒、失败次数 1–10",
            ));
        }
        if let Some(id) = &self.jump_host_id {
            uuid::Uuid::parse_str(id).map_err(|_| Error::Validation("跳板主机引用无效"))?;
        }
        if let Some(proxy) = &mut self.proxy {
            proxy.hostname = normalize_hostname(&proxy.hostname)?;
            if proxy.port == 0 {
                return Err(Error::Validation("代理端口须为 1–65535"));
            }
            if let Some(user) = &proxy.username
                && (user.is_empty()
                    || user.len() > 255
                    || user.chars().any(|c| c.is_control() || c == ':'))
            {
                return Err(Error::Validation("代理用户名无效或超过 255 字节"));
            }
            if proxy.username.is_some() != proxy.credential_id.is_some() {
                return Err(Error::Validation("代理认证须同时配置用户名和安全密码凭据"));
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ForwardKind {
    Local,
    Remote,
    Dynamic,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ForwardInput {
    pub kind: ForwardKind,
    pub bind_address: IpAddr,
    pub listen_port: u16,
    pub target_host: Option<String>,
    pub target_port: Option<u16>,
    pub confirm_public: bool,
}
impl ForwardInput {
    pub fn validate(&mut self) -> Result<(), Error> {
        if !self.bind_address.is_loopback() && !self.confirm_public {
            return Err(Error::Validation("非回环监听必须显式确认网络暴露风险"));
        }
        if self.kind == ForwardKind::Remote && self.listen_port == 0 {
            return Err(Error::Validation("远程转发请指定 1–65535 监听端口"));
        }
        if self.kind != ForwardKind::Dynamic {
            let host = self
                .target_host
                .as_deref()
                .ok_or(Error::Validation("转发目标主机不能为空"))?;
            self.target_host = Some(normalize_hostname(host)?);
            if self.target_port.is_none_or(|port| port == 0) {
                return Err(Error::Validation("转发目标端口无效"));
            }
        } else if self.target_host.is_some() || self.target_port.is_some() {
            return Err(Error::Validation("动态转发不预设目标地址"));
        }
        Ok(())
    }
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForwardInfo {
    pub id: String,
    pub session_id: String,
    pub input: ForwardInput,
    pub state: &'static str,
    pub message: Option<String>,
    pub active_connections: usize,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn non_loopback_forward_requires_explicit_confirmation() {
        let mut input = ForwardInput {
            kind: ForwardKind::Local,
            bind_address: "0.0.0.0".parse().expect("IP"),
            listen_port: 0,
            target_host: Some("localhost".into()),
            target_port: Some(80),
            confirm_public: false,
        };
        assert!(input.validate().is_err());
        input.confirm_public = true;
        input.validate().expect("explicit confirmation");
        input.kind = ForwardKind::Remote;
        assert!(input.validate().is_err());
    }
    #[test]
    fn proxy_auth_never_silently_falls_back_to_anonymous() {
        let mut options = SshOptions {
            proxy: Some(ProxySettings {
                kind: ProxyKind::Socks5,
                hostname: "localhost".into(),
                port: 1080,
                username: Some("user".into()),
                credential_id: None,
            }),
            ..Default::default()
        };
        assert!(options.normalize().is_err());
        options.proxy.as_mut().expect("proxy").credential_id =
            Some(uuid::Uuid::new_v4().to_string());
        options.normalize().expect("valid reference");
    }
}
