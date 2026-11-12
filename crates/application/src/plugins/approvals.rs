//! Exact, single-action plan consent. Tool claims never grant execution rights.
use super::{
    state::{self, Call, Pending, failure},
    *,
};
use serde_json::{Value, json};
use serverdeck_plugin_core::{InstalledPlugin, Permission, package::digest, permissions::Grant};
use serverdeck_plugin_sdk::{
    Capability,
    platform::{ApprovalMode, ApprovalOperation, Request},
};
use std::{
    collections::BTreeMap,
    time::{Duration, Instant},
};

pub(super) struct ConfirmationDetails {
    pub host_id: String,
    pub binding: Option<String>,
    pub target: Option<String>,
    pub description: String,
}
impl Application {
    pub(super) fn plugin_mode_preapproves(
        &self,
        call: &Call,
        plugin: &InstalledPlugin,
        grant: &Grant,
        operation: &Capability,
    ) -> Result<bool, Error> {
        if call.collecting || call.has_batch()? {
            return Ok(false);
        }
        if self.plugin_full_access(call, plugin, grant, operation)? {
            return Ok(true);
        }
        let Capability::Platform { request, bindings } = operation;
        let data = self.plugin_host.lock()?;
        let assist = bindings.iter().any(|id| {
            data.bindings.get(id).is_some_and(|binding| {
                binding.plugin == call.id
                    && binding.owner == call.owner
                    && binding.generation == call.generation
                    && binding.at.elapsed() < Duration::from_secs(600)
                    && binding.target == state::RevisionTarget::ApprovalMode(ApprovalMode::Assist)
            })
        });
        drop(data);
        if !assist {
            return Ok(false);
        }
        let changes = plugin
            .manifest
            .permissions
            .contains(&Permission::OperationsFullPreapproved)
            && grant
                .permissions
                .contains(&Permission::OperationsFullPreapproved)
            && grant
                .operations
                .iter()
                .any(|op| op == "operations.full.preapproved");
        if changes {
            match request {
                Request::TransferStart { id } => {
                    let data = self.plugin_host.lock()?;
                    if data.copies.get(id).is_some_and(|copy| {
                        copy.plugin == call.id
                            && copy.owner == call.owner
                            && copy.generation == call.generation
                            && !copy.preview.overwrite
                            && !copy.preview.target_exists
                    }) {
                        return Ok(true);
                    }
                }
                Request::Execute { command, .. } | Request::StreamOpen { command, .. }
                    if plugin.manifest.assist_commands.iter().any(|template| {
                        template == command || template.matches_argument_template(command)
                    }) =>
                {
                    return Ok(true);
                }
                _ => (),
            }
        }
        if !plugin
            .manifest
            .permissions
            .contains(&Permission::OperationsReadPreapproved)
            || !grant
                .permissions
                .contains(&Permission::OperationsReadPreapproved)
            || !grant
                .operations
                .iter()
                .any(|op| op == "operations.read.preapproved")
        {
            return Ok(false);
        }
        Ok(match request {
            Request::ReadFile { .. } | Request::TransferPrepare { .. } => true,
            Request::Execute { command, .. } | Request::StreamOpen { command, .. } => {
                plugin.manifest.preapproved_commands.contains(command)
                    || (plugin
                        .manifest
                        .permissions
                        .contains(&Permission::OperationsReadArgumentsPreapproved)
                        && grant
                            .permissions
                            .contains(&Permission::OperationsReadArgumentsPreapproved)
                        && grant
                            .operations
                            .iter()
                            .any(|op| op == "operations.read.arguments.preapproved")
                        && plugin
                            .manifest
                            .preapproved_commands
                            .iter()
                            .any(|template| template.matches_argument_template(command)))
            }
            _ => false,
        })
    }

    pub(super) fn plugin_full_access(
        &self,
        call: &Call,
        plugin: &InstalledPlugin,
        grant: &Grant,
        operation: &Capability,
    ) -> Result<bool, Error> {
        if !plugin
            .manifest
            .permissions
            .contains(&Permission::OperationsFullPreapproved)
            || !grant
                .permissions
                .contains(&Permission::OperationsFullPreapproved)
            || !grant
                .operations
                .iter()
                .any(|op| op == "operations.full.preapproved")
        {
            return Ok(false);
        }
        let Capability::Platform { bindings, .. } = operation;
        let data = self.plugin_host.lock()?;
        Ok(bindings.iter().any(|id| {
            data.bindings.get(id).is_some_and(|binding| {
                binding.plugin == call.id
                    && binding.owner == call.owner
                    && binding.generation == call.generation
                    && binding.target == state::RevisionTarget::ApprovalMode(ApprovalMode::Full)
            })
        }))
    }

