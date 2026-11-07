use crate::failure;
use serverdeck_core::{Error, ai::Config};
use std::path::{Path, PathBuf};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, BufReader},
    process::{ChildStderr, ChildStdout},
};
use zeroize::Zeroizing;

pub struct Snapshot {
    pub config: Config,
    pub revision: String,
    pub runtime: Zeroizing<Vec<u8>>,
}

pub fn find_executable(candidates: fn(&Path) -> Vec<PathBuf>) -> Result<Option<PathBuf>, Error> {
    let mut directories: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|value| std::env::split_paths(&value).collect())
        .unwrap_or_default();
    if let Some(home) = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }) {
        directories.push(PathBuf::from(&home).join(".local/bin"));
        directories.push(PathBuf::from(home).join(".cargo/bin"));
    }
    for directory in directories
        .into_iter()
        .filter(|directory| directory.is_absolute())
    {
        for path in candidates(&directory) {
            if path.is_file() {
                return path.canonicalize().map(Some).map_err(io_error);
            }
        }
    }
    Ok(None)
}

pub fn io_error(error: std::io::Error) -> Error {
    Error::Connection {
        code: "AI_LOCAL_IO",
        message: "本地智能体进程通信失败，请检查安装和文件访问权限",
        source: Some(Box::new(error)),
    }
}

pub fn drain_stderr(mut stderr: ChildStderr) -> tokio::task::JoinHandle<Zeroizing<Vec<u8>>> {
    tokio::spawn(async move {
        let mut diagnostic = Zeroizing::new(Vec::new());
        let mut buffer = [0; 4096];
        loop {
            match stderr.read(&mut buffer).await {
                Ok(0) => break,
                Ok(length) => {
                    let remaining = (16 * 1024_usize).saturating_sub(diagnostic.len());
                    diagnostic.extend_from_slice(&buffer[..length.min(remaining)]);
                }
                Err(error) => {
                    tracing::warn!(operation="ai_local_stderr", kind=?error.kind(), "Local agent diagnostic pipe failed");
                    break;
                }
            }
        }
        diagnostic
    })
}

pub async fn read_line(
    output: &mut BufReader<ChildStdout>,
    received: &mut usize,
) -> Result<Option<Zeroizing<Vec<u8>>>, Error> {
    let mut bytes = Zeroizing::new(Vec::new());
    loop {
        let buffer = output.fill_buf().await.map_err(io_error)?;
        if buffer.is_empty() {
            return Ok((!bytes.is_empty()).then_some(bytes));
        }
        let length = buffer
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(buffer.len(), |index| index + 1);
        *received += length;
        if bytes.len() + length > 1024 * 1024 || *received > 4 * 1024 * 1024 {
            return Err(failure("AI_OUTPUT_LIMIT", "本地智能体响应超过限制"));
        }
        bytes.extend_from_slice(&buffer[..length]);
        output.consume(length);
        if bytes.last() == Some(&b'\n') {
            return Ok(Some(bytes));
        }
    }
}
