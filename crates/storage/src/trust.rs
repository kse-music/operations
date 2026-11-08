use super::{Database, storage_error};
use rusqlite::{OptionalExtension, params};
use serverdeck_core::Error;

impl Database {
    pub fn trusted_key(&self, hostname: &str, port: u16) -> Result<Option<String>, Error> {
        self.connect()?
            .query_row(
                "SELECT public_key FROM ssh_known_hosts WHERE hostname=?1 AND port=?2",
                params![hostname, port],
                |r| r.get(0),
            )
            .optional()
            .map_err(storage_error)
    }

    // Immutable TOFU entry: concurrent confirmations can never replace an existing key.
    pub fn trust_key(
        &self,
        hostname: &str,
        port: u16,
        key: &str,
        fingerprint: &str,
    ) -> Result<(), Error> {
        let connection = self.connect()?;
        connection.execute("INSERT OR IGNORE INTO ssh_known_hosts(hostname,port,public_key,fingerprint) VALUES(?1,?2,?3,?4)",params![hostname,port,key,fingerprint]).map_err(storage_error)?;
        if self.trusted_key(hostname, port)?.as_deref() != Some(key) {
            return Err(Error::Conflict);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn trust_is_persistent_and_never_replaces_changed_key() {
        let dir = tempfile::tempdir().expect("tempdir");
        let db = Database::open(dir.path().join("db")).expect("open");
        assert!(db.trusted_key("localhost", 22).expect("lookup").is_none());
        db.trust_key("localhost", 22, "key-a", "fingerprint-a")
            .expect("trust");
        assert!(matches!(
            db.trust_key("localhost", 22, "key-b", "fingerprint-b"),
            Err(Error::Conflict)
        ));
        let db = Database::open(dir.path().join("db")).expect("reopen");
        assert_eq!(
            db.trusted_key("localhost", 22).expect("lookup").as_deref(),
            Some("key-a")
        );
        assert!(db.trusted_key("localhost", 23).expect("lookup").is_none());
    }
}
