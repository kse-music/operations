use crate::{failure, local_cli};
use reqwest::{Client, Url};
use serde::Deserialize;
use serverdeck_core::{Error, ai::Provider};
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    process::Stdio,
    sync::Mutex,
    time::Duration,
};
use tokio::{io::AsyncWriteExt, process::Command};
use tokio_util::sync::CancellationToken;

const CLAUDE_RELEASES: &str = "https://downloads.claude.ai/claude-code-releases";
const MAX_BINARY: u64 = 512 * 1024 * 1024;

pub fn supported() -> bool {
    cfg!(windows) && matches!(std::env::consts::ARCH, "x86_64" | "aarch64")
}
fn names(provider: Provider) -> Result<(&'static str, &'static str), Error> {
    match provider {
        Provider::LocalCodex => Ok((
            "local-codex",
            if cfg!(windows) { "codex.exe" } else { "codex" },
        )),
        Provider::LocalClaudeCode => Ok((
            "local-claude-code",
            if cfg!(windows) {
                "claude.exe"
            } else {
                "claude"
            },
        )),
        _ => Err(Error::Validation("本地工具来源无效")),
    }
}
pub fn with_managed(
    found: Option<PathBuf>,
    root: Option<&Path>,
    provider: Provider,
) -> Result<Option<PathBuf>, Error> {
    if found.is_some() {
        return Ok(found);
    }
    let (id, binary) = names(provider)?;
    let Some(root) = root else {
        return Ok(None);
    };
    let path = root.join(id).join(binary);
    if path.is_file() {
        path.canonicalize().map(Some).map_err(local_cli::io_error)
    } else {
        Ok(None)
    }
}

#[derive(Default)]
pub struct Installer {
    state: Mutex<InstallState>,
    stop: CancellationToken,
}
#[derive(Default)]
struct InstallState {
    active: Option<(String, CancellationToken)>,
    cancelled: std::collections::VecDeque<String>,
}
struct Active<'a>(&'a Installer);
impl Drop for Active<'_> {
    fn drop(&mut self) {
        match self.0.state.lock() {
            Ok(mut state) => state.active = None,
            Err(_) => tracing::error!(
                operation = "ai_install_cleanup",
                "Installer state lock poisoned"
            ),
        }
    }
}
impl Installer {
    pub fn cancel(&self, id: &str) -> Result<(), Error> {
        uuid::Uuid::parse_str(id).map_err(|_| Error::Validation("安装请求 ID 无效"))?;
        let mut state = self
            .state
            .lock()
            .map_err(|_| failure("AI_STATE", "本地工具安装状态不可用"))?;
        if let Some((current, cancel)) = state.active.as_ref()
            && current == id
        {
            cancel.cancel();
            return Ok(());
        }
        if !state.cancelled.iter().any(|current| current == id) {
            if state.cancelled.len() == 32 {
                state.cancelled.pop_front();
            }
            state.cancelled.push_back(id.into());
        }
        Ok(())
    }
    pub fn shutdown(&self) {
        self.stop.cancel();
    }
    pub async fn install(&self, root: &Path, provider: Provider, id: String) -> Result<(), Error> {
        if !supported() {
            return Err(failure(
                "AI_INSTALL_PLATFORM",
                "当前平台请参照官方文档手动安装 CLI，完成后重新检测",
            ));
        }
        uuid::Uuid::parse_str(&id).map_err(|_| Error::Validation("安装请求 ID 无效"))?;
        let cancel = CancellationToken::new();
        {
            let mut state = self
                .state
                .lock()
                .map_err(|_| failure("AI_STATE", "本地工具安装状态不可用"))?;
            if let Some(index) = state.cancelled.iter().position(|current| current == &id) {
                state.cancelled.remove(index);
                return Err(failure("AI_INSTALL_CANCELLED", "已取消下载"));
            }
            if state.active.is_some() {
                return Err(Error::Busy);
            }
            state.active = Some((id, cancel.clone()));
        }
        let _active = Active(self);
        tokio::select! {
            biased;
            _ = self.stop.cancelled() => Err(Error::ShuttingDown),
            _ = cancel.cancelled() => Err(failure("AI_INSTALL_CANCELLED", "已取消下载")),
            result = tokio::time::timeout(Duration::from_secs(600), install(root, provider)) => result.map_err(|_| failure("AI_INSTALL_TIMEOUT", "下载超时，请检查网络后重试"))?,
        }
    }
}

