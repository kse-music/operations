use super::*;
use serverdeck_ai::agent::{
    AgentHost, PlanLease, PlannedStep, fingerprint, verification_request, verified,
};
use std::time::{Duration, Instant};
use tokio_util::sync::CancellationToken;

struct Host<'a> {
    app: &'a Application,
    binding: Option<Binding>,
    cancel: &'a CancellationToken,
}
impl AgentHost for Host<'_> {
    async fn query(&self, request: Request) -> Result<Response, Error> {
        let binding = self
            .binding
            .as_ref()
            .ok_or(Error::Validation("智能体操作需要明确的一台主机"))?;
        self.app.ai_verify_binding(binding)?;
        tokio::select! {
            biased;
            _=self.cancel.cancelled()=>Err(failure("AI_CANCELLED","智能体查询已取消")),
            result=self.app.operations_host.query(&binding.session.id,request)=>{
                self.app.ai_verify_binding(binding)?;
                result
            }
        }
    }
}
impl Application {
    pub(crate) async fn ai_agent_send(
        &self,
        id: String,
        confirmed: bool,
        cancel: &CancellationToken,
    ) -> Result<Answer, Error> {
        for binding in self.assistant.preview_bindings(&id)? {
            self.ai_verify_binding(&binding)?;
        }
        let model_id = self.assistant.preview_model_id(&id)?;
        let (record, key) = self.ai_credentials(model_id).await?;
        let host = Host {
            app: self,
            binding: self.assistant.preview_binding(&id)?,
            cancel,
        };
        self.assistant
            .send_agent(&id, &record.revision, &key, confirmed, &host)
            .await
    }
    async fn ai_verify_plan(
        &self,
        plan: &PlanLease,
        cancel: &CancellationToken,
    ) -> Result<(), Error> {
        if cancel.is_cancelled() || plan.cancel.is_cancelled() {
            return Err(failure("AI_CANCELLED", "计划已停止；未执行后续操作"));
        }
        self.ai_verify_binding(&plan.binding)?;
        let id = plan.model_id.clone();
        let revision = self
            .blocking(move |db| Ok(db.ai_model(&id)?.revision))
            .await?;
        if revision != plan.revision {
            return Err(Error::Conflict);
        }
        Ok(())
    }
    pub(crate) async fn ai_agent_execute(
        &self,
        input: ExecuteInput,
        cancel: &CancellationToken,
    ) -> Result<Execution, Error> {
        let _permit = self.assistant.execution_slot()?;
        let plan = self.assistant.take_plan(input)?;
        let deadline = Instant::now() + Duration::from_secs(100);
        let mut results = vec![];
        let mut stopped = false;
        for step in &plan.steps {
            if stopped {
                results.push(AgentStepResult {
                    action: step.public.action.clone(),
                    target: step.public.target.clone(),
                    status: "skipped".into(),
                    message: "前序操作未确认成功或任务已停止，未执行此项".into(),
                });
                continue;
            }
            let result = if Instant::now() >= deadline {
                Err(failure("AI_AGENT_TIMEOUT", "计划达到执行时限，未执行此项"))
            } else {
                self.ai_agent_step(&plan, step, cancel, deadline).await
            };
            let (status, message) = match result {
                Ok(value) => value,
                Err(error) => (
                    "failed".into(),
                    serverdeck_core::IpcError::from(error).message,
                ),
            };
            stopped = status != "verified";
            results.push(AgentStepResult {
                action: step.public.action.clone(),
                target: step.public.target.clone(),
                status,
                message: plan.redactor.text(&message),
            });
        }
        let success = results.iter().all(|r| r.status == "verified");
        let output = if success {
            format!("已执行并复查 {} 项操作。", results.len())
        } else {
            "计划未全部完成，请查看逐项结果；失败、未确认及跳过项目不会自动重试。".into()
        };
        Ok(Execution {
            success,
            output,
            agent: Some(AgentExecution { steps: results }),
        })
    }
    async fn ai_agent_step(
        &self,
        plan: &PlanLease,
        step: &PlannedStep,
        cancel: &CancellationToken,
        deadline: Instant,
    ) -> Result<(String, String), Error> {
        self.ai_verify_plan(plan, cancel).await?;
        let id = &plan.binding.session.id;
        let before = self.operations_host.query(id, step.read.clone()).await?;
        if fingerprint(&step.request, &before)? != step.before {
            return Err(Error::Validation(
                "目标状态自生成计划后发生变化，请重新查询和确认",
            ));
        }
        self.ai_verify_plan(plan, cancel).await?;
        if Instant::now() >= deadline {
            return Err(failure(
                "AI_AGENT_TIMEOUT",
                "计划达到执行时限，未提交此项变更",
            ));
        }
        // Mutations drain through the existing bounded SSH operation. Cancellation stops later steps.
        let result = match &step.request {
            Request::ImageRemove { id: image, .. } => {
                self.operations_host.remove_untagged_image(id, image).await
            }
            request => self.operations_host.query(id, request.clone()).await,
        };
        if let Err(error) = self.ai_verify_plan(plan, cancel).await {
            return Ok((
                "unverified".into(),
                format!(
                    "操作已提交，{}；结果尚未复查，请独立核对主机状态",
                    serverdeck_core::IpcError::from(error).message
                ),
            ));
        }
        let response = match result {
            Ok(response) => response,
            Err(error) => {
                return Ok((
                    "unverified".into(),
                    format!(
                        "操作结果未确认：{}；停止后续操作",
                        serverdeck_core::IpcError::from(error).message
                    ),
                ));
            }
        };
        let after = match self
            .operations_host
            .query(id, verification_request(step))
            .await
        {
            Ok(response) => response,
            Err(error) => {
                return Ok((
                    "unverified".into(),
                    format!(
                        "操作已提交，但复查失败：{}",
                        serverdeck_core::IpcError::from(error).message
                    ),
                ));
            }
        };
        if let Err(error) = self.ai_verify_plan(plan, cancel).await {
            return Ok((
                "unverified".into(),
                format!(
                    "操作已提交，但复查上下文失效：{}",
                    serverdeck_core::IpcError::from(error).message
                ),
            ));
        }
        if response.success && verified(step, &after) {
            return Ok((
                "verified".into(),
                "操作完成，已通过 SSH 重新读取目标状态并确认预期结果".into(),
            ));
        }
        Ok((
            if response.success {
                "unverified"
            } else {
                "failed"
            }
            .into(),
            response
                .message
                .unwrap_or_else(|| "操作未通过结果复查，停止后续操作，请核对主机状态".into()),
        ))
    }
}