    pub(super) fn plugin_confirm_details(
        &self,
        call: &Call,
        plugin: &InstalledPlugin,
        operation: &Capability,
        details: ConfirmationDetails,
    ) -> Result<Option<Approval>, Error> {
        let hash = digest(
            &serde_json::to_vec(&(
                plugin.revision.as_str(),
                call.generation.as_str(),
                call.owner.as_str(),
                operation,
                &details.binding,
            ))
            .map_err(|e| Error::Worker(Box::new(e)))?,
        );
        if !call.collecting {
            let mut batch = call.batch.lock().map_err(|_| Error::Busy)?;
            if let Some(batch) = batch.as_mut() {
                if batch.at.elapsed() > Duration::from_secs(100) {
                    return Err(failure("PLUGIN_PLAN_EXPIRED", "计划授权已到期，请重新准备"));
                }
                let Some(remaining) = batch.operations.get_mut(&hash).filter(|count| **count > 0)
                else {
                    batch.operations.clear();
                    return Err(failure(
                        "PLUGIN_PLAN_CHANGED",
                        "操作或目标已变化，未执行计划外请求，请重新准备",
                    ));
                };
                *remaining -= 1;
                return Ok(None);
            }
        }
        let public = Approval {
            id: if call.collecting {
                hash.clone()
            } else {
                uuid::Uuid::new_v4().to_string()
            },
            plugin_id: call.id.clone(),
            plugin_name: plugin.manifest.name.clone(),
            plugin_version: plugin.manifest.version.clone(),
            host_id: details.host_id,
            operation: operation.operation().into(),
            description: details.description,
            target: details.target,
        };
        if call.collecting {
            return Ok(Some(public));
        }
        let mut data = self.plugin_host.lock()?;
        data.approvals
            .retain(|_, pending| pending.at.elapsed() <= Duration::from_secs(60));
        if let Some(id) = data
            .approvals
            .iter()
            .find(|(_, pending)| pending.digest == hash && pending.approved)
            .map(|(id, _)| id.clone())
        {
            data.approvals.remove(&id);
            return Ok(None);
        }
        if data.approvals.len() >= 16
            || data
                .approvals
                .values()
                .filter(|pending| pending.public.plugin_id == call.id)
                .count()
                >= 4
        {
            return Err(Error::Busy);
        }
        data.approvals.insert(
            public.id.clone(),
            Pending {
                owner: call.owner.clone(),
                public: public.clone(),
                digest: hash,
                at: Instant::now(),
                approved: false,
            },
        );
        Ok(Some(public))
    }

    pub(super) async fn plugin_confirm_operations(
        &self,
        call: &Call,
        plugin: &InstalledPlugin,
        grant: &Grant,
        operations: Vec<ApprovalOperation>,
        bindings: Vec<String>,
    ) -> Result<Value, Error> {
        if call.collecting
            || call.has_batch()?
            || operations.is_empty()
            || operations.len() > 96
            || operations.iter().map(|op| u32::from(op.count)).sum::<u32>() > 128
            || operations.iter().any(|op| {
                op.count == 0
                    || !matches!(
                        *op.request,
                        Request::Execute { .. }
                            | Request::SaveFile { .. }
                            | Request::TransferStart { .. }
                    )
            })
        {
            return Err(Error::Validation(
                "计划须包含1–96个固定执行、保存或传输请求，最多128次调用",
            ));
        }
        let collect = call.collector();
        let mut hashes = BTreeMap::<String, u16>::new();
        let mut descriptions = Vec::new();
        let mut targets = Vec::new();
        for op in &operations {
            let capability = Capability::Platform {
                request: *op.request.clone(),
                bindings: bindings.clone(),
            };
            let value = Box::pin(self.plugin_dispatch_inner(
                &collect,
                serverdeck_plugin_sdk::Request {
                    api_version: 1,
                    request_id: uuid::Uuid::new_v4().to_string(),
                    operation: capability,
                },
            ))
            .await?;
            let approval: Approval = serde_json::from_value(value["confirmationRequired"].clone())
                .map_err(|_| failure("PLUGIN_PLAN_INVALID", "计划预检未返回确认信息"))?;
            let count = hashes.entry(approval.id).or_default();
            *count = count
                .checked_add(op.count)
                .ok_or(Error::Validation("计划重复次数超限"))?;
            if let Some(target) = approval.target
                && !targets.contains(&target)
            {
                targets.push(target);
            }
            descriptions.push(format!(
                "{}{}",
                approval.description,
                if op.count > 1 {
                    format!("\n（计划内使用 {} 次）", op.count)
                } else {
                    String::new()
                }
            ));
        }
        let binding = serde_json::to_string(&hashes).map_err(|e| Error::Worker(Box::new(e)))?;
        let operation = Capability::Platform {
            request: Request::ConfirmOperations { operations },
            bindings,
        };
        let mut description = format!(
            "确认后仅执行本次固定计划；仍逐项复验权限、目标和原始状态。\n\n{}",
            descriptions.join("\n\n")
        );
        if description.len() > 32768 {
            let mut end = 32000;
            while !description.is_char_boundary(end) {
                end -= 1;
            }
            description.truncate(end);
            description.push_str("\n（内容较长，已省略后部；请结合聊天中的完整计划核对）");
        }
        let mut automatic = self.plugin_full_access(call, plugin, grant, &operation)?;
        if !automatic {
            automatic = true;
            let Capability::Platform {
                request: Request::ConfirmOperations { operations },
                bindings,
            } = &operation
            else {
                return Err(Error::Validation("计划无效"));
            };
            for op in operations {
                if !self.plugin_mode_preapproves(
                    call,
                    plugin,
                    grant,
                    &Capability::Platform {
                        request: *op.request.clone(),
                        bindings: bindings.clone(),
                    },
                )? {
                    automatic = false;
                    break;
                }
            }
        }
        if !automatic && !self.plugin_scope_visible(call)? {
            return Err(failure("PLUGIN_UI_HIDDEN", "请返回页面确认本次计划"));
        }
        if !automatic
            && let Some(approval) = self.plugin_confirm_details(
                call,
                plugin,
                &operation,
                ConfirmationDetails {
                    host_id: String::new(),
                    binding: Some(binding),
                    target: Some(targets.join("\n")),
                    description,
                },
            )?
        {
            return Ok(json!({"confirmationRequired":approval}));
        }
        *call.batch.lock().map_err(|_| Error::Busy)? = Some(state::BatchConsent {
            at: Instant::now(),
            operations: hashes,
        });
        Ok(Value::Null)
    }
}
