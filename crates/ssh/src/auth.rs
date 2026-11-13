use super::*;
use russh::keys::{
    PrivateKey, PrivateKeyWithHashAlg,
    agent::{AgentIdentity, client::AgentClient},
    ssh_key::LineEnding,
};
use std::{io::Read, path::PathBuf};

const KEY_FILE_LIMIT: usize = 1024 * 1024;

fn decode_private_key(contents: &str, passphrase: Option<&str>) -> Result<PrivateKey, Error> {
    russh::keys::decode_secret_key(contents, passphrase).map_err(|error| Error::Connection {
        code: "SSH_KEY_UNLOCK",
        message: "私钥格式不支持或口令错误",
        source: Some(Box::new(error)),
    })
}

/// Normalize a key for the OS credential store. The supplied passphrase is used only to unlock it.
pub fn import_private_key(
    contents: &str,
    passphrase: Option<&str>,
) -> Result<Zeroizing<String>, Error> {
    if contents.is_empty() || contents.len() > KEY_FILE_LIMIT {
        return Err(Error::Validation("私钥文件须为 1 字节至 1 MiB"));
    }
    let mut key = decode_private_key(contents, passphrase)?;
    key.set_comment("");
    key.to_openssh(LineEnding::LF)
        .map_err(|error| Error::Connection {
            code: "SSH_KEY_FORMAT",
            message: "无法转换私钥格式，请选择 OpenSSH 支持的私钥文件",
            source: Some(Box::new(error)),
        })
}

fn read_legacy_key(path: &str) -> Result<Zeroizing<String>, Error> {
    let path = if let Some(suffix) = path.strip_prefix("~/").or_else(|| path.strip_prefix("~\\")) {
        std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
            .map(|home| PathBuf::from(home).join(suffix))
            .ok_or_else(|| failure("SSH_KEY_FILE", "无法解析用户私钥路径"))?
    } else {
        PathBuf::from(path)
    };
    if !path.is_absolute() {
        return Err(failure("SSH_KEY_FILE", "私钥路径必须是绝对路径或 ~/ 路径"));
    }
    let file = std::fs::File::open(path).map_err(|error| Error::Connection {
        code: "SSH_KEY_FILE",
        message: "无法读取私钥文件，请检查路径和权限",
        source: Some(Box::new(error)),
    })?;
    let metadata = file.metadata().map_err(|error| Error::Connection {
        code: "SSH_KEY_FILE",
        message: "无法读取私钥文件信息",
        source: Some(Box::new(error)),
    })?;
    if !metadata.is_file() || metadata.len() > KEY_FILE_LIMIT as u64 {
        return Err(failure("SSH_KEY_FILE", "私钥文件无效或超过 1 MiB"));
    }
    let mut contents = Zeroizing::new(String::new());
    file.take(KEY_FILE_LIMIT as u64 + 1)
        .read_to_string(&mut contents)
        .map_err(|error| Error::Connection {
            code: "SSH_KEY_FILE",
            message: "私钥文件读取失败或不是受支持的文本格式",
            source: Some(Box::new(error)),
        })?;
    if contents.len() > KEY_FILE_LIMIT {
        return Err(failure("SSH_KEY_FILE", "私钥文件超过 1 MiB"));
    }
    Ok(contents)
}

async fn authenticate_key(
    handle: &mut client::Handle<trust::Verifier>,
    username: &str,
    decode: impl FnOnce() -> Result<PrivateKey, Error> + Send + 'static,
) -> Result<bool, Error> {
    let key = tokio::task::spawn_blocking(decode)
        .await
        .map_err(|error| Error::Worker(Box::new(error)))??;
    let hash = if key.algorithm().is_rsa() {
        Some(
            handle
                .best_supported_rsa_hash()
                .await
                .map_err(network)?
                .flatten()
                .ok_or_else(|| {
                    failure(
                        "SSH_RSA_SHA2_REQUIRED",
                        "服务器未声明支持 RSA SHA-2 签名，请升级服务器 SSH 或改用 Ed25519/ECDSA 私钥",
                    )
                })?,
        )
    } else {
        None
    };
    Ok(handle
        .authenticate_publickey(username, PrivateKeyWithHashAlg::new(Arc::new(key), hash))
        .await
        .map_err(network)?
        .success())
}

pub(crate) async fn authenticate(
    handle: &mut client::Handle<trust::Verifier>,
    username: &str,
    auth: Authentication,
) -> Result<(), Error> {
    let success = match auth {
        Authentication::Password(password) => handle
            .authenticate_password(username, password.as_str())
            .await
            .map_err(network)?
            .success(),
        Authentication::PrivateKey { path, passphrase } => {
            authenticate_key(handle, username, move || {
                decode_private_key(
                    &read_legacy_key(&path)?,
                    passphrase.as_deref().map(String::as_str),
                )
            })
            .await?
        }
        Authentication::ImportedKey(contents) => {
            authenticate_key(handle, username, move || {
                decode_private_key(&contents, None)
            })
            .await?
        }
        Authentication::Agent => return authenticate_agent(handle, username).await,
    };
    if success {
        Ok(())
    } else {
        Err(failure(
            "SSH_AUTH_REJECTED",
            "SSH 认证失败，请检查用户名和凭据（不会自动尝试其他认证方式）",
        ))
    }
}

