use crate::Error;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum LayoutNode {
    Leaf {
        pane: String,
    },
    Split {
        id: String,
        axis: SplitAxis,
        ratio: u8,
        first: Box<LayoutNode>,
        second: Box<LayoutNode>,
    },
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SplitAxis {
    Rows,
    Columns,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SavedPane {
    pub key: String,
    pub host_id: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SavedTab {
    pub key: String,
    pub title: String,
    pub panes: Vec<SavedPane>,
    pub layout: LayoutNode,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceLayout {
    pub version: u8,
    pub active: String,
    pub tabs: Vec<SavedTab>,
}
impl WorkspaceLayout {
    pub fn validate(&self) -> Result<(), Error> {
        if self.version != 1 || self.tabs.len() > 32 {
            return Err(Error::Validation("工作区布局版本或标签数量无效"));
        }
        let mut keys = HashSet::new();
        let mut count = 0;
        for tab in &self.tabs {
            if tab.title.trim().is_empty()
                || tab.title.chars().count() > 128
                || tab.title.chars().any(char::is_control)
            {
                return Err(Error::Validation("标签名称无效"));
            }
            identifier(&tab.key)?;
            if !keys.insert(&tab.key) {
                return Err(Error::Validation("工作区标识重复"));
            }
            if tab.panes.is_empty() || tab.panes.len() > 8 {
                return Err(Error::Validation("每个标签须为 1–8 个窗格"));
            }
            let mut leaves = HashSet::new();
            walk(&tab.layout, 0, &mut leaves)?;
            let mut panes = HashSet::new();
            for pane in &tab.panes {
                identifier(&pane.key)?;
                if let Some(id) = &pane.host_id {
                    identifier(id)?;
                }
                if !keys.insert(&pane.key) || !panes.insert(pane.key.as_str()) {
                    return Err(Error::Validation("窗格标识重复"));
                }
            }
            if leaves != panes {
                return Err(Error::Validation("分屏布局与窗格不一致"));
            }
            count += tab.panes.len();
        }
        if count > 32
            || (!self.active.is_empty() && !self.tabs.iter().any(|t| t.key == self.active))
        {
            return Err(Error::Validation("工作区活动标签或窗格总数无效"));
        }
        Ok(())
    }
}
fn identifier(id: &str) -> Result<(), Error> {
    uuid::Uuid::parse_str(id)
        .map(|_| ())
        .map_err(|_| Error::Validation("工作区标识无效"))
}
fn walk<'a>(
    node: &'a LayoutNode,
    depth: usize,
    leaves: &mut HashSet<&'a str>,
) -> Result<(), Error> {
    if depth > 7 {
        return Err(Error::Validation("分屏层级过深"));
    }
    match node {
        LayoutNode::Leaf { pane } => {
            if !leaves.insert(pane) {
                return Err(Error::Validation("窗格重复引用"));
            }
        }
        LayoutNode::Split {
            id,
            ratio,
            first,
            second,
            ..
        } => {
            identifier(id)?;
            if !(10..=90).contains(ratio) {
                return Err(Error::Validation("分屏比例须为 10–90"));
            }
            walk(first, depth + 1, leaves)?;
            walk(second, depth + 1, leaves)?;
        }
    }
    Ok(())
}
