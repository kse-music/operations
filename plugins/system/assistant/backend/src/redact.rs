use crate::Error;
use regex::Regex;
use serde_json::Value;

pub struct Redactor {
    rules: Vec<Regex>,
    addresses: Option<Regex>,
    values: Vec<zeroize::Zeroizing<String>>,
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
            Regex::new(
                &s.replace("\\w", "[A-Za-z0-9_]")
                    .replace("\\d", "[0-9]")
                    .replace("\\b", "(?-u:\\b)"),
            )
            .map_err(|e| Error::Worker(Box::new(e)))
        };
        let rules = patterns
            .into_iter()
            .map(compile)
            .collect::<Result<Vec<_>, _>>()?;
        let addresses = if mask_addresses {
            Some(compile(
                r"(?:\b\d{1,3}(?:\.\d{1,3}){3}\b|[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}|\b(?:[0-9a-fA-F]{0,4}:){2,}[0-9a-fA-F:]+\b)",
            )?)
        } else {
            None
        };
        let mut values = values;
        values.sort_by_key(|v| std::cmp::Reverse(v.len()));
        Ok(Self {
            rules,
            addresses,
            values,
        })
    }
    pub fn text(&self, text: &str) -> String {
        let mut result = text.to_owned();
        for value in &self.values {
            result = result.replace(value.as_str(), "[REDACTED]");
        }
        for rule in &self.rules {
            result = rule.replace_all(&result, "[REDACTED]").into_owned();
        }
        if let Some(addresses) = &self.addresses {
            result = addresses.replace_all(&result, "[ADDRESS]").into_owned();
        }
        result
            .chars()
            .filter(|c| !c.is_control() || matches!(c, '\n' | '\r' | '\t'))
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
}
