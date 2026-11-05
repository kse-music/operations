use serverdeck_plugin_sdk::{
    Capability,
    serde_json::Value,
    server::{LogSource, Query, SurfaceState},
};
use std::sync::Mutex;
static STATE: Mutex<Option<SurfaceState>> = Mutex::new(None);
fn allows(cap: &Capability) -> bool {
    matches!(
        cap,
        Capability::SystemQuery {
            request: Query::Capabilities
                | Query::Containers
                | Query::Images
                | Query::ContainerDetails { .. }
                | Query::ContainerStats { .. }
                | Query::ContainerAction { .. }
                | Query::ImageRemove { .. }
                | Query::Probe { .. }
        } | Capability::SystemFeedback
            | Capability::ContainerShell { .. }
            | Capability::SystemLogStart {
                source: LogSource::Container { .. },
                ..
            }
            | Capability::SystemLogPoll { .. }
            | Capability::SystemLogPause { .. }
            | Capability::SystemLogStop { .. }
    )
}
fn handle(operation: i32, payload: Value) -> Value {
    let Ok(mut guard) = STATE.lock() else {
        return serverdeck_plugin_sdk::json_error("STATE", "Plugin state is unavailable");
    };
    guard
        .get_or_insert_with(SurfaceState::default)
        .handle(operation, payload, allows)
}
serverdeck_plugin_sdk::export_plugin!(handle);
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn refuses_capabilities_outside_this_plugins_domain() {
        assert!(!allows(&Capability::Execute {
            command: "arbitrary".into(),
            timeout_secs: 1
        }));
        assert!(!allows(&Capability::SettingsRead));
    }
    #[test]
    fn accepts_its_domain_and_rejects_other_server_domains() {
        assert!(allows(&Capability::SystemLogStart {
            source: LogSource::Container { id: "a".repeat(64) },
            lines: 200,
            follow: true
        }));
        assert!(!allows(&Capability::SystemLogStart {
            source: LogSource::File {
                path: "/var/log/messages".into()
            },
            lines: 200,
            follow: true
        }));
        assert!(!allows(&Capability::SystemLogStart {
            source: LogSource::Service {
                scope: serverdeck_plugin_sdk::server::Scope::System,
                unit: "owned.service".into()
            },
            lines: 200,
            follow: true
        }));
        assert!(allows(&Capability::SystemQuery {
            request: serverdeck_plugin_sdk::server::Query::Containers
        }));
        assert!(!allows(&Capability::SystemQuery {
            request: serverdeck_plugin_sdk::server::Query::Processes
        }));
    }
}
