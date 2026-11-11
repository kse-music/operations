use crate::Error;
use regex::{Regex, RegexBuilder};
use serde_json::Value;
use std::{cell::RefCell, rc::Rc};

struct Rules {
    rules: Vec<Regex>,
    addresses: Regex,
}

thread_local! {
    static RULES: RefCell<Option<Rc<Rules>>> = const { RefCell::new(None) };
}

pub struct Redactor {
    rules: Rc<Rules>,
    mask_addresses: bool,
    values: Vec<zeroize::Zeroizing<String>>,
}

pub fn initialize() -> Result<(), Error> {
    rules().map(|_| ())
}

fn rules() -> Result<Rc<Rules>, Error> {
    RULES.with_borrow_mut(|cached| {
        if let Some(rules) = cached {
            return Ok(rules.clone());
        }
        let patterns = [
            r"(?s)-----BEGIN [^-]*PRIVATE KEY-----.*?(?:-----END [^-]*PRIVATE KEY-----|$)",
            r#"(?im)(?:[\w.-]*(?:password|passwd|secret|token|api[_-]?key|authorization|credential|cookie)[\w.-]*)["']?\s*[:=]\s*[^\r\n,}]+"#,
            r"(?i)\bBearer\s+[a-z0-9._~+/=-]+",
            r"\bsk-[a-zA-Z0-9_-]{8,}\b",
            r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b",
            r"\beyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\b",
            r"(?i)https?://[^\s/@]+:[^\s/@]+@[^\s]+",
        ];
        // Credential keys and network address syntax are ASCII. Avoid building
        // Unicode word tables inside a sandbox; literal values still support UTF-8.
        let compile = |s: &str| {
            RegexBuilder::new(
                &s.replace("\\w", "[A-Za-z0-9_]")
                    .replace("\\d", "[0-9]")
                    .replace("\\b", "(?-u:\\b)"),
            )
            // Keep lazy-DFA scans within the VM's memory and fuel budgets.
            .dfa_size_limit(64 * 1024)
            .build()
            .map_err(|e| Error::Worker(Box::new(e)))
        };
        let rules = patterns
            .into_iter()
            .map(compile)
            .collect::<Result<Vec<_>, _>>()?;
        let addresses = compile(
                r"(?:\b\d{1,3}(?:\.\d{1,3}){3}\b|[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}|\b(?:[0-9a-fA-F]{0,4}:){2,}[0-9a-fA-F:]+\b)",
            )?;
        let rules = Rc::new(Rules { rules, addresses });
        *cached = Some(rules.clone());
        Ok(rules)
    })
}

