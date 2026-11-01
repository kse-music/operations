use anyhow::{Context, Result, bail, ensure};
use serverdeck_ssh_probe::{
    TIMEOUT, authenticate_agent, authenticate_key, check_channels, connect,
};
use zeroize::Zeroizing;

#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args.len() < 5 {
        bail!(
            "usage: serverdeck-ssh-probe HOST PORT USER SHA256:FINGERPRINT password|key|agent [KEY_PATH]\nOnly run against an authorized POSIX server. Secrets are prompted, never passed on the command line."
        );
    }
    let port: u16 = args[1].parse().context("invalid port")?;
    ensure!(port > 0, "port must be nonzero");
    let mut connection = connect(&args[0], port, args[3].clone()).await?;
    let authentication = async {
        match args[4].as_str() {
            "password" => {
                let password = Zeroizing::new(rpassword::prompt_password("SSH password: ")?);
                ensure!(
                    connection
                        .authenticate_password(&args[2], password.as_str())
                        .await?
                        .success(),
                    "password authentication rejected"
                );
            }
            "key" => {
                let path = args.get(5).context("KEY_PATH is required")?;
                let passphrase = Zeroizing::new(rpassword::prompt_password(
                    "Key passphrase (empty for unencrypted): ",
                )?);
                let key = russh::keys::load_secret_key(
                    path,
                    if passphrase.is_empty() {
                        None
                    } else {
                        Some(passphrase.as_str())
                    },
                )?;
                ensure!(
                    !key.algorithm().is_rsa(),
                    "RSA private-key signing is disabled for external probes: RUSTSEC-2023-0071 has no patched version. Use Ed25519 or an OS agent pending review."
                );
                authenticate_key(&mut connection, &args[2], key).await?;
            }
            "agent" => authenticate_agent(&mut connection, &args[2]).await?,
            _ => bail!("authentication must be password, key or agent"),
        }
        Ok::<_, anyhow::Error>(())
    };
    // The console prompt is synchronous; the network operations are time bounded.
    let authenticated = tokio::time::timeout(TIMEOUT, authentication).await;
    let result: Result<()> = async {
        authenticated.context("authentication timed out")??;
        let count = check_channels(&connection).await?;
        println!("PASS: pinned host key, authentication, PTY/shell, stty size after resize, independent exec channels, SFTP directory listing ({count} entries).");
        println!("This does not verify terminal rendering, transfer integrity or other OS compatibility.");
        Ok(())
    }.await;
    let disconnect = connection
        .disconnect(russh::Disconnect::ByApplication, "probe finished", "en")
        .await;
    result?;
    disconnect?;
    Ok(())
}
