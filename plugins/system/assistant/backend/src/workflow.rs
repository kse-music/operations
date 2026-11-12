use crate::{
    Error,
    agent::{self, AgentHost, PlannedStep},
    files::{self, Resources},
    jobs,
    ops::{self, Request, Response},
    redact::Redactor,
    task::{self, Snapshot, Status, Task, Tasks},
    tools::{self, ToolResult, ToolStatus},
    types::*,
};
use serde::Deserialize;
use serde_json::{Value, json};
use serverdeck_plugin_sdk::{
    backend::Context,
    platform::{self, Command},
};
use std::{cell::RefCell, collections::HashMap, rc::Rc};

struct Host {
    context: Context,
    id: String,
}
impl AgentHost for Host {
    async fn query(&self, request: Request) -> Result<Response, Error> {
        let output = self
            .context
            .execute(&self.id, request.platform_command()?)
            .await?
            .checked()?;
        let mut response = crate::parse::response(&request, output.stdout.as_bytes())?;
        if !output.stderr.is_empty() {
            response.message = Some(output.stderr);
        }
        Ok(response)
    }
}
#[derive(Clone)]
struct Pending {
    memory: Rc<RefCell<Memory>>,
    operation_host: String,
    progress_id: Option<String>,
    scope: String,
    at: u64,
    root: String,
    model: Value,
    bindings: Vec<String>,
    hosts: Vec<String>,
    messages: Vec<platform::Message>,
    redactor: Rc<Redactor>,
}
#[derive(Default)]
struct Memory {
    messages: Vec<platform::Message>,
    rounds: usize,
    queries: usize,
    changes: usize,
    usage: Option<Usage>,
    usage_unknown: bool,
    observations: Vec<AgentObservation>,
    evidence: HashMap<String, Vec<(Request, Response)>>,
    resources: Resources,
    jobs: jobs::Resources,
    loaded_skills: std::collections::HashSet<String>,
    resume_ready: bool,
    cleanup_failed: bool,
    active_job: Option<(String, String)>,
}
struct Plan {
    pending: Pending,
    confirmation: Option<String>,
    work: Work,
}
enum Work {
    Operations(Vec<PlannedStep>),
    File(files::FilePlan),
    Transfer(platform::TransferPreview),
    Job(jobs::Plan),
}
struct ActiveCopy {
    pending: Pending,
    scope: String,
    proposal_id: String,
    preview: platform::TransferPreview,
}
#[derive(Default)]
struct State {
    previews: HashMap<String, Pending>,
    plans: HashMap<String, Plan>,
    tasks: Tasks,
    copies: HashMap<String, ActiveCopy>,
    sessions: HashMap<String, Pending>,
    executions: HashMap<String, (String, Value)>,
}
thread_local! {static STATE:RefCell<State>=RefCell::new(State::default());}
fn prune(info: &Value) {
    let now = now(info);
    STATE.with_borrow_mut(|s| {
        if let Some(active) = info["activeScopes"].as_array() {
            let active = active.iter().filter_map(Value::as_str).collect::<Vec<_>>();
            s.plans
                .retain(|_, plan| active.contains(&plan.pending.scope.as_str()));
            s.copies
                .retain(|_, copy| active.contains(&copy.scope.as_str()));
            s.sessions
                .retain(|_, pending| active.contains(&pending.scope.as_str()));
            s.executions
                .retain(|_, (scope, _)| active.contains(&scope.as_str()));
            s.tasks.abandon_scopes(&active, now);
        }
        s.previews.retain(|_, p| now.saturating_sub(p.at) < 300000);
        s.plans
            .retain(|_, p| now.saturating_sub(p.pending.at) < 300000);
        s.tasks.expire(now);
        s.executions.retain(|id, _| s.tasks.contains(id));
    });
}
fn task_update(id: &str, status: Status, at: u64) -> Result<Snapshot, Error> {
    STATE.with_borrow_mut(|s| s.tasks.update(id, status, at))
}
fn task_finish(id: &str, result: Result<(Value, Status), Error>, at: u64) -> Result<Value, Error> {
    match result {
        Ok((mut value, status)) => {
            value["task"] = json!(task_update(id, status, at)?);
            Ok(value)
        }
        Err(error) => {
            let status = if matches!(&error, Error::Platform(e) if e.code == "USER_CANCELLED") {
                Status::Cancelled
            } else {
                Status::Failed
            };
            task_update(id, status, at)?;
            Err(error)
        }
    }
}
fn scope(info: &Value) -> Result<&str, Error> {
    info["scope"]
        .as_str()
        .ok_or(Error::Validation("平台页面作用域无效"))
}
fn now(info: &Value) -> u64 {
    info["unixMs"].as_u64().unwrap_or(0)
}
fn id(info: &Value) -> Result<String, Error> {
    info["nonce"]
        .as_str()
        .map(str::to_owned)
        .ok_or(Error::Validation("平台随机标识无效"))
}
fn input<T: serde::de::DeserializeOwned>(value: Value) -> Result<T, Error> {
    serde_json::from_value(value).map_err(|_| Error::Validation("助手请求格式无效"))
}
fn validate_question(question: &str) -> Result<(), Error> {
    if question.trim().is_empty() || question.len() > 8192 || question.contains('\0') {
        return Err(Error::Validation("问题须为 1–8192 字节"));
    }
    Ok(())
}
async fn model(context: &Context, id: &str) -> Result<(Value, String), Error> {
    let value = context
        .request(platform::Request::Model {
            model_id: id.into(),
        })
        .await?;
    let binding = value["binding"]
        .as_str()
        .ok_or(Error::Validation("模型绑定无效"))?
        .to_owned();
    Ok((value["model"].clone(), binding))
}
async fn completion(
    context: &Context,
    pending: &Pending,
    messages: Vec<platform::Message>,
) -> Result<Value, Error> {
    let fitted = if pending.progress_id.is_some() {
        crate::budget::fit_stream(messages, &pending.model, 44 * 1024)?
    } else {
        crate::budget::fit(messages, &pending.model, 44 * 1024)?
    };
    let context = context.with_bindings(pending.bindings.clone());
    let mut result = if let Some(progress_id) = &pending.progress_id {
        crate::streaming::complete(
            &context,
            &pending.model,
            fitted.messages,
            &pending.redactor,
            progress_id,
        )
        .await?
    } else {
        context
            .request(platform::Request::ModelComplete {
                model_id: pending.model["id"]
                    .as_str()
                    .ok_or(Error::Validation("模型ID无效"))?
                    .into(),
                expected_revision: pending.model["revision"].as_str().map(str::to_owned),
                messages: fitted.messages,
            })
            .await?
    };
    result["contextWarnings"] = json!(fitted.warnings);
    Ok(result)
}
fn host_asset(h: &Value) -> HostAsset {
    HostAsset {
        id: h["id"].as_str().unwrap_or("").into(),
        name: h["name"].as_str().unwrap_or("").into(),
        hostname: h["hostname"].as_str().unwrap_or("").into(),
        username: h["username"].as_str().unwrap_or("").into(),
        port: h["port"].as_u64().unwrap_or(22) as u16,
        group: None,
    }
}
async fn assets(context: &Context) -> Result<(Vec<HostAsset>, Value), Error> {
    let value = context.request(platform::Request::Hosts).await?;
    let hosts = value["hosts"]
        .as_array()
        .ok_or(Error::Validation("资产列表无效"))?
        .iter()
        .map(host_asset)
        .collect();
    Ok((hosts, value))
}
pub async fn dispatch(context: Context, action: String, value: Value) -> Result<Value, Error> {
    let info = context.info().await?;
    prune(&info);
    match action.as_str() {
        "resolve_hosts" => {
            let request: ResolveHostsInput = input(value)?;
            validate_question(&request.question)?;
            validate_history(&request.history)?;
            if request.request_id.len() > 128 || request.previous_host_ids.len() > 8 {
                return Err(Error::Validation("主机匹配请求超过限制"));
            }
            let (model, binding) = model(&context, &request.model_id).await?;
            let (assets, _) = assets(&context).await?;
            let local_choice = crate::routing::local_choice(
                &request.question,
                &assets,
                &request.previous_host_ids,
            );
            let needs_context = (!request.history.is_empty()
                && !request.previous_host_ids.is_empty()
                && !crate::routing::inventory_question(&request.question))
                || local_choice.as_ref().is_some_and(|choice| {
                    choice.message.is_empty()
                        && choice.host_ids.len() == 1
                        && request.entry_host_id.as_ref().is_some_and(|entry| {
                            assets.iter().any(|asset| &asset.id == entry)
                                && &choice.host_ids[0] != entry
                        })
                });
            let explicit_host_ids = crate::routing::explicit_host_ids(&request.question, &assets);
            let choice = if let Some(choice) = local_choice.filter(|_| !needs_context) {
                choice
            } else {
                let redactor = Rc::new(Redactor::new(
                    request.mask_addresses,
                    request.redact_values,
                )?);
                for asset in &assets {
                    redactor.register_host_address(&asset.hostname);
                }
                let mut metadata = json!({"question":request.question,"assets":assets,"previousHostIds":request.previous_host_ids,"entryHostId":request.entry_host_id,"explicitHostIds":explicit_host_ids});
                redactor.value(&mut metadata);
                let pending = Pending {
                    memory: Rc::new(RefCell::new(Memory::default())),
                    operation_host: String::new(),
                    progress_id: None,
                    scope: scope(&info)?.into(),
                    at: now(&info),
                    root: request.request_id,
                    model: model.clone(),
                    bindings: vec![binding],
                    hosts: vec![],
                    messages: vec![],
                    redactor,
                };
                let mut messages = vec![platform::Message {
                    role: platform::Role::System,
                    content: crate::routing::PROMPT.into(),
                }];
                for message in request.history {
                    messages.push(platform::Message {
                        role: match message.role {
                            ChatRole::User => platform::Role::User,
                            ChatRole::Assistant => platform::Role::Assistant,
                        },
                        content: pending.redactor.text(&message.content),
                    });
                }
                messages.push(platform::Message {
                    role: platform::Role::User,
                    content: metadata.to_string(),
                });
                let result = completion(&context, &pending, messages).await?;
                if result["incomplete"] == true {
                    return Err(Error::Validation("主机匹配响应不完整"));
                }
                serde_json::from_str(
                    result["text"]
                        .as_str()
                        .ok_or(Error::Validation("主机匹配响应无效"))?,
                )
                .map_err(|_| Error::Validation("主机匹配响应无效"))?
            };
            crate::routing::validate_choice(&choice, &assets)?;
            if choice.message.is_empty()
                && explicit_host_ids
                    .iter()
                    .any(|id| !choice.host_ids.contains(id))
            {
                return Err(Error::Validation("主机匹配遗漏了明确指定的目标"));
            }
            Ok(
                json!({"hostIds":choice.host_ids,"message":choice.message,"modelRevision":model["revision"]}),
            )
        }
        "prepare" => prepare(context, input(value)?, info).await,
        "send" => {
            #[derive(Deserialize)]
            #[serde(deny_unknown_fields)]
            struct SendInput {
                id: String,
                confirmed: bool,
            }
            let request: SendInput = input(value)?;
            if !request.confirmed {
                return Err(Error::Validation("请明确发送问题"));
            }
            let key = request.id.as_str();
            let pending = STATE.with_borrow_mut(|s| {
                if s.previews
                    .get(key)
                    .is_none_or(|p| p.scope != scope(&info).unwrap_or(""))
                {
                    return Err(Error::NotFound);
                }
                s.previews.remove(key).ok_or(Error::NotFound)
            })?;
            task_update(key, Status::Running, now(&info))?;
            let result = send(context, pending).await;
            task_finish(key, result, now(&info))
        }
        "execute" => execute(context, input(value)?, info).await,
        "tools" => Ok(json!(tools::catalog())),
        "resume" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase", deny_unknown_fields)]
            struct Resume {
                id: String,
                #[serde(default)]
                progress_id: Option<String>,
            }
            let request: Resume = input(value)?;
            let mut pending = STATE
                .with_borrow(|s| {
                    s.sessions
                        .get(&request.id)
                        .filter(|p| p.scope == scope(&info).unwrap_or(""))
                        .cloned()
                })
                .ok_or(Error::NotFound)?;
            {
                let mut memory = pending.memory.borrow_mut();
                if !memory.resume_ready {
                    return Err(Error::Validation("任务尚未准备好继续，不能重放工具调用"));
                }
                memory.resume_ready = false;
            }
            STATE.with_borrow_mut(|s| {
                s.executions.remove(&request.id);
            });
            pending.progress_id = request.progress_id;
            STATE.with_borrow_mut(|s| s.tasks.renew(&request.id, now(&info)))?;
            task_update(&request.id, Status::Running, now(&info))?;
            let result = send(context, pending).await;
            task_finish(&request.id, result, now(&info))
        }
        "poll" => {
            let request: TaskInput = input(value)?;
            poll_job(context, &request.id, &info).await
        }
        "task" => {
            let request: TaskInput = input(value)?;
            let (snapshot, bindings, native_job) = STATE.with_borrow(|s| {
                let task = s.tasks.get(&request.id, scope(&info)?)?;
                Ok::<_, Error>((
                    task.snapshot.clone(),
                    task.bindings.clone(),
                    task.native_job,
                ))
            })?;
            if !native_job {
                context.with_bindings(bindings).info().await?;
            }
            Ok(json!(snapshot))
        }
        "cancel" => {
            let request: TaskInput = input(value)?;
            cancel_task(context, &request.id, &info).await
        }
        _ => Err(Error::Validation("未知助手动作")),
    }
}
async fn prepare(context: Context, request: PrepareInput, info: Value) -> Result<Value, Error> {
    validate_question(&request.question)?;
    validate_history(&request.history)?;
    let (model, model_binding) = model(&context, &request.model_id).await?;
    if request
        .expected_model_revision
        .as_ref()
        .is_some_and(|revision| model["revision"] != *revision)
    {
        return Err(Error::Conflict);
    }
    let redactor = Rc::new(Redactor::new(
        request.mask_addresses,
        request.redact_values,
    )?);
    let mut hosts = request.session_ids;
    if let Some(host) = request.session_id {
        hosts.push(host);
    }
    hosts.sort();
    hosts.dedup();
    if hosts.len() > 8 {
        return Err(Error::Validation("每轮最多八台主机"));
    }
    let mut bindings = vec![model_binding];
    if request.approval_mode != platform::ApprovalMode::Request {
        let policy = context
            .request(platform::Request::ApprovalMode {
                mode: request.approval_mode,
            })
            .await?;
        bindings.push(policy["binding"].as_str().ok_or(Error::Conflict)?.into());
    }
    let mut collected = vec![];
    let mut host_assets = vec![];
    let mut warnings = vec![];
    let plan = if request.auto_hosts {
        crate::collection::Plan::for_question(&request.question, &request.history)
    } else {
        crate::collection::Plan::default()
    };
    for host in &hosts {
        let bound = context
            .request(platform::Request::Host {
                host_id: host.clone(),
            })
            .await?;
        bindings.push(bound["binding"].as_str().ok_or(Error::Conflict)?.into());
        if let Some(address) = bound["host"]["hostname"].as_str() {
            redactor.register_host_address(address);
        }
        host_assets.push(host_asset(&bound["host"]));
        let client = Host {
            context: context.with_bindings(bindings.clone()),
            id: host.clone(),
        };
        let mut data = json!({"hostId":host,"server":if request.selection.server {bound["host"].clone()}else{Value::Null},"collection":{"sources":plan.sources(),"policy":"仅采集本轮相关证据，未采集或读取失败不等于零"}});
        let mut queries = vec![];
        if plan.metrics || request.selection.metrics {
            match sample(&client).await {
                Ok(sample) => {
                    let disk_total = sample.disks.len();
                    let network_total = sample.network.len();
                    data["system"] = json!(sample.system);
                    data["metrics"] = json!({"sampledAt":sample.sampled_at,"uptime":sample.uptime,"load":sample.load,"cpu":sample.cpus.iter().find(|cpu|cpu.name=="cpu"),"memory":sample.memory,"diskTotal":disk_total,"disks":sample.disks.into_iter().take(8).collect::<Vec<_>>(),"omittedDisks":disk_total.saturating_sub(8),"networkTotal":network_total,"network":sample.network.into_iter().take(8).collect::<Vec<_>>(),"omittedNetwork":network_total.saturating_sub(8),"warnings":sample.warnings});
                    redactor.value(&mut data["system"]);
                    redactor.value(&mut data["metrics"]);
                    crate::summary::bound_strings(&mut data["system"], 256);
                }
                Err(Error::Platform(error)) if error.code == "USER_CANCELLED" => {
                    return Err(error.into());
                }
                Err(error) => {
                    data["metrics"] = json!({"available":false,"message":error.message()});
                    warnings.push(format!("主机 {host} 资源采样失败"));
                }
            }
        }
        if plan.processes || request.selection.processes {
            queries.push(("processes", Request::Processes));
        }
        if plan.docker || request.selection.docker {
            queries.push(("docker", Request::Containers));
        }
        if plan.services {
            queries.push((
                "services",
                Request::Services {
                    scope: ops::Scope::System,
                },
            ));
        }
        if plan.ports {
            queries.push(("ports", Request::Ports));
        }
        for (key, query) in queries {
            match client.query(query).await {
                Ok(response) => {
                    if response.detail.is_some() {
                        data[key] = json!({"available":true,"detail":response.detail});
                        redactor.value(&mut data[key]);
                        crate::summary::bound_strings(&mut data[key], 4096);
                    } else {
                        data[key] = crate::summary::summarize(key, response, &redactor);
                    }
                }
                Err(Error::Platform(error)) if error.code == "USER_CANCELLED" => {
                    return Err(Error::Platform(error));
                }
                Err(error) => {
                    data[key] = json!({"available":false,"message":error.message()});
                    warnings.push(format!("主机 {host} 的 {key} 未读取成功"));
                }
            }
        }
        let log_command = if let Some(source) = request.selection.log.clone() {
            Some(
                ops::LogInput {
                    source,
                    lines: request.selection.log_lines,
                    follow: false,
                }
                .command()?,
            )
        } else if plan.journal {
            Some(format!("{}{}", ops::PRELUDE, ops::SYSTEM_JOURNAL))
        } else {
            None
        };
        if let Some(command) = log_command {
            if request.selection.log.is_some() && !(1..=200).contains(&request.selection.log_lines)
            {
                return Err(Error::Validation("日志范围须为 1–200 行"));
            }
            match client
                .context
                .execute(host, Command::script(command))
                .await
                .and_then(|r| r.checked())
            {
                Ok(result) => {
                    data["selectedLog"] = json!({"available":true,"output":result.stdout});
                    redactor.value(&mut data["selectedLog"]);
                    crate::summary::bound_strings(&mut data["selectedLog"], 8192);
                }
                Err(error) if error.code == "USER_CANCELLED" => return Err(error.into()),
                Err(error) => {
                    data["selectedLog"] = json!({"available":false,"message":error.message});
                }
            }
        }
        redactor.value(&mut data);
        collected.push(data);
    }
    let mut evidence = json!({"hosts":collected});
    if let Some(entry) = request.entry_host_id.filter(|id| hosts.contains(id)) {
        evidence["entryHostId"] = json!(entry);
    }
    let explicit_host_ids = crate::routing::explicit_host_ids(&request.question, &host_assets);
    if !explicit_host_ids.is_empty() {
        evidence["explicitHostIds"] = json!(explicit_host_ids);
    }
    // Asset matching has its own request. A diagnosis must not resend unrelated
    // inventory; only an explicit inventory question needs directory metadata.
    if hosts.is_empty() && crate::routing::inventory_question(&request.question) {
        let (assets, _) = assets(&context).await?;
        evidence["assets"] = json!({"total":assets.len(),"records":assets,"omittedRecords":0});
    }
    redactor.value(&mut evidence);
    if crate::summary::has_omissions(&evidence) {
        warnings.push("上下文明细已限量，统计基于完整成功查询，不能将未采集视为零。".into());
    }
    let mut messages = vec![platform::Message {
        role: platform::Role::System,
        content: agent::prompt()?,
    }];
    for message in request.history {
        messages.push(platform::Message {
            role: match message.role {
                ChatRole::User => platform::Role::User,
                ChatRole::Assistant => platform::Role::Assistant,
            },
            content: redactor.text(&message.content),
        });
    }
    messages.push(platform::Message {
        role: platform::Role::User,
        content: json!({"question":redactor.text(&request.question),"context":evidence})
            .to_string(),
    });
    let fitted = if request.progress_id.is_some() {
        crate::budget::fit_stream(messages, &model, 40 * 1024)?
    } else {
        crate::budget::fit(messages, &model, 40 * 1024)?
    };
    warnings.extend(fitted.warnings);
    let messages = fitted.messages;
    let key = id(&info)?;
    let snapshot = Snapshot {
        id: key.clone(),
        status: Status::Prepared,
        model_id: request.model_id.clone(),
        host_ids: hosts.clone(),
        created_at: now(&info),
        updated_at: now(&info),
        expires_at: now(&info).saturating_add(task::TTL_MS),
    };
    let preview = json!({"id":key,"modelId":request.model_id,"destination":model["config"]["baseUrl"],"model":model["config"]["model"],"body":serde_json::to_string(&messages).map_err(|e|Error::Worker(Box::new(e)))?,"estimatedInputTokens":fitted.input_tokens,"maxOutputTokens":model["config"]["maxOutputTokens"],"warnings":warnings,"task":snapshot});
    let pending = Pending {
        memory: Rc::new(RefCell::new(Memory {
            messages: messages.clone(),
            ..Memory::default()
        })),
        operation_host: hosts.first().cloned().unwrap_or_default(),
        progress_id: request.progress_id,
        scope: scope(&info)?.into(),
        at: now(&info),
        root: key.clone(),
        model,
        bindings,
        hosts,
        messages,
        redactor,
    };
    STATE.with_borrow_mut(|s| {
        if s.previews.len() >= 8 {
            return Err(Error::Busy);
        }
        s.tasks.insert(Task {
            native_job: false,
            scope: pending.scope.clone(),
            bindings: pending.bindings.clone(),
            snapshot,
        })?;
        s.previews.insert(key, pending);
        Ok(())
    })?;
    Ok(preview)
}
// The VM runs one guest action at a time; keep Memory reachable during awaits so
// cancel_current cannot drop file, stream, or transfer handles needed for cleanup.
#[allow(clippy::await_holding_refcell_ref)]
async fn send(context: Context, pending: Pending) -> Result<(Value, Status), Error> {
    STATE.with_borrow_mut(|s| {
        s.sessions.insert(pending.root.clone(), pending.clone());
    });
    let cell = pending.memory.clone();
    let mut memory = cell.borrow_mut();
    let result = send_inner(context.clone(), pending.clone(), &mut memory).await;
    if matches!(&result, Ok((_, Status::AwaitingApproval | Status::Running))) {
        return result;
    }
    let result = close_memory(&context, &mut memory, result).await;
    if !memory.cleanup_failed {
        STATE.with_borrow_mut(|s| {
            s.sessions.remove(&pending.root);
        });
    }
    result
}
async fn close_memory(
    context: &Context,
    memory: &mut Memory,
    result: Result<(Value, Status), Error>,
) -> Result<(Value, Status), Error> {
    // TransferClose cancels and drains before job streams release their archive files.
    let files = memory.resources.close(&context.with_bindings(vec![])).await;
    let jobs = if files.is_ok() {
        memory.jobs.close(&context.with_bindings(vec![])).await
    } else {
        Ok(())
    };
    memory.resume_ready = false;
    memory.active_job = None;
    let errors = [files.err(), jobs.err()]
        .into_iter()
        .flatten()
        .map(|e| e.message())
        .collect::<Vec<_>>();
    memory.cleanup_failed = !errors.is_empty();
    if errors.is_empty() {
        return result;
    }
    let message = format!(
        "{}；资源释放失败：{}",
        match &result {
            Ok((v, _)) => v["output"]
                .as_str()
                .or(v["text"].as_str())
                .unwrap_or("任务停止")
                .to_owned(),
            Err(e) => e.message(),
        },
        errors.join("；")
    );
    Ok((
        json!({"success":false,"output":message,"text":message,"proposals":[],"warnings":[message]}),
        if memory.changes > 0 {
            Status::Unverified
        } else {
            Status::Failed
        },
    ))
}
async fn query_call(
    context: &Context,
    pending: &Pending,
    memory: &mut Memory,
    query: tools::Query,
) -> Result<Value, Error> {
    let tool = query.tool()?;
    match query {
        tools::Query::Extension(tools::ExtensionQuery::SkillRead { name, path }) => {
            if path != "SKILL.md" && !memory.loaded_skills.contains(&name) {
                return Err(Error::Validation("请先加载该 Skill 的 SKILL.md"));
            }
            let mut value = crate::skills::read(&name, &path)?;
            if path == "SKILL.md" {
                memory.loaded_skills.insert(name);
            }
            pending.redactor.value(&mut value);
            memory.observations.push(AgentObservation {
                query: tool.label().into(),
                records: 1,
                result: ToolResult {
                    tool,
                    status: ToolStatus::Succeeded,
                    message: None,
                },
            });
            Ok(json!({"tool":tool,"status":"succeeded","result":value}))
        }
        tools::Query::Files(query) => {
            let result = memory
                .resources
                .query(
                    context,
                    query.clone(),
                    &pending.hosts,
                    &pending.redactor,
                    &memory.jobs.artifacts,
                )
                .await;
            let (value, count, status, message) = match result {
                Ok((value, count)) => (value, count, ToolStatus::Succeeded, None),
                Err(Error::Platform(error))
                    if match query {
                        files::Query::FileRead { .. } => error.code == "TEXT_SIZE_MISMATCH",
                        files::Query::TransferPrepare { .. } => {
                            files::preflight_path_error(&error.code)
                        }
                    } =>
                {
                    let message = pending.redactor.text(&error.message);
                    (
                        json!({"code":error.code,"message":message}),
                        0,
                        ToolStatus::Failed,
                        Some(message),
                    )
                }
                Err(error) => return Err(error),
            };
            memory.observations.push(AgentObservation {
                query: tool.label().into(),
                records: count,
                result: ToolResult {
                    tool,
                    status,
                    message,
                },
            });
            Ok(json!({"tool":tool,"status":status,"request":query,"result":value}))
        }
        operation => {
            let (host_id, request) = match operation {
                tools::Query::Extension(tools::ExtensionQuery::HostQuery { host_id, query }) => {
                    (host_id, query.0)
                }
                tools::Query::Operations(request) if pending.hosts.len() == 1 => {
                    (pending.hosts[0].clone(), request)
                }
                _ => return Err(Error::Validation("多主机查询需要 host_query 明确 hostId")),
            };
            if !pending.hosts.contains(&host_id) {
                return Err(Error::Validation("查询主机不在本轮已匹配范围"));
            }
            let host = Host {
                context: context.clone(),
                id: host_id.clone(),
            };
            let response = match tools::query(&host, request.clone()).await {
                Ok(response) => response,
                Err(Error::Platform(error))
                    if ["REMOTE_COMMAND", "OUTPUT_LIMIT"].contains(&error.code.as_str()) =>
                {
                    let message = pending.redactor.text(&error.message);
                    let key =
                        serde_json::to_value(&request).map_err(|e| Error::Worker(Box::new(e)))?;
                    if let Some(evidence) = memory.evidence.get_mut(&host_id) {
                        evidence.retain(|(old, _)| {
                            serde_json::to_value(old).ok().as_ref() != Some(&key)
                        });
                    }
                    memory.observations.push(AgentObservation {
                        query: tool.label().into(),
                        records: 0,
                        result: ToolResult {
                            tool,
                            status: ToolStatus::Failed,
                            message: Some(message.clone()),
                        },
                    });
                    return Ok(
                        json!({"tool":tool,"hostId":host_id,"status":"failed","request":request,"result":{"success":false,"code":error.code,"message":message}}),
                    );
                }
                Err(error) => return Err(error),
            };
            let count = response.records.len();
            let mut value = json!({"success":response.success,"code":response.code,"message":response.message,"records":response.records.iter().take(20).collect::<Vec<_>>(),"detail":response.detail,"totalRecords":count,"omittedRecords":count.saturating_sub(20)});
            pending.redactor.value(&mut value);
            if value.to_string().len() > 8192 {
                value["records"] = json!([]);
                value["detail"] = Value::Null;
                value["omittedRecords"] = json!(count);
                value["notice"] = json!("明细超过8KiB，完整证据保留在执行器");
            }
            let status = if response.success {
                ToolStatus::Succeeded
            } else {
                ToolStatus::Failed
            };
            memory.observations.push(AgentObservation {
                query: tool.label().into(),
                records: count,
                result: ToolResult {
                    tool,
                    status,
                    message: response.message.as_ref().map(|s| pending.redactor.text(s)),
                },
            });
            memory
                .evidence
                .entry(host_id.clone())
                .or_default()
                .push((request.clone(), response));
            Ok(
                json!({"tool":tool,"hostId":host_id,"status":status,"request":request,"result":value}),
            )
        }
    }
}
async fn send_inner(
    context: Context,
    mut pending: Pending,
    memory: &mut Memory,
) -> Result<(Value, Status), Error> {
    if memory.messages.is_empty() {
        memory.messages = pending.messages.clone();
    }
    let bound = context.with_bindings(pending.bindings.clone());
    let mut warnings = vec![];
    for _ in 0..6 {
        if memory.rounds >= 32 {
            return Err(Error::Validation("任务达到32轮推理上限，已停止"));
        }
        memory.rounds += 1;
        let result = completion(&context, &pending, memory.messages.clone()).await?;
        for warning in result["contextWarnings"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            if !warnings.iter().any(|s| s == warning) {
                warnings.push(warning.to_owned());
            }
        }
        if result["incomplete"] == true {
            return Err(Error::Validation("智能体响应被截断，未开放变更"));
        }
        if result["usage"].is_null() {
            memory.usage_unknown = true;
            memory.usage = None;
        } else if !memory.usage_unknown {
            let next: Usage = input(result["usage"].clone())?;
            let total = memory.usage.get_or_insert(Usage {
                input_tokens: 0,
                output_tokens: 0,
            });
            total.input_tokens = total.input_tokens.saturating_add(next.input_tokens);
            total.output_tokens = total.output_tokens.saturating_add(next.output_tokens);
        }
        let text = result["text"]
            .as_str()
            .ok_or(Error::Validation("模型响应缺少文本"))?;
        let decision: agent::Decision = serde_json::from_str(text)
            .map_err(|_| Error::Validation("模型未返回有效的智能体协议"))?;
        let answer_status = match &decision {
            agent::Decision::Clarify { .. } => Status::NeedsInput,
            agent::Decision::Answer {
                outcome: agent::Outcome::Completed,
                ..
            } => {
                if pending.hosts.is_empty()
                    && memory.changes == 0
                    && !memory
                        .observations
                        .iter()
                        .any(|o| o.result.status == ToolStatus::Succeeded)
                {
                    return Err(Error::Validation("没有真实工具结果，不能确认运维目标完成"));
                }
                Status::Succeeded
            }
            agent::Decision::Answer {
                outcome: agent::Outcome::Incomplete,
                ..
            } => Status::Failed,
            _ => Status::Answered,
        };
        match decision {
            agent::Decision::Query { requests } => {
                if requests.is_empty() || requests.len() > 3 || memory.queries + requests.len() > 64
                {
                    return Err(Error::Validation("查询批次或任务工具次数超过上限"));
                }
                // Check every requested host before the first request in this batch.
                for tools::Call(query) in &requests {
                    if let tools::Query::Extension(tools::ExtensionQuery::HostQuery {
                        host_id, ..
                    }) = query
                        && !pending.hosts.contains(host_id)
                    {
                        return Err(Error::Validation("批次查询目标超出匹配范围"));
                    }
                    if matches!(query, tools::Query::Operations(_)) && pending.hosts.len() != 1 {
                        return Err(Error::Validation("多主机查询需要 host_query 明确 hostId"));
                    }
                }
                memory.queries += requests.len();
                let mut results = vec![];
                for tools::Call(query) in requests {
                    results.push(query_call(&bound, &pending, memory, query).await?);
                }
                memory.messages.push(platform::Message {
                    role: platform::Role::Assistant,
                    content: text.into(),
                });
                memory.messages.push(platform::Message {
                    role: platform::Role::User,
                    content: json!({"untrustedToolResults":results}).to_string(),
                });
            }
            agent::Decision::Answer { text, .. } | agent::Decision::Clarify { text } => {
                let status = answer_status;
                return Ok((
                    json!({"text":pending.redactor.text(&text),"proposals":[],"usage":memory.usage,"warnings":warnings,"agent":{"observations":memory.observations,"steps":[]}}),
                    status,
                ));
            }
            agent::Decision::Plan {
                host_id,
                summary,
                actions,
            } => {
                if actions.is_empty()
                    || actions.len() > 32
                    || summary.trim().is_empty()
                    || summary.len() > 8192
                    || memory.changes >= 32
                {
                    return Err(Error::Validation("计划为空或超过任务变更上限"));
                }
                if let Some(host) = host_id {
                    if !pending.hosts.contains(&host) {
                        return Err(Error::Validation("计划目标不在本轮已匹配主机中"));
                    }
                    pending.operation_host = host;
                } else if pending.hosts.len() != 1 {
                    pending.operation_host.clear();
                }
                let host = Host {
                    context: bound.clone(),
                    id: pending.operation_host.clone(),
                };
                let evidence = memory
                    .evidence
                    .get(&host.id)
                    .map(Vec::as_slice)
                    .unwrap_or(&[]);
                let mut actions = actions.into_iter().map(|call| call.0).collect::<Vec<_>>();
                let (work, public, target) = if actions.len() == 1 {
                    match actions.remove(0) {
                        action @ (tools::Action::Command { .. }
                        | tools::Action::ImageSave { .. }
                        | tools::Action::ImageLoad { .. }) => {
                            let plan = memory
                                .jobs
                                .prepare(&bound, &action, &pending.hosts, &memory.evidence)
                                .await?;
                            let public = vec![plan.public.clone()];
                            let target = plan.host.clone();
                            (Work::Job(plan), public, target)
                        }
                        tools::Action::FileEdit { document_id, edits } => {
                            let plan = memory.resources.edit_plan(&document_id, &edits)?;
                            let public = vec![plan.public.clone()];
                            let target = plan.host.clone();
                            (Work::File(plan), public, target)
                        }
                        tools::Action::Transfer { preview_id } => {
                            let preview = memory.resources.transfer(&preview_id)?;
                            let public = vec![files::transfer_step(&preview)];
                            let target = preview.destination.host_id.clone();
                            (Work::Transfer(preview), public, target)
                        }
                        action => {
                            if host.id.is_empty() {
                                return Err(Error::Validation("运维变更需要明确计划 hostId"));
                            }
                            let steps = agent::build_plan(vec![action], evidence, &host).await?;
                            let public = steps.iter().map(|s| s.public.clone()).collect::<Vec<_>>();
                            (Work::Operations(steps), public, host.id.clone())
                        }
                    }
                } else {
                    if host.id.is_empty() {
                        return Err(Error::Validation("批量运维变更需要明确计划 hostId"));
                    }
                    let steps = agent::build_plan(actions, evidence, &host).await?;
                    let public = steps.iter().map(|s| s.public.clone()).collect::<Vec<_>>();
                    (Work::Operations(steps), public, host.id.clone())
                };
                if public.is_empty() {
                    memory.messages.push(platform::Message {
                        role: platform::Role::Assistant,
                        content: text.into(),
                    });
                    memory.messages.push(platform::Message{role:platform::Role::User,content:json!({"untrustedToolResults":[{"status":"succeeded","result":{"noOp":true,"hostId":target,"message":"已查询的操作没有目标，未执行变更；继续判断其他必要步骤"}}]}).to_string()});
                    continue;
                }
                let info = bound.info().await?;
                let key = id(&info)?;
                pending.at = now(&info);
                STATE.with_borrow_mut(|s| s.tasks.renew(&pending.root, now(&info)))?;
                let routine = match &work {
                    Work::Job(plan) => plan.routine,
                    Work::Transfer(preview) => !preview.overwrite && !preview.target_exists,
                    _ => false,
                };
                let proposals = if public.is_empty() {
                    vec![]
                } else {
                    vec![
                        json!({"id":key,"command":format!("执行计划：{} 个操作，按模式批准后执行",public.len()),"risk":if routine {"routine"} else {"change"},"reason":"冻结本批目标、参数和修订；真实结果返回智能体，未知结果不重放","target":target,"changeConfirmation":null}),
                    ]
                };
                memory.messages.push(platform::Message {
                    role: platform::Role::Assistant,
                    content: text.into(),
                });
                if !public.is_empty() {
                    STATE.with_borrow_mut(|s| {
                        if s.plans.len() >= 8 {
                            return Err(Error::Busy);
                        }
                        s.plans.insert(
                            key,
                            Plan {
                                pending: pending.clone(),
                                confirmation: None,
                                work,
                            },
                        );
                        Ok(())
                    })?;
                }
                return Ok((
                    json!({"text":pending.redactor.text(&summary),"proposals":proposals,"usage":memory.usage,"warnings":warnings,"agent":{"observations":memory.observations,"steps":public}}),
                    if public.is_empty() {
                        Status::Succeeded
                    } else {
                        Status::AwaitingApproval
                    },
                ));
            }
        }
    }
    memory.resume_ready = true;
    Ok((
        json!({"text":"正在继续推理","proposals":[],"continuation":true,"usage":memory.usage,"warnings":warnings,"agent":{"observations":memory.observations,"steps":[]}}),
        Status::Running,
    ))
}
fn observe_change(pending: &Pending, memory: &mut Memory, value: &Value) {
    let mut payload = value
        .get("result")
        .filter(|v| v.is_object())
        .cloned()
        .unwrap_or_else(|| json!({}));
    payload["output"] = value["output"].clone();
    payload["steps"] = value["agent"]["steps"].clone();
    let mut safe =
        json!({"tool":value["agent"]["steps"][0]["tool"],"status":"verified","result":payload});
    pending.redactor.value(&mut safe);
    memory.messages.push(platform::Message {
        role: platform::Role::User,
        content: json!({"untrustedToolResults":[safe]}).to_string(),
    });
    memory.changes += 1;
    memory.resume_ready = true;
}
#[allow(clippy::await_holding_refcell_ref)]
async fn finish_operation(
    context: Context,
    pending: Pending,
    result: Result<(Value, Status), Error>,
    info: &Value,
) -> Result<Value, Error> {
    let cell = pending.memory.clone();
    let mut memory = cell.borrow_mut();
    match result {
        Ok((mut value, Status::Succeeded)) => {
            if let Err(error) = memory
                .resources
                .close_documents(&context.with_bindings(vec![]))
                .await
            {
                let result=close_memory(&context,&mut memory,Ok((json!({"success":false,"output":format!("操作已提交，旧文档释放失败：{}",pending.redactor.text(&error.message()))}),Status::Unverified))).await;
                if !memory.cleanup_failed {
                    STATE.with_borrow_mut(|s| {
                        s.sessions.remove(&pending.root);
                    });
                }
                return task_finish(&pending.root, result, now(info));
            }
            memory.evidence.clear();
            observe_change(&pending, &mut memory, &value);
            value["continuation"] = json!(true);
            value["task"] = json!(task_update(&pending.root, Status::Running, now(info))?);
            Ok(value)
        }
        other => {
            let result = close_memory(&context, &mut memory, other).await;
            if !memory.cleanup_failed {
                STATE.with_borrow_mut(|s| {
                    s.sessions.remove(&pending.root);
                });
            }
            task_finish(&pending.root, result, now(info))
        }
    }
}
async fn execute(context: Context, request: ExecuteInput, info: Value) -> Result<Value, Error> {
    if !request.confirmed {
        return Err(Error::Validation("请先确认完整计划"));
    }
    let plan = STATE.with_borrow_mut(|s| {
        let plan = s.plans.get(&request.proposal_id).ok_or(Error::NotFound)?;
        if plan.pending.scope != scope(&info)? {
            return Err(Error::NotFound);
        }
        if plan.confirmation != request.change_confirmation {
            return Err(Error::Validation("计划确认参数无效"));
        }
        s.plans.remove(&request.proposal_id).ok_or(Error::NotFound)
    })?;
    let Plan { pending, work, .. } = plan;
    task_update(&pending.root, Status::Executing, now(&info))?;
    STATE.with_borrow_mut(|s| s.tasks.detach(&pending.root))?;
    let bound = context.with_bindings(pending.bindings.clone());
    if let Work::Job(plan) = work {
        let root = pending.root.clone();
        let result = start_job(&bound, &pending, plan, &request.proposal_id).await;
        if let Err(error) = result {
            return finish_operation(
                context,
                pending,
                Ok((
                    json!({"success":false,"output":error.message()}),
                    Status::Unverified,
                )),
                &info,
            )
            .await;
        }
        return poll_job(context, &root, &info).await;
    }
    let approved = async {
        let operations = plan_operations(&work, &pending)?;
        bound
            .request(platform::Request::ConfirmOperations { operations })
            .await?;
        Ok::<_, Error>(())
    }
    .await;
    if let Err(error) = approved {
        return finish_operation(context, pending, Err(error), &info).await;
    }
    let result = match work {
        Work::Operations(steps) => {
            execute_operations(context.clone(), &pending, &steps, &info).await
        }
        Work::File(file) => {
            let result = files::save(&bound, &file).await;
            let (tool_status, status, message) = match result {
                Ok(()) => (
                    ToolStatus::Verified,
                    Status::Succeeded,
                    "文件已原子保存并完成真实复查".into(),
                ),
                Err(Error::Platform(e)) if e.code == "USER_CANCELLED" => {
                    (ToolStatus::Skipped, Status::Cancelled, e.message)
                }
                Err(error) => (
                    ToolStatus::Unverified,
                    Status::Unverified,
                    format!("保存未确认：{}；停止后续变更", error.message()),
                ),
            };
            let step = AgentStepResult {
                action: file.public.action,
                target: file.public.target,
                result: ToolResult {
                    tool: tools::ToolId::FileEdit,
                    status: tool_status,
                    message: Some(message.clone()),
                },
            };
            Ok((
                json!({"success":status==Status::Succeeded,"output":message,"agent":{"steps":[step]}}),
                status,
            ))
        }
        Work::Transfer(preview) => {
            let root = pending.root.clone();
            STATE.with_borrow_mut(|s| {
                s.copies.insert(
                    root.clone(),
                    ActiveCopy {
                        pending: pending.clone(),
                        scope: pending.scope.clone(),
                        proposal_id: request.proposal_id,
                        preview: preview.clone(),
                    },
                );
            });
            match files::begin_transfer(&bound, &preview.id).await {
                Ok(_) => return poll_copy(context, &root, &info).await,
                Err(error) => {
                    STATE.with_borrow_mut(|s| {
                        s.copies.remove(&root);
                    });
                    Err(error)
                }
            }
        }
        Work::Job(_) => Err(Error::Validation("独立工具未进入任务路由")),
    };
    finish_operation(context, pending, result, &info).await
}
#[allow(clippy::await_holding_refcell_ref)]
async fn start_job(
    context: &Context,
    pending: &Pending,
    plan: jobs::Plan,
    proposal_id: &str,
) -> Result<(), Error> {
    let mut memory = pending.memory.borrow_mut();
    memory.active_job = Some((plan.id.clone(), proposal_id.into()));
    memory.jobs.start(context, plan).await?;
    Ok(())
}
fn plan_operations(
    work: &Work,
    pending: &Pending,
) -> Result<Vec<platform::ApprovalOperation>, Error> {
    let mut operations = std::collections::BTreeMap::<String, platform::ApprovalOperation>::new();
    let mut add = |request: platform::Request| -> Result<(), Error> {
        let key = serde_json::to_string(&request).map_err(|e| Error::Worker(Box::new(e)))?;
        if let Some(operation) = operations.get_mut(&key) {
            operation.count += 1;
        } else {
            operations.insert(
                key,
                platform::ApprovalOperation {
                    request: Box::new(request),
                    count: 1,
                },
            );
        }
        Ok(())
    };
    match work {
        Work::Job(_) => return Err(Error::Validation("独立长任务使用宿主命令流审批")),
        Work::Operations(steps) => {
            for step in steps {
                add(platform::Request::Execute {
                    host_id: pending.operation_host.clone(),
                    command: step.read.platform_command()?,
                })?;
                add(platform::Request::Execute {
                    host_id: pending.operation_host.clone(),
                    command: Command::script(guarded_command(step)?),
                })?;
                add(platform::Request::Execute {
                    host_id: pending.operation_host.clone(),
                    command: agent::verification_request(step).platform_command()?,
                })?;
            }
        }
        Work::File(file) => add(platform::Request::SaveFile {
            document_id: file.document_id.clone(),
            content: file.content.to_string(),
        })?,
        Work::Transfer(preview) => add(platform::Request::TransferStart {
            id: preview.id.clone(),
        })?,
    }
    Ok(operations.into_values().collect())
}

