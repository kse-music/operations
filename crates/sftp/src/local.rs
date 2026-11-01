use crate::*;
use serverdeck_core::files::*;
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};
use tokio::io::AsyncReadExt;

pub(crate) fn io(error: std::io::Error) -> Error {
    let (code, message) = match error.kind() {
        std::io::ErrorKind::PermissionDenied => ("LOCAL_PERMISSION", "本地文件权限不足"),
        std::io::ErrorKind::AlreadyExists => ("FILE_CONFLICT", "目标已存在，请选择冲突策略"),
        std::io::ErrorKind::NotFound => ("LOCAL_NOT_FOUND", "本地路径不存在，请刷新"),
        _ => ("LOCAL_IO", "本地文件读写失败，请检查路径、空间和权限"),
    };
    Error::Connection {
        code,
        message,
        source: Some(Box::new(error)),
    }
}
pub(crate) fn text(path: &Path) -> Result<String, Error> {
    path.to_str()
        .map(str::to_owned)
        .ok_or_else(|| fail("LOCAL_ENCODING", "本地路径不是有效 Unicode，不能安全传输"))
}
pub(crate) fn link(meta: &std::fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        meta.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        meta.file_type().is_symlink()
    }
}
pub(crate) fn validate_name(name: &str) -> Result<(), Error> {
    if name.is_empty() || matches!(name, "." | "..") || name.contains(['/', '\0']) {
        return Err(fail("LOCAL_NAME", "文件名不能映射到本地路径"));
    }
    #[cfg(windows)]
    {
        let stem = name
            .split('.')
            .next()
            .unwrap_or_default()
            .to_ascii_uppercase();
        if name.contains(['\\', ':', '<', '>', '"', '|', '?', '*'])
            || name.chars().any(char::is_control)
            || name.ends_with(['.', ' '])
            || ["CON", "PRN", "AUX", "NUL"].contains(&stem.as_str())
            || (stem.len() == 4
                && (stem.starts_with("COM") || stem.starts_with("LPT"))
                && matches!(stem.as_bytes()[3], b'1'..=b'9'))
        {
            return Err(fail(
                "LOCAL_NAME",
                "远程名称与 Windows 文件命名规则不兼容，未更改名称或创建替代文件",
            ));
        }
    }
    Ok(())
}
pub async fn listing(path: Option<String>) -> Result<DirectoryListing, Error> {
    let input = path
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from)
        })
        .ok_or(Error::Validation("请指定本地目录"))?;
    valid_path(&text(&input)?)?;
    let root = tokio::fs::canonicalize(input).await.map_err(io)?;
    let mut directory = tokio::fs::read_dir(&root).await.map_err(io)?;
    let mut entries = Vec::new();
    while let Some(entry) = directory.next_entry().await.map_err(io)? {
        let path = entry.path();
        let metadata = tokio::fs::symlink_metadata(&path).await.map_err(io)?;
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| fail("LOCAL_ENCODING", "目录包含非 Unicode 文件名，无法安全列出"))?;
        #[cfg(unix)]
        let permissions = {
            use std::os::unix::fs::MetadataExt;
            Some(metadata.mode() & 0o7777)
        };
        #[cfg(not(unix))]
        let permissions = None;
        entries.push(FileEntry {
            name,
            path: text(&path)?,
            kind: if link(&metadata) {
                EntryKind::Symlink
            } else if metadata.is_dir() {
                EntryKind::Directory
            } else if metadata.is_file() {
                EntryKind::File
            } else {
                EntryKind::Other
            },
            size: metadata.is_file().then_some(metadata.len()),
            modified: metadata
                .modified()
                .ok()
                .and_then(|v| v.duration_since(UNIX_EPOCH).ok())
                .map(|v| v.as_secs()),
            permissions,
            uid: None,
            gid: None,
        });
        if entries.len() > LIST_LIMIT {
            return Err(fail(
                "LOCAL_LIMIT",
                "本地单目录超过 20000 项，请选择更小目录",
            ));
        }
    }
    Ok(DirectoryListing {
        parent: root.parent().map(text).transpose()?,
        path: text(&root)?,
        entries,
    })
}
pub(crate) async fn hash(path: &Path) -> Result<String, Error> {
    let mut file = tokio::fs::File::open(path).await.map_err(io)?;
    let mut digest = Sha256::new();
    let mut buffer = vec![0; 65536];
    loop {
        let n = file.read(&mut buffer).await.map_err(io)?;
        if n == 0 {
            break;
        }
        digest.update(&buffer[..n]);
    }
    Ok(format!("{:x}", digest.finalize()))
}
pub(crate) fn same(a: &std::fs::Metadata, b: &std::fs::Metadata) -> bool {
    a.len() == b.len()
        && a.modified().ok() == b.modified().ok()
        && a.file_type() == b.file_type()
        && a.permissions().readonly() == b.permissions().readonly()
}
