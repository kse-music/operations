use super::*;
use std::{collections::HashMap, sync::Mutex};

#[derive(Default)]
struct Store {
    values: Mutex<HashMap<String, Vec<u8>>>,
    fail_write: Option<usize>,
    fail_delete: Mutex<Option<usize>>,
}

fn injected_failure() -> Error {
    Error::SecureStore(Box::new(std::io::Error::other("injected failure")))
}

impl SecretStore for Store {
    fn write(&self, reference: &str, secret: &[u8]) -> Result<(), Error> {
        if self
            .fail_write
            .is_some_and(|index| reference.ends_with(&format!(":{index}")))
        {
            return Err(injected_failure());
        }
        assert!(secret.len() <= CHUNK_SIZE, "native credential size limit");
        self.values
            .lock()
            .unwrap()
            .insert(reference.into(), secret.into());
        Ok(())
    }
    fn read(&self, reference: &str) -> Result<Option<Zeroizing<Vec<u8>>>, Error> {
        Ok(self
            .values
            .lock()
            .unwrap()
            .get(reference)
            .cloned()
            .map(Zeroizing::new))
    }
    fn delete(&self, reference: &str) -> Result<(), Error> {
        if self
            .fail_delete
            .lock()
            .unwrap()
            .is_some_and(|index| reference.ends_with(&format!(":{index}")))
        {
            return Err(injected_failure());
        }
        self.values.lock().unwrap().remove(reference);
        Ok(())
    }
}

#[test]
fn roundtrips_binary_secrets_at_chunk_boundaries_and_limit() {
    let store = Store::default();
    for length in [
        0,
        CHUNK_SIZE,
        CHUNK_SIZE + 1,
        CHUNK_SIZE * 2,
        CHUNK_SIZE * 2 + 1,
        SECRET_LIMIT,
    ] {
        let secret = Zeroizing::new(
            (0..length)
                .map(|index| (index % 251) as u8)
                .collect::<Vec<_>>(),
        );
        let reference = new_secret_reference(&secret).unwrap();
        assert!(read(&store, &reference).unwrap().is_none());
        write(&store, &reference, &secret).unwrap();
        assert_eq!(
            read(&store, &reference).unwrap().unwrap().as_slice(),
            secret.as_slice()
        );
        delete(&store, &reference).unwrap();
        delete(&store, &reference).unwrap();
        assert!(read(&store, &reference).unwrap().is_none());
        assert!(store.values.lock().unwrap().is_empty());
    }
}

#[test]
fn legacy_entries_and_new_versions_remain_independent() {
    let store = Store::default();
    // Existing non-Windows entries can already exceed the Windows limit.
    let legacy = vec![42; CHUNK_SIZE * 2];
    store
        .values
        .lock()
        .unwrap()
        .insert("legacy-reference".into(), legacy.clone());
    let reference = new_secret_reference(&legacy).unwrap();
    assert_ne!(reference, new_secret_reference(&legacy).unwrap());
    write(&store, &reference, &legacy).unwrap();
    delete(&store, &reference).unwrap();
    assert_eq!(
        read(&store, "legacy-reference")
            .unwrap()
            .unwrap()
            .as_slice(),
        legacy.as_slice()
    );
    delete(&store, "legacy-reference").unwrap();
    assert!(store.values.lock().unwrap().is_empty());
}

#[test]
fn partial_write_is_rejected_and_cleanup_needs_only_the_original_reference() {
    let store = Store {
        fail_write: Some(1),
        ..Default::default()
    };
    let secret = vec![42; CHUNK_SIZE * 3];
    let reference = new_secret_reference(&secret).unwrap();
    assert!(matches!(
        write(&store, &reference, &secret),
        Err(Error::SecureStore(_))
    ));
    assert_eq!(store.values.lock().unwrap().len(), 1);
    assert!(read(&store, &reference).is_err());
    delete(&store, &reference).unwrap();
    assert!(store.values.lock().unwrap().is_empty());
}

#[test]
fn deletion_can_retry_after_partial_failure_without_touching_other_versions() {
    let store = Store::default();
    let secret = vec![42; CHUNK_SIZE * 3];
    let reference = new_secret_reference(&secret).unwrap();
    let other = new_secret_reference(&secret).unwrap();
    write(&store, &reference, &secret).unwrap();
    write(&store, &other, &secret).unwrap();
    *store.fail_delete.lock().unwrap() = Some(1);
    assert!(matches!(
        delete(&store, &reference),
        Err(Error::SecureStore(_))
    ));
    assert!(read(&store, &reference).is_err());
    *store.fail_delete.lock().unwrap() = None;
    delete(&store, &reference).unwrap();
    assert!(read(&store, &reference).unwrap().is_none());
    assert_eq!(
        read(&store, &other).unwrap().unwrap().as_slice(),
        secret.as_slice()
    );
}

#[test]
fn missing_and_truncated_chunks_never_return_partial_secrets() {
    let store = Store::default();
    let secret = vec![42; CHUNK_SIZE * 3];
    let reference = new_secret_reference(&secret).unwrap();
    for index in 0..3 {
        write(&store, &reference, &secret).unwrap();
        store
            .values
            .lock()
            .unwrap()
            .remove(&chunk_reference(&reference, index));
        assert!(read(&store, &reference).is_err());
    }
    write(&store, &reference, &secret).unwrap();
    store
        .values
        .lock()
        .unwrap()
        .get_mut(&chunk_reference(&reference, 2))
        .unwrap()
        .pop();
    assert!(read(&store, &reference).is_err());
}

#[test]
fn rejects_unknown_versions_invalid_lengths_and_mismatched_writes_before_storage() {
    let store = Store::default();
    let id = Uuid::new_v4();
    for reference in [
        format!("chunked:v2:{id}:3000"),
        "chunked:v1:invalid:3000".into(),
        format!("{PREFIX}{id}:0"),
        format!("{PREFIX}{id}:2560"),
        format!("{PREFIX}{id}:{}", SECRET_LIMIT + 1),
        format!("{PREFIX}{id}:9999999999999999999999999999999999"),
        format!("{PREFIX}{id}:3000:0"),
    ] {
        assert!(write(&store, &reference, b"secret").is_err());
        assert!(read(&store, &reference).is_err());
        assert!(delete(&store, &reference).is_err());
    }
    let reference = new_secret_reference(&vec![0; CHUNK_SIZE + 1]).unwrap();
    assert!(write(&store, &reference, b"wrong length").is_err());
    assert!(new_secret_reference(&vec![0; SECRET_LIMIT + 1]).is_err());
    assert!(store.values.lock().unwrap().is_empty());
}

#[test]
fn ssh_session_chunks_have_separate_names_and_roundtrip_small_and_large_snapshots() {
    let store = Store::default();
    let id = Uuid::new_v4();
    store.write(&id.to_string(), b"host reference").unwrap();
    for size in [32, CHUNK_SIZE + 1] {
        let reference = format!("ssh-session:{id}:{size}");
        let blob = vec![42; size];
        write(&store, &reference, &blob).unwrap();
        assert_eq!(read(&store, &reference).unwrap().unwrap().as_slice(), blob);
        delete(&store, &reference).unwrap();
        assert!(read(&store, &reference).unwrap().is_none());
        assert_eq!(
            store.read(&id.to_string()).unwrap().unwrap().as_slice(),
            b"host reference"
        );
    }
}
