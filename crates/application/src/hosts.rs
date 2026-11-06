use super::Application;
use serde::Serialize;
use serverdeck_core::{
    Error,
    hosts::*,
    openssh::{self, ImportPreview},
};
use serverdeck_security::SecretStore;
use serverdeck_storage::Database;
use uuid::Uuid;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecureStatus {
    pub available: bool,
    pub message: &'static str,
}

pub(crate) fn cleanup(database: &Database, secrets: &dyn SecretStore) -> Vec<String> {
    let pending = match database.pending_secret_gc() {
        Ok(pending) => pending,
        Err(_) => return vec!["配置已保存，但无法读取旧秘密清理状态，请重试清理。".into()],
    };
    let mut failed = 0;
    for reference in pending {
        match secrets.delete(&reference) {
            Ok(()) => {
                if database.complete_secret_gc(&reference).is_err() {
                    failed += 1;
                }
            }
            Err(_) => failed += 1, // NativeStore already records the failure at its boundary.
        }
    }
    if failed > 0 {
        vec![format!(
            "配置已保存；{failed} 个旧秘密删除或清理登记未完成，请恢复服务后点击“重试清理”"
        )]
    } else {
        vec![]
    }
}

impl Application {
    pub async fn catalog(&self) -> Result<Catalog, Error> {
        self.blocking(|db| db.catalog()).await
    }
    pub async fn host_create(&self, input: HostInput) -> Result<Host, Error> {
        self.blocking(move |db| db.host_create(input)).await
    }
    pub async fn host_update(&self, id: String, input: HostInput) -> Result<Host, Error> {
        self.blocking(move |db| db.host_update(&id, input)).await
    }
    pub async fn host_delete(&self, id: String) -> Result<(), Error> {
        self.blocking(move |db| db.host_delete(&id)).await
    }
    pub async fn host_copy(&self, id: String) -> Result<Host, Error> {
        self.blocking(move |db| db.host_copy(&id)).await
    }
    pub async fn group_save(
        &self,
        id: Option<String>,
        input: GroupInput,
    ) -> Result<HostGroup, Error> {
        self.blocking(move |db| db.group_save(id.as_deref(), input))
            .await
    }
    pub async fn group_delete(&self, id: String) -> Result<(), Error> {
        self.blocking(move |db| db.group_delete(&id)).await
    }

    pub async fn secure_status(&self) -> Result<SecureStatus, Error> {
        let secrets = self.secrets.clone();
        self.blocking(move |_| {
            Ok(match secrets.read("availability-check-v1") {
                Ok(_) => SecureStatus {
                    available: true,
                    message: "系统凭据库可读取。秘密写入仍以保存操作的实际结果为准。",
                },
                Err(_) => SecureStatus {
                    available: false,
                    message: "系统凭据库不可用，无法保存密码或导入私钥。",
                },
            })
        })
        .await
    }

