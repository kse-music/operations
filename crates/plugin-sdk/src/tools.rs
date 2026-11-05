//! Public operations for the trusted workspace tool surfaces.
//! Inputs are immutable, short-lived Host tickets; Guest code never receives credentials,
//! private sessions, prompts or an arbitrary native IPC command.
use crate::Permission;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Tool {
    Assistant,
    Network,
}
impl Tool {
    pub fn permission(self) -> Permission {
        match self {
            Self::Assistant => Permission::AssistantUse,
            Self::Network => Permission::NetworkRun,
        }
    }
    pub fn operation(self) -> &'static str {
        match self {
            Self::Assistant => "assistant.use",
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
}
impl Operation {
    pub fn tool(self) -> Tool {
        match self {
            Self::AiResolveHosts | Self::AiPrepare | Self::AiSend | Self::AiExecute => {
                Tool::Assistant
            }
            Self::DiagnosticStart | Self::DiagnosticList | Self::DiagnosticCancel => Tool::Network,
        }
    }
}
