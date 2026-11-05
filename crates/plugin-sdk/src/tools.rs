//! Public operations for the trusted workspace tool surfaces.
//! Inputs are immutable, short-lived Host tickets; Guest code never receives credentials,
//! private sessions, prompts or an arbitrary native IPC command.
use crate::Permission;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Tool {
    Assistant,
}
impl Tool {
    pub fn permission(self) -> Permission {
        match self {
            Self::Assistant => Permission::AssistantUse,
        }
    }
    pub fn operation(self) -> &'static str {
        match self {
            Self::Assistant => "assistant.use",
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
}
impl Operation {
    pub fn tool(self) -> Tool {
        match self {
            Self::AiResolveHosts | Self::AiPrepare | Self::AiSend | Self::AiExecute => {
                Tool::Assistant
            }
        }
    }
}