#[allow(clippy::await_holding_refcell_ref)]
async fn poll_job(context: Context, root: &str, info: &Value) -> Result<Value, Error> {
    let pending = STATE.with_borrow(|s| {
        s.sessions
            .get(root)
            .filter(|p| p.scope == scope(info).unwrap_or(""))
            .cloned()
    });
    if let Some(pending) = pending {
        let cell = pending.memory.clone();
        let mut memory = cell.borrow_mut();
        if let Some((job_id, proposal_id)) = memory.active_job.clone() {
            let bound = context.with_bindings(pending.bindings.clone());
            let result = memory.jobs.poll(&bound, &job_id, &pending.redactor).await;
            let step = memory.jobs.step(&job_id)?;
            let tool = memory.jobs.tool(&job_id)?;
            match result {
                Ok(None) => {
                    return Ok(
                        json!({"pending":true,"success":false,"jobId":job_id,"proposalId":proposal_id,"output":"工具任务运行中","task":STATE.with_borrow(|s|s.tasks.get(root,scope(info)?).map(|t|t.snapshot.clone()))?}),
                    );
                }
                Ok(Some(result)) => {
                    memory.active_job = None;
                    if let Err(error) = memory
                        .resources
                        .close_documents(&context.with_bindings(vec![]))
                        .await
                    {
                        let result=close_memory(&context,&mut memory,Ok((json!({"success":false,"output":format!("工具已执行，旧文档释放失败：{}",pending.redactor.text(&error.message()))}),Status::Unverified))).await;
                        if !memory.cleanup_failed {
                            STATE.with_borrow_mut(|s| {
                                s.sessions.remove(root);
                            });
                        }
                        return task_finish(root, result, now(info));
                    }
                    memory.evidence.clear();
                    let mut value = json!({"pending":false,"success":true,"jobId":job_id,"proposalId":proposal_id,"output":result["output"],"result":result,"agent":{"steps":[AgentStepResult{action:step.action,target:step.target,result:ToolResult{tool,status:ToolStatus::Verified,message:Some("工具已完成并核对结果".into())}}]}});
                    observe_change(&pending, &mut memory, &value);
                    value["continuation"] = json!(true);
                    value["task"] = json!(task_update(root, Status::Running, now(info))?);
                    return Ok(value);
                }
                Err(error) => {
                    let value = json!({"success":false,"pending":false,"output":pending.redactor.text(&error.message()),"agent":{"steps":[AgentStepResult{action:step.action,target:step.target,result:ToolResult{tool,status:ToolStatus::Unverified,message:Some(pending.redactor.text(&error.message()))}}]}});
                    let result =
                        close_memory(&context, &mut memory, Ok((value, Status::Unverified))).await;
                    if !memory.cleanup_failed {
                        STATE.with_borrow_mut(|s| {
                            s.sessions.remove(root);
                        });
                    }
                    return task_finish(root, result, now(info));
                }
            }
        }
    }
    poll_copy(context, root, info).await
}
#[allow(clippy::await_holding_refcell_ref)]
async fn cancel_task(context: Context, root: &str, info: &Value) -> Result<Value, Error> {
    let pending = STATE.with_borrow(|s| {
        s.sessions
            .get(root)
            .filter(|p| p.scope == scope(info).unwrap_or(""))
            .cloned()
    });
    if let Some(pending) = pending {
        let mut memory = pending.memory.borrow_mut();
        let snapshot =
            STATE.with_borrow(|s| s.tasks.get(root, scope(info)?).map(|t| t.snapshot.clone()))?;
        let status = if snapshot.status.terminal() {
            snapshot.status
        } else if memory.changes > 0
            || matches!(
                snapshot.status,
                Status::Executing | Status::Transferring | Status::Verifying
            )
        {
            Status::Unverified
        } else {
            Status::Cancelled
        };
        let result=close_memory(&context,&mut memory,Ok((json!({"success":false,"pending":false,"output":"任务已停止；已提交变更不回滚，请核对实际状态"}),status))).await;
        STATE.with_borrow_mut(|s| {
            if !memory.cleanup_failed {
                s.sessions.remove(root);
            }
            s.copies.remove(root);
            s.plans.retain(|_, p| p.pending.root != root);
            s.previews.remove(root);
        });
        return task_finish(root, result, now(info));
    }
    STATE.with_borrow_mut(|s| {
        if let Some(p) = s.previews.get(root)
            && p.scope != scope(info).unwrap_or("")
        {
            return Err(Error::NotFound);
        }
        s.previews.remove(root);
        s.plans
            .retain(|_, p| p.pending.scope != scope(info).unwrap_or("") || p.pending.root != root);
        if s.tasks.get(root, scope(info)?).is_ok() {
            s.tasks.cancel(root, scope(info)?, now(info))?;
        }
        Ok(())
    })?;
    Ok(Value::Null)
}

