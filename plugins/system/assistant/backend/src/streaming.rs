//! Incremental reply preview only. Full model JSON still goes through workflow validation.
use crate::{Error, redact::Redactor};
use serde_json::Value;
use serverdeck_plugin_sdk::{backend::Context, platform, streaming::Request};

#[derive(Clone, Copy)]
enum Role {
    Key,
    Kind,
    Reply,
    Ignore,
}
#[derive(Default)]
struct Preview {
    depth: usize,
    key_expected: bool,
    role: Option<Role>,
    field: String,
    current: String,
    kind: String,
    reply_field: String,
    text: String,
    escape: bool,
    unicode_left: u8,
    unicode: u16,
    high: Option<u16>,
    invalid: bool,
}
impl Preview {
    fn push(&mut self, chunk: &str) {
        for ch in chunk.chars() {
            if self.invalid {
                break;
            }
            if self.role.is_some() {
                self.string(ch);
                continue;
            }
            match ch {
                '{' | '[' => {
                    self.depth += 1;
                    if self.depth == 1 {
                        self.key_expected = true;
                    }
                }
                '}' | ']' => self.depth = self.depth.saturating_sub(1),
                ',' if self.depth == 1 => {
                    self.key_expected = true;
                    self.field.clear();
                }
                '"' => {
                    self.current.clear();
                    let role = if self.depth != 1 {
                        Role::Ignore
                    } else if self.key_expected {
                        Role::Key
                    } else if self.field == "kind" {
                        Role::Kind
                    } else if matches!(self.field.as_str(), "text" | "summary" | "answer") {
                        self.text.clear();
                        self.reply_field.clone_from(&self.field);
                        Role::Reply
                    } else {
                        Role::Ignore
                    };
                    self.role = Some(role);
                }
                _ => (),
            }
        }
    }
    fn emit(&mut self, ch: char) {
        match self.role {
            Some(Role::Reply) => self.text.push(ch),
            Some(Role::Key | Role::Kind) => {
                if self.current.len() >= 256 {
                    self.invalid = true;
                } else {
                    self.current.push(ch);
                }
            }
            _ => (),
        }
    }
    fn string(&mut self, ch: char) {
        if self.unicode_left > 0 {
            let Some(digit) = ch.to_digit(16) else {
                self.invalid = true;
                return;
            };
            self.unicode = (self.unicode << 4) | digit as u16;
            self.unicode_left -= 1;
            if self.unicode_left != 0 {
                return;
            }
            let code = self.unicode;
            if let Some(high) = self.high.take() {
                if !(0xdc00..=0xdfff).contains(&code) {
                    self.invalid = true;
                    return;
                }
                if let Some(c) = char::from_u32(
                    0x10000 + ((u32::from(high) - 0xd800) << 10) + u32::from(code) - 0xdc00,
                ) {
                    self.emit(c);
                }
            } else if (0xd800..=0xdbff).contains(&code) {
                self.high = Some(code);
            } else if let Some(c) = char::from_u32(u32::from(code)) {
                self.emit(c);
            } else {
                self.invalid = true;
            }
            return;
        }
        if self.escape {
            self.escape = false;
            if ch == 'u' {
                self.unicode = 0;
                self.unicode_left = 4;
                return;
            }
            if self.high.is_some() {
                self.invalid = true;
                return;
            }
            let decoded = match ch {
                '"' => '"',
                '\\' => '\\',
                '/' => '/',
                'n' => '\n',
                'r' => '\r',
                't' => '\t',
                'b' => '\u{8}',
                'f' => '\u{c}',
                _ => {
                    self.invalid = true;
                    return;
                }
            };
            self.emit(decoded);
            return;
        }
        if self.high.is_some() && ch != '\\' {
            self.invalid = true;
            return;
        }
        match ch {
            '\\' => self.escape = true,
            '"' => match self.role.take() {
                Some(Role::Key) => {
                    self.field.clone_from(&self.current);
                    self.key_expected = false;
                }
                Some(Role::Kind) => self.kind.clone_from(&self.current),
                _ => (),
            },
            c if c.is_control() => self.invalid = true,
            c => self.emit(c),
        }
    }
    fn text(&self) -> &str {
        if !self.invalid
            && matches!(
                (self.kind.as_str(), self.reply_field.as_str()),
                ("answer", "text") | ("plan", "summary") | ("", "answer")
            )
        {
            &self.text
        } else {
            ""
        }
    }
}

