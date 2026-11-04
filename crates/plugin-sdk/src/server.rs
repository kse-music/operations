//! Public structured server capabilities. No private application or SSH types.
use crate::{Capability, Response, host_call, json_error, json_reply};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Scope {
    System,
    User,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContainerAction {
    Start,
    Stop,
    Restart,
    Remove,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ServiceAction {
    Start,
    Stop,
    Restart,
    Enable,
    Disable,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Signal {
    Term,
    Kill,
    Int,
    Hup,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Query {
    Capabilities,
    Containers,
    Images,
    ContainerDetails {
        id: String,
        reveal_env: bool,
    },
    ContainerStats {
        id: String,
    },
    ContainerAction {
        id: String,
        action: ContainerAction,
    },
    ImageRemove {
        id: String,
    },
    Processes,
    ProcessDetails {
        pid: u32,
    },
    Signal {
        pid: u32,
        start_ticks: String,
        boot_id: String,
        signal: Signal,
    },
    Ports,
    Services {
        scope: Scope,
    },
    ServiceDetails {
        scope: Scope,
        unit: String,
    },
    ServiceAction {
        scope: Scope,
        unit: String,
        action: ServiceAction,
    },
    Probe {
        location: String,
        target: String,
        port: u16,
    },
}
impl Query {
    pub fn sensitive(&self) -> bool {
        matches!(
            self,
            Self::ContainerDetails {
                reveal_env: true,
                ..
            } | Self::ContainerAction { .. }
                | Self::ImageRemove { .. }
                | Self::Signal { .. }
                | Self::ServiceAction { .. }
        )
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum LogSource {
    Container { id: String },
    File { path: String },
    Service { scope: Scope, unit: String },
}

/// Reusable protocol plumbing only; each package supplies its own capability policy.
#[derive(Default)]
pub struct SurfaceState {
    pending: Option<String>,
    sequence: u64,
}
impl SurfaceState {
    pub fn handle(
        &mut self,
        operation: i32,
        payload: Value,
        allow: fn(&Capability) -> bool,
    ) -> Value {
        match operation {
            6 => {
                self.pending = None;
                if payload["action"] != "bridge" {
                    return json_error("ACTION", "Unknown surface action");
                }
                let Some(encoded) = payload["values"]["request"].as_str() else {
                    return json_error("REQUEST", "Missing surface request");
                };
                let capability: Capability = match serde_json::from_str(encoded) {
                    Ok(value) => value,
                    Err(_) => return json_error("REQUEST", "Invalid public capability"),
                };
                if !allow(&capability) {
                    return json_error(
                        "CAPABILITY",
                        "This plugin does not implement that capability",
                    );
                }
                self.sequence = self.sequence.wrapping_add(1);
                let id = format!("surface-{}", self.sequence);
                self.pending = Some(id.clone());
                json_reply(host_call(&id, capability))
            }
            7 => {
                let reply: Response = match serde_json::from_value(payload["hostResponse"].clone())
                {
                    Ok(reply) => reply,
                    Err(_) => return json_error("HOST_RESPONSE", "Invalid host response"),
                };
                if self.pending.take().as_deref() != Some(reply.request_id.as_str()) {
                    return json_error("HOST_RESPONSE", "Unmatched host response");
                }
                if let Some(error) = reply.error {
                    return json_error(&error.code, &error.message);
                }
                json_reply(json!({"kind":"done", "value":reply.result}))
            }
            _ => {
                self.pending = None;
                json_reply(json!({"ready":true}))
            }
        }
    }
}