async fn poll_copy(context: Context, root: &str, info: &Value) -> Result<Value, Error> {
    if let Some(value) = STATE.with_borrow(|s| {
        s.executions
            .get(root)
            .filter(|(owner, _)| Some(owner.as_str()) == info["scope"].as_str())
            .map(|(_, value)| value.clone())
    }) {
        return close_finished_copy(&context, root, value).await;
    }
    let (preview, proposal_id) = STATE.with_borrow(|s| {
        let copy = s
            .copies
            .get(root)
            .filter(|copy| copy.scope == scope(info).unwrap_or(""))
            .ok_or(Error::NotFound)?;
        Ok::<_, Error>((copy.preview.clone(), copy.proposal_id.clone()))
    })?;
    let state = match files::transfer_state(&context, &preview.id).await {
        Ok(state) => state,
        Err(Error::Platform(error))
            if ["BUSY", "PLUGIN_BUSY", "PLUGIN_RATE_LIMIT"].contains(&error.code.as_str()) =>
        {
            return Err(error.into());
        }
        Err(error) => platform::TransferState {
            id: preview.id.clone(),
            state: "unverified".into(),
            total_bytes: preview.bytes,
            transferred_bytes: 0,
            bytes_per_second: 0,
            sha256: None,
            message: Some(format!(
                "无法读取传输实际结果：{}；请独立核对",
                error.message()
            )),
            recovery_paths: vec![],
        },
    };
    let pending = matches!(
        state.state.as_str(),
        "queued" | "scanning" | "running" | "verifying" | "cancelling"
    );
    let (tool_status, mut status) = match state.state.as_str() {
        "completed"
            if state.sha256.as_ref().is_some_and(|hash| {
                hash.len() == 64 && hash.bytes().all(|c| c.is_ascii_hexdigit())
            }) =>
        {
            (ToolStatus::Verified, Status::Succeeded)
        }
        "cancelled" => (ToolStatus::Skipped, Status::Cancelled),
        "failed" => (ToolStatus::Failed, Status::Failed),
        "verifying" => (ToolStatus::Running, Status::Verifying),
        _ if pending => (ToolStatus::Running, Status::Transferring),
        _ => (ToolStatus::Unverified, Status::Unverified),
    };
    let step = files::transfer_step(&preview);
    let message = state.message.clone().unwrap_or_else(|| {
        if pending {
            "传输已启动；可查看进度或取消，不自动重放".into()
        } else {
            "传输结果见实际状态，请核对".into()
        }
    });
    let mut value = json!({"success":status==Status::Succeeded,"pending":pending,"output":message,"transfer":state,"proposalId":proposal_id,"agent":{"steps":[AgentStepResult {action:step.action,target:step.target,result:ToolResult {tool:tools::ToolId::Transfer,status:tool_status,message:Some(message)}}]}});
    if pending {
        return task_finish(root, Ok((value, status)), now(info));
    }
    let task_pending = STATE
        .with_borrow(|s| s.copies.get(root).map(|copy| copy.pending.clone()))
        .ok_or(Error::NotFound)?;
    if status == Status::Succeeded {
        let artifact = task_pending
            .memory
            .borrow_mut()
            .jobs
            .record_transfer(&preview, &state);
        match artifact {
            Ok(artifact) => value["result"] = artifact,
            Err(error) => {
                status = Status::Unverified;
                let message = task_pending.redactor.text(&error.message());
                let code = match &error {
                    Error::Platform(error) => error.code.as_str(),
                    _ => "ARTIFACT_UNVERIFIED",
                };
                value["success"] = json!(false);
                value["output"] = json!(message);
                value["result"] = json!({"code":code,"message":message});
                value["agent"]["steps"][0]["status"] = json!("unverified");
                value["agent"]["steps"][0]["message"] = json!(message);
            }
        }
    }
    value = close_finished_copy(&context, root, value).await?;
    let result = finish_operation(context, task_pending, Ok((value, status)), info).await?;
    STATE.with_borrow_mut(|s| {
        s.executions.insert(
            root.into(),
            (scope(info).unwrap_or("").into(), result.clone()),
        );
    });
    Ok(result)
}

