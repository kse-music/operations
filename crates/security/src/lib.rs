use serverdeck_core::Error;
use serverdeck_core::identity::{CREDENTIAL_SERVICE, LEGACY_APPLICATION_ID};
use zeroize::Zeroizing;

fn legacy_service() -> String {
    format!("{LEGACY_APPLICATION_ID}.credentials.v1")
}

// Different implementations are used only for OS storage and fault-injection tests.
pub trait SecretStore: Send + Sync {
    fn write(&self, reference: &str, secret: &[u8]) -> Result<(), Error>;
    fn read(&self, reference: &str) -> Result<Option<Zeroizing<Vec<u8>>>, Error>;
    fn delete(&self, reference: &str) -> Result<(), Error>;
}
pub struct NativeStore;
fn failure(error: keyring::Error) -> Error {
    tracing::error!(
        operation = "secure_store",
        "native credential store operation failed"
    );
    Error::SecureStore(Box::new(error))
}
impl SecretStore for NativeStore {
    fn write(&self, reference: &str, secret: &[u8]) -> Result<(), Error> {
        keyring::Entry::new(CREDENTIAL_SERVICE, reference)
            .map_err(failure)?
            .set_secret(secret)
            .map_err(failure)
    }
    fn read(&self, reference: &str) -> Result<Option<Zeroizing<Vec<u8>>>, Error> {
        if let Some(secret) = read_service(CREDENTIAL_SERVICE, reference)? {
            return Ok(Some(secret));
        }
        let secret = read_service(&legacy_service(), reference)?;
        if let Some(secret) = &secret {
            self.write(reference, secret)?;
        }
        Ok(secret)
    }
    fn delete(&self, reference: &str) -> Result<(), Error> {
        // Remove legacy first: a failed deletion must not resurrect an old secret
        // through the read fallback after the current entry has been removed.
        for service in [&legacy_service(), CREDENTIAL_SERVICE] {
            match keyring::Entry::new(service, reference)
                .map_err(failure)?
                .delete_credential()
            {
                Ok(()) | Err(keyring::Error::NoEntry) => (),
                Err(error) => return Err(failure(error)),
            }
        }
        Ok(())
    }
}

fn read_service(service: &str, reference: &str) -> Result<Option<Zeroizing<Vec<u8>>>, Error> {
    match keyring::Entry::new(service, reference)
        .map_err(failure)?
        .get_secret()
    {
        Ok(secret) => Ok(Some(Zeroizing::new(secret))),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(failure(error)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[ignore = "Explicit OS credential-store migration test; uses only a random test entry"]
    fn native_store_migrates_legacy_secret_and_delete_prevents_resurrection() {
        let reference = format!("identity-migration-test-{}", uuid::Uuid::new_v4());
        let legacy = keyring::Entry::new(&legacy_service(), &reference).unwrap();
        let current = keyring::Entry::new(CREDENTIAL_SERVICE, &reference).unwrap();
        let store = NativeStore;
        legacy.set_secret(b"ephemeral-legacy-secret").unwrap();
        let result = (|| {
            let migrated = store.read(&reference)?;
            let copied = read_service(CREDENTIAL_SERVICE, &reference)?;
            store.write(&reference, b"replacement-secret")?;
            let replacement = store.read(&reference)?;
            store.delete(&reference)?;
            let removed = store.read(&reference)?.is_none();
            Ok::<_, Error>((migrated, copied, replacement, removed))
        })();
        // Always attempt cleanup of both owned entries, including on an API error.
        store.delete(&reference).unwrap();
        let (migrated, copied, replacement, removed) = result.unwrap();
        assert_eq!(migrated.unwrap().as_slice(), b"ephemeral-legacy-secret");
        assert_eq!(copied.unwrap().as_slice(), b"ephemeral-legacy-secret");
        assert_eq!(replacement.unwrap().as_slice(), b"replacement-secret");
        assert!(removed);
        assert!(matches!(legacy.get_secret(), Err(keyring::Error::NoEntry)));
        assert!(matches!(current.get_secret(), Err(keyring::Error::NoEntry)));
    }
    #[test]
    #[ignore = "Explicit OS credential-store integration test; creates and removes only a random test entry"]
    fn native_store_roundtrip_update_and_delete() {
        let reference = format!("integration-test-{}", uuid::Uuid::new_v4());
        let store = NativeStore;
        assert!(store.read(&reference).expect("read").is_none());
        store
            .write(&reference, b"ephemeral-test-secret")
            .expect("write");
        assert_eq!(
            store
                .read(&reference)
                .expect("read")
                .expect("secret")
                .as_slice(),
            b"ephemeral-test-secret"
        );
        store
            .write(&reference, b"replacement-test-secret")
            .expect("replace");
        assert_eq!(
            store
                .read(&reference)
                .expect("read")
                .expect("secret")
                .as_slice(),
            b"replacement-test-secret"
        );
        store.delete(&reference).expect("delete");
        assert!(store.read(&reference).expect("removed").is_none());
    }
}