async fn authenticate_agent(
    handle: &mut client::Handle<trust::Verifier>,
    username: &str,
) -> Result<(), Error> {
    #[cfg(windows)]
    let agent = AgentClient::connect_named_pipe(r"\\.\pipe\openssh-ssh-agent").await;
    #[cfg(unix)]
    let agent = AgentClient::connect_env().await;
    let mut agent = agent.map_err(|e| Error::Connection {
        code: "SSH_AGENT_UNAVAILABLE",
        message: "系统 SSH Agent 不可用，请启动服务并加载密钥",
        source: Some(Box::new(e)),
    })?;
    authenticate_with_agent(handle, username, &mut agent).await
}

async fn authenticate_with_agent<H, S>(
    handle: &mut client::Handle<H>,
    username: &str,
    agent: &mut AgentClient<S>,
) -> Result<(), Error>
where
    H: client::Handler<Error = russh::Error>,
    S: russh::keys::agent::client::AgentStream + Send + Unpin,
{
    let identities = agent
        .request_identities()
        .await
        .map_err(|e| Error::Connection {
            code: "SSH_AGENT",
            message: "读取 SSH Agent 身份失败",
            source: Some(Box::new(e)),
        })?;
    if identities.len() > 32 {
        return Err(failure(
            "SSH_AGENT",
            "SSH Agent 身份超过 32 个，请精简加载的密钥",
        ));
    }
    for identity in identities {
        let AgentIdentity::PublicKey { key, .. } = identity else {
            continue;
        };
        let hash = if key.algorithm().is_rsa() {
            match handle
                .best_supported_rsa_hash()
                .await
                .map_err(network)?
                .flatten()
            {
                Some(hash) => Some(hash),
                None => continue,
            }
        } else {
            None
        };
        if handle
            .authenticate_publickey_with(username, key, hash, agent)
            .await
            .map_err(|e| Error::Connection {
                code: "SSH_AGENT",
                message: "SSH Agent 签名或认证失败",
                source: Some(Box::new(e)),
            })?
            .success()
        {
            return Ok(());
        }
    }
    Err(failure(
        "SSH_AUTH_REJECTED",
        "SSH Agent 没有可用于此账户的有效身份",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use russh::{
        keys::{Algorithm, PrivateKey, PublicKey, PublicKeyOrCertificate},
        server,
    };
    struct Pinned(PublicKey);
    impl client::Handler for Pinned {
        type Error = russh::Error;
        async fn check_server_key(
            &mut self,
            key: &PublicKeyOrCertificate,
        ) -> Result<bool, Self::Error> {
            Ok(key.certificate().is_none() && key.public_key() == self.0)
        }
    }
    struct PublicAuth(PublicKey);
    impl server::Handler for PublicAuth {
        type Error = russh::Error;
        async fn auth_publickey(
            &mut self,
            user: &str,
            key: server::VerifiedPublicKey<'_>,
        ) -> Result<server::Auth, Self::Error> {
            Ok(if user == "fixture" && key.public_key == &self.0 {
                server::Auth::Accept
            } else {
                server::Auth::reject()
            })
        }
    }
    #[tokio::test]
    async fn agent_protocol_lists_identities_signs_and_authenticates_real_ssh() {
        let host = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).expect("host key");
        let user = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).expect("agent key");
        let public = user.public_key().clone();
        let pin = host.public_key().clone();
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("listen");
        let address = listener.local_addr().expect("address");
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.expect("accept");
            let config = Arc::new(server::Config {
                keys: vec![host],
                ..Default::default()
            });
            let session = server::run_stream(config, stream, PublicAuth(public))
                .await
                .expect("server");
            let _ = session.await;
        });
        let (tx, rx) = tokio::sync::mpsc::channel(1);
        let agent_server = tokio::spawn(russh::keys::agent::server::serve(
            tokio_stream::wrappers::ReceiverStream::new(rx),
            (),
        ));
        #[cfg(windows)]
        let mut agent = {
            let name = format!(r"\\.\pipe\serverdeck-test-{}", uuid::Uuid::new_v4());
            let pipe = tokio::net::windows::named_pipe::ServerOptions::new()
                .first_pipe_instance(true)
                .create(&name)
                .expect("isolated agent pipe");
            let agent = AgentClient::connect_named_pipe(&name)
                .await
                .expect("connect pipe");
            pipe.connect().await.expect("accept pipe");
            tx.send(Ok(pipe)).await.expect("agent listener");
            agent
        };
        #[cfg(unix)]
        let mut agent = {
            let (client, server) = tokio::io::duplex(64 * 1024);
            tx.send(Ok(server)).await.expect("agent listener");
            AgentClient::connect(client)
        };
        agent
            .add_identity(&user, &[])
            .await
            .expect("load generated identity");
        let mut connection =
            client::connect(Arc::new(client::Config::default()), address, Pinned(pin))
                .await
                .expect("handshake");
        authenticate_with_agent(&mut connection, "fixture", &mut agent)
            .await
            .expect("agent signature verified by SSH server");
        connection
            .disconnect(russh::Disconnect::ByApplication, "", "en")
            .await
            .expect("disconnect");
        agent_server.abort();
        server.abort();
    }
}