fn allowed(url: &Url) -> bool {
    url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.port_or_known_default() == Some(443)
        && matches!(
            url.host_str(),
            Some(
                "api.github.com"
                    | "github.com"
                    | "release-assets.githubusercontent.com"
                    | "objects.githubusercontent.com"
                    | "downloads.claude.ai"
                    | "storage.googleapis.com"
            )
        )
}
fn client() -> Result<Client, Error> {
    Client::builder()
        .user_agent("ServerDeck local-tool-installer")
        .connect_timeout(Duration::from_secs(15))
        .read_timeout(Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 5 || !allowed(attempt.url()) {
                attempt.stop()
            } else {
                attempt.follow()
            }
        }))
        .build()
        .map_err(network_error)
}
fn network_error(error: reqwest::Error) -> Error {
    Error::Connection {
        code: "AI_INSTALL_NETWORK",
        message: "无法从官方源下载，请检查网络或代理后重试",
        source: Some(Box::new(error.without_url())),
    }
}
async fn response(client: &Client, url: &str) -> Result<reqwest::Response, Error> {
    let parsed = Url::parse(url).map_err(|_| Error::Validation("工具下载地址无效"))?;
    if !allowed(&parsed) {
        return Err(Error::Validation("只允许从固定官方源下载本地工具"));
    }
    let mut request = client.get(parsed.clone());
    if parsed.host_str() == Some("api.github.com") && parsed.path().contains("/releases/assets/") {
        request = request.header(reqwest::header::ACCEPT, "application/octet-stream");
    }
    let response = request.send().await.map_err(network_error)?;
    if !response.status().is_success() {
        return Err(Error::Connection {
            code: "AI_INSTALL_NETWORK",
            message: "无法从官方源下载，请检查网络或代理后重试",
            source: Some(Box::new(std::io::Error::other(format!(
                "Official download HTTP {}",
                response.status()
            )))),
        });
    }
    Ok(response)
}
async fn metadata(client: &Client, url: &str) -> Result<Vec<u8>, Error> {
    let mut response = response(client, url).await?;
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(network_error)? {
        if bytes.len() + chunk.len() > 2 * 1024 * 1024 {
            return Err(failure("AI_INSTALL_METADATA", "官方发行清单超过限制"));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}
fn invalid_metadata() -> Error {
    failure("AI_INSTALL_METADATA", "官方发行清单无效，请稍后重试")
}
fn version(value: &str) -> Result<&str, Error> {
    if value.is_empty()
        || value.len() > 80
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b".-".contains(&byte))
    {
        return Err(invalid_metadata());
    }
    Ok(value)
}
struct Artifact {
    url: String,
    checksum: String,
    size: u64,
}
#[derive(Deserialize)]
struct Release {
    tag_name: String,
    assets: Vec<Asset>,
}
#[derive(Deserialize)]
struct Asset {
    id: u64,
    name: String,
    digest: Option<String>,
    size: u64,
}
async fn artifact(client: &Client, provider: Provider) -> Result<Artifact, Error> {
    let arch = if cfg!(target_arch = "aarch64") {
        "aarch64"
    } else {
        "x86_64"
    };
    let artifact = if provider == Provider::LocalCodex {
        let bytes = metadata(
            client,
            "https://api.github.com/repos/openai/codex/releases/latest",
        )
        .await?;
        let release: Release = serde_json::from_slice(&bytes).map_err(|_| invalid_metadata())?;
        version(&release.tag_name)?;
        let name = format!("codex-{arch}-pc-windows-msvc.exe");
        let asset = release
            .assets
            .into_iter()
            .find(|asset| asset.name == name)
            .ok_or_else(invalid_metadata)?;
        if asset.id == 0 {
            return Err(invalid_metadata());
        }
        Artifact {
            url: format!(
                "https://api.github.com/repos/openai/codex/releases/assets/{}",
                asset.id
            ),
            checksum: asset
                .digest
                .and_then(|digest| digest.strip_prefix("sha256:").map(str::to_owned))
                .ok_or_else(invalid_metadata)?,
            size: asset.size,
        }
    } else if provider == Provider::LocalClaudeCode {
        let bytes = metadata(client, &format!("{CLAUDE_RELEASES}/latest")).await?;
        let release = version(
            std::str::from_utf8(&bytes)
                .map_err(|_| invalid_metadata())?
                .trim(),
        )?;
        let manifest = metadata(
            client,
            &format!("{CLAUDE_RELEASES}/{release}/manifest.json"),
        )
        .await?;
        let manifest: serde_json::Value =
            serde_json::from_slice(&manifest).map_err(|_| invalid_metadata())?;
        let platform = if arch == "aarch64" {
            "win32-arm64"
        } else {
            "win32-x64"
        };
        let entry = &manifest["platforms"][platform];
        if manifest["version"] != release || entry["binary"] != "claude.exe" {
            return Err(invalid_metadata());
        }
        Artifact {
            url: format!("{CLAUDE_RELEASES}/{release}/{platform}/claude.exe"),
            checksum: entry["checksum"]
                .as_str()
                .ok_or_else(invalid_metadata)?
                .into(),
            size: entry["size"].as_u64().ok_or_else(invalid_metadata)?,
        }
    } else {
        return Err(Error::Validation("本地工具来源无效"));
    };
    if artifact.checksum.len() != 64
        || !artifact
            .checksum
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
        || artifact.size == 0
        || artifact.size > MAX_BINARY
    {
        return Err(invalid_metadata());
    }
    Ok(artifact)
}
async fn download(client: &Client, artifact: &Artifact, path: &Path) -> Result<(), Error> {
    receive(response(client, &artifact.url).await?, artifact, path).await
}
async fn receive(
    mut response: reqwest::Response,
    artifact: &Artifact,
    path: &Path,
) -> Result<(), Error> {
    let mut file = tokio::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(path)
        .await
        .map_err(local_cli::io_error)?;
    let mut hash = Sha256::new();
    let mut received = 0_u64;
    while let Some(chunk) = response.chunk().await.map_err(network_error)? {
        received = received.saturating_add(chunk.len() as u64);
        if received > artifact.size {
            return Err(failure(
                "AI_INSTALL_SIZE",
                "下载文件超过官方声明大小，已停止安装",
            ));
        }
        hash.update(&chunk);
        file.write_all(&chunk).await.map_err(local_cli::io_error)?;
    }
    if received != artifact.size
        || !format!("{:x}", hash.finalize()).eq_ignore_ascii_case(&artifact.checksum)
    {
        return Err(failure(
            "AI_INSTALL_CHECKSUM",
            "下载文件校验失败，已停止安装，请重试",
        ));
    }
    file.sync_all().await.map_err(local_cli::io_error)?;
    Ok(())
}

async fn install(root: &Path, provider: Provider) -> Result<(), Error> {
    let (id, binary) = names(provider)?;
    let target = root.join(id);
    if target.join(binary).is_file() {
        return Ok(());
    }
    tokio::fs::create_dir_all(root)
        .await
        .map_err(local_cli::io_error)?;
    let staging = tempfile::Builder::new()
        .prefix(".download-")
        .tempdir_in(root)
        .map_err(local_cli::io_error)?;
    let client = client()?;
    let artifact = artifact(&client, provider).await?;
    let path = staging.path().join(binary);
    download(&client, &artifact, &path).await?;
    let mut command = Command::new(&path);
    command
        .arg("--version")
        .current_dir(staging.path())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let mut child = command.spawn().map_err(local_cli::io_error)?;
    if !tokio::time::timeout(Duration::from_secs(15), child.wait())
        .await
        .map_err(|_| failure("AI_INSTALL_VERIFY", "已下载工具未能启动，请检查系统要求"))?
        .map_err(local_cli::io_error)?
        .success()
    {
        return Err(failure(
            "AI_INSTALL_VERIFY",
            "已下载工具未能启动，请检查系统要求",
        ));
    }
    publish(&path, &target.join(binary)).await?;
    Ok(())
}

async fn publish(source: &Path, target: &Path) -> Result<(), Error> {
    let directory = target
        .parent()
        .ok_or(Error::Validation("本地工具安装目录无效"))?;
    tokio::fs::create_dir_all(directory)
        .await
        .map_err(local_cli::io_error)?;
    match tokio::fs::symlink_metadata(target).await {
        Ok(_) => return Err(Error::Conflict),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(local_cli::io_error(error)),
    }
    tokio::fs::rename(source, target)
        .await
        .map_err(local_cli::io_error)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::{io::AsyncReadExt, net::TcpListener};

    #[tokio::test]
    async fn missing_binary_can_be_reinstalled_in_an_existing_directory_without_overwriting_files()
    {
        let root = tempfile::tempdir().unwrap();
        let target = root.path().join("local-codex/codex.exe");
        std::fs::create_dir(target.parent().unwrap()).unwrap();
        let source = root.path().join("download");
        std::fs::write(&source, b"verified-binary").unwrap();
        publish(&source, &target).await.unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"verified-binary");
        std::fs::write(&source, b"other-binary").unwrap();
        assert!(matches!(
            publish(&source, &target).await,
            Err(Error::Conflict)
        ));
        assert_eq!(std::fs::read(&target).unwrap(), b"verified-binary");
        assert_eq!(std::fs::read(&source).unwrap(), b"other-binary");
    }

    #[test]
    fn managed_runtime_is_only_a_fallback_and_sources_are_fixed_https() {
        let root = tempfile::tempdir().unwrap();
        for provider in [Provider::LocalCodex, Provider::LocalClaudeCode] {
            let (id, binary) = names(provider).unwrap();
            assert!(
                with_managed(None, Some(root.path()), provider)
                    .unwrap()
                    .is_none()
            );
            let directory = root.path().join(id);
            std::fs::create_dir(&directory).unwrap();
            std::fs::write(directory.join(binary), b"fixture").unwrap();
            assert_eq!(
                with_managed(None, Some(root.path()), provider)
                    .unwrap()
                    .unwrap(),
                directory.join(binary).canonicalize().unwrap()
            );
            let existing = PathBuf::from("existing-cli");
            assert_eq!(
                with_managed(Some(existing.clone()), Some(root.path()), provider).unwrap(),
                Some(existing)
            );
        }
        for address in [
            "http://github.com/openai/codex",
            "https://github.com.evil.test/file",
            "https://user@github.com/file",
            "https://github.com:444/file",
            "file:///tmp/payload",
        ] {
            assert!(!allowed(&Url::parse(address).unwrap()), "{address}");
        }
        assert!(allowed(
            &Url::parse(
                "https://github.com/openai/codex/releases/download/rust-v0.167.0/codex.exe"
            )
            .unwrap()
        ));
        assert!(version("../payload").is_err());
        assert!(version("v1?token=secret").is_err());
    }
    async fn fixture(body: &'static [u8]) -> reqwest::Response {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = [0; 2048];
            assert!(stream.read(&mut request).await.unwrap() > 0);
            stream
                .write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        body.len()
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
            stream.write_all(body).await.unwrap();
        });
        // Only this test transport uses loopback; production keeps the fixed HTTPS allowlist.
        Client::new()
            .get(format!("http://{address}"))
            .send()
            .await
            .unwrap()
    }
    #[tokio::test]
    async fn download_rejects_truncation_checksum_mismatch_and_oversize_without_overwriting() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("binary");
        let mut artifact = Artifact {
            url: String::new(),
            checksum: format!("{:x}", Sha256::digest(b"native")),
            size: 6,
        };
        receive(fixture(b"native").await, &artifact, &path)
            .await
            .unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"native");
        assert!(
            receive(fixture(b"changed").await, &artifact, &path)
                .await
                .is_err()
        );
        assert_eq!(std::fs::read(&path).unwrap(), b"native");
        for (index, size, checksum, expected) in [
            (0, 5, artifact.checksum.clone(), "AI_INSTALL_SIZE"),
            (1, 7, artifact.checksum.clone(), "AI_INSTALL_CHECKSUM"),
            (2, 6, "0".repeat(64), "AI_INSTALL_CHECKSUM"),
        ] {
            artifact.size = size;
            artifact.checksum = checksum;
            let error = receive(
                fixture(b"native").await,
                &artifact,
                &directory.path().join(format!("invalid-{index}")),
            )
            .await
            .err()
            .unwrap();
            assert_eq!(serverdeck_core::IpcError::from(error).code, expected);
        }
    }
    #[cfg(windows)]
    #[tokio::test]
    async fn early_cancellation_shutdown_and_active_install_release_are_bounded() {
        let installer = Installer::default();
        let root = tempfile::tempdir().unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        installer.cancel(&id).unwrap();
        let error = installer
            .install(root.path(), Provider::LocalCodex, id)
            .await
            .err()
            .unwrap();
        assert_eq!(
            serverdeck_core::IpcError::from(error).code,
            "AI_INSTALL_CANCELLED"
        );
        assert!(std::fs::read_dir(root.path()).unwrap().next().is_none());
        for _ in 0..40 {
            installer.cancel(&uuid::Uuid::new_v4().to_string()).unwrap();
        }
        assert_eq!(installer.state.lock().unwrap().cancelled.len(), 32);
        installer.shutdown();
        let error = installer
            .install(
                root.path(),
                Provider::LocalClaudeCode,
                uuid::Uuid::new_v4().to_string(),
            )
            .await
            .err()
            .unwrap();
        assert!(matches!(error, Error::ShuttingDown));
        assert!(installer.state.lock().unwrap().active.is_none());
        assert!(std::fs::read_dir(root.path()).unwrap().next().is_none());
    }
}
