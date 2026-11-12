use std::collections::HashMap;

pub fn metadata(text: &str) -> Result<(String, String, &str), String> {
    let text = text.strip_prefix("\u{feff}").unwrap_or(text);
    let rest = text
        .strip_prefix("---\n")
        .or_else(|| text.strip_prefix("---\r\n"))
        .ok_or("Skill 缺少 YAML frontmatter")?;
    let mut fields = HashMap::<String, String>::new();
    let mut offset = text.len() - rest.len();
    let mut multiline: Option<String> = None;
    for line in rest.split_inclusive('\n') {
        offset += line.len();
        let value = line.trim_end_matches(['\r', '\n']);
        if value == "---" {
            let name = fields.remove("name").ok_or("Skill 缺少 name")?;
            let description = fields
                .remove("description")
                .ok_or("Skill 缺少 description")?;
            if name.is_empty()
                || name.len() > 64
                || name.starts_with('-')
                || name.ends_with('-')
                || name.contains("--")
                || !name
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
                || description.trim().is_empty()
                || description.len() > 4096
            {
                return Err("Skill 名称或说明无效".into());
            }
            return Ok((
                name,
                description,
                text.get(offset..).ok_or("Skill 正文无效")?,
            ));
        }
        if value.starts_with([' ', '\t']) {
            if let Some(key) = &multiline {
                let field = fields.get_mut(key).ok_or("Skill 多行元数据无效")?;
                if !field.is_empty() {
                    field.push(' ');
                }
                field.push_str(value.trim());
            }
            continue;
        }
        multiline = None;
        if value.trim().is_empty() || value.starts_with('#') {
            continue;
        }
        let Some((key, value)) = value.split_once(':') else {
            return Err("Skill 元数据格式无效".into());
        };
        if !["name", "description"].contains(&key) {
            continue;
        }
        if fields.contains_key(key) {
            return Err("Skill 元数据重复".into());
        }
        let value = value.trim();
        if [">", "|", ">-", "|-"].contains(&value) {
            fields.insert(key.into(), String::new());
            multiline = Some(key.into());
        } else {
            fields.insert(key.into(), value.trim_matches(['\"', '\'']).into());
        }
    }
    Err("Skill frontmatter 未结束".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_crlf_multiline_metadata_without_granting_allowed_tools() {
        let (name,description,body)=metadata("---\r\nname: my-skill\r\ndescription: >\r\n  first line\r\n  second line\r\nallowed-tools: exec\r\n---\r\nInstructions").unwrap();
        assert_eq!(name, "my-skill");
        assert_eq!(description, "first line second line");
        assert_eq!(body, "Instructions");
        for text in [
            "no header",
            "---\nname: ../bad\ndescription: text\n---\nbody",
            "---\nname: valid\nname: twice\ndescription: text\n---\nbody",
            "---\nname: valid\n---\nbody",
        ] {
            assert!(metadata(text).is_err());
        }
    }
}
