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

    pub fn should_check(&self, now: u64) -> bool {
        self.auto_check
            && self
                .last_attempt_at
                .is_none_or(|at| now.saturating_sub(at) >= 86_400)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn automatic_checks_respect_opt_out_daily_limit_and_clock_changes() {
        let mut preferences = UpdatePreferences::default();
        assert!(preferences.should_check(200_000));
        preferences.last_attempt_at = Some(200_000);
        for now in [100_000, 200_000, 286_399] {
            assert!(!preferences.should_check(now));
        }
        assert!(preferences.should_check(286_400));
        preferences.auto_check = false;
        assert!(!preferences.should_check(900_000));
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
