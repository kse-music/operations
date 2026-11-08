//! Conservative import only. Never executes ssh, Include, Match exec or ProxyCommand.
use crate::{
    Error,
    hosts::{AuthType, HostInput},
};
use serde::Serialize;
use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportCandidate {
    pub alias: String,
    pub host: HostInput,
    pub identity_file: Option<String>,
    pub warnings: Vec<String>,
    pub blocked: bool,
    pub duplicate: bool,
    pub jump_alias: Option<String>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreview {
    pub candidates: Vec<ImportCandidate>,
    pub warnings: Vec<String>,
}
#[derive(Default)]
struct Block {
    patterns: Vec<String>,
    options: Vec<(String, Vec<String>, usize)>,
}

fn words(line: &str) -> Result<Vec<String>, Error> {
    let mut result = Vec::new();
    let mut current = String::new();
    let mut quoted = false;
    let mut chars = line.chars().peekable();
    let mut started = false;
    while let Some(c) = chars.next() {
        match c {
            '"' => {
                quoted = !quoted;
                started = true;
            }
            '#' if !quoted => break,
            '=' if !quoted && result.len() == 1 && !started => (),
            '\\' if quoted && chars.peek().is_some_and(|c| *c == '"' || *c == '\\') => {
                current.push(chars.next().ok_or(Error::Validation("无效转义"))?);
                started = true;
            }
            c if !quoted && (c.is_whitespace() || (c == '=' && result.is_empty())) => {
                if started {
                    result.push(std::mem::take(&mut current));
                    started = false;
                }
            }
            _ => {
                current.push(c);
                started = true;
            }
        }
    }
    if quoted {
        return Err(Error::Validation("OpenSSH 配置包含未闭合引号"));
    }
    if started {
        result.push(current);
    }
    Ok(result)
}

fn wildcard(pattern: &[u8], text: &[u8]) -> bool {
    let (mut p, mut t, mut star, mut saved) = (0, 0, None, 0);
    while t < text.len() {
        if p < pattern.len() && (pattern[p] == b'?' || pattern[p] == text[t]) {
            p += 1;
            t += 1;
        } else if p < pattern.len() && pattern[p] == b'*' {
            star = Some(p);
            p += 1;
            saved = t;
        } else if let Some(s) = star {
            saved += 1;
            t = saved;
            p = s + 1;
        } else {
            return false;
        }
    }
    while p < pattern.len() && pattern[p] == b'*' {
        p += 1;
    }
    p == pattern.len()
}
fn matches(patterns: &[String], alias: &str) -> bool {
    !patterns.iter().any(|p| {
        p.strip_prefix('!')
            .is_some_and(|p| wildcard(p.as_bytes(), alias.as_bytes()))
    }) && patterns
        .iter()
        .any(|p| !p.starts_with('!') && wildcard(p.as_bytes(), alias.as_bytes()))
}

pub fn preview(text: &str, default_user: &str, timeout: u16) -> Result<ImportPreview, Error> {
    if text.len() > 1024 * 1024 || text.contains('\0') {
        return Err(Error::Validation(
            "配置文件须为不含 NUL 的 UTF-8 文本，最大 1 MiB",
        ));
    }
    let mut blocks = vec![Block {
        patterns: vec!["*".into()],
        ..Default::default()
    }];
    let mut aliases = Vec::new();
    let mut seen = HashSet::new();
    let mut global = Vec::new();
    let mut unsafe_semantics = false;
    for (index, line) in text.lines().enumerate() {
        if index >= 10_000 {
            return Err(Error::Validation("配置最多 10000 行，请分批导入"));
        }
        let tokens = words(line)?;
        if tokens.is_empty() {
            continue;
        }
        let keyword = tokens[0].to_ascii_lowercase();
        if keyword.len() > 64 || tokens.iter().skip(1).any(|value| value.len() > 4096) {
            return Err(Error::Validation("配置指令或参数过长"));
        }
        let values = tokens[1..].to_vec();
        if values.is_empty() {
            return Err(Error::Validation("配置指令缺少值"));
        }
        if keyword == "host" {
            for alias in &values {
                if !alias.contains(['*', '?', '!']) && seen.insert(alias.clone()) {
                    crate::hosts::validate_name(alias)?;
                    aliases.push(alias.clone());
                    if aliases.len() > 500 {
                        return Err(Error::Validation("单次最多预览 500 个主机"));
                    }
                }
            }
            blocks.push(Block {
                patterns: values,
                ..Default::default()
            });
        } else if keyword == "match" || keyword == "include" {
            if global.len() >= 64 {
                return Err(Error::Validation("不支持的全局指令过多，请简化配置"));
            }
            global.push(format!(
                "第 {} 行：{} 尚不支持，无法可靠解析其影响，本文件条目禁止导入",
                index + 1,
                tokens[0]
            ));
            unsafe_semantics = true;
            if keyword == "match" {
                blocks.push(Block::default());
            }
        } else {
            blocks
                .last_mut()
                .ok_or(Error::Validation("无配置块"))?
                .options
                .push((keyword, values, index + 1));
        }
    }
    if blocks
        .iter()
        .skip(1)
        .any(|b| b.patterns.iter().any(|p| p.contains(['*', '?', '!'])))
    {
        global.push("通配符/排除模式仅作为明确 Host 别名的匹配规则，不展开为新主机".into());
    }
    let mut candidates = Vec::new();
    for alias in aliases {
        let mut options = HashMap::new();
        let mut identities = Vec::new();
        let mut warnings = Vec::new();
        let mut blocked = unsafe_semantics;
        'matching: for block in blocks.iter().filter(|b| matches(&b.patterns, &alias)) {
            for (key, value, line) in &block.options {
                if warnings.len() >= 64 {
                    blocked = true;
                    warnings.push("警告过多，已阻止此条目，请简化配置".into());
                    break 'matching;
                }
                match key.as_str() {
                    "hostname"
                    | "port"
                    | "user"
                    | "connecttimeout"
                    | "proxyjump"
                    | "serveraliveinterval"
                    | "serveralivecountmax" => {
                        if value.len() != 1 {
                            blocked = true;
                            warnings.push(format!("第 {line} 行：{key} 参数格式不支持"));
                        } else {
                            options
                                .entry(key.as_str())
                                .or_insert_with(|| value[0].clone());
                        }
                    }
                    "identityfile" => {
                        if value.len() != 1 {
                            blocked = true;
                            warnings.push(format!("第 {line} 行：IdentityFile 参数格式不支持"));
                        } else if !identities.contains(&value[0]) {
                            identities.push(value[0].clone());
                            if identities.len() > 1 {
                                break 'matching;
                            }
                        }
                    }
                    // These options do not change endpoint/authentication semantics; warn explicitly.
                    "tcpkeepalive" | "compression" => {
                        warnings.push(format!("第 {line} 行：{key} 暂不导入"))
                    }
                    _ => {
                        blocked = true;
                        warnings.push(format!(
                            "第 {line} 行：不支持 {key}，为避免错误连接已阻止此条目"
                        ));
                    }
                }
            }
        }
        if identities.len() > 1 {
            blocked = true;
            warnings.push("多个 IdentityFile 不能无损表示为单一凭据，请调整配置后导入".into());
        }
        let identity_file = identities.first().filter(|p| p.as_str() != "none").cloned();
        if identity_file
            .as_ref()
            .is_some_and(|p| p.trim().is_empty() || p.chars().any(char::is_control))
        {
            blocked = true;
            warnings.push("IdentityFile 路径无效".into());
        }
        if identity_file
            .as_ref()
            .is_some_and(|p| p.contains('%') || p.contains("${"))
        {
            blocked = true;
            warnings.push("IdentityFile 中的变量/令牌尚不支持展开".into());
        }
        let mut host = HostInput {
            name: alias.clone(),
            hostname: options
                .get("hostname")
                .cloned()
                .unwrap_or_else(|| alias.clone()),
            port: 22,
            username: options
                .get("user")
                .cloned()
                .unwrap_or_else(|| default_user.to_owned()),
            auth_type: if identity_file.is_some() {
                AuthType::PrivateKey
            } else {
                AuthType::Agent
            },
            credential_id: None,
            group_id: None,
            description: String::new(),
            favorite: false,
            connect_timeout_secs: timeout,
            ssh: Default::default(),
        };
        if let Some(port) = options.get("port") {
            match port.parse::<u16>() {
                Ok(port) => host.port = port,
                Err(_) => {
                    blocked = true;
                    warnings.push("Port 无效".into());
                }
            }
        }
        if let Some(timeout) = options.get("connecttimeout") {
            match timeout.parse::<u16>() {
                Ok(timeout) => host.connect_timeout_secs = timeout,
                Err(_) => {
                    blocked = true;
                    warnings.push("ConnectTimeout 无效".into());
                }
            }
        }
        for (key, field) in [("serveraliveinterval", &mut host.ssh.keepalive_interval_secs)] {
            if let Some(value) = options.get(key) {
                match value.parse::<u16>() {
                    Ok(value) => *field = value,
                    Err(_) => {
                        blocked = true;
                        warnings.push(format!("{key} 无效"));
                    }
                }
            }
        }
        if let Some(value) = options.get("serveralivecountmax") {
            match value.parse::<u8>() {
                Ok(value) => host.ssh.keepalive_count_max = value,
                Err(_) => {
                    blocked = true;
                    warnings.push("ServerAliveCountMax 无效".into());
                }
            }
        }
        let jump_alias = options
            .get("proxyjump")
            .filter(|v| v.as_str() != "none")
            .cloned();
        if let Some(alias) = &jump_alias {
            if alias.contains([',', '@', ':', '%', '$', '/', '\\']) || alias == &host.name {
                blocked = true;
                warnings.push(
                    "ProxyJump 仅导入已管理的 Host 别名；多跳请为跳板逐级配置，不执行 ProxyCommand"
                        .into(),
                );
            } else {
                warnings.push(format!(
                    "ProxyJump {alias}：须同时选择跳板条目或已存在同名主机；逐跳校验密钥"
                ));
            }
        }
        match host.clone().normalize() {
            Ok(normalized) => host = normalized,
            Err(error) => {
                blocked = true;
                warnings.push(error.to_string());
            }
        }
        candidates.push(ImportCandidate {
            alias,
            host,
            identity_file,
            warnings,
            blocked,
            duplicate: false,
            jump_alias,
        });
    }
    Ok(ImportPreview {
        candidates,
        warnings: global,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn common_keepalive_and_managed_jump_alias_are_preserved() {
        let parsed=preview("Host app\n HostName example.com\n ProxyJump bastion\n ServerAliveInterval 25\n ServerAliveCountMax 4\nHost bastion\n HostName jump.example.com", "user", 15).expect("preview");
        let app = &parsed.candidates[0];
        assert!(!app.blocked);
        assert_eq!(app.jump_alias.as_deref(), Some("bastion"));
        assert_eq!(app.host.ssh.keepalive_interval_secs, 25);
        assert_eq!(app.host.ssh.keepalive_count_max, 4);
    }
    #[test]
    fn applies_first_value_wildcards_negation_quotes_and_multiple_aliases() {
        let p = preview("Host app other\n HostName=EXAMPLE.com\n User ops # comment\n IdentityFile \"~/.ssh/key with space\"\nHost * !other\n Port 2222\nHost *\n Port 22\n User ignored", "local", 15).expect("parse");
        assert_eq!(p.candidates.len(), 2);
        assert_eq!(p.candidates[0].host.port, 2222);
        assert_eq!(p.candidates[1].host.port, 22);
        assert_eq!(p.candidates[0].host.username, "ops");
        assert_eq!(
            p.candidates[0].identity_file.as_deref(),
            Some("~/.ssh/key with space")
        );
        assert!(!p.candidates[0].blocked);
    }
    #[test]
    fn blocks_unsafe_or_lossy_import_and_rejects_malformed_input() {
        for config in [
            "Host app\n ProxyCommand arbitrary-command",
            "Include other\nHost app",
            "Host app\nMatch exec test\n User ops",
            "Host app\nIdentityFile a\nIdentityFile b",
            "Host app\n Port 0",
        ] {
            assert!(
                preview(config, "ops", 15)
                    .expect("preview")
                    .candidates
                    .iter()
                    .all(|c| c.blocked)
            );
        }
        assert!(preview("Host a\n IdentityFile \"unterminated", "ops", 15).is_err());
    }
    #[test]
    fn hostile_import_is_bounded_and_rejects_oversized_paths() {
        let config = format!("Host app\n{}", "Unsupported value\n".repeat(1000));
        let result = preview(&config, "ops", 15).expect("bounded preview");
        assert!(result.candidates[0].blocked);
        assert!(result.candidates[0].warnings.len() <= 65);
        assert!(
            preview(
                &format!("Host app\nIdentityFile {}", "a".repeat(4097)),
                "ops",
                15
            )
            .is_err()
        );
    }
}
