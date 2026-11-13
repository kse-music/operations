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
use zeroize::Zeroizing;
mod test_connection;
pub use test_connection::HostTestResult;
pub(crate) use test_connection::HostTests;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecureStatus {
    pub available: bool,
    pub message: &'static str,
}

pub(crate) fn cleanup(database: &Database, secrets: &dyn SecretStore) -> Vec<String> {
    let pending = match database.pending_secret_gc() {
        Ok(pending) => pending,
        Err(_) => return vec!["无法读取旧秘密清理状态。后续凭据变更时将重试。".into()],
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
            "旧秘密清理未完成（{failed} 项）。后续凭据变更时将重试。"
        )]
    } else {
        vec![]
    }
}

fn retry_host_secret_cleanup(database: &Database, secrets: &dyn SecretStore) {
    if !cleanup(database, secrets).is_empty() {
        tracing::warn!(
            operation = "host_secret_cleanup",
            "host secret cleanup needs a retry"
        );
    }
}

fn inline_secret(
    kind: AuthType,
    authentication: Option<HostAuthenticationInput>,
) -> Result<Option<Zeroizing<String>>, Error> {
    let secret = match (kind, authentication) {
        (_, None) => return Ok(None),
        (AuthType::Password, Some(HostAuthenticationInput::Password { password })) => {
            HostAuthenticationInput::validate_secret(&password)?;
            password
        }
        (
            AuthType::PrivateKey,
            Some(HostAuthenticationInput::PrivateKey {
                key_data,
                passphrase,
            }),
        ) => {
            let passphrase = passphrase.as_deref().map(String::as_str);
            if let Some(passphrase) = passphrase {
                HostAuthenticationInput::validate_secret(passphrase)?;
            }
            serverdeck_ssh::import_private_key(&key_data, passphrase)?
        }
        _ => return Err(Error::Validation("输入的密码或私钥与认证方式不匹配")),
    };
    Ok(Some(secret))
}

fn save_host(
    db: &Database,
    secrets: &dyn SecretStore,
    id: Option<&str>,
    input: HostInput,
    secret: Option<Zeroizing<String>>,
) -> Result<Host, Error> {
    let saved = if let Some(secret) = secret {
        let reference = Uuid::new_v4().to_string();
        db.queue_secret_gc(&reference)?;
        secrets
            .write(&reference, secret.as_bytes())
            .and_then(|()| db.host_save(id, input, Some(&reference)))
    } else {
        db.host_save(id, input, None)
    };
    retry_host_secret_cleanup(db, secrets);
    saved
}

