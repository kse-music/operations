use super::*;
use serde::{Deserialize, Serialize};
use serverdeck_core::connection::LocalForwardInput;
use std::collections::HashSet;

const VERSION: u32 = 1;

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct SavedRules {
    version: u32,
    rules: Vec<LocalForwardInput>,
}

pub(super) fn key(host_id: &str) -> String {
    format!("ssh_forward_rules:{host_id}")
}

fn load(connection: &Connection, key: &str) -> Result<Vec<LocalForwardInput>, Error> {
    let json: Option<String> = connection
        .query_row(
            "SELECT value FROM application_settings WHERE key=?1",
            [key],
            |row| row.get(0),
        )
        .optional()
        .map_err(storage_error)?;
    let Some(json) = json else {
        return Ok(Vec::new());
    };
    let saved: SavedRules = serde_json::from_str(&json).map_err(storage_error)?;
    if saved.version != VERSION {
        return Err(Error::UnsupportedConfig(saved.version));
    }
    let mut ports = HashSet::new();
    saved
        .rules
        .into_iter()
        .map(|rule| {
            let rule = rule.normalize()?;
            if !ports.insert(rule.listen_port) {
                return Err(Error::Validation("此主机已有使用该本地端口的规则。"));
            }
            Ok(rule)
        })
        .collect()
}

impl Database {
    pub fn forward_rules(&self, host_id: &str) -> Result<Vec<LocalForwardInput>, Error> {
        load(&self.connect()?, &key(host_id))
    }

    pub fn add_forward_rule(
        &self,
        host_id: &str,
        rule: LocalForwardInput,
    ) -> Result<LocalForwardInput, Error> {
        let rule = rule.normalize()?;
        self.change_forward_rules(host_id, |rules| {
            if rules
                .iter()
                .any(|saved| saved.listen_port == rule.listen_port)
            {
                return Err(Error::Validation("此主机已有使用该本地端口的规则。"));
            }
            rules.push(rule.clone());
            Ok(())
        })?;
        Ok(rule)
    }

    pub fn remove_forward_rule(&self, host_id: &str, listen_port: u16) -> Result<(), Error> {
        if listen_port == 0 {
            return Err(Error::Validation("本地监听端口必须为 1–65535"));
        }
        self.change_forward_rules(host_id, |rules| {
            rules.retain(|rule| rule.listen_port != listen_port);
            Ok(())
        })
    }

    fn change_forward_rules(
        &self,
        host_id: &str,
        change: impl FnOnce(&mut Vec<LocalForwardInput>) -> Result<(), Error>,
    ) -> Result<(), Error> {
        let mut connection = self.connect()?;
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_error)?;
        let exists: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM hosts WHERE id=?1)",
                [host_id],
                |row| row.get(0),
            )
            .map_err(storage_error)?;
        if !exists {
            return Err(Error::NotFound);
        }
        let key = key(host_id);
        let mut saved = SavedRules {
            version: VERSION,
            rules: load(&tx, &key)?,
        };
        change(&mut saved.rules)?;
        if saved.rules.is_empty() {
            tx.execute("DELETE FROM application_settings WHERE key=?1", [&key])
                .map_err(storage_error)?;
        } else {
            let json = serde_json::to_string(&saved).map_err(storage_error)?;
            tx.execute(
                "INSERT INTO application_settings(key,value) VALUES(?1,?2)
                 ON CONFLICT(key) DO UPDATE SET value=excluded.value,
                   updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')",
                params![key, json],
            )
            .map_err(storage_error)?;
        }
        tx.commit().map_err(storage_error)
    }
}
