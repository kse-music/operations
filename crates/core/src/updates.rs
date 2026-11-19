use crate::Error;
use serde::{Deserialize, Serialize};

/// Independent, versioned preferences; does not change the application config contract.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdatePreferences {
    pub version: u32,
    pub auto_check: bool,
    pub last_attempt_at: Option<u64>,
    pub last_checked_at: Option<u64>,
}

impl Default for UpdatePreferences {
    fn default() -> Self {
        Self {
            version: 1,
            auto_check: true,
            last_attempt_at: None,
            last_checked_at: None,
        }
    }
}

impl UpdatePreferences {
    pub fn validate(&self) -> Result<(), Error> {
        if self.version != 1 {
            return Err(Error::UnsupportedConfig(self.version));
        }
        if self
            .last_attempt_at
            .into_iter()
            .chain(self.last_checked_at)
            .any(|at| at > 253_402_300_799)
        {
            return Err(Error::Validation("更新检查时间无效"));
        }
        Ok(())
    }

    pub fn allows_check(&self, automatic: bool) -> bool {
        !automatic || self.auto_check
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn automatic_checks_use_the_saved_toggle_even_after_a_previous_attempt() {
        let mut preferences = UpdatePreferences {
            last_attempt_at: Some(200_000),
            last_checked_at: Some(200_000),
            ..Default::default()
        };
        assert!(preferences.allows_check(true));
        preferences.auto_check = false;
        assert!(!preferences.allows_check(true));
        assert!(preferences.allows_check(false));
    }

    #[test]
    fn unknown_fields_and_future_preferences_are_rejected() {
        let mut value = serde_json::to_value(UpdatePreferences::default()).unwrap();
        value["secret"] = "untrusted".into();
        assert!(serde_json::from_value::<UpdatePreferences>(value).is_err());
        assert!(
            UpdatePreferences {
                version: 2,
                ..Default::default()
            }
            .validate()
            .is_err()
        );
    }
}
