//! Bounded model text streams and plugin-owned display progress. Neither grants execution.
use crate::{Permission, platform::Message};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Request {
    ModelStart {
        model_id: String,
        expected_revision: Option<String>,
        messages: Vec<Message>,
    },
    ModelPoll {
        id: String,
    },
    ModelClose {
        id: String,
    },
    ProgressOpen,
    ProgressPublish {
        id: String,
        text: String,
        reset: bool,
    },
    ProgressRead {
        id: String,
        revision: u64,
        offset: usize,
    },
    ProgressClose {
        id: String,
    },
}
impl Request {
    pub fn permission(&self) -> Permission {
        match self {
            Self::ModelStart { .. } | Self::ModelPoll { .. } | Self::ModelClose { .. } => {
                Permission::ModelsUse
            }
            _ => Permission::UiContribute,
        }
    }
    pub fn operation(&self) -> &'static str {
        match self.permission() {
            Permission::ModelsUse => "models.use",
            _ => "ui.contribute",
        }
    }
    pub fn cleanup(&self) -> bool {
        matches!(
            self,
            Self::ModelClose { .. } | Self::ProgressRead { .. } | Self::ProgressClose { .. }
        )
    }
    pub fn stream_io(&self) -> bool {
        matches!(self, Self::ModelPoll { .. } | Self::ProgressPublish { .. })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn model_privileges_cleanup_and_stream_budget_are_separate_from_execution() {
        let poll = Request::ModelPoll { id: "id".into() };
        assert_eq!(poll.permission(), Permission::ModelsUse);
        assert!(poll.stream_io());
        assert!(!poll.cleanup());
        let publish = Request::ProgressPublish {
            id: "id".into(),
            text: "text".into(),
            reset: false,
        };
        assert_eq!(publish.permission(), Permission::UiContribute);
        assert!(publish.stream_io());
        assert!(!publish.cleanup());
        assert!(Request::ModelClose { id: "id".into() }.cleanup());
        assert!(
            Request::ProgressRead {
                id: "id".into(),
                revision: 1,
                offset: 0
            }
            .cleanup()
        );
        assert!(
            serde_json::from_value::<Request>(
                serde_json::json!({"kind":"model_poll","id":"id","command":"reboot"})
            )
            .is_err()
        );
    }
}