impl Application {
    pub async fn catalog(&self) -> Result<Catalog, Error> {
        self.blocking(|db| db.catalog()).await
    }
    pub async fn host_save(
        &self,
        id: Option<String>,
        input: HostInput,
        authentication: Option<HostAuthenticationInput>,
    ) -> Result<Host, Error> {
        let secrets = self.secrets.clone();
        self.blocking(move |db| {
            let input = input.normalize()?;
            let secret = inline_secret(input.auth_type, authentication)?;
            save_host(&db, secrets.as_ref(), id.as_deref(), input, secret)
        })
        .await
    }
    pub async fn host_delete(&self, id: String) -> Result<(), Error> {
        let secrets = self.secrets.clone();
        self.blocking(move |db| {
            db.host_delete(&id)?;
            retry_host_secret_cleanup(&db, secrets.as_ref());
            Ok(())
        })
        .await
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
    fn host_input(auth_type: AuthType) -> HostInput {
        HostInput {
            ssh: Default::default(),
            name: "test".into(),
            hostname: "example.com".into(),
            port: 22,
            username: "ops".into(),
            auth_type,
            credential_id: None,
            group_id: None,
            description: String::new(),
            favorite: false,
            connect_timeout_secs: 15,
        }
    }

    #[tokio::test]
    async fn new_host_requires_successful_ssh_authentication_and_reuses_encrypted_rsa_credentials()
    {
        use russh::{
            keys::{Algorithm, PrivateKey, PublicKey, ssh_key::LineEnding},
            server,
        };
        use std::sync::atomic::AtomicUsize;

        struct TestSsh {
            calls: Arc<AtomicUsize>,
            key: PublicKey,
        }
        impl server::Handler for TestSsh {
            type Error = russh::Error;
            async fn auth_password(
                &mut self,
                user: &str,
                password: &str,
            ) -> Result<server::Auth, Self::Error> {
                self.calls.fetch_add(1, Ordering::SeqCst);
                Ok(
                    if user == "ops" && password == "fixture-ssh-test-password" {
                        server::Auth::Accept
                    } else {
                        server::Auth::reject()
                    },
                )
            }
            async fn auth_publickey(
                &mut self,
                user: &str,
                key: server::VerifiedPublicKey<'_>,
            ) -> Result<server::Auth, Self::Error> {
                Ok(if user == "ops" && key.public_key == &self.key {
                    server::Auth::Accept
                } else {
                    server::Auth::reject()
                })
            }
        }

        let dir = tempfile::tempdir().unwrap();
        let mut app = Application::initialize(dir.path().into(), dir.path().join("logs")).unwrap();
        let secrets = Arc::new(TestStore::default());
        app.secrets = secrets.clone();
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let port = listener.local_addr().unwrap().port();
        let auth_calls = Arc::new(AtomicUsize::new(0));
        let server_calls = auth_calls.clone();
        let client_key = tokio::task::spawn_blocking(|| {
            PrivateKey::random(&mut rand::rng(), Algorithm::Rsa { hash: None }).unwrap()
        })
        .await
        .unwrap();
        let authorized_key = client_key.public_key().clone();
        let sshd = tokio::spawn(async move {
            let config = Arc::new(server::Config {
                keys: vec![PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).unwrap()],
                auth_rejection_time: std::time::Duration::ZERO,
                ..Default::default()
            });
            while let Ok((socket, _)) = listener.accept().await {
                let config = config.clone();
                let handler = TestSsh {
                    calls: server_calls.clone(),
                    key: authorized_key.clone(),
                };
                tokio::spawn(async move {
                    if let Ok(session) = server::run_stream(config, socket, handler).await {
                        let _ = session.await;
                    }
                });
            }
        });
        let input = HostInput {
            hostname: "127.0.0.1".into(),
            port,
            connect_timeout_secs: 2,
            ..host_input(AuthType::Password)
        };
        let password = |value: &str| {
            Some(HostAuthenticationInput::Password {
                password: Zeroizing::new(value.into()),
            })
        };
        let correct = || password("fixture-ssh-test-password");
        assert!(
            app.host_save_tested(None, input.clone(), correct(), Uuid::new_v4())
                .await
                .is_err()
        );
        let HostTestResult::TrustRequired { key } = app
            .host_test(None, input.clone(), correct(), None)
            .await
            .unwrap()
        else {
            panic!("unseen SSH key must be confirmed");
        };
        assert_eq!(auth_calls.load(Ordering::SeqCst), 0);
        assert!(
            app.database
                .trusted_key(&input.hostname, port)
                .unwrap()
                .is_none()
        );
        let wrong_key = HostKeyFingerprint {
            fingerprint: "wrong".into(),
            ..key.clone()
        };
        assert!(matches!(
            app.host_test(None, input.clone(), correct(), Some(wrong_key))
                .await,
            Err(Error::Connection {
                code: "SSH_HOST_KEY_CHANGED",
                ..
            })
        ));
        assert_eq!(auth_calls.load(Ordering::SeqCst), 0);
        assert!(matches!(
            app.host_test(None, input.clone(), password("bad"), Some(key))
                .await,
            Err(Error::Connection {
                code: "SSH_AUTH_REJECTED",
                ..
            })
        ));

        let HostTestResult::Connected { test_id, .. } = app
            .host_test(None, input.clone(), correct(), None)
            .await
            .unwrap()
        else {
            panic!("verified credentials must pass");
        };
        assert!(app.catalog().await.unwrap().hosts.is_empty());
        assert!(secrets.values.lock().unwrap().is_empty());
        assert!(
            app.host_save_tested(None, input.clone(), password("changed"), test_id)
                .await
                .is_err()
        );
        assert!(
            app.host_save_tested(None, input.clone(), correct(), test_id)
                .await
                .is_err()
        );
        let HostTestResult::Connected { test_id, .. } = app
            .host_test(None, input.clone(), correct(), None)
            .await
            .unwrap()
        else {
            panic!("retesting must issue a receipt");
        };
        let created = app
            .host_save_tested(None, input.clone(), correct(), test_id)
            .await
            .unwrap();
        assert!(created.config.credential_id.is_some());
        assert!(
            app.host_save_tested(None, input.clone(), correct(), test_id)
                .await
                .is_err()
        );
        assert_eq!(app.catalog().await.unwrap().hosts.len(), 1);
        assert_eq!(secrets.values.lock().unwrap().len(), 1);
        assert!(auth_calls.load(Ordering::SeqCst) >= 3);

        let edit_id = Some(created.id.clone());
        let mut draft = created.config.clone();
        draft.name = "未保存的主机名".into();
        assert!(
            app.host_save_tested(edit_id.clone(), draft.clone(), None, Uuid::new_v4())
                .await
                .is_err()
        );
        let HostTestResult::Connected { test_id, .. } = app
            .host_test(edit_id.clone(), draft.clone(), None, None)
            .await
            .unwrap()
        else {
            panic!("stored password must authenticate for editing");
        };
        let copy = app.host_copy(created.id.clone()).await.unwrap();
        assert!(
            app.host_save_tested(Some(copy.id.clone()), draft.clone(), None, test_id)
                .await
                .is_err()
        );
        app.host_delete(copy.id).await.unwrap();

        let HostTestResult::Connected { test_id, .. } = app
            .host_test(edit_id.clone(), draft.clone(), None, None)
            .await
            .unwrap()
        else {
            panic!("retest must authorize the current edit");
        };
        let changed = HostInput {
            name: "测试后改名".into(),
            ..draft.clone()
        };
        assert!(
            app.host_save_tested(edit_id.clone(), changed, None, test_id)
                .await
                .is_err()
        );
        assert!(matches!(
            app.host_test(
                edit_id.clone(),
                draft.clone(),
                password("wrong replacement"),
                None
            )
            .await,
            Err(Error::Connection {
                code: "SSH_AUTH_REJECTED",
                ..
            })
        ));
        assert_eq!(
            app.database.host(&created.id).unwrap().config,
            created.config
        );
        assert_eq!(secrets.values.lock().unwrap().len(), 1);
        let HostTestResult::Connected { test_id, .. } = app
            .host_test(edit_id.clone(), draft.clone(), None, None)
            .await
            .unwrap()
        else {
            panic!("retest must authorize the current edit");
        };
        let edited = app
            .host_save_tested(edit_id.clone(), draft.clone(), None, test_id)
            .await
            .unwrap();
        assert_eq!(edited.id, created.id);
        assert_eq!(edited.config, draft);
        assert!(
            app.host_save_tested(edit_id, draft, None, test_id)
                .await
                .is_err()
        );
        assert_eq!(secrets.values.lock().unwrap().len(), 1);

        let input = HostInput {
            auth_type: AuthType::PrivateKey,
            ..input
        };
        let encrypted_key = client_key
            .encrypt(&mut rand::rng(), "fixture-rsa-passphrase")
            .unwrap();
        let key = || {
            Some(HostAuthenticationInput::PrivateKey {
                key_data: encrypted_key.to_openssh(LineEnding::LF).unwrap(),
                passphrase: Some(Zeroizing::new("fixture-rsa-passphrase".into())),
            })
        };
        let HostTestResult::Connected { test_id, .. } = app
            .host_test(None, input.clone(), key(), None)
            .await
            .unwrap()
        else {
            panic!("verified client key must pass");
        };
        let created = app
            .host_save_tested(None, input, key(), test_id)
            .await
            .unwrap();
        assert_eq!(created.config.auth_type, AuthType::PrivateKey);
        let edit_id = Some(created.id);
        let mut draft = created.config;
        draft.name = "沿用原私钥".into();
        let HostTestResult::Connected { test_id, .. } = app
            .host_test(edit_id.clone(), draft.clone(), None, None)
            .await
            .unwrap()
        else {
            panic!("stored private key must authenticate for editing");
        };
        assert_eq!(
            app.host_save_tested(edit_id, draft.clone(), None, test_id)
                .await
                .unwrap()
                .config,
            draft
        );
        assert_eq!(secrets.values.lock().unwrap().len(), 2);
        sshd.abort();
    }