    pub async fn credential_save(
        &self,
        id: Option<String>,
        expected_revision: Option<u32>,
        input: CredentialInput,
    ) -> Result<Mutation<Credential>, Error> {
        input.validate()?;
        let secrets = self.secrets.clone();
        self.blocking(move |db| {
            let old = id.as_ref().map(|id| db.credential_record(id)).transpose()?;
            if let Some(old) = &old {
                if Some(old.public.revision) != expected_revision || old.public.kind != input.kind {
                    return Err(Error::Conflict);
                }
            } else if expected_revision.is_some() {
                return Err(Error::Validation("新建凭据不能带有旧版本"));
            }
            let was_imported = old.as_ref().is_some_and(|record| {
                record.public.kind == AuthType::PrivateKey && record.public.key_path.is_none()
            });
            if was_imported
                && input.key_data.is_none()
                && (input.key_path.is_some() || input.secret.is_some() || input.clear_secret)
            {
                return Err(Error::Validation("更换已导入的私钥需要选择新的私钥文件"));
            }
            let key_path = if input.key_data.is_some() {
                None
            } else {
                input.key_path.as_deref().map(str::trim).or_else(|| {
                    old.as_ref()
                        .and_then(|record| record.public.key_path.as_deref())
                })
            };
            if input.kind == AuthType::PrivateKey
                && key_path.is_none()
                && input.key_data.is_none()
                && !was_imported
            {
                return Err(Error::Validation("请选择要导入的私钥文件"));
            }
            let secret = match &input.key_data {
                Some(key) => Some(serverdeck_ssh::import_private_key(
                    key,
                    input.secret.as_deref().map(String::as_str),
                )?),
                None => input.secret,
            };
            let previous_reference = old.as_ref().and_then(|r| r.secret_ref.clone());
            let reference = if secret.is_some() {
                Some(Uuid::new_v4().to_string())
            } else if input.clear_secret {
                None
            } else {
                previous_reference
            };
            if input.kind == AuthType::Password && reference.is_none() {
                return Err(Error::Validation("密码凭据必须设置密码，不能清空"));
            }
            let id = id.unwrap_or_else(|| Uuid::new_v4().to_string());
            // Immutable secret version: never overwrite the old entry before SQLite commits.
            if let (Some(secret), Some(reference)) = (&secret, &reference) {
                db.queue_secret_gc(reference)?;
                secrets.write(reference, secret.as_bytes())?;
            }
            let saved = db.credential_save(
                &id,
                expected_revision,
                input.name.trim(),
                input.kind,
                key_path,
                reference.as_deref(),
            );
            match saved {
                Ok(value) => Ok(Mutation {
                    value,
                    warnings: cleanup(&db, secrets.as_ref()),
                }),
                Err(error) => {
                    if secret.is_some()
                        && let Some(reference) = reference
                        && secrets.delete(&reference).is_ok()
                    {
                        // The intent remains durable if cleanup acknowledgement fails.
                        let _ = db.complete_secret_gc(&reference);
                    }
                    Err(error)
                }
            }
        })
        .await
    }

