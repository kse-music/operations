use serverdeck_core::Error;
use zeroize::Zeroizing;

const SERVICE: &str = "io.serverdeck.desktop.credentials.v1";

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
        keyring::Entry::new(SERVICE, reference)
            .map_err(failure)?
            .set_secret(secret)
            .map_err(failure)
    }
    fn read(&self, reference: &str) -> Result<Option<Zeroizing<Vec<u8>>>, Error> {
        match keyring::Entry::new(SERVICE, reference)
            .map_err(failure)?
            .get_secret()
        {
            Ok(secret) => Ok(Some(Zeroizing::new(secret))),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(failure(error)),
        }
    }
    fn delete(&self, reference: &str) -> Result<(), Error> {
        match keyring::Entry::new(SERVICE, reference)
            .map_err(failure)?
            .delete_credential()
        {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(failure(error)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
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
