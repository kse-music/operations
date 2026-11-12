use crate::{
    Error, image_archive,
    ops::{self, Request, Response},
    redact::Redactor,
    tools::{Action, ToolId},
    types::AgentStep,
};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use serverdeck_plugin_sdk::{
    backend::Context,
    platform::{self, Command},
};
use std::collections::HashMap;

#[derive(Clone)]
pub struct Artifact {
    pub host: String,
    pub path: String,
    pub sha256: Option<String>,
}
#[derive(Clone)]
enum Kind {
    Command,
    Save { path: String },
    Load,
}
#[derive(Clone)]
pub struct Plan {
    pub host: String,
    pub id: String,
    pub command: Command,
    pub public: AgentStep,
    pub tool: ToolId,
    kind: Kind,
}
struct Job {
    plan: Plan,
    stream: Option<String>,
    partial: String,
    output: Vec<u8>,
    truncated: bool,
    done: bool,
}
impl Job {
    fn safe_output(&self, redactor: &Redactor) -> String {
        let raw = std::str::from_utf8(&self.output).unwrap_or("输出不是 UTF-8");
        let prepared = format!("SD_ARCHIVE_PREPARED:{}", self.plan.id);
        let ready = format!("SD_ARCHIVE_READY:{}", self.plan.id);
        let exit = format!("SD_JOB_EXIT:{}:", self.plan.id);
        let text = raw
            .split_inclusive('\n')
            .filter(|line| {
                let text = line.trim_end_matches(['\r', '\n']);
                text != prepared && text != ready && !text.starts_with(&exit)
            })
            .collect::<String>();
        redactor.stream_text(&text, !self.truncated)
    }
}
#[derive(Default)]
pub struct Resources {
    jobs: HashMap<String, Job>,
    pub artifacts: HashMap<String, Artifact>,
}
pub fn reference(value: &str) -> Result<(), Error> {
    if value.is_empty()
        || value.len() > 1024
        || value.starts_with('-')
        || value.chars().any(|c| c.is_control() || c.is_whitespace())
    {
        return Err(Error::Validation("镜像引用无效"));
    }
    Ok(())
}
fn image_snapshot(evidence: &[(Request, Response)]) -> Result<&[Value], Error> {
    evidence
        .iter()
        .rev()
        .find(|(q, _)| matches!(q, Request::Images))
        .filter(|(_, r)| r.success)
        .map(|(_, r)| r.records.as_slice())
        .ok_or(Error::Validation("请先成功查询对应主机的完整镜像清单"))
}
fn tag_id(rows: &[Value], name: &str) -> Option<String> {
    rows.iter()
        .find(|row| {
            format!(
                "{}:{}",
                row["Repository"].as_str().unwrap_or(""),
                row["Tag"].as_str().unwrap_or("")
            ) == name
                || row["ID"].as_str() == Some(name)
        })
        .and_then(|row| row["ID"].as_str())
        .map(|id| format!("sha256:{}", id.strip_prefix("sha256:").unwrap_or(id)))
}
impl Resources {
    pub async fn prepare(
        &self,
        context: &Context,
        action: &Action,
        hosts: &[String],
        evidence: &HashMap<String, Vec<(Request, Response)>>,
    ) -> Result<Plan, Error> {
        let (host, tool) = match action {
            Action::Command { host_id, .. } => (host_id, ToolId::Command),
            Action::ImageSave { host_id, .. } => (host_id, ToolId::ImageSave),
            Action::ImageLoad { host_id, .. } => (host_id, ToolId::ImageLoad),
            _ => return Err(Error::Validation("不是独立工具操作")),
        };
        if !hosts.contains(host) {
            return Err(Error::Validation("工具目标不在本轮已匹配主机中"));
        }
        let info = context.info().await?;
        let nonce = info["nonce"]
            .as_str()
            .ok_or(Error::Validation("平台任务标识无效"))?
            .to_owned();
        if nonce.len() != 36 || !nonce.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-') {
            return Err(Error::Validation("平台任务标识无效"));
        }
        let (command, kind, target) = match action {
            Action::Command { program, args, .. } => {
                let mut command = Command::new(program);
                command.args = args.clone();
                command.validate()?;
                let shell = command.shell()?;
                let script = format!(
                    r#"sd_child=
cleanup() {{ if test -n "$sd_child"; then kill -TERM "$sd_child" 2>/dev/null; wait "$sd_child" 2>/dev/null; fi; }}
trap 'cleanup; exit 1' HUP INT TERM
{shell} & sd_child=$!
wait "$sd_child"; sd_result=$?; sd_child=
printf '\nSD_JOB_EXIT:{nonce}:%s\n' "$sd_result"
exit "$sd_result"
"#
                );
                (
                    Command::script(script),
                    Kind::Command,
                    format!("{host}: {}", command.shell()?),
                )
            }
            Action::ImageSave {
                id, reference: tag, ..
            } => {
                ops::image_id(id)?;
                reference(tag)?;
                let rows = image_snapshot(evidence.get(host).map(Vec::as_slice).unwrap_or(&[]))?;
                let normalized = format!("sha256:{}", id.strip_prefix("sha256:").unwrap_or(id));
                if tag_id(rows, tag).as_deref() != Some(normalized.as_str()) {
                    return Err(Error::Validation("镜像标签和完整 ID 不在本次查询证据中"));
                }
                let (command, _, path) = image_archive::command(
                    &image_archive::Archive::Export {
                        id: id.clone(),
                        reference: tag.clone(),
                        file_name: format!("image-{nonce}.tar"),
                        confirmed: true,
                    },
                    &nonce,
                )?;
                (
                    command,
                    Kind::Save { path },
                    format!("{host}: {tag} · {normalized}"),
                )
            }
            Action::ImageLoad {
                artifact_id,
                id,
                reference: tag,
                ..
            } => {
                ops::image_id(id)?;
                reference(tag)?;
                let artifact = self
                    .artifacts
                    .get(artifact_id)
                    .filter(|artifact| &artifact.host == host && artifact.sha256.is_some())
                    .ok_or(Error::Validation(
                        "导入需要本任务已完成校验传输的目标归档 artifactId",
                    ))?;
                let hash = artifact
                    .sha256
                    .as_deref()
                    .ok_or(Error::Validation("归档未校验"))?;
                let rows = image_snapshot(evidence.get(host).map(Vec::as_slice).unwrap_or(&[]))?;
                let before = tag_id(rows, tag).unwrap_or_default();
                let (archive_command, _, _) = image_archive::command(
                    &image_archive::Archive::Import {
                        file_name: "unused.tar".into(),
                        confirmed: true,
                    },
                    &nonce,
                )?;
                let script = archive_command
                    .args
                    .get(1)
                    .ok_or(Error::Validation("归档脚本不兼容"))?;
                let start = script
                    .find("while ! test -e")
                    .ok_or(Error::Validation("归档脚本不兼容"))?;
                let end = script[start..]
                    .find("printf ")
                    .map(|end| start + end)
                    .ok_or(Error::Validation("归档脚本不兼容"))?;
                let load = format!(
                    r#"sd_input={path}
test -f "$sd_input" && ! test -L "$sd_input" || exit 65
sd_hash=$(sha256sum -- "$sd_input") || exit
sd_hash=${{sd_hash%% *}}
test "$sd_hash" = {hash} || {{ echo 'Archive changed after transfer' >&2; exit 65; }}
sd_before=$(d image inspect --format '{{{{.Id}}}}' -- {tag} 2>/dev/null) || sd_before=
test "$sd_before" = {before} || {{ echo 'Target image changed; query again' >&2; exit 65; }}
run_child docker --host unix://$sd_socket image load --input "$sd_input" || exit
sd_after=$(d image inspect --format '{{{{.Id}}}}' -- {tag}) || exit
test "$sd_after" = {id} || {{ echo 'Loaded image verification failed' >&2; exit 65; }}
"#,
                    path = platform::quote(&artifact.path)?,
                    hash = platform::quote(hash)?,
                    tag = platform::quote(tag)?,
                    before = platform::quote(&before)?,
                    id = platform::quote(&format!(
                        "sha256:{}",
                        id.strip_prefix("sha256:").unwrap_or(id)
                    ))?
                );
                let command =
                    Command::script(format!("{}{}{}", &script[..start], load, &script[end..]));
                command.validate()?;
                (
                    command,
                    Kind::Load,
                    format!(
                        "{host}: {} → {tag} · 同名标签可能替换；不更新容器",
                        artifact.path
                    ),
                )
            }
            _ => return Err(Error::Validation("不支持的独立工具")),
        };
        command.validate()?;
        Ok(Plan {
            host: host.clone(),
            id: nonce,
            command,
            public: AgentStep {
                action: tool.label().into(),
                target,
                preview: None,
            },
            tool,
            kind,
        })
    }
    pub async fn start(&mut self, context: &Context, plan: Plan) -> Result<String, Error> {
        let id = plan.id.clone();
        if self.jobs.contains_key(&id) || self.jobs.len() >= 32 {
            return Err(Error::Busy);
        }
        self.jobs.insert(
            id.clone(),
            Job {
                plan,
                stream: None,
                partial: String::new(),
                output: vec![],
                truncated: false,
                done: false,
            },
        );
        let job = self.jobs.get_mut(&id).ok_or(Error::NotFound)?;
        let value = context
            .request(platform::Request::StreamOpen {
                host_id: job.plan.host.clone(),
                command: job.plan.command.clone(),
            })
            .await?;
        job.stream = Some(
            value["id"]
                .as_str()
                .ok_or(Error::Validation("命令流句柄无效"))?
                .into(),
        );
        Ok(id)
    }
    pub async fn poll(
        &mut self,
        context: &Context,
        id: &str,
        redactor: &Redactor,
    ) -> Result<Option<Value>, Error> {
        let job = self.jobs.get_mut(id).ok_or(Error::NotFound)?;
        if !job.done {
            let stream = job
                .stream
                .clone()
                .ok_or(Error::Validation("工具启动未确认，不能自动重试"))?;
            let value = context
                .request(platform::Request::StreamPoll { stream_id: stream })
                .await?;
            for event in value["events"]
                .as_array()
                .ok_or(Error::Validation("命令事件无效"))?
            {
                if event["type"] == "data" {
                    let bytes = STANDARD
                        .decode(event["dataBase64"].as_str().unwrap_or(""))
                        .map_err(|_| Error::Validation("命令输出编码无效"))?;
                    if job.output.len() + bytes.len() <= 32768 {
                        job.output.extend_from_slice(&bytes);
                    } else {
                        job.truncated = true;
                    }
                    if event["stream"] == "stdout" {
                        job.partial.push_str(&String::from_utf8_lossy(&bytes));
                        while let Some(end) = job.partial.find('\n') {
                            let line = &job.partial[..end];
                            if matches!(job.plan.kind, Kind::Command) {
                                if let Some(code) = line.strip_prefix(&format!("SD_JOB_EXIT:{id}:"))
                                {
                                    if code != "0" {
                                        return Err(Error::Platform(
                                            serverdeck_plugin_sdk::ApiError::new(
                                                "COMMAND_FAILED",
                                                format!(
                                                    "命令退出码 {code}；{}",
                                                    redactor.stream_text(
                                                        std::str::from_utf8(&job.output)
                                                            .unwrap_or("输出不是 UTF-8"),
                                                        !job.truncated
                                                    )
                                                ),
                                            ),
                                        ));
                                    }
                                    job.done = true;
                                }
                            } else if line == format!("SD_ARCHIVE_READY:{id}") {
                                job.done = true;
                            }
                            job.partial.drain(..=end);
                        }
                        if job.partial.len() > 16384 {
                            return Err(Error::Validation("命令输出行超过限制"));
                        }
                    }
                } else if event["type"] == "state" && event["state"] != "running" && !job.done {
                    return Err(Error::Platform(serverdeck_plugin_sdk::ApiError::new(
                        "TOOL_UNVERIFIED",
                        format!(
                            "工具流提前结束：{}；{}",
                            event["message"].as_str().unwrap_or("没有完整完成标记"),
                            job.safe_output(redactor)
                        ),
                    )));
                }
            }
        }
        if !job.done {
            return Ok(None);
        }
        let mut result = json!({"jobId":id,"hostId":job.plan.host,"tool":job.plan.tool,"status":"verified","output":job.safe_output(redactor),"outputOmitted":job.truncated});
        if let Kind::Save { path } = &job.plan.kind {
            self.artifacts.insert(
                id.into(),
                Artifact {
                    host: job.plan.host.clone(),
                    path: path.clone(),
                    sha256: None,
                },
            );
            result["archiveId"] = json!(id);
            result["path"] = json!(path);
        } else if let Some(stream) = &job.stream {
            context
                .request(platform::Request::StreamStop {
                    stream_id: stream.clone(),
                })
                .await?;
            job.stream = None;
        }
        redactor.value(&mut result);
        Ok(Some(result))
    }
    pub fn step(&self, id: &str) -> Result<AgentStep, Error> {
        self.jobs
            .get(id)
            .map(|job| job.plan.public.clone())
            .ok_or(Error::NotFound)
    }
    pub fn tool(&self, id: &str) -> Result<ToolId, Error> {
        self.jobs
            .get(id)
            .map(|job| job.plan.tool)
            .ok_or(Error::NotFound)
    }
    pub fn record_transfer(
        &mut self,
        preview: &platform::TransferPreview,
        state: &platform::TransferState,
    ) -> Result<Value, Error> {
        if state.state != "completed"
            || state.transferred_bytes != state.total_bytes
            || state
                .sha256
                .as_ref()
                .is_none_or(|h| h.len() != 64 || !h.bytes().all(|b| b.is_ascii_hexdigit()))
        {
            return Err(Error::Validation("文件传输未通过完整校验"));
        }
        self.artifacts.insert(
            preview.id.clone(),
            Artifact {
                host: preview.destination.host_id.clone(),
                path: preview.destination.path.clone(),
                sha256: state.sha256.clone(),
            },
        );
        Ok(
            json!({"artifactId":preview.id,"hostId":preview.destination.host_id,"path":preview.destination.path,"sha256":state.sha256,"bytes":state.total_bytes}),
        )
    }
    pub async fn close(&mut self, context: &Context) -> Result<(), Error> {
        let mut errors = Vec::new();
        for job in self.jobs.values_mut() {
            if let Some(id) = &job.stream {
                match context
                    .request(platform::Request::StreamStop {
                        stream_id: id.clone(),
                    })
                    .await
                {
                    Ok(_) => job.stream = None,
                    Err(e) if e.code == "NOT_FOUND" => job.stream = None,
                    Err(e) => errors.push(e.message),
                }
            }
        }
        if errors.is_empty() {
            self.jobs.clear();
            self.artifacts.clear();
            Ok(())
        } else {
            Err(Error::Platform(serverdeck_plugin_sdk::ApiError::new(
                "RESOURCE_CLEANUP",
                errors.join("；"),
            )))
        }
    }
}