    #[tokio::test]
    async fn inline_password_preserves_legacy_and_copy_credentials_and_rolls_back_on_failure() {
        let dir = tempfile::tempdir().unwrap();
        let mut app = Application::initialize(dir.path().into(), dir.path().join("logs")).unwrap();
        let secrets = Arc::new(TestStore::default());
        app.secrets = secrets.clone();
        let legacy = app
            .credential_save(None, None, credential(Some("legacy-password")))
            .await
            .unwrap()
            .value;
        let password = |value: &str| {
            Some(HostAuthenticationInput::Password {
                password: Zeroizing::new(value.to_owned()),
            })
        };
        let mut input = host_input(AuthType::Password);
        input.credential_id = Some(legacy.id.clone());
        let host = app.host_save(None, input.clone(), None).await.unwrap();
        let shared = app.host_copy(host.id.clone()).await.unwrap();
        let id = Some(host.id.clone());
        let retained = app
            .host_save(id.clone(), input.clone(), None)
            .await
            .unwrap();
        assert_eq!(retained.config.credential_id.as_ref(), Some(&legacy.id));

        secrets.unavailable.store(true, Ordering::SeqCst);
        assert!(matches!(
            app.host_save(id.clone(), input.clone(), password("failed-write"))
                .await,
            Err(Error::SecureStore(_))
        ));
        secrets.unavailable.store(false, Ordering::SeqCst);
        let mut invalid = input.clone();
        invalid.group_id = Some(Uuid::new_v4().to_string());
        assert!(matches!(
            app.host_save(id.clone(), invalid, password("failed-commit"))
                .await,
            Err(Error::Validation("分组不存在"))
        ));
        assert_eq!(app.database.host(&host.id).unwrap().config, input);
        assert_eq!(secrets.values.lock().unwrap().len(), 1);
        assert_eq!(app.catalog().await.unwrap().pending_secret_deletions, 0);

        let updated = app
            .host_save(id, input, password("new-password"))
            .await
            .unwrap();
        assert_ne!(updated.config.credential_id.as_ref(), Some(&legacy.id));
        assert_eq!(app.catalog().await.unwrap().credentials.len(), 1);
        for (id, password) in [
            (&updated.id, "new-password"),
            (&shared.id, "legacy-password"),
        ] {
            let (_, plan) =
                crate::terminal::connection_plan(&app.database, secrets.as_ref(), id).unwrap();
            assert!(
                matches!(&plan.hops[0].auth, serverdeck_ssh::Authentication::Password(secret) if secret.as_str() == password)
            );
        }
        let copy = app.host_copy(updated.id.clone()).await.unwrap();
        app.host_delete(updated.id).await.unwrap();
        assert_eq!(secrets.values.lock().unwrap().len(), 2);
        app.host_delete(copy.id).await.unwrap();
        assert_eq!(secrets.values.lock().unwrap().len(), 1);
        assert_eq!(app.catalog().await.unwrap().pending_secret_deletions, 0);
    }

