use super::SecretStore;
use serverdeck_core::Error;
use uuid::Uuid;
use zeroize::Zeroizing;

// Windows CRED_MAX_CREDENTIAL_BLOB_SIZE. Other stores can use the same layout.
const CHUNK_SIZE: usize = 2560;
const SECRET_LIMIT: usize = 1024 * 1024;
const PREFIX: &str = "chunked:v1:";

/// Allocate an immutable secret version before recording its durable cleanup intent.
/// The versioned reference describes every chunk, including after a partial write.
pub fn new_secret_reference(secret: &[u8]) -> Result<String, Error> {
    if secret.len() > SECRET_LIMIT {
        return Err(Error::Validation("安全凭据内容不能超过 1 MiB"));
    }
    let id = Uuid::new_v4();
    Ok(if secret.len() > CHUNK_SIZE {
        format!("{PREFIX}{id}:{}", secret.len())
    } else {
        id.to_string()
    })
}

fn chunked_length(reference: &str) -> Result<Option<usize>, Error> {
    if let Some(scoped) = reference.strip_prefix("ssh-session:") {
        return scoped
            .split_once(':')
            .and_then(|(id, size)| {
                let id = Uuid::parse_str(id).ok()?;
                let size = size.parse::<usize>().ok()?;
                (scoped == format!("{id}:{size}") && (1..=SECRET_LIMIT).contains(&size))
                    .then_some(Some(size))
            })
            .ok_or(Error::Validation("SSH 会话快照引用无效"));
    }
    if !reference.starts_with("chunked:") {
        return Ok(None);
    }
    let parsed = reference
        .strip_prefix(PREFIX)
        .and_then(|value| value.split_once(':'))
        .and_then(|(id, length)| {
            let id = Uuid::parse_str(id).ok()?;
            let length = length.parse::<usize>().ok()?;
            (reference == format!("{PREFIX}{id}:{length}")
                && (CHUNK_SIZE + 1..=SECRET_LIMIT).contains(&length))
            .then_some(length)
        });
    parsed
        .map(Some)
        .ok_or(Error::Validation("安全凭据引用格式或版本不受支持"))
}

fn chunk_reference(reference: &str, index: usize) -> String {
    format!("{reference}:{index}")
}

pub(super) fn write(store: &dyn SecretStore, reference: &str, secret: &[u8]) -> Result<(), Error> {
    let Some(length) = chunked_length(reference)? else {
        return store.write(reference, secret);
    };
    if secret.len() != length {
        return Err(Error::Validation("安全凭据内容长度与引用不匹配"));
    }
    for (index, chunk) in secret.chunks(CHUNK_SIZE).enumerate() {
        store.write(&chunk_reference(reference, index), chunk)?;
    }
    Ok(())
}

pub(super) fn read(
    store: &dyn SecretStore,
    reference: &str,
) -> Result<Option<Zeroizing<Vec<u8>>>, Error> {
    let Some(length) = chunked_length(reference)? else {
        return store.read(reference);
    };
    let mut secret = Zeroizing::new(Vec::with_capacity(length));
    let mut missing = false;
    for index in 0..length.div_ceil(CHUNK_SIZE) {
        match store.read(&chunk_reference(reference, index))? {
            Some(chunk) => {
                if chunk.len() != CHUNK_SIZE.min(length - index * CHUNK_SIZE) {
                    return Err(Error::Validation(
                        "系统凭据库中的分块凭据已损坏，请重新导入",
                    ));
                }
                secret.extend_from_slice(&chunk);
            }
            None => missing = true,
        }
    }
    if secret.is_empty() {
        Ok(None)
    } else if missing {
        Err(Error::Validation(
            "系统凭据库中的分块凭据不完整，请重新导入",
        ))
    } else {
        Ok(Some(secret))
    }
}

pub(super) fn delete(store: &dyn SecretStore, reference: &str) -> Result<(), Error> {
    let Some(length) = chunked_length(reference)? else {
        return store.delete(reference);
    };
    for index in 0..length.div_ceil(CHUNK_SIZE) {
        store.delete(&chunk_reference(reference, index))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests;