async fn close_finished_copy(
    context: &Context,
    root: &str,
    mut value: Value,
) -> Result<Value, Error> {
    let id = STATE.with_borrow(|s| s.copies.get(root).map(|copy| copy.preview.id.clone()));
    if let Some(id) = id {
        match context
            .request(platform::Request::TransferClose { id })
            .await
        {
            Ok(_) => {
                STATE.with_borrow_mut(|s| s.copies.remove(root));
            }
            Err(error) if error.code == "NOT_FOUND" => {
                STATE.with_borrow_mut(|s| s.copies.remove(root));
            }
            Err(error) => {
                value["output"] = json!(format!(
                    "{}；传输结果已保留，资源释放失败：{}",
                    value["output"].as_str().unwrap_or("传输结束"),
                    error.message
                ));
            }
        }
    }
    Ok(value)
}

async fn execute_operations(
    context: Context,
    pending: &Pending,
    steps: &[PlannedStep],
    info: &Value,
) -> Result<(Value, Status), Error> {
    let client = Host {
        context: context.with_bindings(pending.bindings.clone()),
        id: pending.operation_host.clone(),
    };
    let task_id = pending.root.clone();
    let mut results = vec![];
    let mut stopped = false;
    for step in steps {
        let outcome = if stopped {
            (
                ToolStatus::Skipped,
                "前序结果未确认或任务已停止，未执行此项".into(),
            )
        } else {
            let work = async {
                let stamp = client.context.info().await?;
                if now(&stamp).saturating_sub(now(info)) >= 100000 {
                    return Err(Error::Validation("计划达到执行时限"));
                }
                // Revalidation remains a real platform request, including original bindings.
                if !results.is_empty() {
                    task_update(&task_id, Status::Executing, now(&stamp))?;
                }
                let before = tools::query(&client, step.read.clone()).await?;
                if agent::fingerprint(&step.request, &before)? != step.before {
                    return Err(Error::Validation(
                        "目标状态自生成计划后已变化，请重新查询确认",
                    ));
                }
                let command = guarded_command(step)?;
                let applied = client
                    .context
                    .execute(&client.id, Command::script(command))
                    .await
                    .and_then(|r| r.checked());
                match applied {
                    Err(error) => Ok((
                        ToolStatus::Unverified,
                        format!(
                            "操作结果未确认：{}；请独立核对，停止后续操作",
                            error.message
                        ),
                    )),
                    Ok(_) => {
                        task_update(&task_id, Status::Verifying, now(&stamp))?;
                        match tools::query(&client, agent::verification_request(step)).await {
                            Ok(after) if agent::verified(step, &after) => {
                                Ok((ToolStatus::Verified, "已执行并复查目标状态".into()))
                            }
                            Ok(_) => Ok((
                                ToolStatus::Unverified,
                                "操作已提交，复查状态不符合预期，请独立核对".into(),
                            )),
                            Err(error) => Ok((
                                ToolStatus::Unverified,
                                format!("操作已提交，复查失败：{}", error.message()),
                            )),
                        }
                    }
                }
            }
            .await;
            match work {
                Ok(result) => result,
                Err(error) => (ToolStatus::Failed, error.message()),
            }
        };
        stopped |= outcome.0 != ToolStatus::Verified;
        results.push(AgentStepResult {
            action: step.public.action.clone(),
            target: step.public.target.clone(),
            result: ToolResult {
                tool: tools::change_id(&step.request)?,
                status: outcome.0,
                message: Some(pending.redactor.text(&outcome.1)),
            },
        });
    }
    let success = results
        .iter()
        .all(|r| r.result.status == ToolStatus::Verified);
    let status = if results
        .iter()
        .any(|r| r.result.status == ToolStatus::Unverified)
    {
        Status::Unverified
    } else if success {
        Status::Succeeded
    } else {
        Status::Failed
    };
    Ok((
        json!({"success":success,"output":if success{format!("已执行并复查 {} 项操作。",results.len())}else{"计划未全部完成，请核对逐项结果；未自动重试。".into()},"agent":{"steps":results}}),
        status,
    ))
}

async fn sample(client: &Host) -> Result<crate::metrics_types::Sample, Error> {
    let script = include_str!("metrics.sh").replace("\r\n", "\n");
    let mut processor = crate::metrics::Processor::default();
    let first = client
        .context
        .execute(&client.id, Command::script(script.clone()))
        .await?
        .checked()?;
    let time = client.context.info().await?;
    processor
        .ingest(first.stdout.as_bytes(), now(&time))
        .map_err(Error::Validation)?;
    let second = client
        .context
        .execute(&client.id, Command::script(format!("sleep 0.25;{script}")))
        .await?
        .checked()?;
    let time = client.context.info().await?;
    processor
        .ingest(second.stdout.as_bytes(), now(&time))
        .map_err(Error::Validation)
}

