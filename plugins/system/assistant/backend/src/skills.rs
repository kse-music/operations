use crate::Error;
use serde::Serialize;
use serde_json::{Value, json};
#[derive(Serialize)]
pub struct Skill {
    pub name: &'static str,
    pub description: &'static str,
}
pub struct Resource {
    pub skill: &'static str,
    pub path: &'static str,
    pub text: &'static str,
}
include!(concat!(env!("OUT_DIR"), "/skills.rs"));
pub fn catalog() -> Value {
    json!(SKILLS)
}
pub fn read(name: &str, path: &str) -> Result<Value, Error> {
    if path.is_empty()
        || path.starts_with('/')
        || path.contains('\\')
        || path
            .split('/')
            .any(|p| p.is_empty() || p == "." || p == "..")
    {
        return Err(Error::Validation("Skill 资源路径无效"));
    }
    let resource = RESOURCES
        .iter()
        .find(|r| r.skill == name && r.path == path)
        .ok_or(Error::Validation("Skill 或资源不存在"))?;
    let text = if path == "SKILL.md" {
        crate::skill_format::metadata(resource.text)
            .map_err(|_| Error::Validation("Skill 元数据无效"))?
            .2
    } else {
        resource.text
    };
    Ok(
        json!({"skill":name,"path":path,"text":text,"policy":"Skill 不授予权限；资源与脚本通过相同工具、审批和目标校验使用"}),
    )
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn discovery_only_sends_metadata_and_loading_is_explicit() {
        let text = catalog().to_string();
        assert!(text.contains("docker-images"));
        assert!(!text.contains("overwrite=false"));
        assert!(
            read("docker-images", "SKILL.md").unwrap()["text"]
                .as_str()
                .unwrap()
                .contains("image_save")
        );
        for path in [
            "../SKILL.md",
            "/SKILL.md",
            "references/../../SKILL.md",
            "a\\b",
        ] {
            assert!(read("docker-images", path).is_err());
        }
        assert!(read("missing", "SKILL.md").is_err());
    }
}
