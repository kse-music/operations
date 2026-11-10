use crate::Error;
use serde::Serialize;
use std::collections::HashMap;

pub const TTL_MS: u64 = 300_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Prepared,
    Running,
    AwaitingApproval,
    Executing,
    Transferring,
    Verifying,
    Succeeded,
    Failed,
    Cancelled,
    Unverified,
    Expired,
}
impl Status {
    fn terminal(self) -> bool {
        matches!(
            self,
            Self::Succeeded | Self::Failed | Self::Cancelled | Self::Unverified | Self::Expired
        )
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub id: String,
    pub status: Status,
    pub model_id: String,
    pub host_ids: Vec<String>,
    pub created_at: u64,
    pub updated_at: u64,
    pub expires_at: u64,
}
pub struct Task {
    pub native_job: bool,
    pub scope: String,
    pub bindings: Vec<String>,
    pub snapshot: Snapshot,
}
#[derive(Default)]
pub struct Tasks(HashMap<String, Task>);
impl Tasks {
    pub fn contains(&self, id: &str) -> bool {
        self.0.contains_key(id)
    }
    pub fn insert(&mut self, task: Task) -> Result<(), Error> {
        if self.0.contains_key(&task.snapshot.id) {
            return Err(Error::Conflict);
        }
        if self.0.len() >= 32 {
            let oldest = self
                .0
                .iter()
                .filter(|(_, t)| t.snapshot.status.terminal())
                .min_by_key(|(_, t)| t.snapshot.updated_at)
                .map(|(id, _)| id.clone());
            if let Some(id) = oldest {
                self.0.remove(&id);
            } else {
                return Err(Error::Busy);
            }
        }
        self.0.insert(task.snapshot.id.clone(), task);
        Ok(())
    }
    pub fn get(&self, id: &str, scope: &str) -> Result<&Task, Error> {
        self.0
            .get(id)
            .filter(|t| t.scope == scope)
            .ok_or(Error::NotFound)
    }
    pub fn update(&mut self, id: &str, status: Status, now: u64) -> Result<Snapshot, Error> {
        let task = self.0.get_mut(id).ok_or(Error::NotFound)?;
        let previous = task.snapshot.status;
        let allowed = matches!(
            (previous, status),
            (Status::Prepared, Status::Running)
                | (
                    Status::Running,
                    Status::AwaitingApproval | Status::Succeeded
                )
                | (Status::AwaitingApproval, Status::Executing)
                | (Status::Executing, Status::Verifying)
                | (Status::Executing, Status::Transferring)
                | (
                    Status::Transferring,
                    Status::Verifying | Status::Succeeded | Status::Unverified
                )
                | (Status::Verifying, Status::Executing | Status::Succeeded)
                | (Status::Verifying, Status::Transferring)
                | (Status::Executing, Status::Succeeded | Status::Unverified)
                | (Status::Verifying, Status::Unverified)
        ) || (previous == status && !previous.terminal())
            || (!previous.terminal()
                && matches!(status, Status::Failed | Status::Cancelled | Status::Expired));
        if !allowed {
            return Err(Error::Validation("助手任务状态转换无效"));
        }
        task.snapshot.status = status;
        task.snapshot.updated_at = task.snapshot.updated_at.max(now);
        Ok(task.snapshot.clone())
    }
    pub fn expire(&mut self, now: u64) {
        for task in self.0.values_mut() {
            if !task.native_job
                && !task.snapshot.status.terminal()
                && now >= task.snapshot.expires_at
            {
                task.snapshot.status = match task.snapshot.status {
                    Status::Executing | Status::Verifying => Status::Unverified,
                    Status::Running => Status::Failed,
                    _ => Status::Expired,
                };
                task.snapshot.updated_at = now;
            }
        }
    }
    pub fn detach(&mut self, id: &str) -> Result<(), Error> {
        self.0.get_mut(id).ok_or(Error::NotFound)?.native_job = true;
        Ok(())
    }
    pub fn abandon_scopes(&mut self, active: &[&str], now: u64) {
        for task in self.0.values_mut().filter(|task| {
            !active.contains(&task.scope.as_str()) && !task.snapshot.status.terminal()
        }) {
            task.snapshot.status = if task.native_job {
                Status::Unverified
            } else {
                Status::Cancelled
            };
            task.snapshot.updated_at = now;
        }
    }
    pub fn cancel(&mut self, id: &str, scope: &str, now: u64) -> Result<(), Error> {
        let status = self.get(id, scope)?.snapshot.status;
        if !status.terminal() {
            let next = if matches!(status, Status::Executing | Status::Verifying) {
                Status::Unverified
            } else {
                Status::Cancelled
            };
            self.update(id, next, now)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture(id: usize) -> Task {
        Task {
            native_job: false,
            scope: "a".into(),
            bindings: vec![],
            snapshot: Snapshot {
                id: id.to_string(),
                status: Status::Prepared,
                model_id: "model".into(),
                host_ids: vec![],
                created_at: 1,
                updated_at: 1,
                expires_at: TTL_MS + 1,
            },
        }
    }
    #[test]
    fn native_jobs_outlive_preview_ttl_but_closed_scopes_preserve_uncertainty() {
        let mut tasks = Tasks::default();
        tasks.insert(fixture(0)).unwrap();
        for status in [
            Status::Running,
            Status::AwaitingApproval,
            Status::Executing,
            Status::Transferring,
        ] {
            tasks.update("0", status, 2).unwrap();
        }
        tasks.detach("0").unwrap();
        tasks.expire(TTL_MS * 4);
        assert_eq!(
            tasks.get("0", "a").unwrap().snapshot.status,
            Status::Transferring
        );
        tasks.abandon_scopes(&["b"], TTL_MS * 4);
        assert_eq!(
            tasks.get("0", "a").unwrap().snapshot.status,
            Status::Unverified
        );
        assert!(tasks.update("0", Status::Executing, TTL_MS * 4).is_err());
    }
    #[test]
    fn bounded_tasks_preserve_active_work_and_expire_without_reauthorizing() {
        let mut tasks = Tasks::default();
        for id in 0..32 {
            tasks.insert(fixture(id)).unwrap();
        }
        assert!(matches!(tasks.insert(fixture(32)), Err(Error::Busy)));
        tasks.cancel("0", "a", 2).unwrap();
        tasks.insert(fixture(32)).unwrap();
        assert!(tasks.get("0", "a").is_err());
        for status in [Status::Running, Status::AwaitingApproval, Status::Executing] {
            tasks.update("1", status, 3).unwrap();
        }
        tasks.expire(TTL_MS + 1);
        assert_eq!(
            tasks.get("1", "a").unwrap().snapshot.status,
            Status::Unverified
        );
        assert_eq!(
            tasks.get("2", "a").unwrap().snapshot.status,
            Status::Expired
        );
        assert!(tasks.update("2", Status::Running, TTL_MS + 2).is_err());
    }
    #[test]
    fn tasks_reject_cross_owner_replay_and_preserve_uncertain_results_on_cancel() {
        let mut tasks = Tasks::default();
        tasks
            .insert(Task {
                native_job: false,
                scope: "a".into(),
                bindings: vec![],
                snapshot: Snapshot {
                    id: "task".into(),
                    status: Status::Prepared,
                    model_id: "model".into(),
                    host_ids: vec!["host".into()],
                    created_at: 1,
                    updated_at: 1,
                    expires_at: TTL_MS + 1,
                },
            })
            .unwrap();
        assert!(tasks.get("task", "b").is_err());
        assert!(tasks.update("task", Status::Executing, 2).is_err());
        for status in [
            Status::Running,
            Status::AwaitingApproval,
            Status::Executing,
            Status::Verifying,
            Status::Unverified,
        ] {
            tasks.update("task", status, 3).unwrap();
        }
        tasks.cancel("task", "a", 4).unwrap();
        assert_eq!(
            tasks.get("task", "a").unwrap().snapshot.status,
            Status::Unverified
        );
        assert!(tasks.update("task", Status::Executing, 5).is_err());
    }
}
