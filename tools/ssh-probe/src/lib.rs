use std::{sync::Arc, time::Duration};

use anyhow::{Context, Result, bail, ensure};
use russh::{
    Channel, ChannelMsg, client,
    keys::{HashAlg, PrivateKey, PrivateKeyWithHashAlg, PublicKeyOrCertificate},
};

pub const TIMEOUT: Duration = Duration::from_secs(15);
pub struct PinnedClient {
    expected: String,
}

impl PinnedClient {
    pub fn new(expected: String) -> Result<Self> {
        ensure!(
            expected.starts_with("SHA256:") && expected.len() == 50,
            "a SHA256 host key fingerprint is required"
        );
        Ok(Self { expected })
    }
}

impl client::Handler for PinnedClient {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        presented: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        // Certificates require a separate CA/validity/principal policy. Fail closed here.
        Ok(presented.certificate().is_none()
            && presented
                .public_key()
                .fingerprint(HashAlg::Sha256)
                .to_string()
                == self.expected)
    }
}

pub type Connection = client::Handle<PinnedClient>;

pub async fn connect(host: &str, port: u16, fingerprint: String) -> Result<Connection> {
    let config = client::Config {
        inactivity_timeout: Some(Duration::from_secs(30)),
        channel_buffer_size: 16,
        ..Default::default()
    };
    Ok(tokio::time::timeout(
        TIMEOUT,
        client::connect(
            Arc::new(config),
            (host, port),
            PinnedClient::new(fingerprint)?,
        ),
    )
    .await
    .context("SSH handshake timed out")??)
}

pub async fn authenticate_key(
    connection: &mut Connection,
    user: &str,
    key: PrivateKey,
) -> Result<()> {
    let hash = if key.algorithm().is_rsa() {
        Some(
            connection
                .best_supported_rsa_hash()
                .await?
                .flatten()
                .context("RSA SHA-2 support is required; SHA-1 fallback is disabled")?,
        )
    } else {
        None
    };
    let result = connection
        .authenticate_publickey(user, PrivateKeyWithHashAlg::new(Arc::new(key), hash))
        .await?;
    ensure!(result.success(), "private key authentication rejected");
    Ok(())
}

pub async fn authenticate_agent(connection: &mut Connection, user: &str) -> Result<()> {
    #[cfg(windows)]
    let mut agent =
        russh::keys::agent::client::AgentClient::connect_named_pipe(r"\\.\pipe\openssh-ssh-agent")
            .await?;
    #[cfg(unix)]
    let mut agent = russh::keys::agent::client::AgentClient::connect_env().await?;
    let identities = agent.request_identities().await?;
    for identity in identities {
        // Never silently treat an agent certificate as a plain public key.
        let russh::keys::agent::AgentIdentity::PublicKey { key, .. } = identity else {
            continue;
        };
        let hash = if key.algorithm().is_rsa() {
            match connection.best_supported_rsa_hash().await?.flatten() {
                Some(hash) => Some(hash),
                None => continue,
            }
        } else {
            None
        };
        if connection
            .authenticate_publickey_with(user, key, hash, &mut agent)
            .await?
            .success()
        {
            return Ok(());
        }
    }
    bail!("agent authentication rejected or no supported identities available")
}

async fn accepted(channel: &mut Channel<client::Msg>) -> Result<()> {
    loop {
        match channel.wait().await {
            Some(ChannelMsg::Success) => return Ok(()),
            Some(ChannelMsg::Failure | ChannelMsg::Close) | None => {
                bail!("channel request rejected")
            }
            _ => (),
        }
    }
}

async fn collect(mut channel: Channel<client::Msg>) -> Result<Vec<u8>> {
    let mut output = Vec::new();
    let mut status = None;
    loop {
        match channel.wait().await {
            Some(ChannelMsg::Data { data }) => {
                ensure!(
                    output.len() + data.len() <= 16 * 1024,
                    "probe output exceeded limit"
                );
                output.extend_from_slice(&data);
            }
            Some(ChannelMsg::ExitStatus { exit_status }) => status = Some(exit_status),
            Some(ChannelMsg::Failure) => bail!("exec request rejected"),
            Some(ChannelMsg::Close) | None => break,
            _ => (),
        }
    }
    ensure!(
        status == Some(0),
        "remote command did not exit successfully"
    );
    Ok(output)
}

/// Fixed harmless POSIX commands only, no interpolation of user input.
/// Opens a PTY and SFTP subsystem alongside two exec channels on one transport.
pub async fn check_channels(connection: &Connection) -> Result<usize> {
    let checks = async {
        let mut pty = connection.channel_open_session().await?;
        pty.request_pty(true, "xterm-256color", 80, 24, 0, 0, &[])
            .await?;
        accepted(&mut pty).await?;
        pty.window_change(100, 40, 0, 0).await?;
        pty.request_shell(true).await?;
        accepted(&mut pty).await?;

        let first = connection.channel_open_session().await?;
        let second = connection.channel_open_session().await?;
        ensure!(
            first.id() != second.id() && first.id() != pty.id(),
            "channel IDs must be distinct"
        );
        first.exec(true, "printf serverdeck-probe-a").await?;
        second.exec(true, "printf serverdeck-probe-b").await?;

        let mut files = connection.channel_open_session().await?;
        files.request_subsystem(true, "sftp").await?;
        accepted(&mut files).await?;
        let sftp = russh_sftp::client::SftpSession::new(files.into_stream()).await?;
        let (first, second, directory) =
            tokio::try_join!(collect(first), collect(second), async {
                Ok::<_, anyhow::Error>(sftp.read_dir(".").await?.count())
            })?;
        ensure!(
            first == b"serverdeck-probe-a" && second == b"serverdeck-probe-b",
            "channel output isolation failed"
        );
        sftp.close().await?;
        // Exec + SFTP closure must not close an independent PTY.
        pty.data(&b"stty size\n"[..]).await?;
        let mut size_output = Vec::new();
        loop {
            match pty.wait().await {
                Some(ChannelMsg::Data { data }) => {
                    ensure!(
                        size_output.len() + data.len() <= 16 * 1024,
                        "PTY probe output exceeded limit"
                    );
                    size_output.extend_from_slice(&data);
                    if size_output.windows(6).any(|bytes| bytes == b"40 100") {
                        break;
                    }
                }
                Some(ChannelMsg::Close | ChannelMsg::Failure) | None => {
                    bail!("PTY closed before size verification")
                }
                _ => (),
            }
        }
        pty.data(&b"exit\n"[..]).await?;
        pty.eof().await?;
        pty.close().await?;
        Ok(directory)
    };
    tokio::time::timeout(TIMEOUT, checks)
        .await
        .context("channel probe timed out")?
}