async fn publish(
    context: &Context,
    id: &str,
    last: &mut String,
    text: String,
) -> Result<(), Error> {
    if *last == text {
        return Ok(());
    }
    let (mut rest, mut reset) = if let Some(suffix) = text.strip_prefix(last.as_str()) {
        (suffix, false)
    } else {
        (text.as_str(), true)
    };
    loop {
        let mut end = rest.len().min(16 * 1024);
        while !rest.is_char_boundary(end) {
            end -= 1;
        }
        context
            .request(platform::Request::Streaming {
                request: Request::ProgressPublish {
                    id: id.into(),
                    text: rest[..end].into(),
                    reset,
                },
            })
            .await?;
        rest = &rest[end..];
        reset = false;
        if rest.is_empty() {
            break;
        }
    }
    *last = text;
    Ok(())
}

pub async fn complete(
    context: &Context,
    model: &Value,
    messages: Vec<platform::Message>,
    redactor: &Redactor,
    progress_id: &str,
) -> Result<Value, Error> {
    context
        .request(platform::Request::Streaming {
            request: Request::ProgressPublish {
                id: progress_id.into(),
                text: String::new(),
                reset: true,
            },
        })
        .await?;
    let stream = context
        .request(platform::Request::Streaming {
            request: Request::ModelStart {
                model_id: model["id"]
                    .as_str()
                    .ok_or(Error::Validation("模型ID无效"))?
                    .into(),
                expected_revision: model["revision"].as_str().map(str::to_owned),
                messages,
            },
        })
        .await?;
    let id = stream["id"]
        .as_str()
        .ok_or(Error::Validation("模型流句柄无效"))?
        .to_owned();
    let result = async {
        let mut preview = Preview::default();
        let mut raw = String::new();
        let mut last = String::new();
        loop {
            let part = context
                .request(platform::Request::Streaming {
                    request: Request::ModelPoll { id: id.clone() },
                })
                .await?;
            for delta in part["deltas"]
                .as_array()
                .ok_or(Error::Validation("模型流片段无效"))?
            {
                if delta["reset"] == true {
                    preview = Preview::default();
                    raw.clear();
                }
                let text = delta["text"]
                    .as_str()
                    .ok_or(Error::Validation("模型流文本无效"))?;
                if raw.len() + text.len() > 256 * 1024 {
                    return Err(Error::Validation("模型流文本超过上限"));
                }
                raw.push_str(text);
                preview.push(text);
            }
            let done = !part["completion"].is_null();
            if done {
                let text = part["completion"]["text"]
                    .as_str()
                    .ok_or(Error::Validation("模型流缺少完整文本"))?;
                if raw != text {
                    preview = Preview::default();
                    preview.push(text);
                }
            }
            publish(
                context,
                progress_id,
                &mut last,
                redactor.stream_text(
                    preview.text(),
                    done && part["completion"]["incomplete"] != true,
                ),
            )
            .await?;
            if done {
                if part["completion"]["incomplete"] == true {
                    return Err(Error::Validation(
                        "模型流被截断，已保留部分回答；未开放执行",
                    ));
                }
                return Ok(part["completion"].clone());
            }
        }
    }
    .await;
    let closed = context
        .request(platform::Request::Streaming {
            request: Request::ModelClose { id },
        })
        .await;
    match (result, closed) {
        (Ok(value), Ok(_)) => Ok(value),
        (Err(error), Ok(_)) => Err(error),
        (Ok(_), Err(error)) => Err(error.into()),
        (Err(error), Err(close)) => Err(Error::Worker(Box::new(std::io::Error::other(format!(
            "{}；关闭模型流失败：{}",
            error.message(),
            close.message
        ))))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preview_decodes_split_escapes_surrogates_and_never_publishes_tool_arguments() {
        let raw = r#"{"kind":"answer","ignored":{"text":"private"},"text":"CPU\n你好\uD83D\uDE00 \\\"ok\\\""}"#;
        let mut p = Preview::default();
        for c in raw.chars() {
            p.push(&c.to_string());
        }
        let value: Value = serde_json::from_str(raw).unwrap();
        assert_eq!(p.text(), value["text"].as_str().unwrap());
        for raw in [
            r#"{"kind":"query","requests":[{"text":"do not show"}]}"#,
            r#"{"kind":"plan","actions":[{"text":"do not show"}]}"#,
        ] {
            let mut p = Preview::default();
            p.push(raw);
            assert_eq!(p.text(), "");
        }
        let mut p = Preview::default();
        p.push(r#"{"text":"边生成边显示","kind":"answer"}"#);
        assert_eq!(p.text(), "边生成边显示");
    }
    #[test]
    fn invalid_unicode_never_turns_into_a_displayable_or_executable_reply() {
        let mut p = Preview::default();
        p.push(r#"{"kind":"answer","text":"\uD800bad"}"#);
        assert_eq!(p.text(), "");
    }
}