    #[tokio::test]
    async fn inline_publickey_auth_imports_encrypted_private_key_and_rejects_public_key() {
        use russh::keys::{Algorithm, PrivateKey, ssh_key::LineEnding};

        let dir = tempfile::tempdir().unwrap();
        let mut app = Application::initialize(dir.path().into(), dir.path().join("logs")).unwrap();
        let secrets = Arc::new(TestStore::default());
        app.secrets = secrets.clone();
        let key = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).unwrap();
        let input = host_input(AuthType::PrivateKey);
        let result = app
            .host_save(
                None,
                input.clone(),
                Some(HostAuthenticationInput::PrivateKey {
                    key_data: Zeroizing::new(key.public_key().to_openssh().unwrap()),
                    passphrase: None,
                }),
            )
            .await;
        assert!(matches!(
            result,
            Err(Error::Connection {
                code: "SSH_KEY_UNLOCK",
                ..
            })
        ));
        assert!(app.catalog().await.unwrap().hosts.is_empty());
        assert!(secrets.values.lock().unwrap().is_empty());

        let passphrase = "inline-test-passphrase";
        let encrypted = key
            .encrypt(&mut rand::rng(), passphrase)
            .unwrap()
            .to_openssh(LineEnding::LF)
            .unwrap();
        let host = app
            .host_save(
                None,
                input,
                Some(HostAuthenticationInput::PrivateKey {
                    key_data: encrypted,
                    passphrase: Some(Zeroizing::new(passphrase.to_owned())),
                }),
            )
            .await
            .unwrap();
        let (_, plan) =
            crate::terminal::connection_plan(&app.database, secrets.as_ref(), &host.id).unwrap();
        let serverdeck_ssh::Authentication::ImportedKey(contents) = &plan.hops[0].auth else {
            panic!("expected imported SSH identity");
        };
        let decoded = russh::keys::decode_secret_key(contents, None).unwrap();
        assert_eq!(decoded.public_key(), key.public_key());
        let catalog = serde_json::to_string(&app.catalog().await.unwrap()).unwrap();
        let database = std::fs::read(dir.path().join("serverdeck.sqlite3")).unwrap();
        for secret in ["PRIVATE KEY", passphrase] {
            assert!(!catalog.contains(secret));
            assert!(
                !database
                    .windows(secret.len())
                    .any(|bytes| bytes == secret.as_bytes())
            );
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
            .host_save(
                None,
                HostInput {
                    ssh: Default::default(),
                    name: "test".into(),
                    hostname: "example.com".into(),
                    port: 22,
                    username: "ops".into(),
                    auth_type: AuthType::Password,
                    credential_id: Some(first.id.clone()),
                    group_id: None,
                    description: String::new(),
                    favorite: false,
                    connect_timeout_secs: 15,
                },
                None,
            )
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