impl Redactor {
    pub fn new(
        mask_addresses: bool,
        values: Vec<zeroize::Zeroizing<String>>,
    ) -> Result<Self, Error> {
        if values.len() > 33 || values.iter().any(|v| v.len() > 4096 || v.trim().is_empty()) {
            return Err(Error::Validation(
                "自定义脱敏值最多 32 项，每项 1–4096 字节",
            ));
        }
        let mut values = values;
        values.sort_by_key(|v| std::cmp::Reverse(v.len()));
        Ok(Self {
            rules: rules()?,
            mask_addresses,
            values,
        })
    }
    pub fn text(&self, text: &str) -> String {
        let mut result = text.to_owned();
        for value in &self.values {
            result = result.replace(value.as_str(), "[REDACTED]");
        }
        for rule in &self.rules.rules {
            result = rule.replace_all(&result, "[REDACTED]").into_owned();
        }
        if self.mask_addresses {
            result = self
                .rules
                .addresses
                .replace_all(&result, "[ADDRESS]")
                .into_owned();
        }
        result
            .chars()
            .filter(|c| !c.is_control() || matches!(c, '\n' | '\r' | '\t'))
            .collect()
    }
    /// Hold unfinished ASCII tokens and literal-secret prefixes before applying existing rules.
    pub fn stream_text(&self, text: &str, complete: bool) -> String {
        if complete {
            return self.text(text);
        }
        let mut end = text.len();
        for (i, ch) in text.char_indices().rev() {
            if !ch.is_ascii() || ch.is_whitespace() {
                break;
            }
            end = i;
        }
        for value in &self.values {
            let max = value.len().min(text.len());
            for length in (1..=max).rev() {
                if value.is_char_boundary(length) && text.ends_with(&value[..length]) {
                    end = end.min(text.len() - length);
                    break;
                }
            }
        }
        self.text(&text[..end])
    }
    /// Mask original ranges while preserving line boundaries used by file edits.
    pub fn lines(&self, text: &str) -> String {
        let mut ranges = Vec::new();
        for value in &self.values {
            ranges.extend(
                text.match_indices(value.as_str())
                    .map(|(i, _)| (i, i + value.len())),
            );
        }
        for rule in &self.rules.rules {
            ranges.extend(rule.find_iter(text).map(|m| (m.start(), m.end())));
        }
        if self.mask_addresses {
            ranges.extend(
                self.rules
                    .addresses
                    .find_iter(text)
                    .map(|m| (m.start(), m.end())),
            );
        }
        ranges.sort_unstable();
        let mut merged: Vec<(usize, usize)> = Vec::new();
        for (start, end) in ranges {
            if let Some(last) = merged.last_mut()
                && start <= last.1
            {
                last.1 = last.1.max(end);
                continue;
            }
            merged.push((start, end));
        }
        let mut output = String::new();
        let mut cursor = 0;
        for (start, end) in merged {
            output.push_str(&text[cursor..start]);
            let mut masked = false;
            for c in text[start..end].chars() {
                if matches!(c, '\r' | '\n') {
                    output.push(c);
                    masked = false;
                } else if !masked {
                    output.push_str("[REDACTED]");
                    masked = true;
                }
            }
            cursor = end;
        }
        output.push_str(&text[cursor..]);
        output
            .chars()
            .filter(|c| !c.is_control() || matches!(c, '\r' | '\n' | '\t'))
            .collect()
    }
    pub fn value(&self, value: &mut Value) {
        match value {
            Value::String(s) => *s = self.text(s),
            Value::Array(values) => values.iter_mut().for_each(|v| self.value(v)),
            Value::Object(map) => {
                for (key, value) in map {
                    let key = key.to_ascii_lowercase();
                    if [
                        "password",
                        "secret",
                        "token",
                        "apikey",
                        "api_key",
                        "authorization",
                        "cookie",
                        "privatekey",
                        "env",
                    ]
                    .iter()
                    .any(|s| key.contains(s))
                    {
                        *value = Value::String("[REDACTED]".into());
                    } else {
                        self.value(value);
                    }
                }
            }
            _ => (),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn streamed_prefixes_do_not_reveal_split_credentials_addresses_or_literal_secrets() {
        let redactor =
            Redactor::new(true, vec!["蓝鲸保密值 with spaces".to_owned().into()]).unwrap();
        let text = "开始 蓝鲸保密值 with spaces\n密码 password=secret-value\nBearer abcdefgh\nsk-abcdefghijklmnop\n192.168.1.159\n结束";
        for (end, _) in text.char_indices().skip(1) {
            let shown = redactor.stream_text(&text[..end], false);
            for secret in ["蓝鲸", "secret-value", "abcdef", "sk-abc", "192.168"] {
                assert!(!shown.contains(secret), "prefix {end}: {shown}");
            }
        }
        assert_eq!(redactor.stream_text(text, true), redactor.text(text));
        assert!(
            !redactor
                .stream_text("开始 secret-value", false)
                .contains("secret-value")
        );
    }
    #[test]
    fn file_redaction_preserves_original_line_coordinates_including_multiline_secrets() {
        let raw = "header\r\n-----BEGIN OPENSSH PRIVATE KEY-----\r\nprivate\r\n-----END OPENSSH PRIVATE KEY-----\r\npassword: secret\r\nlast\r\n";
        let masked = Redactor::new(true, vec![]).unwrap().lines(raw);
        assert_eq!(masked.lines().count(), raw.lines().count());
        assert_eq!(masked.lines().nth(5), Some("last"));
        assert!(!masked.contains("private"));
        assert!(!masked.contains("secret"));
        let (result, _) = crate::files::apply(
            raw,
            &[crate::files::Edit {
                start_line: 6,
                delete_lines: 1,
                insert_lines: vec!["x: yy".into()],
            }],
        )
        .unwrap();
        assert!(result.starts_with(raw.strip_suffix("last\r\n").unwrap()));
        assert!(result.ends_with("x: yy\r\n"));
    }
    #[test]
    fn redacts_nested_secrets_keys_urls_private_keys_addresses_and_literals() {
        let redactor = Redactor::new(true, vec!["internal.example".to_owned().into()]).unwrap();
        let mut value = serde_json::json!({"Env":["not-a-key"],"text":"password=hello\napi_key: whatever\nBearer abc.def\nsk-abcdefghijkl\nhttps://foo:bar@example.com/secret\n192.168.1.2 internal.example\n-----BEGIN OPENSSH PRIVATE KEY-----\nprivate\n-----END OPENSSH PRIVATE KEY-----"});
        redactor.value(&mut value);
        let output = value.to_string();
        for secret in [
            "not-a-key",
            "hello",
            "whatever",
            "abc.def",
            "abcdefghijkl",
            "foo:bar",
            "192.168.1.2",
            "internal.example",
            "private\\n",
        ] {
            assert!(!output.contains(secret), "{secret}");
        }
        assert!(output.contains("[REDACTED]"));
    }

    #[test]
    fn preserves_unicode_matching_and_optional_address_masking() {
        for mask in [false, true] {
            let redactor = Redactor::new(mask, vec!["中文秘密".to_owned().into()]).unwrap();
            let output = redactor.text(
                "中文说明\nAPI_KEY：无分隔符\nAPI_KEY\u{2003}=\u{2003}unicode-secret\nBearer\u{2003}bearer-secret\n中文秘密\n192.168.1.2 user@example.com 2001:db8::1",
            );
            assert!(output.contains("中文说明"));
            for secret in ["unicode-secret", "bearer-secret", "中文秘密"] {
                assert!(!output.contains(secret), "{secret}");
            }
            for address in ["192.168.1.2", "user@example.com", "2001:db8::1"] {
                assert_eq!(output.contains(address), !mask, "{address}");
            }
        }
    }

    #[test]
    fn cached_rules_do_not_share_custom_secrets_or_address_preferences() {
        let first = Redactor::new(true, vec!["custom-secret".to_owned().into()]).unwrap();
        let second = Redactor::new(false, vec![]).unwrap();
        let text = "custom-secret 192.168.1.2";
        assert_eq!(first.text(text), "[REDACTED] [ADDRESS]");
        assert_eq!(second.text(text), text);
    }
}
