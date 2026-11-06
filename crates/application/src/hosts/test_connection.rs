use super::{inline_secret, save_host};
use crate::{Application, terminal::plan_for_target};
use serde::Serialize;
use serverdeck_core::{
    Error,
    hosts::{AuthType, Host, HostAuthenticationInput, HostInput, HostKeyFingerprint},
};
use serverdeck_security::SecretStore;
use serverdeck_ssh::{Authentication, ConnectionPlan};
use serverdeck_storage::Database;
use sha2::{Digest, Sha256};
use std::time::{Duration, Instant};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;
use zeroize::Zeroizing;

const RECEIPT_LIFETIME: Duration = Duration::from_secs(300);
const TEST_REQUIRED: Error = Error::Validation("请先测试当前 SSH 配置，测试成功后五分钟内保存");

#[derive(Default)]
pub(crate) struct HostTests {
    receipt: Mutex<Option<Receipt>>,
    pub(crate) stop: CancellationToken,
}

struct Receipt {
    id: Uuid,
    binding: [u8; 32],
    expires: Instant,
}

#[derive(Serialize)]
#[serde(
    tag = "status",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum HostTestResult {
    TrustRequired {
        key: HostKeyFingerprint,
    },
    Connected {
        test_id: Uuid,
        expires_in_seconds: u64,
    },
}

fn prepare(
    db: &Database,
    secrets: &dyn SecretStore,
    host_id: Option<&str>,
    input: HostInput,
    authentication: Option<HostAuthenticationInput>,
) -> Result<(Host, Option<Zeroizing<String>>, ConnectionPlan), Error> {
    let input = input.normalize()?;
    let secret = inline_secret(input.auth_type, authentication)?;
    if host_id.is_none() && secret.is_none() {
        return Err(Error::Validation("请填写 SSH 密码或私钥后再测试连接"));
    }
    let auth = match (input.auth_type, &secret) {
        (_, None) => None,
        (AuthType::Password, Some(secret)) => Some(Authentication::Password(secret.clone())),
        (AuthType::PrivateKey, Some(secret)) => Some(Authentication::ImportedKey(secret.clone())),
        (AuthType::Agent, Some(_)) => {
            return Err(Error::Validation("SSH Agent 无需填写密码或私钥"));
        }
    };
    let host = match host_id {
        Some(id) => Host {
            config: input,
            ..db.host(id)?
        },
        None => Host {
            id: String::new(),
            config: input,
            created_at: String::new(),
            updated_at: String::new(),
        },
    };
    let plan = plan_for_target(db, secrets, host.clone(), auth)?;
    Ok((host, secret, plan))
}

fn binding(
    id: Uuid,
    host: &Host,
    secret: Option<&str>,
    plan: &ConnectionPlan,
) -> Result<[u8; 32], Error> {
    let metadata = serde_json::to_vec(&(host, plan.signature()?, secret.is_some()))
        .map_err(|error| Error::Worker(Box::new(error)))?;
    let mut digest = Sha256::new();
    digest.update(id.as_bytes());
    digest.update(metadata);
    digest.update([0]);
    digest.update(secret.unwrap_or_default().as_bytes());
    Ok(digest.finalize().into())
}

impl Application {
    pub async fn host_test(
        &self,
        host_id: Option<String>,
        input: HostInput,
        authentication: Option<HostAuthenticationInput>,
        confirmed: Option<HostKeyFingerprint>,
    ) -> Result<HostTestResult, Error> {
        let mut receipt = self
            .host_tests
            .receipt
            .try_lock()
            .map_err(|_| Error::Busy)?;
        *receipt = None;
        let id = Uuid::new_v4();
        let secrets = self.secrets.clone();
        let (plan, binding) = self
            .blocking(move |db| {
                let (host, secret, plan) = prepare(
                    &db,
                    secrets.as_ref(),
                    host_id.as_deref(),
                    input,
                    authentication,
                )?;
                let binding = binding(
                    id,
                    &host,
                    secret.as_ref().map(|secret| secret.as_str()),
                    &plan,
                )?;
                Ok((plan, binding))
            })
            .await?;
        let challenge = tokio::select! {
            _ = self.host_tests.stop.cancelled() => return Err(Error::ShuttingDown),
            result = tokio::time::timeout(
                Duration::from_secs(60),
                self.terminals.test_connection(plan, confirmed),
            ) => result.map_err(|_| Error::Connection {
                code: "SSH_TIMEOUT",
                message: "SSH 连接测试超过 60 秒，请检查连接设置",
                source: None,
            })??,
        };
        if let Some(key) = challenge {
            return Ok(HostTestResult::TrustRequired { key });
        }
        *receipt = Some(Receipt {
            id,
            binding,
            expires: Instant::now() + RECEIPT_LIFETIME,
        });
        Ok(HostTestResult::Connected {
            test_id: id,
            expires_in_seconds: RECEIPT_LIFETIME.as_secs(),
        })
    }

    pub async fn host_save_tested(
        &self,
        host_id: Option<String>,
        input: HostInput,
        authentication: Option<HostAuthenticationInput>,
        test_id: Uuid,
    ) -> Result<Host, Error> {
        let mut slot = self
            .host_tests
            .receipt
            .try_lock()
            .map_err(|_| Error::Busy)?;
        if slot.as_ref().is_none_or(|receipt| receipt.id != test_id) {
            return Err(TEST_REQUIRED);
        }
        let receipt = slot.take().ok_or(TEST_REQUIRED)?;
        drop(slot);
        let secrets = self.secrets.clone();
        self.blocking(move |db| {
            if receipt.expires <= Instant::now() {
                return Err(TEST_REQUIRED);
            }
            let (host, secret, plan) = prepare(
                &db,
                secrets.as_ref(),
                host_id.as_deref(),
                input,
                authentication,
            )?;
            if receipt.binding
                != binding(
                    receipt.id,
                    &host,
                    secret.as_ref().map(|secret| secret.as_str()),
                    &plan,
                )?
            {
                return Err(TEST_REQUIRED);
            }
            save_host(
                &db,
                secrets.as_ref(),
                host_id.as_deref(),
                host.config,
                secret,
            )
        })
        .await
    }
}
