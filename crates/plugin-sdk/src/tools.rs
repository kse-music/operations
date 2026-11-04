//! Public operations for the trusted workspace tool surfaces.
//! Inputs are immutable, short-lived Host tickets; Guest code never receives credentials,
//! private sessions, prompts or an arbitrary native IPC command.
use crate::Permission;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Tool {
    Assistant,
    Batch,
    Automation,
    Network,
}
impl Tool {
    pub fn permission(self) -> Permission {
        match self {
            Self::Assistant => Permission::AssistantUse,
            Self::Batch => Permission::BatchRun,
            Self::Automation => Permission::AutomationManage,
            Self::Network => Permission::NetworkRun,
        }
    }
    pub fn operation(self) -> &'static str {
        match self {
            Self::Assistant => "assistant.use",
            Self::Batch => "batch.run",
            Self::Automation => "automation.manage",
            Self::Network => "network.run",
        }
    }
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Operation {
    AiResolveHosts,
    AiPrepare,
    AiSend,
    AiExecute,
    DiagnosticStart,
    DiagnosticList,
    DiagnosticCancel,
    BatchStart,
    BatchList,
    BatchCancel,
    BatchRetryFile,
    AutomationCatalog,
    AutomationPrepare,
    AutomationEntrySave,
    AutomationEntryDelete,
    AutomationGroupSave,
    AutomationGroupDelete,
    AutomationStart,
    AutomationRun,
    AutomationHistory,
    AutomationCancel,
    AutomationApprove,
    AutomationScheduleSave,
    AutomationScheduleDisable,
    AutomationScheduleDelete,
    AutomationStatus,
    AutomationRunDelete,
}
impl Operation {
    pub fn tool(self) -> Tool {
        match self {
            Self::AiResolveHosts | Self::AiPrepare | Self::AiSend | Self::AiExecute => {
                Tool::Assistant
            }
            Self::DiagnosticStart | Self::DiagnosticList | Self::DiagnosticCancel => Tool::Network,
            Self::BatchStart | Self::BatchList | Self::BatchCancel | Self::BatchRetryFile => {
                Tool::Batch
            }
            Self::AutomationCatalog
            | Self::AutomationPrepare
            | Self::AutomationEntrySave
            | Self::AutomationEntryDelete
            | Self::AutomationGroupSave
            | Self::AutomationGroupDelete
            | Self::AutomationStart
            | Self::AutomationRun
            | Self::AutomationHistory
            | Self::AutomationCancel
            | Self::AutomationApprove
            | Self::AutomationScheduleSave
            | Self::AutomationScheduleDisable
            | Self::AutomationScheduleDelete
            | Self::AutomationStatus
            | Self::AutomationRunDelete => Tool::Automation,
        }
    }
}
