use crate::{
    Error,
    redact::Redactor,
    types::{AgentStep, StepPreview},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use serverdeck_plugin_sdk::{
    FileDocument,
    backend::Context,
    platform::{self, RemotePath, TransferPreview, TransferSource, TransferState},
};
use std::collections::HashMap;
use zeroize::Zeroizing;

#[derive(Clone, Deserialize, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Query {
    FileRead {
        host_id: String,
        path: String,
        start_line: u32,
        lines: u32,
    },
    TransferPrepare {
        source: TransferSource,
        destination: RemotePath,
        overwrite: bool,
    },
}
fn path(value: &str, remote: bool) -> Result<(), Error> {
    if value.is_empty()
        || value.len() > 4096
        || value.chars().any(char::is_control)
        || (remote
            && (!value.starts_with('/')
                || value.contains("//")
                || value.split('/').any(|v| v == "." || v == "..")))
    {
        return Err(Error::Validation(
            "文件路径须为规范绝对路径，不能包含控制字符",
        ));
    }
    Ok(())
}
fn host(value: &str) -> Result<(), Error> {
    if value.is_empty() || value.len() > 128 || value.chars().any(char::is_control) {
        return Err(Error::Validation("文件工具需要明确主机 ID"));
    }
    Ok(())
}
impl Query {
    pub fn validate(&self) -> Result<(), Error> {
        match self {
            Self::FileRead {
                host_id,
                path: p,
                start_line,
                lines,
            } => {
                host(host_id)?;
                path(p, true)?;
                if *start_line == 0 || !(1..=200).contains(lines) {
                    return Err(Error::Validation("文件读取需要从第 1 行起，每次 1–200 行"));
                }
            }
            Self::TransferPrepare {
                source,
                destination,
                ..
            } => {
                host(&destination.host_id)?;
                path(&destination.path, true)?;
                match source {
                    TransferSource::Local { path: p } => path(p, false)?,
                    TransferSource::Remote { host_id, path: p } => {
                        host(host_id)?;
                        path(p, true)?;
                    }
                }
            }
        }
        Ok(())
    }
    fn hosts(&self) -> Vec<&str> {
        match self {
            Self::FileRead { host_id, .. } => vec![host_id],
            Self::TransferPrepare {
                source,
                destination,
                ..
            } => {
                let mut hosts = vec![destination.host_id.as_str()];
                if let TransferSource::Remote { host_id, .. } = source {
                    hosts.push(host_id);
                }
                hosts
            }
        }
    }
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Edit {
    pub start_line: u32,
    pub delete_lines: u32,
    pub insert_lines: Vec<String>,
}
pub fn validate_edits(edits: &[Edit]) -> Result<(), Error> {
    if edits.is_empty()
        || edits.len() > 32
        || edits.iter().any(|edit| {
            edit.start_line == 0
                || edit.insert_lines.len() > 200
                || edit
                    .insert_lines
                    .iter()
                    .any(|line| line.contains(['\r', '\n', '\0']))
        })
        || edits
            .iter()
            .flat_map(|edit| &edit.insert_lines)
            .map(String::len)
            .sum::<usize>()
            > 32768
    {
        return Err(Error::Validation(
            "修改最多 32 处，每处为原文行号和完整插入行，总文本不超过 32 KiB",
        ));
    }
    Ok(())
}

pub fn apply(original: &str, edits: &[Edit]) -> Result<(Zeroizing<String>, String), Error> {
    validate_edits(edits)?;
    let mut offsets = if original.is_empty() { vec![] } else { vec![0] };
    for (i, byte) in original.bytes().enumerate() {
        if byte == b'\n' && i + 1 < original.len() {
            offsets.push(i + 1);
        }
    }
    let lines = offsets.len();
    offsets.push(original.len());
    let mut edits = edits.iter().collect::<Vec<_>>();
    edits.sort_by_key(|edit| edit.start_line);
    let eol = if original
        .find('\n')
        .is_some_and(|i| i > 0 && original.as_bytes()[i - 1] == b'\r')
    {
        "\r\n"
    } else {
        "\n"
    };
    let mut output = Zeroizing::new(String::new());
    let mut diff = String::new();
    let mut cursor = 0;
    let mut previous = None;
    for edit in edits {
        let start = (edit.start_line - 1) as usize;
        let end = start
            .checked_add(edit.delete_lines as usize)
            .ok_or(Error::Validation("行范围溢出"))?;
        if start > lines || end > lines || offsets[start] < cursor || previous == Some(start) {
            return Err(Error::Validation("修改超出原文范围、重叠或重复位置"));
        }
        output.push_str(&original[cursor..offsets[start]]);
        if !edit.insert_lines.is_empty() {
            if start == lines && !output.is_empty() && !output.ends_with('\n') {
                output.push_str(eol);
            }
            output.push_str(&edit.insert_lines.join(eol));
            if offsets[end] < original.len()
                || original.ends_with('\n')
                || edit.insert_lines.last().is_some_and(String::is_empty)
            {
                output.push_str(eol);
            }
        }
        diff.push_str(&format!(
            "@@ 原文第 {} 行，删除 {} 行，插入 {} 行 @@\n",
            edit.start_line,
            edit.delete_lines,
            edit.insert_lines.len()
        ));
        for line in original[offsets[start]..offsets[end]].lines() {
            diff.push('-');
            diff.push_str(line);
            diff.push('\n');
        }
        for line in &edit.insert_lines {
            diff.push('+');
            diff.push_str(line);
            diff.push('\n');
        }
        cursor = offsets[end];
        previous = Some(start);
    }
    output.push_str(&original[cursor..]);
    if output.len() > 32768 || *output == original {
        return Err(Error::Validation("候选文件超过 32 KiB 或没有实际修改"));
    }
    Ok((output, diff))
}

struct Document {
    id: String,
    host: String,
    path: String,
    content: Zeroizing<String>,
    sha256: String,
    atomic: bool,
}
pub struct FilePlan {
    pub document_id: String,
    pub content: Zeroizing<String>,
    pub public: AgentStep,
    pub host: String,
}
#[derive(Default)]
pub struct Resources {
    documents: HashMap<String, Document>,
    pub transfers: HashMap<String, TransferPreview>,
}
fn decode<T: serde::de::DeserializeOwned>(value: Value) -> Result<T, Error> {
    serde_json::from_value(value).map_err(|_| Error::Validation("文件平台返回格式无效"))
}
impl Resources {
    pub async fn query(
        &mut self,
        context: &Context,
        query: Query,
        hosts: &[String],
        redactor: &Redactor,
    ) -> Result<(Value, usize), Error> {
        if query
            .hosts()
            .iter()
            .any(|id| !hosts.iter().any(|host| host == id))
        {
            return Err(Error::Validation("文件工具目标不在本次已匹配主机中"));
        }
        match query {
            Query::FileRead {
                host_id,
                path,
                start_line,
                lines,
            } => {
                let existing = self
                    .documents
                    .values()
                    .find(|doc| doc.host == host_id && doc.path == path)
                    .map(|doc| doc.id.clone());
                let id = if let Some(id) = existing {
                    id
                } else {
                    let doc: FileDocument = decode(
                        context
                            .request(platform::Request::ReadFile {
                                host_id: host_id.clone(),
                                path,
                            })
                            .await?,
                    )?;
                    let id = doc.id.clone();
                    self.documents.insert(
                        id.clone(),
                        Document {
                            id: doc.id,
                            host: host_id,
                            path: doc.path,
                            content: Zeroizing::new(doc.content),
                            sha256: doc.sha256,
                            atomic: doc.atomic_save,
                        },
                    );
                    id
                };
                let doc = self.documents.get(&id).ok_or(Error::NotFound)?;
                let safe = redactor.lines(&doc.content);
                let total = doc.content.lines().count();
                if start_line as usize > total.saturating_add(1) {
                    return Err(Error::Validation("读取行号超出文件范围"));
                }
                let records = safe
                    .lines()
                    .enumerate()
                    .skip((start_line - 1) as usize)
                    .take(lines as usize)
                    .map(|(i, text)| json!({"line":i+1,"text":text}))
                    .collect::<Vec<_>>();
                let count = records.len();
                Ok((
                    json!({"documentId":id,"path":doc.path,"baseSha256":doc.sha256,"atomicSave":doc.atomic,"records":records,"totalRecords":total,"omittedRecords":total.saturating_sub(count)}),
                    count,
                ))
            }
            Query::TransferPrepare {
                source,
                destination,
                overwrite,
            } => {
                let preview: TransferPreview = decode(
                    context
                        .request(platform::Request::TransferPrepare {
                            source,
                            destination,
                            overwrite,
                        })
                        .await?,
                )?;
                let mut value = json!(preview);
                redactor.value(&mut value);
                self.transfers.insert(preview.id.clone(), preview);
                Ok((value, 1))
            }
        }
    }
    pub fn edit_plan(&self, id: &str, edits: &[Edit]) -> Result<FilePlan, Error> {
        let doc = self
            .documents
            .get(id)
            .ok_or(Error::Validation("请先成功读取本任务中的目标文件"))?;
        if !doc.atomic {
            return Err(Error::Validation("目标服务器不支持原子保存"));
        }
        let (content, diff) = apply(&doc.content, edits)?;
        Ok(FilePlan {
            document_id: id.into(),
            content,
            host: doc.host.clone(),
            public: AgentStep {
                action: "确认保存文件修改".into(),
                target: format!("{}:{}", doc.host, doc.path),
                preview: Some(StepPreview::Edit {
                    path: doc.path.clone(),
                    base_sha256: doc.sha256.clone(),
                    diff,
                }),
            },
        })
    }
    pub fn transfer(&self, id: &str) -> Result<TransferPreview, Error> {
        self.transfers
            .get(id)
            .cloned()
            .ok_or(Error::Validation("请先准备本任务中的文件传输预览"))
    }
    pub async fn close_documents(&mut self, context: &Context) -> Result<(), Error> {
        let mut errors = Vec::new();
        for id in self.documents.keys().cloned().collect::<Vec<_>>() {
            match context
                .request(platform::Request::CloseFile {
                    document_id: id.clone(),
                    discard: true,
                })
                .await
            {
                Ok(_) => {
                    self.documents.remove(&id);
                }
                Err(error) if error.code == "NOT_FOUND" => {
                    self.documents.remove(&id);
                }
                Err(error) => errors.push(error.message),
            }
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(Error::Platform(serverdeck_plugin_sdk::ApiError::new(
                "DOCUMENT_CLEANUP",
                errors.join("；"),
            )))
        }
    }
    pub async fn close(&mut self, context: &Context) -> Result<(), Error> {
        let mut errors = Vec::new();
        if let Err(error) = self.close_documents(context).await {
            errors.push(serverdeck_plugin_sdk::ApiError::new(
                "DOCUMENT_CLEANUP",
                error.message(),
            ));
        }
        for id in self.transfers.keys().cloned().collect::<Vec<_>>() {
            match context
                .request(platform::Request::TransferClose { id: id.clone() })
                .await
            {
                Ok(_) => {
                    self.transfers.remove(&id);
                }
                Err(e) if e.code == "NOT_FOUND" => {
                    self.transfers.remove(&id);
                }
                Err(e) => {
                    errors.push(e);
                }
            }
        }
        if let Some((first, rest)) = errors.split_first() {
            let mut error = first.clone();
            for next in rest {
                error.message.push_str(&format!("；{}", next.message));
            }
            Err(error.into())
        } else {
            Ok(())
        }
    }
}
pub fn transfer_step(preview: &TransferPreview) -> AgentStep {
    AgentStep {
        action: "确认传输文件".into(),
        target: format!(
            "{}:{}",
            preview.destination.host_id, preview.destination.path
        ),
        preview: Some(StepPreview::Transfer {
            preview: preview.clone(),
        }),
    }
}
pub async fn save(context: &Context, plan: &FilePlan) -> Result<(), Error> {
    let value = context
        .request(platform::Request::SaveFile {
            document_id: plan.document_id.clone(),
            content: plan.content.to_string(),
        })
        .await?;
    let saved: serverdeck_plugin_sdk::SaveResult = decode(value)?;
    if !saved.saved {
        return Err(Error::Platform(serverdeck_plugin_sdk::ApiError::new(
            "FILE_SAVE_UNVERIFIED",
            format!(
                "{}；恢复路径：{}",
                saved
                    .message
                    .unwrap_or_else(|| "保存未确认成功，请核对远程文件".into()),
                saved.recovery_path.unwrap_or_else(|| "无".into())
            ),
        )));
    }
    Ok(())
}
pub async fn transfer_state(context: &Context, id: &str) -> Result<TransferState, Error> {
    decode(
        context
            .request(platform::Request::TransferStatus { id: id.into() })
            .await?,
    )
}
pub async fn begin_transfer(context: &Context, id: &str) -> Result<TransferState, Error> {
    let result = match context
        .request(platform::Request::TransferStart { id: id.into() })
        .await
    {
        Ok(value) => decode(value),
        Err(error) => Err(error.into()),
    };
    match result {
        Ok(state) => Ok(state),
        Err(error) => match transfer_state(&context.with_bindings(vec![]), id).await {
            Ok(state) if !["prepared", "expired"].contains(&state.state.as_str()) => Ok(state),
            Ok(_) => Err(error),
            Err(check) => Err(Error::Platform(serverdeck_plugin_sdk::ApiError::new(
                "TRANSFER_UNVERIFIED",
                format!(
                    "启动结果未确认：{}；状态读取失败：{}",
                    error.message(),
                    check.message()
                ),
            ))),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn edits_use_one_original_version_and_preserve_newlines_and_untouched_secrets() {
        for eol in ["\n", "\r\n"] {
            let original = (1..=24)
                .map(|n| format!("line{n}{eol}"))
                .collect::<String>();
            let edits = vec![
                Edit {
                    start_line: 6,
                    delete_lines: 1,
                    insert_lines: vec![],
                },
                Edit {
                    start_line: 21,
                    delete_lines: 0,
                    insert_lines: vec!["x: yy".into()],
                },
            ];
            let (result, diff) = apply(&original, &edits).unwrap();
            assert!(!result.contains("line6"));
            assert!(result.contains(&format!("line20{eol}x: yy{eol}line21")));
            assert!(result.ends_with(eol));
            assert!(diff.contains("-line6"));
        }
        let (result, _) = apply(
            "密码: unchanged\nlast",
            &[Edit {
                start_line: 3,
                delete_lines: 0,
                insert_lines: vec!["x: yy".into()],
            }],
        )
        .unwrap();
        assert_eq!(*result, "密码: unchanged\nlast\nx: yy");
        assert!(
            apply(
                "one\ntwo",
                &[
                    Edit {
                        start_line: 2,
                        delete_lines: 1,
                        insert_lines: vec![]
                    },
                    Edit {
                        start_line: 2,
                        delete_lines: 0,
                        insert_lines: vec!["x".into()]
                    }
                ]
            )
            .is_err()
        );
        assert!(
            apply(
                "one",
                &[Edit {
                    start_line: 3,
                    delete_lines: 1,
                    insert_lines: vec![]
                }]
            )
            .is_err()
        );
    }
}