fn guarded_command(step: &PlannedStep) -> Result<String, Error> {
    match &step.request {
        Request::ImageRemove { id, .. } => {
            ops::image_id(id)?;
            let arg = ops::quote(id)?;
            Ok(format!(
                "{}sd_tags=$(d image inspect --format '{{{{len .RepoTags}}}}' {arg}) || exit $?; if test \"$sd_tags\" != 0; then printf '镜像已新增标签，计划已失效' >&2; exit 65; fi; d image rm --no-prune {arg}",
                ops::PRELUDE
            ))
        }
        Request::ContainerAction { id, .. } => {
            ops::container_id(id)?;
            let state = &step.before["state"];
            let status = state["Status"]
                .as_str()
                .ok_or(Error::Validation("容器状态缺失"))?;
            let started = state["StartedAt"]
                .as_str()
                .ok_or(Error::Validation("容器启动时间缺失"))?;
            let pid = state["Pid"]
                .as_i64()
                .ok_or(Error::Validation("容器进程身份缺失"))?;
            let expected = format!("{status}|{started}|{pid}");
            let read = format!(
                "d container inspect --format '{{{{.State.Status}}}}|{{{{.State.StartedAt}}}}|{{{{.State.Pid}}}}' {}",
                ops::quote(id)?
            );
            Ok(format!(
                "{}sd_state=$({read}) || exit $?; if test \"$sd_state\" != {}; then printf '容器状态在审批期间已变化，请重新查询' >&2; exit 65; fi; {}",
                ops::PRELUDE,
                ops::quote(&expected)?,
                step.request.command()?
            ))
        }
        Request::ServiceAction { .. } => {
            let expected = step.before["_stateGuard"]
                .as_str()
                .ok_or(Error::Validation("服务状态快照缺失"))?;
            let read = step.read.command()?;
            Ok(format!(
                "{}sd_state=$({read}) || exit $?; if test \"$sd_state\" != {}; then printf '服务状态在审批期间已变化，请重新查询' >&2; exit 65; fi; {}",
                ops::PRELUDE,
                ops::quote(expected)?,
                step.request.command()?
            ))
        }
        _ => Err(Error::Validation("计划包含未开放的变更")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serverdeck_plugin_sdk::{ApiError, backend::Runtime};
    struct Platform {
        sequence: u64,
        scope: String,
        model_calls: usize,
        commands: Vec<String>,
        images: Vec<Value>,
        removed: bool,
        cancel_mutation: bool,
        decision: Option<Value>,
        assets: Vec<Value>,
        containers: Vec<Value>,
        context_window: u64,
        failed_host: Option<String>,
        at: u64,
        reject_bindings: bool,
        decisions: Vec<Value>,
        started: bool,
        composed: bool,
        composed_reference: String,
        calls: Vec<Value>,
        streams: HashMap<String, (String, String, usize)>,
        transfer_started: bool,
        transfer_finished: bool,
        fail_save: bool,
        fail_load: bool,
        fail_cleanup: bool,
        fail_transfer_close: bool,
        corrupt_hash: bool,
        changed_archive: bool,
        transfer_polls: usize,
        prepare_failure: Option<String>,
        prepare_failures: usize,
        file_content: String,
        file_reads: usize,
    }
    impl Default for Platform {
        fn default() -> Self {
            Self {
                sequence: 0,
                scope: "owner-a".into(),
                model_calls: 0,
                commands: vec![],
                images: vec![json!({"ID":"a".repeat(64),"Tag":"<none>"})],
                removed: false,
                cancel_mutation: false,
                decision: None,
                assets: vec![],
                containers: vec![],
                context_window: 131072,
                failed_host: None,
                at: 100000,
                reject_bindings: false,
                decisions: vec![],
                started: false,
                composed: false,
                composed_reference: "stock:v1".into(),
                calls: vec![],
                streams: HashMap::new(),
                transfer_started: false,
                transfer_finished: false,
                fail_save: false,
                fail_load: false,
                fail_cleanup: false,
                fail_transfer_close: false,
                corrupt_hash: false,
                changed_archive: false,
                transfer_polls: 0,
                prepare_failure: None,
                prepare_failures: 0,
                file_content: "old\n".into(),
                file_reads: 0,
            }
        }
    }
    impl Platform {
        fn action(&mut self, runtime: &mut Runtime, action: &str, input: Value) -> Value {
            let mut reply = runtime.handle(6, json!({"action":action,"input":input}));
            for _ in 0..96 {
                if reply["error"].is_object() || reply["result"]["kind"] != "host_call" {
                    return reply;
                }
                let wire = &reply["result"]["request"];
                assert_eq!(wire["operation"]["kind"], "platform");
                let request = &wire["operation"]["request"];
                let result = if self.reject_bindings
                    && wire["operation"]["bindings"]
                        .as_array()
                        .is_some_and(|b| !b.is_empty())
                {
                    Err(ApiError::new("PLUGIN_TARGET_CHANGED", "测试绑定已失效"))
                } else {
                    self.respond(request)
                };
                reply=runtime.handle(7,json!({"hostResponse":{"requestId":wire["requestId"],"result":result.as_ref().ok(),"error":result.err()}}));
            }
            panic!("unbounded action")
        }
        fn respond(&mut self, request: &Value) -> Result<Value, ApiError> {
            self.calls.push(request.clone());
            match request["kind"].as_str().unwrap() {
                "approval_mode" => Ok(json!({"binding":"approval-mode-binding","mode":"assist"})),
                "confirm_operations" => Ok(Value::Null),
                "info" => {
                    self.sequence += 1;
                    Ok(
                        json!({"unixMs":self.at,"scope":self.scope,"nonce":format!("{:036x}",self.sequence)}),
                    )
                }
                "model" => Ok(
                    json!({"model":{"id":"model","revision":"r1","config":{"model":"fixture","baseUrl":"fixture://model","maxOutputTokens":2048,"contextWindowTokens":self.context_window}},"binding":"model-binding"}),
                ),
                "host" => {
                    let host = self
                        .assets
                        .iter()
                        .find(|host| host["id"] == request["hostId"]);
                    let host = host.map(|host| json!({"id":host["id"],"name":host["name"],"hostname":host["hostname"],"port":host["port"],"username":host["username"]}))
                        .unwrap_or_else(|| json!({"id":request["hostId"],"name":"fixture"}));
                    Ok(json!({"host":host,"binding":"host-binding"}))
                }
                "hosts" => Ok(json!({"hosts":self.assets,"groups":[]})),
                "stream_open" => {
                    let id = format!("stream-{}", self.streams.len());
                    let mut script = request["command"]["args"][1].as_str().unwrap().to_owned();
                    if let Some(nonce) = request["command"]["args"].get(3).and_then(Value::as_str) {
                        script = script.replace(
                            "SD_ARCHIVE_PREPARED:%s",
                            &format!("SD_ARCHIVE_PREPARED:{nonce}"),
                        );
                    }
                    self.streams.insert(
                        id.clone(),
                        (request["hostId"].as_str().unwrap().into(), script, 0),
                    );
                    Ok(json!({"id":id}))
                }
                "stream_poll" => {
                    let (host, command, polls) = self
                        .streams
                        .get_mut(request["streamId"].as_str().unwrap())
                        .unwrap();
                    *polls += 1;
                    if command.contains("SD_JOB_EXIT:") {
                        let nonce = command
                            .split("SD_JOB_EXIT:")
                            .nth(1)
                            .unwrap()
                            .split(':')
                            .next()
                            .unwrap();
                        use base64::Engine as _;
                        return Ok(
                            json!({"events":[{"type":"data","stream":"stdout","dataBase64":base64::engine::general_purpose::STANDARD.encode(format!("fixture output\nSD_JOB_EXIT:{nonce}:0\n"))}]}),
                        );
                    }
                    let nonce = command
                        .split("SD_ARCHIVE_PREPARED:")
                        .nth(1)
                        .unwrap()
                        .split('\\')
                        .next()
                        .unwrap();
                    let fail = if host == "source" {
                        self.fail_save
                    } else {
                        self.fail_load && self.transfer_finished
                    };
                    if fail {
                        return Ok(
                            json!({"events":[{"type":"state","state":"failed","message":"fixture Docker failed"}]}),
                        );
                    }
                    let ready = if host == "source" {
                        *polls > 1
                    } else {
                        self.transfer_finished
                    };
                    use base64::Engine as _;
                    let marker = format!(
                        "SD_ARCHIVE_PREPARED:{nonce}\n{}",
                        if ready {
                            format!(
                                "{}SD_ARCHIVE_READY:{nonce}\n",
                                if host == "source" {
                                    format!("SD_ARCHIVE_SHA256:{nonce}:{}\n", "c".repeat(64))
                                } else {
                                    String::new()
                                }
                            )
                        } else {
                            String::new()
                        }
                    );
                    Ok(
                        json!({"events":[{"type":"data","stream":"stdout","dataBase64":base64::engine::general_purpose::STANDARD.encode(marker)}]}),
                    )
                }
                "stream_stop" => {
                    if self.fail_cleanup {
                        self.fail_cleanup = false;
                        return Err(ApiError::new("CLEANUP_FAILED", "fixture cleanup failed"));
                    }
                    Ok(Value::Null)
                }
                "read_file" => {
                    self.file_reads += 1;
                    Ok(
                        json!({"id":format!("document-{}",self.file_reads),"path":request["path"],"content":self.file_content,"sha256":"d".repeat(64),"atomicSave":true,"permissions":384}),
                    )
                }
                "save_file" => {
                    self.file_content = request["content"].as_str().unwrap().into();
                    Ok(json!({"saved":true,"document":null,"recoveryPath":null,"message":null}))
                }
                "close_file" => Ok(Value::Null),
                "transfer_prepare" => {
                    if let Some(code) = self.prepare_failure.take() {
                        self.prepare_failures += 1;
                        return Err(ApiError::new(code, "传输目标目录不存在；请填写已有目录"));
                    }
                    let source = request["source"]["path"].as_str().unwrap();
                    let path = format!(
                        "{}/{}",
                        request["destination"]["path"]
                            .as_str()
                            .unwrap()
                            .trim_end_matches('/'),
                        source.rsplit('/').next().unwrap()
                    );
                    Ok(
                        json!({"id":"image-copy","source":request["source"],"destination":{"hostId":request["destination"]["hostId"],"path":path},"bytes":1024,"overwrite":false,"targetExists":false}),
                    )
                }
                "transfer_start" | "transfer_status" => {
                    if request["kind"] == "transfer_start" {
                        self.transfer_started = true;
                    } else {
                        self.transfer_polls += 1;
                        self.transfer_finished = self.transfer_polls > 1;
                    }
                    Ok(
                        json!({"id":"image-copy","state":if self.transfer_finished {"completed"} else {"running"},"totalBytes":1024,"transferredBytes":if self.transfer_finished {1024} else {0},"bytesPerSecond":0,"sha256":if self.transfer_finished && !self.corrupt_hash {json!(if self.changed_archive {"d".repeat(64)} else {"c".repeat(64)})} else {Value::Null},"message":null,"recoveryPaths":[]}),
                    )
                }
                "transfer_close" => {
                    if self.fail_transfer_close {
                        return Err(ApiError::new("DRAIN_FAILED", "transfer drain failed"));
                    }
                    Ok(Value::Null)
                }
                "model_complete" => {
                    self.model_calls += 1;
                    if self.composed {
                        let observations = request["messages"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .filter_map(|m| {
                                m["content"]
                                    .as_str()
                                    .and_then(|s| serde_json::from_str::<Value>(s).ok())
                            })
                            .flat_map(|v| {
                                v["untrustedToolResults"]
                                    .as_array()
                                    .cloned()
                                    .unwrap_or_default()
                            })
                            .collect::<Vec<_>>();
                        let latest = observations.last().cloned().unwrap_or(Value::Null);
                        let artifact = observations
                            .iter()
                            .rev()
                            .find_map(|v| v["result"]["artifactId"].as_str())
                            .unwrap_or("");
                        let archive = observations
                            .iter()
                            .rev()
                            .find_map(|v| v["result"]["archiveId"].as_str())
                            .unwrap_or("");
                        let phase = self.model_calls - self.prepare_failures;
                        let decision = match phase {
                            1 => {
                                json!({"kind":"query","requests":[{"kind":"host_query","hostId":"source","query":{"kind":"images"}}]})
                            }
                            2 if self.images.len() != 1 => {
                                json!({"kind":"clarify","text":"请选择实际存在的镜像及标签"})
                            }
                            2 => {
                                json!({"kind":"plan","summary":"导出已查询的镜像","actions":[{"kind":"image_save","hostId":"source","id":"a".repeat(64),"reference":self.composed_reference}]})
                            }
                            3 => {
                                json!({"kind":"query","requests":[{"kind":"transfer_prepare","source":{"kind":"artifact","artifactId":archive},"destination":{"hostId":"destination","path":if self.prepare_failure.is_some() {"/tmp/new-image.tar"} else {"/tmp"}},"overwrite":false}]})
                            }
                            4 => {
                                json!({"kind":"plan","summary":"传输真实归档","actions":[{"kind":"transfer","previewId":latest["result"]["id"]}]})
                            }
                            5 => {
                                json!({"kind":"query","requests":[{"kind":"host_query","hostId":"destination","query":{"kind":"images"}}]})
                            }
                            6 => {
                                json!({"kind":"plan","summary":"导入已校验归档并核对镜像","actions":[{"kind":"image_load","hostId":"destination","artifactId":artifact,"id":"a".repeat(64),"reference":self.composed_reference}]})
                            }
                            _ => {
                                json!({"kind":"answer","outcome":"completed","text":"镜像导入及ID、标签复查已完成"})
                            }
                        };
                        return Ok(
                            json!({"text":decision.to_string(),"usage":null,"incomplete":false}),
                        );
                    }

                    let value = if let Some(value) = self.decisions.get(self.model_calls - 1) {
                        value.clone()
                    } else if let Some(value) = self.decision.clone() {
                        value
                    } else if self.model_calls == 1 {
                        json!({"kind":"query","requests":[{"kind":"images"}]})
                    } else if self.model_calls == 2 {
                        json!({"kind":"plan","summary":"清理已查询的无标签镜像","actions":[{"kind":"remove_untagged_images"}]})
                    } else {
                        json!({"kind":"answer","outcome":"completed","text":"执行和复查完成"})
                    };
                    Ok(
                        json!({"text":value.to_string(),"usage":{"inputTokens":10,"outputTokens":2},"incomplete":false}),
                    )
                }
                "execute" => {
                    let command = request["command"]["args"][1].as_str().unwrap().to_owned();
                    self.commands.push(command.clone());
                    if request["hostId"].as_str() == self.failed_host.as_deref() {
                        return Err(ApiError::new("SSH_FIXTURE", "测试主机查询失败"));
                    }
                    if command.contains("d image rm") {
                        if self.cancel_mutation {
                            return Err(ApiError::new("USER_CANCELLED", "用户取消"));
                        }
                        self.removed = true;
                    }
                    if command.contains("d container start")
                        || command.contains("--no-pager start --")
                    {
                        self.started = true;
                    }
                    let output = if command.contains("d container inspect") {
                        json!({"Id":"a".repeat(64),"State":{"Status":if self.started {"running"} else {"exited"},"Running":self.started,"StartedAt":if self.started {"new"} else {"old"},"Pid":if self.started {42} else {0}}}).to_string()
                    } else if command.contains("show --property=") {
                        format!(
                            "Id=app.service\nLoadState=loaded\nActiveState={}\nUnitFileState=enabled\nMainPID={}\nActiveEnterTimestamp={}\n",
                            if self.started { "active" } else { "inactive" },
                            if self.started { 42 } else { 0 },
                            if self.started { "new" } else { "old" }
                        )
                    } else if command.contains("d container ls") {
                        self.containers
                            .iter()
                            .map(Value::to_string)
                            .collect::<Vec<_>>()
                            .join("\n")
                    } else if command.contains("d image ls")
                        && !self.removed
                        && !(self.composed && request["hostId"] == "destination")
                    {
                        self.images
                            .iter()
                            .map(Value::to_string)
                            .collect::<Vec<_>>()
                            .join("\n")
                    } else {
                        String::new()
                    };
                    Ok(
                        json!({"state":"completed","exitCode":0,"stdout":output,"stderr":"","message":null,"truncated":false}),
                    )
                }
                other => panic!("unexpected platform primitive: {other}"),
            }
        }
    }
    fn prepare(platform: &mut Platform, runtime: &mut Runtime) -> String {
        STATE.with_borrow_mut(|s| *s = State::default());
        let response=platform.action(runtime,"prepare",json!({"modelId":"model","sessionId":null,"sessionIds":["host"],"question":"清理 Docker 无标签镜像","selection":{"server":true,"metrics":false,"processes":false,"docker":false,"log":null,"logLines":100},"maskAddresses":true,"redactValues":[],"history":[],"autoHosts":true,"expectedModelRevision":"r1"}));
        assert!(response["error"].is_null(), "{response}");
        response["result"]["value"]["id"].as_str().unwrap().into()
    }
    fn proposal(platform: &mut Platform, runtime: &mut Runtime) -> Value {
        let id = prepare(platform, runtime);
        let reply = platform.action(runtime, "send", json!({"id":id,"confirmed":true}));
        assert!(reply["error"].is_null(), "{reply}");
        reply["result"]["value"]["proposals"][0].clone()
    }
    fn context_input(hosts: Vec<String>, question: &str) -> Value {
        json!({"modelId":"model","sessionId":null,"sessionIds":hosts,"question":question,"selection":{"server":true,"metrics":false,"processes":false,"docker":false,"log":null,"logLines":100},"maskAddresses":false,"redactValues":[],"history":[],"autoHosts":true,"expectedModelRevision":"r1"})
    }
    fn preview_body(reply: &Value) -> Vec<platform::Message> {
        assert!(reply["error"].is_null(), "{reply}");
        serde_json::from_str(reply["result"]["value"]["body"].as_str().unwrap()).unwrap()
    }
    fn evidence(messages: &[platform::Message]) -> Value {
        serde_json::from_str::<Value>(&messages.last().unwrap().content).unwrap()["context"].clone()
    }
    #[test]
    fn redacts_full_values_before_summary_and_excludes_unrelated_assets() {
        STATE.with_borrow_mut(|s| *s = State::default());
        let secret = "SENSITIVE_VALUE_".repeat(30);
        let mut platform = Platform {
            assets: vec![
                json!({"id":"unrelated","name":"UNRELATED_ASSET","hostname":"unrelated.example","port":22,"username":"other"}),
            ],
            containers: vec![json!({"ID":"a".repeat(64),"Names":secret,"State":"running"})],
            ..Default::default()
        };
        let mut request = context_input(vec!["host".into()], "查看 Docker 容器数量");
        request["redactValues"] = json!([secret]);
        let reply = platform.action(&mut Runtime::new(crate::dispatch), "prepare", request);
        let messages = preview_body(&reply);
        let body = serde_json::to_string(&messages).unwrap();
        assert!(
            !body.contains("SENSITIVE_VALUE_"),
            "sensitive value was truncated before redaction"
        );
        assert!(body.contains("[REDACTED]"));
        assert!(
            !body.contains("UNRELATED_ASSET"),
            "diagnosis leaked an unrelated asset"
        );
        assert_eq!(
            evidence(&messages)["hosts"][0]["docker"]["summary"]["total"],
            1
        );
    }
    #[test]
    fn budgets_encoded_multi_host_context_and_keeps_counts_failures_and_complete_turns() {
        STATE.with_borrow_mut(|s| *s = State::default());
        let mut platform = Platform {
            context_window: 20000,
            failed_host: Some("host-3".into()),
            containers: (0..20).map(|i| json!({"ID":format!("{i:064x}"),"Names":"quoted\"\\中文".repeat(50),"State":"running"})).collect(),
            ..Default::default()
        };
        let mut request = context_input(
            (0..8).map(|i| format!("host-{i}")).collect(),
            "查看全部主机 Docker 容器数量",
        );
        request["history"] = Value::Array((0..6).flat_map(|i| [json!({"role":"user","content":format!("旧问题{i}")}),json!({"role":"assistant","content":format!("旧回答{i} {}", "历史\"\\\n".repeat(500))})]).collect());
        let reply = platform.action(&mut Runtime::new(crate::dispatch), "prepare", request);
        let messages = preview_body(&reply);
        // The mandatory prompt now includes all 18 tools for multi-host file work.
        assert!(serde_json::to_vec(&messages).unwrap().len() + 2048 + 64 <= 20000);
        assert_eq!((messages.len() - 2) % 2, 0, "partial history turn survived");
        assert!(messages.len() < 14, "old turns were not removed");
        let context = evidence(&messages);
        assert_eq!(context["hosts"].as_array().unwrap().len(), 8);
        for (index, host) in context["hosts"].as_array().unwrap().iter().enumerate() {
            if index == 3 {
                assert_eq!(host["docker"]["available"], false);
                assert!(!host["docker"]["message"].as_str().unwrap().is_empty());
            } else {
                assert_eq!(host["docker"]["summary"]["total"], 20);
                assert_eq!(host["docker"]["summary"]["running"], 20);
                assert!(host["docker"]["omittedRecords"].as_u64().unwrap() > 0);
            }
        }
        assert!(
            !reply["result"]["value"]["warnings"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            platform.model_calls, 0,
            "budgeting unexpectedly called the model"
        );
    }
    #[test]
    fn mandatory_question_over_budget_fails_without_model_call() {
        STATE.with_borrow_mut(|s| *s = State::default());
        let mut platform = Platform {
            context_window: 4096,
            ..Default::default()
        };
        let reply = platform.action(
            &mut Runtime::new(crate::dispatch),
            "prepare",
            context_input(vec![], &"q".repeat(8000)),
        );
        assert_eq!(reply["error"]["code"], "AI_INPUT");
        assert_eq!(platform.model_calls, 0);
    }
    #[test]
    fn includes_asset_catalog_only_for_an_explicit_inventory_question() {
        STATE.with_borrow_mut(|s| *s = State::default());
        let mut platform = Platform {
            assets: vec![
                json!({"id":"catalog-host","name":"CATALOG_ENTRY","hostname":"host.example","port":22,"username":"user"}),
            ],
            ..Default::default()
        };
        let mut runtime = Runtime::new(crate::dispatch);
        let knowledge = platform.action(
            &mut runtime,
            "prepare",
            context_input(vec![], "解释 Linux 进程状态"),
        );
        assert!(evidence(&preview_body(&knowledge))["assets"].is_null());
        let inventory = platform.action(
            &mut runtime,
            "prepare",
            context_input(vec![], "列出服务器资产列表"),
        );
        let context = evidence(&preview_body(&inventory));
        assert_eq!(context["assets"]["total"], 1);
        assert_eq!(context["assets"]["records"][0]["id"], "catalog-host");
        assert_eq!(platform.model_calls, 0);
    }
    #[test]
    fn complete_evidence_single_use_confirmation_and_verified_execution() {
        let mut platform = Platform {
            images: (0..21)
                .map(|i| json!({"ID":format!("{i:064x}"),"Tag":"latest"}))
                .collect(),
            ..Default::default()
        };
        platform
            .images
            .push(json!({"ID":"a".repeat(64),"Tag":"<none>"}));
        let mut runtime = Runtime::new(crate::dispatch);
        let id = prepare(&mut platform, &mut runtime);
        let answer = platform.action(&mut runtime, "send", json!({"id":id,"confirmed":true}));
        let proposal = answer["result"]["value"]["proposals"][0].clone();
        let task = platform.action(&mut runtime, "task", json!({"id":id}));
        assert_eq!(task["result"]["value"]["status"], "awaiting_approval");
        assert!(!platform.commands.iter().any(|c| c.contains("d image rm")));
        let bad = platform.action(
            &mut runtime,
            "execute",
            json!({"proposalId":proposal["id"],"confirmed":true,"changeConfirmation":"forged"}),
        );
        assert_eq!(bad["error"]["code"], "AI_INPUT");
        let request = json!({"proposalId":proposal["id"],"confirmed":true,"changeConfirmation":proposal["changeConfirmation"]});
        let reply = platform.action(&mut runtime, "execute", request.clone());
        assert_eq!(
            reply["result"]["value"]["agent"]["steps"][0]["status"], "verified",
            "{reply}"
        );
        assert_eq!(reply["result"]["value"]["task"]["status"], "running");
        assert_eq!(reply["result"]["value"]["continuation"], true);
        let finished = platform.action(&mut runtime, "resume", json!({"id":id}));
        assert_eq!(
            finished["result"]["value"]["task"]["status"], "succeeded",
            "{finished}"
        );
        assert_eq!(
            reply["result"]["value"]["agent"]["steps"][0]["tool"],
            "remove_untagged_images"
        );
        assert_eq!(finished["result"]["value"]["usage"]["inputTokens"], 30);
        assert_eq!(finished["result"]["value"]["usage"]["outputTokens"], 6);
        assert!(platform.commands.iter().any(|c| c.contains("--no-prune")));
        assert_eq!(
            platform.action(&mut runtime, "execute", request)["error"]["code"],
            "NOT_FOUND"
        );
    }
    #[test]
    fn model_mutation_tools_retagging_and_cross_page_handles_are_rejected() {
        let mut platform = Platform {
            decision: Some(
                json!({"kind":"query","requests":[{"kind":"image_remove","id":"a".repeat(64),"confirmed":true}]}),
            ),
            ..Default::default()
        };
        let mut runtime = Runtime::new(crate::dispatch);
        let id = prepare(&mut platform, &mut runtime);
        assert_eq!(
            platform.action(&mut runtime, "send", json!({"id":id,"confirmed":true}))["error"]["code"],
            "AI_INPUT"
        );
        assert!(!platform.commands.iter().any(|c| c.contains("d image rm")));
        platform = Platform::default();
        let p = proposal(&mut platform, &mut runtime);
        platform.scope = "owner-b".into();
        let request = json!({"proposalId":p["id"],"confirmed":true,"changeConfirmation":p["changeConfirmation"]});
        assert_eq!(
            platform.action(&mut runtime, "execute", request.clone())["error"]["code"],
            "NOT_FOUND"
        );
        platform.scope = "owner-a".into();
        platform.images[0]["Tag"] = json!("new-tag");
        let result = platform.action(&mut runtime, "execute", request);
        assert_eq!(
            result["result"]["value"]["agent"]["steps"][0]["status"],
            "failed"
        );
        assert!(!platform.commands.iter().any(|c| c.contains("d image rm")));
    }
    #[test]
    fn cancelled_mutation_preserves_partial_report_and_skips_later_steps() {
        let mut platform = Platform::default();
        platform
            .images
            .push(json!({"ID":"b".repeat(64),"Tag":"<none>"}));
        platform.cancel_mutation = true;
        let mut runtime = Runtime::new(crate::dispatch);
        let p = proposal(&mut platform, &mut runtime);
        let result=platform.action(&mut runtime,"execute",json!({"proposalId":p["id"],"confirmed":true,"changeConfirmation":p["changeConfirmation"]}));
        let steps = &result["result"]["value"]["agent"]["steps"];
        assert_eq!(steps[0]["status"], "unverified");
        assert_eq!(steps[1]["status"], "skipped");
        assert_eq!(result["result"]["value"]["task"]["status"], "unverified");
        assert_eq!(
            platform
                .commands
                .iter()
                .filter(|c| c.contains("d image rm"))
                .count(),
            1
        );
    }

    #[test]
    fn full_tool_batch_is_validated_before_any_query_and_failed_task_is_readable() {
        for request in [
            json!({"kind":"container_stats","id":"not-an-id"}),
            json!({"kind":"images","confirmed":true}),
            json!({"kind":"execute","command":"reboot"}),
            json!({"kind":"image_remove","id":"a".repeat(64),"confirmed":true}),
        ] {
            let mut platform = Platform::default();
            let mut runtime = Runtime::new(crate::dispatch);
            let id = prepare(&mut platform, &mut runtime);
            platform.commands.clear();
            platform.decision =
                Some(json!({"kind":"query","requests":[{"kind":"images"},request]}));
            let reply = platform.action(&mut runtime, "send", json!({"id":id,"confirmed":true}));
            assert_eq!(reply["error"]["code"], "AI_INPUT");
            assert!(
                platform.commands.is_empty(),
                "partial query batch was executed"
            );
            let task = platform.action(&mut runtime, "task", json!({"id":id}));
            assert_eq!(task["result"]["value"]["status"], "failed");
            assert_eq!(task["result"]["value"]["hostIds"], json!(["host"]));
            assert!(!task.to_string().contains("binding"));
        }
    }

    #[test]
    fn task_owner_expiration_cancellation_and_revision_binding_are_enforced() {
        let mut platform = Platform::default();
        let mut runtime = Runtime::new(crate::dispatch);
        let id = prepare(&mut platform, &mut runtime);
        let task = platform.action(&mut runtime, "task", json!({"id":id}));
        assert_eq!(task["result"]["value"]["status"], "prepared");
        platform.scope = "other-owner".into();
        assert_eq!(
            platform.action(&mut runtime, "task", json!({"id":id}))["error"]["code"],
            "NOT_FOUND"
        );
        platform.action(&mut runtime, "cancel", json!({"id":id}));
        platform.scope = "owner-a".into();
        platform.reject_bindings = true;
        assert_eq!(
            platform.action(&mut runtime, "task", json!({"id":id}))["error"]["code"],
            "PLUGIN_TARGET_CHANGED"
        );
        platform.reject_bindings = false;
        platform.at += task::TTL_MS;
        assert_eq!(
            platform.action(&mut runtime, "task", json!({"id":id}))["result"]["value"]["status"],
            "expired"
        );
        assert_eq!(
            platform.action(&mut runtime, "send", json!({"id":id,"confirmed":true}))["error"]["code"],
            "NOT_FOUND"
        );
        assert_eq!(platform.model_calls, 0);

        platform = Platform::default();
        let id = prepare(&mut platform, &mut runtime);
        let reply = platform.action(&mut runtime, "send", json!({"id":id,"confirmed":true}));
        let p = &reply["result"]["value"]["proposals"][0];
        platform.action(&mut runtime, "cancel", json!({"id":id}));
        assert_eq!(
            platform.action(&mut runtime, "task", json!({"id":id}))["result"]["value"]["status"],
            "cancelled"
        );
        assert_eq!(platform.action(&mut runtime,"execute",json!({"proposalId":p["id"],"confirmed":true,"changeConfirmation":p["changeConfirmation"]}))["error"]["code"],"NOT_FOUND");
        assert!(!platform.commands.iter().any(|c| c.contains("d image rm")));
    }

    #[test]
    fn container_and_service_plans_still_revalidate_execute_and_verify() {
        for (query, action, tool) in [
            (
                json!({"kind":"containers"}),
                json!({"kind":"container","id":"a".repeat(64),"action":"start"}),
                "container",
            ),
            (
                json!({"kind":"service_details","scope":"system","unit":"app.service"}),
                json!({"kind":"service","scope":"system","unit":"app.service","action":"start"}),
                "service",
            ),
        ] {
            let mut platform = Platform {
                containers: vec![json!({"ID":"a".repeat(64),"State":"exited"})],
                decisions: vec![
                    json!({"kind":"query","requests":[query]}),
                    json!({"kind":"plan","summary":"启动已查询目标","actions":[action]}),
                ],
                ..Default::default()
            };
            let mut runtime = Runtime::new(crate::dispatch);
            let p = proposal(&mut platform, &mut runtime);
            assert!(!platform.started);
            let result = platform.action(&mut runtime,"execute",json!({"proposalId":p["id"],"confirmed":true,"changeConfirmation":p["changeConfirmation"]}));
            assert_eq!(
                result["result"]["value"]["agent"]["steps"][0]["status"], "verified",
                "{result}"
            );
            assert_eq!(result["result"]["value"]["agent"]["steps"][0]["tool"], tool);
            assert_eq!(result["result"]["value"]["task"]["status"], "running");
            let task_id = result["result"]["value"]["task"]["id"].clone();
            let finished = platform.action(&mut runtime, "resume", json!({"id":task_id}));
            assert_eq!(
                finished["result"]["value"]["task"]["status"], "succeeded",
                "{finished}"
            );
            assert!(platform.started);
            assert!(
                platform
                    .commands
                    .iter()
                    .any(|c| c.contains("审批期间已变化"))
            );
        }
    }
    #[test]
    fn read_results_and_empty_plans_finish_without_opening_mutation() {
        let mut platform = Platform {
            images: vec![],
            ..Default::default()
        };
        let mut runtime = Runtime::new(crate::dispatch);
        let id = prepare(&mut platform, &mut runtime);
        let reply = platform.action(&mut runtime, "send", json!({"id":id,"confirmed":true}));
        let value = &reply["result"]["value"];
        assert_eq!(value["task"]["status"], "succeeded");
        assert_eq!(platform.model_calls, 3);
        assert_eq!(value["agent"]["observations"][0]["tool"], "images");
        assert_eq!(value["agent"]["observations"][0]["status"], "succeeded");
        assert!(value["proposals"].as_array().unwrap().is_empty());
        assert!(!platform.commands.iter().any(|c| c.contains("d image rm")));
    }
    fn composed_plan(platform: &mut Platform, runtime: &mut Runtime) -> (String, Value) {
        STATE.with_borrow_mut(|s| *s = State::default());
        platform.composed = true;
        let response=platform.action(runtime,"prepare",json!({"modelId":"model","sessionId":null,"sessionIds":["source","destination"],"entryHostId":"source","question":"把stock镜像导入目标主机","selection":{"server":true,"metrics":false,"processes":false,"docker":false,"log":null,"logLines":100},"maskAddresses":false,"redactValues":[],"history":[]}));
        assert!(response["error"].is_null(), "{response}");
        let id = response["result"]["value"]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let response = platform.action(runtime, "send", json!({"id":id,"confirmed":true}));
        assert!(response["error"].is_null(), "{response}");
        (id, response["result"]["value"].clone())
    }
    fn composed_platform() -> Platform {
        Platform {
            images: vec![json!({"ID":"a".repeat(64),"Repository":"stock","Tag":"v1"})],
            ..Default::default()
        }
    }
    fn finish_phase(
        platform: &mut Platform,
        runtime: &mut Runtime,
        id: &str,
        answer: &Value,
    ) -> Value {
        let input = json!({"proposalId":answer["proposals"][0]["id"],"confirmed":true,"changeConfirmation":null});
        let mut response = platform.action(runtime, "execute", input.clone());
        for _ in 0..8 {
            assert!(response["error"].is_null(), "{response}");
            if response["result"]["value"]["pending"] != true {
                break;
            }
            response = platform.action(runtime, "poll", json!({"id":id}));
        }
        assert_eq!(
            platform.action(runtime, "execute", input)["error"]["code"],
            "NOT_FOUND"
        );
        response["result"]["value"].clone()
    }
    #[test]
    fn composes_query_save_transfer_load_without_a_skill_or_scenario_executor() {
        let mut platform = composed_platform();
        let mut runtime = Runtime::new(crate::dispatch);
        let (id, mut answer) = composed_plan(&mut platform, &mut runtime);
        assert_eq!(answer["task"]["status"], "awaiting_approval");
        assert!(platform.streams.is_empty());
        for expected in ["image_save", "transfer", "image_load"] {
            let result = finish_phase(&mut platform, &mut runtime, &id, &answer);
            assert_eq!(result["success"], true, "{result}");
            assert_eq!(result["continuation"], true);
            assert_eq!(result["agent"]["steps"][0]["tool"], expected);
            assert_eq!(result["task"]["status"], "running");
            assert!(
                !result["output"]
                    .as_str()
                    .unwrap_or("")
                    .contains("SD_ARCHIVE_")
            );
            let response = platform.action(&mut runtime, "resume", json!({"id":id}));
            assert!(response["error"].is_null(), "{response}");
            answer = response["result"]["value"].clone();
        }
        assert_eq!(answer["task"]["status"], "succeeded", "{answer}");
        assert_eq!(platform.model_calls, 7);
        assert!(platform.transfer_finished);
        assert!(!platform.calls.iter().any(|c| c["kind"] == "skill_read"));
        let calls = &platform.calls;
        let save = calls
            .iter()
            .position(|c| c["kind"] == "stream_open" && c["hostId"] == "source")
            .unwrap();
        let copy = calls
            .iter()
            .position(|c| c["kind"] == "transfer_start")
            .unwrap();
        let load = calls
            .iter()
            .position(|c| c["kind"] == "stream_open" && c["hostId"] == "destination")
            .unwrap();
        let close_copy = calls
            .iter()
            .position(|c| c["kind"] == "transfer_close")
            .unwrap();
        let source_stream = platform
            .streams
            .iter()
            .find(|(_, (host, _, _))| host == "source")
            .unwrap()
            .0;
        let close_save = calls
            .iter()
            .position(|c| c["kind"] == "stream_stop" && c["streamId"] == *source_stream)
            .unwrap();
        assert!(save < copy && copy < close_copy && close_copy < load && load < close_save);
        let load_script = calls[load]["command"]["args"][1].as_str().unwrap();
        assert!(load_script.contains("Archive changed after transfer"));
        assert!(load_script.contains("Loaded image verification failed"));
        let manifest: Value = serde_json::from_str(include_str!("../../manifest.json")).unwrap();
        let template: platform::Command =
            serde_json::from_value(manifest["assistCommands"][0].clone()).unwrap();
        let actual: platform::Command =
            serde_json::from_value(calls[load]["command"].clone()).unwrap();
        assert!(
            template.matches_argument_template(&actual),
            "verified export/copy to an empty target must match the guarded Assist template"
        );
        let mut overwrite = actual.clone();
        overwrite.args[8] = format!("sha256:{}", "b".repeat(64));
        assert!(!template.matches_argument_template(&overwrite));

        assert!(platform.action(&mut runtime, "resume", json!({"id":id}))["error"].is_object());
    }
    #[test]
    fn transfer_path_preflight_can_be_corrected_without_reexport_or_losing_the_source() {
        let mut platform = composed_platform();
        platform.prepare_failure = Some("TRANSFER_DIRECTORY_NOT_FOUND".into());
        let mut runtime = Runtime::new(crate::dispatch);
        let (id, mut answer) = composed_plan(&mut platform, &mut runtime);
        for _ in 0..3 {
            let result = finish_phase(&mut platform, &mut runtime, &id, &answer);
            assert_eq!(result["success"], true, "{result}");
            let response = platform.action(&mut runtime, "resume", json!({"id":id}));
            assert!(response["error"].is_null(), "{response}");
            answer = response["result"]["value"].clone();
        }
        assert_eq!(answer["task"]["status"], "succeeded", "{answer}");
        assert_eq!(platform.model_calls, 8);
        let calls = &platform.calls;
        let saves = calls
            .iter()
            .filter(|c| c["kind"] == "stream_open" && c["hostId"] == "source")
            .collect::<Vec<_>>();
        assert_eq!(
            saves.len(),
            1,
            "successful changes must never replay on preflight failure"
        );
        let nonce = saves[0]["command"]["args"][3].as_str().unwrap();
        let prepares = calls
            .iter()
            .filter(|c| c["kind"] == "transfer_prepare")
            .collect::<Vec<_>>();
        assert_eq!(prepares.len(), 2);
        for prepare in &prepares {
            assert_eq!(
                prepare["source"],
                json!({"kind":"remote","hostId":"source","path":format!("/tmp/serverdeck-image-{nonce}/image-{nonce}.tar")})
            );
        }
        assert_eq!(prepares[0]["destination"]["path"], "/tmp/new-image.tar");
        assert_eq!(prepares[1]["destination"]["path"], "/tmp");
        let failed_observation = calls
            .iter()
            .filter(|c| c["kind"] == "model_complete")
            .flat_map(|c| c["messages"].as_array().unwrap())
            .filter_map(|m| serde_json::from_str::<Value>(m["content"].as_str()?).ok())
            .any(|m| {
                m["untrustedToolResults"].as_array().is_some_and(|results| {
                    results.iter().any(|r| {
                        r["status"] == "failed"
                            && r["result"]["code"] == "TRANSFER_DIRECTORY_NOT_FOUND"
                            && r["result"]["message"].as_str().is_some_and(|message| {
                                message.contains(&format!(
                                    "source:/tmp/serverdeck-image-{nonce}/image-{nonce}.tar"
                                )) && message.contains("destination:/tmp/new-image.tar")
                            })
                    })
                })
            });
        assert!(
            failed_observation,
            "the model must receive the real preflight failure"
        );
        assert_eq!(
            calls
                .iter()
                .filter(|c| c["kind"] == "transfer_start")
                .count(),
            1
        );
        let first_stop = calls
            .iter()
            .position(|c| c["kind"] == "stream_stop")
            .unwrap();
        let copy_start = calls
            .iter()
            .position(|c| c["kind"] == "transfer_start")
            .unwrap();
        assert!(
            copy_start < first_stop,
            "preflight failure must keep the source stream alive"
        );
    }
    #[test]
    fn transfer_preflight_does_not_retry_permission_revision_or_cancellation_errors() {
        for code in ["PLUGIN_PERMISSION_DENIED", "CONFLICT", "USER_CANCELLED"] {
            let mut platform = composed_platform();
            platform.prepare_failure = Some(code.into());
            let mut runtime = Runtime::new(crate::dispatch);
            let (id, answer) = composed_plan(&mut platform, &mut runtime);
            let result = finish_phase(&mut platform, &mut runtime, &id, &answer);
            assert_eq!(result["success"], true);
            let response = platform.action(&mut runtime, "resume", json!({"id":id}));
            assert!(response["error"].is_object(), "{response}");
            assert!(!platform.transfer_started);
            assert_eq!(
                platform
                    .calls
                    .iter()
                    .filter(|c| c["kind"] == "transfer_prepare")
                    .count(),
                1
            );
            assert!(platform.calls.iter().any(|c| c["kind"] == "stream_stop"));
        }
    }
    #[test]
    fn image_id_export_does_not_auto_approve_a_load_that_may_restore_multiple_tags() {
        let mut platform = composed_platform();
        platform.composed_reference = "a".repeat(64);
        let mut runtime = Runtime::new(crate::dispatch);
        let (id, mut answer) = composed_plan(&mut platform, &mut runtime);
        for _ in 0..2 {
            let result = finish_phase(&mut platform, &mut runtime, &id, &answer);
            assert_eq!(result["success"], true);
            let response = platform.action(&mut runtime, "resume", json!({"id":id}));
            assert!(response["error"].is_null(), "{response}");
            answer = response["result"]["value"].clone();
        }
        assert_eq!(answer["proposals"][0]["risk"], "change");
        let _ = finish_phase(&mut platform, &mut runtime, &id, &answer);
        let load = platform
            .calls
            .iter()
            .find(|c| c["kind"] == "stream_open" && c["hostId"] == "destination")
            .unwrap();
        let manifest: Value = serde_json::from_str(include_str!("../../manifest.json")).unwrap();
        let template: platform::Command =
            serde_json::from_value(manifest["assistCommands"][0].clone()).unwrap();
        let command: platform::Command = serde_json::from_value(load["command"].clone()).unwrap();
        assert!(!template.matches_argument_template(&command));
    }
    #[test]
    fn composition_stops_on_save_failure_and_defers_ambiguous_image_selection() {
        let mut platform = composed_platform();
        platform.fail_save = true;
        let mut runtime = Runtime::new(crate::dispatch);
        let (id, answer) = composed_plan(&mut platform, &mut runtime);
        let result = finish_phase(&mut platform, &mut runtime, &id, &answer);
        assert_eq!(result["success"], false);
        assert_eq!(result["task"]["status"], "unverified");
        assert!(!platform.transfer_started);
        assert_eq!(platform.model_calls, 2);
        let mut platform = composed_platform();
        platform
            .images
            .push(json!({"ID":"b".repeat(64),"Repository":"stock","Tag":"v2"}));
        let (_, answer) = composed_plan(&mut platform, &mut runtime);
        assert_eq!(answer["task"]["status"], "needs_input");
        assert!(answer["proposals"].as_array().unwrap().is_empty());
        assert!(platform.streams.is_empty());
    }
    #[test]
    fn owner_cancel_and_revision_failure_stop_composed_tools_without_replay() {
        for during_copy in [false, true] {
            let mut platform = composed_platform();
            let mut runtime = Runtime::new(crate::dispatch);
            let (id, mut answer) = composed_plan(&mut platform, &mut runtime);
            if during_copy {
                finish_phase(&mut platform, &mut runtime, &id, &answer);
                answer =
                    platform.action(&mut runtime, "resume", json!({"id":id}))["result"]["value"]
                        .clone();
            }
            let response=platform.action(&mut runtime,"execute",json!({"proposalId":answer["proposals"][0]["id"],"confirmed":true,"changeConfirmation":null}));
            assert_eq!(response["result"]["value"]["pending"], true, "{response}");
            platform.scope = "other-owner".into();
            assert!(platform.action(&mut runtime, "poll", json!({"id":id}))["error"].is_object());
            platform.scope = "owner-a".into();
            let response = platform.action(&mut runtime, "cancel", json!({"id":id}));
            assert_eq!(response["result"]["value"]["success"], false, "{response}");
            assert_eq!(response["result"]["value"]["task"]["status"], "unverified");
            assert!(platform.action(&mut runtime, "resume", json!({"id":id}))["error"].is_object());
            assert!(
                !platform
                    .streams
                    .values()
                    .any(|(host, _, _)| host == "destination")
            );
        }
        let mut platform = composed_platform();
        let mut runtime = Runtime::new(crate::dispatch);
        let (id, answer) = composed_plan(&mut platform, &mut runtime);
        platform.reject_bindings = true;
        let result = finish_phase(&mut platform, &mut runtime, &id, &answer);
        assert_eq!(result["success"], false);
        assert!(!platform.transfer_started);
    }
    #[test]
    fn skills_load_on_demand_and_unrelated_commands_use_the_same_loop() {
        let mut platform = Platform {
            decisions: vec![
                json!({"kind":"query","requests":[{"kind":"skill_read","name":"remote-operations","path":"SKILL.md"}]}),
                json!({"kind":"plan","summary":"查看系统内核","actions":[{"kind":"command","hostId":"host","program":"uname","args":["-a"]}]}),
                json!({"kind":"query","requests":[{"kind":"host_query","hostId":"host","query":{"kind":"diagnostic","tool":"uptime"}}]}),
                json!({"kind":"answer","outcome":"completed","text":"命令执行后已查询系统状态"}),
            ],
            ..Default::default()
        };
        let mut runtime = Runtime::new(crate::dispatch);
        let id = prepare(&mut platform, &mut runtime);
        let response = platform.action(&mut runtime, "send", json!({"id":id,"confirmed":true}));
        assert!(response["error"].is_null(), "{response}");
        let requests = platform
            .calls
            .iter()
            .filter(|c| c["kind"] == "model_complete")
            .collect::<Vec<_>>();
        let first = requests[0]["messages"].to_string();
        assert!(first.contains("remote-operations"));
        assert!(!first.contains("变更后使用适当的独立查询验证业务目标"));
        assert!(
            requests[1]["messages"]
                .to_string()
                .contains("变更后使用适当的独立查询验证业务目标")
        );
        let result = finish_phase(
            &mut platform,
            &mut runtime,
            &id,
            &response["result"]["value"],
        );
        assert_eq!(result["success"], true, "{result}");
        let response = platform.action(&mut runtime, "resume", json!({"id":id}));
        assert_eq!(
            response["result"]["value"]["task"]["status"], "succeeded",
            "{response}"
        );
    }
    #[test]
    fn unverified_transfer_cannot_feed_an_import_and_failure_does_not_resume() {
        for changed in [false, true] {
            let mut platform = composed_platform();
            let mut runtime = Runtime::new(crate::dispatch);
            let (id, answer) = composed_plan(&mut platform, &mut runtime);
            finish_phase(&mut platform, &mut runtime, &id, &answer);
            let answer =
                platform.action(&mut runtime, "resume", json!({"id":id}))["result"]["value"]
                    .clone();
            platform.corrupt_hash = !changed;
            platform.changed_archive = changed;
            let result = finish_phase(&mut platform, &mut runtime, &id, &answer);
            assert_eq!(result["task"]["status"], "unverified");
            assert_ne!(result["continuation"], true);
            assert!(
                !platform
                    .streams
                    .values()
                    .any(|(host, _, _)| host == "destination")
            );
            assert!(platform.action(&mut runtime, "resume", json!({"id":id}))["error"].is_object());
        }
    }
    #[test]
    fn failed_drain_keeps_producer_handles_until_cleanup_can_retry() {
        let mut platform = composed_platform();
        let mut runtime = Runtime::new(crate::dispatch);
        let (id, answer) = composed_plan(&mut platform, &mut runtime);
        finish_phase(&mut platform, &mut runtime, &id, &answer);
        let answer =
            platform.action(&mut runtime, "resume", json!({"id":id}))["result"]["value"].clone();
        platform.action(&mut runtime,"execute",json!({"proposalId":answer["proposals"][0]["id"],"confirmed":true,"changeConfirmation":null}));
        platform.fail_transfer_close = true;
        let before = platform.calls.len();
        let response = platform.action(&mut runtime, "cancel", json!({"id":id}));
        assert_eq!(
            response["result"]["value"]["task"]["status"], "unverified",
            "{response}"
        );
        assert!(
            !platform.calls[before..]
                .iter()
                .any(|c| c["kind"] == "stream_stop")
        );
        assert!(STATE.with_borrow(|s| s.sessions.contains_key(&id)));
        platform.fail_transfer_close = false;
        let response = platform.action(&mut runtime, "cancel", json!({"id":id}));
        assert!(response["error"].is_null(), "{response}");
        assert!(
            platform.calls[before..]
                .iter()
                .any(|c| c["kind"] == "stream_stop")
        );
        assert!(!STATE.with_borrow(|s| s.sessions.contains_key(&id)));
    }
    #[test]
    fn import_and_final_cleanup_failures_preserve_uncertain_results() {
        for scenario in ["load", "cleanup"] {
            let mut platform = composed_platform();
            let mut runtime = Runtime::new(crate::dispatch);
            let (id, mut answer) = composed_plan(&mut platform, &mut runtime);
            for _ in 0..2 {
                let result = finish_phase(&mut platform, &mut runtime, &id, &answer);
                assert_eq!(result["success"], true);
                answer =
                    platform.action(&mut runtime, "resume", json!({"id":id}))["result"]["value"]
                        .clone();
            }
            platform.fail_load = scenario == "load";
            let mut result = finish_phase(&mut platform, &mut runtime, &id, &answer);
            if scenario == "cleanup" {
                platform.fail_cleanup = true;
                result =
                    platform.action(&mut runtime, "resume", json!({"id":id}))["result"]["value"]
                        .clone();
            }
            assert_eq!(
                result["task"]["status"], "unverified",
                "{scenario}: {result}"
            );
            assert_ne!(result["success"], true);
            assert_ne!(result["continuation"], true);
        }
    }
    #[test]
    fn skills_and_cross_host_query_cannot_expand_authority() {
        let mut platform = Platform {
            decisions: vec![
                json!({"kind":"query","requests":[{"kind":"host_query","hostId":"other","query":{"kind":"images"}}]}),
            ],
            ..Default::default()
        };
        let mut runtime = Runtime::new(crate::dispatch);
        let id = prepare(&mut platform, &mut runtime);
        let before = platform.commands.len();
        let response = platform.action(&mut runtime, "send", json!({"id":id,"confirmed":true}));
        assert!(response["error"].is_object());
        assert_eq!(platform.commands.len(), before);
        for request in [
            json!({"kind":"host_query","hostId":"host","query":{"kind":"images","command":"reboot"}}),
            json!({"kind":"host_query","hostId":"host","query":{"kind":"container","id":"a".repeat(64),"action":"remove"}}),
        ] {
            assert!(serde_json::from_value::<tools::Call<tools::Query>>(request).is_err());
        }
        assert!(crate::skills::read("remote-operations", "../docker-images/SKILL.md").is_err());
    }
    #[test]
    fn generic_host_resolution_preserves_explicit_targets_through_address_redaction() {
        let mut runtime = Runtime::new(crate::dispatch);
        for (question, ids) in [
            (
                "把当前主机的任意文件传给192.168.1.159",
                json!(["source", "target"]),
            ),
            ("检查192.168.1.159的CPU", json!(["target"])),
        ] {
            let mut platform = Platform {
                assets: vec![
                    json!({"id":"source","name":"来源","hostname":"192.168.4.64","port":22,"username":"ops"}),
                    json!({"id":"target","name":"目标","hostname":"192.168.1.159","port":22,"username":"ops"}),
                ],
                decision: Some(json!({"hostIds":ids,"message":""})),
                ..Default::default()
            };
            let response=platform.action(&mut runtime,"resolve_hosts",json!({"modelId":"model","requestId":"route","question":question,"previousHostIds":[],"entryHostId":"source","maskAddresses":true,"redactValues":[]}));
            assert_eq!(response["result"]["value"]["hostIds"], ids, "{response}");
            let request = platform
                .calls
                .iter()
                .find(|c| c["kind"] == "model_complete")
                .unwrap();
            let metadata: Value =
                serde_json::from_str(request["messages"][1]["content"].as_str().unwrap()).unwrap();
            assert_eq!(metadata["explicitHostIds"], json!(["target"]));
            assert_eq!(metadata["entryHostId"], "source");
            assert_eq!(metadata["assets"][0]["hostname"], "192.168.4.64");
            assert_eq!(metadata["assets"][1]["hostname"], "192.168.1.159");
            assert!(
                !platform
                    .calls
                    .iter()
                    .any(|c| c["kind"] == "execute" || c["kind"] == "stream_open")
            );
        }
    }
    #[test]
    fn host_matching_uses_clarification_history_and_does_not_force_old_hosts_into_new_tasks() {
        for (question, ids) in [
            ("对，用户为dh的主机", json!(["source", "target"])),
            ("来源就是192.168.4.64", json!(["source", "target"])),
            ("换个问题，只检查192.168.1.159的CPU", json!(["target"])),
        ] {
            let mut platform = Platform {
                assets: vec![
                    json!({"id":"source","name":"来源","hostname":"192.168.4.64","port":22,"username":"root"}),
                    json!({"id":"target","name":"目标","hostname":"192.168.1.159","port":22,"username":"dh"}),
                ],
                decision: Some(json!({"hostIds":ids,"message":""})),
                ..Default::default()
            };
            let mut runtime = Runtime::new(crate::dispatch);
            let response=platform.action(&mut runtime,"resolve_hosts",json!({"modelId":"model","requestId":"route","question":question,"previousHostIds":["source","target"],"entryHostId":"source","maskAddresses":false,"redactValues":["history-private-fixture"],"history":[{"role":"user","content":"把stock镜像导入192.168.1.159；备注 history-private-fixture"},{"role":"assistant","content":"请确认目标为 SSH 用户 dh 的主机"}]}));
            assert_eq!(response["result"]["value"]["hostIds"], ids, "{response}");
            let request = platform
                .calls
                .iter()
                .find(|c| c["kind"] == "model_complete")
                .expect("clarifications need semantic host matching");
            let messages = request["messages"].as_array().unwrap();
            assert_eq!(messages.len(), 4);
            assert_eq!(messages[1]["role"], "user");
            assert!(
                messages[1]["content"]
                    .as_str()
                    .unwrap()
                    .contains("stock镜像")
            );
            assert_eq!(messages[2]["role"], "assistant");
            assert!(!request.to_string().contains("history-private-fixture"));
            let metadata: Value =
                serde_json::from_str(messages[3]["content"].as_str().unwrap()).unwrap();
            assert_eq!(metadata["entryHostId"], "source");
            assert_eq!(metadata["previousHostIds"], json!(["source", "target"]));
            assert_eq!(metadata["question"], question);
            assert!(
                !platform
                    .calls
                    .iter()
                    .any(|c| c["kind"] == "execute" || c["kind"] == "stream_open")
            );
        }
        let mut platform = Platform::default();
        let mut runtime = Runtime::new(crate::dispatch);
        let response=platform.action(&mut runtime,"resolve_hosts",json!({"modelId":"model","requestId":"route","question":"继续","previousHostIds":[],"maskAddresses":false,"redactValues":[],"history":[{"role":"assistant","content":"unpaired"}]}));
        assert!(response["error"].is_object());
        assert!(!platform.calls.iter().any(|c| c["kind"] == "model_complete"));
    }
    #[test]
    fn prepared_context_keeps_workspace_and_explicit_host_identity_with_optional_address_masking() {
        for mask in [false, true] {
            let mut platform = Platform {
                sequence: if mask { 100 } else { 0 },
                assets: vec![
                    json!({"id":"source","name":"入口","hostname":"192.168.4.64","port":22,"username":"root"}),
                    json!({"id":"target","name":"目标","hostname":"192.168.1.159","port":22,"username":"dh"}),
                    json!({"id":"unrelated","name":"unrelated-server","hostname":"10.20.30.40","port":22,"username":"ops"}),
                ],
                ..Default::default()
            };
            let mut runtime = Runtime::new(crate::dispatch);
            let mut request = context_input(
                vec!["source".into(), "target".into()],
                "把stock镜像导入192.168.1.159；其他地址10.30.40.50，password=synthetic-secret",
            );
            request["entryHostId"] = json!("source");
            request["maskAddresses"] = json!(mask);
            let response = platform.action(&mut runtime, "prepare", request);
            let messages = preview_body(&response);
            let context = evidence(&messages);
            assert_eq!(context["entryHostId"], "source");
            assert_eq!(context["explicitHostIds"], json!(["target"]));
            let hosts = context["hosts"].as_array().unwrap();
            assert_eq!(hosts.len(), 2);
            assert_eq!(hosts[0]["server"]["id"], "source");
            assert_eq!(hosts[1]["server"]["id"], "target");
            let text = serde_json::to_string(&messages).unwrap();
            assert!(!text.contains("synthetic-secret"));
            assert!(!text.contains("unrelated-server"));
            assert!(!text.contains("10.20.30.40"));
            assert!(text.contains("192.168.4.64"));
            assert!(text.contains("192.168.1.159"));
            assert_eq!(text.contains("10.30.40.50"), !mask);
        }
    }
    #[test]
    fn file_edit_then_read_observes_fresh_bytes_and_retires_old_document_ids() {
        let mut platform = Platform {
            decisions: vec![
                json!({"kind":"query","requests":[{"kind":"file_read","hostId":"host","path":"/work/test","startLine":1,"lines":10}]}),
                json!({"kind":"plan","summary":"修改一行","actions":[{"kind":"file_edit","documentId":"document-1","edits":[{"startLine":1,"deleteLines":1,"insertLines":["new"]}]}]}),
                json!({"kind":"query","requests":[{"kind":"file_read","hostId":"host","path":"/work/test","startLine":1,"lines":10}]}),
                json!({"kind":"answer","outcome":"completed","text":"已读取修改后的内容"}),
            ],
            ..Default::default()
        };
        let mut runtime = Runtime::new(crate::dispatch);
        let id = prepare(&mut platform, &mut runtime);
        let answer=platform.action(&mut runtime,"send",json!({"id":id,"confirmed":true}))["result"]["value"].clone();
        let result = finish_phase(&mut platform, &mut runtime, &id, &answer);
        assert_eq!(result["success"], true, "{result}");
        assert_eq!(platform.file_content, "new\n");
        let response = platform.action(&mut runtime, "resume", json!({"id":id}));
        assert_eq!(
            response["result"]["value"]["task"]["status"], "succeeded",
            "{response}"
        );
        assert_eq!(platform.file_reads, 2);
        let last = platform
            .calls
            .iter()
            .rev()
            .find(|c| c["kind"] == "model_complete")
            .unwrap()["messages"]
            .to_string();
        assert!(last.contains("document-2"));
        assert!(last.contains("new"));
    }
    #[test]
    fn reasoning_limit_is_global_across_continuation_slices() {
        let mut platform = Platform {
            decision: Some(
                json!({"kind":"query","requests":[{"kind":"host_query","hostId":"host","query":{"kind":"diagnostic","tool":"uptime"}}]}),
            ),
            ..Default::default()
        };
        let mut runtime = Runtime::new(crate::dispatch);
        let id = prepare(&mut platform, &mut runtime);
        let mut response = platform.action(&mut runtime, "send", json!({"id":id,"confirmed":true}));
        assert_eq!(response["result"]["value"]["continuation"], true);
        assert_eq!(platform.model_calls, 6);
        for _ in 0..8 {
            if response["error"].is_object() {
                break;
            }
            response = platform.action(&mut runtime, "resume", json!({"id":id}));
        }
        assert!(response["error"].is_object());
        assert_eq!(platform.model_calls, 32);
        assert_eq!(
            platform.action(&mut runtime, "task", json!({"id":id}))["result"]["value"]["status"],
            "failed"
        );
        assert!(
            !platform
                .calls
                .iter()
                .any(|call| call["kind"] == "stream_open")
        );
    }
    #[test]
    fn partial_execution_and_plain_answers_cannot_be_presented_as_goal_completion() {
        for (outcome, expected) in [("incomplete", "failed"), ("informational", "answered")] {
            let mut platform = Platform {
                decisions: vec![
                    json!({"kind":"plan","summary":"读取系统信息","actions":[{"kind":"command","hostId":"host","program":"uname","args":["-a"]}]}),
                    json!({"kind":"answer","outcome":outcome,"text":"本项已执行，整体目标尚未完成"}),
                ],
                ..Default::default()
            };
            let mut runtime = Runtime::new(crate::dispatch);
            let id = prepare(&mut platform, &mut runtime);
            let answer =
                platform.action(&mut runtime, "send", json!({"id":id,"confirmed":true}))["result"]
                    ["value"]
                    .clone();
            let step = finish_phase(&mut platform, &mut runtime, &id, &answer);
            assert_eq!(step["success"], true);
            let response = platform.action(&mut runtime, "resume", json!({"id":id}));
            assert_eq!(
                response["result"]["value"]["task"]["status"], expected,
                "{response}"
            );
        }
        let mut platform = Platform {
            decision: Some(
                json!({"kind":"answer","outcome":"completed","text":"没有证据却声称完成"}),
            ),
            ..Default::default()
        };
        let mut runtime = Runtime::new(crate::dispatch);
        STATE.with_borrow_mut(|s| *s = State::default());
        let prepared=platform.action(&mut runtime,"prepare",json!({"modelId":"model","sessionId":null,"sessionIds":[],"question":"普通知识说明","selection":{"server":false,"metrics":false,"processes":false,"docker":false,"log":null,"logLines":100},"maskAddresses":false,"redactValues":[],"history":[]}));
        let id = prepared["result"]["value"]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let response = platform.action(&mut runtime, "send", json!({"id":id,"confirmed":true}));
        assert!(response["error"].is_object());
    }
}
