use crate::{
    Error,
    types::{HostAsset, HostChoice},
};
use std::collections::HashSet;

fn mentions(question: &str, value: &str) -> bool {
    if value.is_empty() {
        return false;
    }
    let value = value.to_lowercase();
    let word = |c: char| c.is_ascii_alphanumeric() || ".:_-@".contains(c);
    question.match_indices(&value).any(|(i, _)| {
        (!value.starts_with(|c: char| c.is_ascii_alphanumeric())
            || question[..i].chars().next_back().is_none_or(|c| !word(c)))
            && (!value.ends_with(|c: char| c.is_ascii_alphanumeric())
                || question[i + value.len()..]
                    .chars()
                    .next()
                    .is_none_or(|c| !word(c)))
    })
}
pub fn inventory_question(question: &str) -> bool {
    let q = question.to_lowercase();
    ["有哪些", "多少", "列表", "清单", "列出"]
        .iter()
        .any(|s| q.contains(s))
        && ["服务器", "主机", "资产"].iter().any(|s| q.contains(s))
        && ![
            "负载", "故障", "异常", "cpu", "内存", "磁盘", "进程", "docker", "容器", "状态",
            "日志", "端口", "运行", "网络", "连接", "检查", "排查", "监控",
        ]
        .iter()
        .any(|s| q.contains(s))
}
pub fn local_choice(
    question: &str,
    assets: &[HostAsset],
    previous: &[String],
) -> Option<HostChoice> {
    let q = question.to_lowercase();
    if inventory_question(question) {
        return Some(HostChoice {
            host_ids: vec![],
            message: String::new(),
        });
    }
    let all = [
        "所有",
        "全部",
        "每台",
        "各台",
        "哪台",
        "哪些主机",
        "哪些服务器",
        "all servers",
        "all hosts",
    ]
    .iter()
    .any(|s| q.contains(s));
    let mut ids = Vec::new();
    let mut matched_aliases = HashSet::new();
    for a in assets {
        let aliases = [
            &a.name,
            &a.hostname,
            &format!("{}:{}", a.hostname, a.port),
            &format!("{}@{}", a.username, a.hostname),
            &format!("{}@{}:{}", a.username, a.hostname, a.port),
        ];
        for alias in aliases {
            if mentions(&q, alias) {
                ids.push(a.id.clone());
                matched_aliases.insert(alias.to_lowercase());
                break;
            }
        }
    }
    ids.sort();
    ids.dedup();
    if !ids.is_empty() {
        if ids.len() > 1 && matched_aliases.len() == 1 && !all {
            return Some(HostChoice {
                host_ids: vec![],
                message: "命中多个同名或同地址主机，请在问题中补充地址、端口或用户名。".into(),
            });
        }
        return Some(HostChoice {
            host_ids: ids,
            message: String::new(),
        });
    }
    if all
        && [
            "服务器",
            "主机",
            "机器",
            "节点",
            "哪台",
            "各台",
            "每台",
            "all servers",
            "all hosts",
        ]
        .iter()
        .any(|s| q.contains(s))
    {
        return Some(HostChoice {
            host_ids: assets.iter().map(|a| a.id.clone()).collect(),
            message: String::new(),
        });
    }
    if [
        "这台",
        "当前主机",
        "当前服务器",
        "那台",
        "刚才",
        "上述主机",
        "这些主机",
        "继续",
        "再看看",
    ]
    .iter()
    .any(|s| q.contains(s))
        && !previous.is_empty()
    {
        return Some(HostChoice {
            host_ids: previous
                .iter()
                .filter(|id| assets.iter().any(|a| &a.id == *id))
                .cloned()
                .collect(),
            message: String::new(),
        });
    }
    if assets.is_empty() {
        return Some(HostChoice {
            host_ids: vec![],
            message: String::new(),
        });
    }
    None
}
pub fn validate_choice(choice: &HostChoice, assets: &[HostAsset]) -> Result<(), Error> {
    let unique: HashSet<_> = choice.host_ids.iter().collect();
    if choice.host_ids.len() > 8
        || unique.len() != choice.host_ids.len()
        || choice.message.len() > 2048
        || choice
            .host_ids
            .iter()
            .any(|id| !assets.iter().any(|a| &a.id == id))
    {
        return Err(Error::Validation(
            "主机匹配结果无效或超过八台，请在问题中缩小主机范围",
        ));
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn asset(id: &str, name: &str, hostname: &str, port: u16) -> HostAsset {
        HostAsset {
            id: id.into(),
            name: name.into(),
            hostname: hostname.into(),
            port,
            username: "ops".into(),
            group: None,
        }
    }
    #[test]
    fn local_matching_respects_boundaries_endpoints_ambiguity_and_followups() {
        let assets = vec![
            asset("a", "web", "10.0.0.1", 22),
            asset("b", "数据库", "10.0.0.10", 2222),
        ];
        assert_eq!(
            local_choice("看看10.0.0.10的负载", &assets, &[])
                .unwrap()
                .host_ids,
            vec!["b"]
        );
        assert!(local_choice("websocket如何配置", &assets, &[]).is_none());
        assert!(local_choice("列出所有Docker命令", &assets, &[]).is_none());
        assert_eq!(
            local_choice("列出web服务器的Docker容器状态", &assets, &[])
                .unwrap()
                .host_ids,
            vec!["a"]
        );
        assert_eq!(
            local_choice("检查web和数据库", &assets, &[])
                .unwrap()
                .host_ids,
            vec!["a", "b"]
        );
        assert_eq!(
            local_choice("全部服务器负载", &assets, &[])
                .unwrap()
                .host_ids
                .len(),
            2
        );
        assert!(
            local_choice("有哪些服务器", &assets, &[])
                .unwrap()
                .host_ids
                .is_empty()
        );
        assert_eq!(
            local_choice("继续排查那台", &assets, &["b".into()])
                .unwrap()
                .host_ids,
            vec!["b"]
        );
        assert_eq!(
            local_choice("检查当前主机的负载", &assets, &["b".into()])
                .unwrap()
                .host_ids,
            vec!["b"]
        );
        let shared = vec![
            asset("a", "same", "10.0.0.1", 22),
            asset("b", "same", "10.0.0.1", 2222),
        ];
        assert!(
            !local_choice("same怎么了", &shared, &[])
                .unwrap()
                .message
                .is_empty()
        );
        assert_eq!(
            local_choice("10.0.0.1:2222怎么了", &shared, &[])
                .unwrap()
                .host_ids,
            vec!["b"]
        );
    }
    #[test]
    fn model_choices_are_limited_to_unique_registered_assets() {
        let assets = vec![asset("a", "web", "10.0.0.1", 22)];
        for ids in [
            vec!["invented".into()],
            vec!["a".into(), "a".into()],
            vec!["a".into(); 9],
        ] {
            assert!(
                validate_choice(
                    &HostChoice {
                        host_ids: ids,
                        message: String::new()
                    },
                    &assets
                )
                .is_err()
            );
        }
        assert!(
            serde_json::from_value::<HostChoice>(
                json!({"hostIds":["a"],"message":"","command":"reboot"})
            )
            .is_err()
        );
    }
}