    pub async fn credential_delete(
        &self,
        id: String,
        detach_hosts: bool,
    ) -> Result<Mutation<()>, Error> {
        let secrets = self.secrets.clone();
        self.blocking(move |db| {
            db.credential_delete(&id, detach_hosts)?;
            Ok(Mutation {
                value: (),
                warnings: cleanup(&db, secrets.as_ref()),
            })
        })
        .await
    }
    pub async fn cleanup_secrets(&self) -> Result<Mutation<()>, Error> {
        let secrets = self.secrets.clone();
        self.blocking(move |db| {
            Ok(Mutation {
                value: (),
                warnings: cleanup(&db, secrets.as_ref()),
            })
        })
        .await
    }
    pub async fn import_preview(&self, text: String) -> Result<ImportPreview, Error> {
        self.blocking(move |db| {
            let mut preview = openssh::preview(
                &text,
                &local_username(),
                db.load_config()?.connect_timeout_secs,
            )?;
            db.annotate_duplicates(&mut preview)?;
            Ok(preview)
        })
        .await
    }
    pub async fn import_hosts(
        &self,
        text: String,
        selected: Vec<String>,
        group_id: Option<String>,
    ) -> Result<Mutation<Vec<Host>>, Error> {
        self.blocking(move |db| {
            let preview = openssh::preview(
                &text,
                &local_username(),
                db.load_config()?.connect_timeout_secs,
            )?;
            db.import_hosts(preview.candidates, &selected, group_id)
        })
        .await
    }
}
fn local_username() -> String {
    std::env::var(if cfg!(windows) { "USERNAME" } else { "USER" }).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        collections::HashMap,
        sync::{
            Arc, Mutex,
            atomic::{AtomicBool, Ordering},
        },
    };
    use zeroize::Zeroizing;
    #[derive(Default)]
    struct TestStore {
        values: Mutex<HashMap<String, Vec<u8>>>,
        unavailable: AtomicBool,
    }
    impl SecretStore for TestStore {
        fn write(&self, reference: &str, secret: &[u8]) -> Result<(), Error> {
            if self.unavailable.load(Ordering::SeqCst) {
                return Err(Error::SecureStore(Box::new(std::io::Error::other(
                    "test failure",
                ))));
            }
            self.values
                .lock()
                .expect("store")
                .insert(reference.into(), secret.to_vec());
            Ok(())
        }
        fn read(&self, reference: &str) -> Result<Option<Zeroizing<Vec<u8>>>, Error> {
            Ok(self
                .values
                .lock()
                .expect("store")
                .get(reference)
                .cloned()
                .map(Zeroizing::new))
        }
        fn delete(&self, reference: &str) -> Result<(), Error> {
            if self.unavailable.load(Ordering::SeqCst) {
                return Err(Error::SecureStore(Box::new(std::io::Error::other(
                    "test failure",
                ))));
            }
            self.values.lock().expect("store").remove(reference);
            Ok(())
        }
    }
    fn credential(secret: Option<&str>) -> CredentialInput {
        CredentialInput {
            name: "测试密码".into(),
            kind: AuthType::Password,
            key_path: None,
            key_data: None,
            secret: secret.map(|s| Zeroizing::new(s.to_owned())),
            clear_secret: false,
        }
    }
    #[tokio::test]
    async fn secrets_are_separate_rotated_and_deleted_with_explicit_host_detachment() {
        let directory = tempfile::tempdir().expect("dir");
        let mut app =
            Application::initialize(directory.path().join("data"), directory.path().join("logs"))
                .expect("app");
        let secrets = Arc::new(TestStore::default());
        app.secrets = secrets.clone();
        let first = app
            .credential_save(None, None, credential(Some("test-only-secret")))
            .await
            .expect("save")
            .value;
        let host = app
            .host_create(HostInput {
                ssh: Default::default(),
                name: "test".into(),
                hostname: "example.com".into(),
                port: 22,
                username: "ops".into(),
                auth_type: AuthType::Password,
                credential_id: Some(first.id.clone()),
                group_id: None,
                tags: vec![],
                description: String::new(),
                favorite: false,
                connect_timeout_secs: 15,
            })
            .await
            .expect("host");
        assert!(matches!(
            app.credential_delete(first.id.clone(), false).await,
            Err(Error::Conflict)
        ));
        let second = app
            .credential_save(
                Some(first.id.clone()),
                Some(first.revision),
                credential(Some("replacement-test-secret")),
            )
            .await
            .expect("update")
            .value;
        assert_eq!(secrets.values.lock().expect("store").len(), 1);
        assert!(matches!(
            app.credential_save(
                Some(first.id.clone()),
                Some(first.revision),
                credential(Some("stale"))
            )
            .await,
            Err(Error::Conflict)
        ));
        let catalog = serde_json::to_string(&app.catalog().await.expect("catalog")).expect("json");
        for forbidden in ["secretRef", "test-only-secret", "replacement-test-secret"] {
            assert!(!catalog.contains(forbidden));
        }
        let bytes =
            std::fs::read(directory.path().join("data/serverdeck.sqlite3")).expect("database");
        assert!(
            !bytes
                .windows(b"replacement-test-secret".len())
                .any(|w| w == b"replacement-test-secret")
        );
        secrets.unavailable.store(true, Ordering::SeqCst);
        let result = app
            .credential_delete(second.id, true)
            .await
            .expect("durable delete");
        assert!(!result.warnings.is_empty());
        let catalog = app.catalog().await.expect("catalog");
        assert_eq!(catalog.pending_secret_deletions, 1);
        assert!(
            catalog
                .hosts
                .iter()
                .find(|h| h.id == host.id)
                .expect("host")
                .config
                .credential_id
                .is_none()
        );
        secrets.unavailable.store(false, Ordering::SeqCst);
        assert!(
            app.cleanup_secrets()
                .await
                .expect("cleanup")
                .warnings
                .is_empty()
        );
        assert!(secrets.values.lock().expect("store").is_empty());
    }
    #[tokio::test]
    async fn unavailable_vault_never_creates_plaintext_fallback() {
        let directory = tempfile::tempdir().expect("dir");
        let mut app =
            Application::initialize(directory.path().to_owned(), directory.path().join("logs"))
                .expect("app");
        let secrets = Arc::new(TestStore::default());
        secrets.unavailable.store(true, Ordering::SeqCst);
        app.secrets = secrets;
        assert!(matches!(
            app.credential_save(None, None, credential(Some("never-persist-this")))
                .await,
            Err(Error::SecureStore(_))
        ));
        assert!(app.catalog().await.expect("catalog").credentials.is_empty());
    }

    #[tokio::test]
    async fn encrypted_key_import_replaces_legacy_path_without_persisting_file_or_passphrase() {
        use russh::keys::{Algorithm, PrivateKey, ssh_key::LineEnding};

        let dir = tempfile::tempdir().unwrap();
        let mut app = Application::initialize(dir.path().into(), dir.path().join("logs")).unwrap();
        let secrets = Arc::new(TestStore::default());
        app.secrets = secrets.clone();
        let legacy = app
            .credential_save(
                None,
                None,
                CredentialInput {
                    kind: AuthType::PrivateKey,
                    key_path: Some("~/.ssh/legacy-test-key".into()),
                    ..credential(Some("legacy-test-passphrase"))
                },
            )
            .await
            .unwrap()
            .value;
        let key = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).unwrap();
        let encrypted = key
            .encrypt(&mut rand::rng(), "import-test-passphrase")
            .unwrap()
            .to_openssh(LineEnding::LF)
            .unwrap();
        let input = |passphrase| CredentialInput {
            kind: AuthType::PrivateKey,
            key_data: Some(encrypted.clone()),
            ..credential(Some(passphrase))
        };
        let failed = app
            .credential_save(
                Some(legacy.id.clone()),
                Some(legacy.revision),
                input("wrong-passphrase"),
            )
            .await;
        assert!(matches!(
            failed,
            Err(Error::Connection {
                code: "SSH_KEY_UNLOCK",
                ..
            })
        ));
        assert_eq!(
            app.catalog().await.unwrap().credentials[0].revision,
            legacy.revision
        );
        assert!(
            app.catalog().await.unwrap().credentials[0]
                .key_path
                .is_some()
        );
        let saved = app
            .credential_save(
                Some(legacy.id.clone()),
                Some(legacy.revision),
                input("import-test-passphrase"),
            )
            .await
            .unwrap()
            .value;
        assert_eq!(saved.id, legacy.id);
        assert!(saved.key_path.is_none() && saved.has_secret);
        let reference = app
            .database
            .credential_record(&saved.id)
            .unwrap()
            .secret_ref
            .unwrap();
        let stored = secrets.read(&reference).unwrap().unwrap();
        let decoded =
            russh::keys::decode_secret_key(std::str::from_utf8(&stored).unwrap(), None).unwrap();
        assert_eq!(decoded.public_key(), key.public_key());
        assert_eq!(secrets.values.lock().unwrap().len(), 1);
        let bytes = std::fs::read(dir.path().join("serverdeck.sqlite3")).unwrap();
        for secret in [
            "PRIVATE KEY",
            "import-test-passphrase",
            "legacy-test-passphrase",
        ] {
            assert!(
                !bytes
                    .windows(secret.len())
                    .any(|bytes| bytes == secret.as_bytes())
            );
        }
        let renamed = app
            .credential_save(
                Some(saved.id.clone()),
                Some(saved.revision),
                CredentialInput {
                    kind: AuthType::PrivateKey,
                    name: "已导入密钥".into(),
                    ..credential(None)
                },
            )
            .await
            .unwrap()
            .value;
        assert!(renamed.key_path.is_none() && renamed.has_secret);
        assert_eq!(
            app.database
                .credential_record(&renamed.id)
                .unwrap()
                .secret_ref
                .as_deref(),
            Some(reference.as_str())
        );
        app.credential_delete(saved.id, false).await.unwrap();
        assert!(secrets.read(&reference).unwrap().is_none());
    }
}
