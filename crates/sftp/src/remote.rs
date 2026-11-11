use crate::*;
use russh_sftp::{
    client::{Config, RawSftpSession, error::Error as SftpError},
    protocol::{FileAttributes, OpenFlags, Packet, StatusCode},
};
use serverdeck_core::files::*;
use sha2::{Digest, Sha256};

pub(crate) fn map(error: SftpError) -> Error {
    let (code, message) = match &error {
        SftpError::Status(s) => match s.status_code {
            StatusCode::PermissionDenied => ("SFTP_PERMISSION", "远程权限不足，未完成文件操作"),
            StatusCode::NoSuchFile => ("SFTP_NOT_FOUND", "远程文件或目录不存在，请刷新"),
            StatusCode::OpUnsupported => ("SFTP_UNSUPPORTED", "服务器不支持此 SFTP 操作或扩展"),
            _ => (
                "SFTP_OPERATION",
                "SFTP 操作失败，可能是冲突、配额或服务器策略限制",
            ),
        },
        SftpError::Timeout => ("SFTP_TIMEOUT", "SFTP 请求超时，请检查连接后重试"),
        _ => (
            "SFTP_NETWORK",
            "SFTP 网络或协议失败，请重新连接；原有终端不受子系统错误影响",
        ),
    };
    Error::Connection {
        code,
        message,
        source: Some(Box::new(error)),
    }
}
pub(crate) fn missing(error: &SftpError) -> bool {
    matches!(error, SftpError::Status(s) if s.status_code == StatusCode::NoSuchFile)
}
pub(crate) fn check_editor_cancel(cancel: Option<&CancellationToken>) -> Result<(), Error> {
    if cancel.is_some_and(CancellationToken::is_cancelled) {
        Err(fail(
            "EDITOR_CANCELLED",
            "回传已取消，未提交的远程原文件及本地副本保留",
        ))
    } else {
        Ok(())
    }
}
pub(crate) struct Remote {
    pub raw: RawSftpSession,
    pub atomic: bool,
    pub fsync: bool,
    pub owner_closed: CancellationToken,
    pub transport_closed: CancellationToken,
}
impl Drop for Remote {
    fn drop(&mut self) {
        let _ = self.raw.close_session();
    }
}
impl Remote {
    pub async fn connect(engine: &serverdeck_ssh::Engine, id: &str) -> Result<Arc<Self>, Error> {
        let channel = engine.open_sftp_channel(id).await?;
        let raw = RawSftpSession::new_with_config(
            channel.channel.into_stream(),
            Config {
                max_packet_len: 1024 * 1024,
                max_concurrent_reads: 1,
                max_concurrent_writes: 1,
                max_write_packet_len: 32768,
                request_timeout_secs: 15,
            },
        );
        let version = raw.init().await.map_err(map)?;
        if version.version != 3 {
            return Err(fail("SFTP_VERSION", "服务器未协商 SFTP v3"));
        }
        let atomic = version.extensions.contains_key("posix-rename@openssh.com");
        let fsync = version.extensions.contains_key("fsync@openssh.com");
        Ok(Arc::new(Self {
            raw,
            atomic,
            fsync,
            owner_closed: channel.session_closed,
            transport_closed: channel.transport_closed,
        }))
    }
    pub async fn canonical(&self, path: &str) -> Result<String, Error> {
        valid_path(path)?;
        let value = self
            .raw
            .realpath(path)
            .await
            .map_err(map)?
            .files
            .into_iter()
            .next()
            .ok_or_else(|| fail("SFTP_PATH", "服务器未返回绝对路径"))?
            .filename;
        remote_absolute(&value)?;
        Ok(value)
    }
    pub async fn attrs(&self, path: &str) -> Result<FileAttributes, Error> {
        remote_absolute(path)?;
        Ok(self.raw.lstat(path).await.map_err(map)?.attrs)
    }
    pub async fn optional_attrs(&self, path: &str) -> Result<Option<FileAttributes>, Error> {
        remote_absolute(path)?;
        match self.raw.lstat(path).await {
            Ok(v) => Ok(Some(v.attrs)),
            Err(e) if missing(&e) => Ok(None),
            Err(e) => Err(map(e)),
        }
    }
    pub async fn entries(&self, path: &str) -> Result<Vec<(String, FileAttributes)>, Error> {
        let handle = self.raw.opendir(path).await.map_err(map)?.handle;
        let result = async {
            let mut entries = Vec::new();
            let mut names_bytes = 0usize;
            let mut batches = 0usize;
            loop {
                batches += 1;
                if batches > LIST_LIMIT * 2 {
                    return Err(fail("SFTP_LIMIT", "目录响应过多或无法到达结尾"));
                }
                match self.raw.readdir(&handle).await {
                    Ok(batch) => {
                        for mut file in batch.files {
                            if matches!(file.filename.as_str(), "." | "..") {
                                continue;
                            }
                            remote_join(path, &file.filename)?;
                            names_bytes += file.filename.len();
                            if names_bytes > 8 * 1024 * 1024 {
                                return Err(fail(
                                    "SFTP_LIMIT",
                                    "单目录文件名数据超过 8 MiB，请缩小目录范围",
                                ));
                            }
                            file.attrs.user = owner_name(&file.longname);
                            entries.push((file.filename, file.attrs));
                            if entries.len() > LIST_LIMIT {
                                return Err(fail(
                                    "SFTP_LIMIT",
                                    "单目录超过 20000 项，请缩小目录范围",
                                ));
                            }
                        }
                    }
                    Err(SftpError::Status(status)) if status.status_code == StatusCode::Eof => {
                        break;
                    }
                    Err(error) => return Err(map(error)),
                }
            }
            Ok(entries)
        }
        .await;
        let closing = self.raw.close(handle).await.map_err(map);
        match result {
            Ok(value) => {
                closing?;
                Ok(value)
            }
            Err(error) => Err(error),
        }
    }
    pub async fn listing(&self, path: &str) -> Result<DirectoryListing, Error> {
        let path = self.canonical(path).await?;
        let entries = self
            .entries(&path)
            .await?
            .into_iter()
            .map(|(name, attrs)| {
                let full = remote_join(&path, &name)?;
                Ok(entry(name, full, &attrs))
            })
            .collect::<Result<_, Error>>()?;
        Ok(DirectoryListing {
            parent: remote_parent(&path),
            path,
            entries,
        })
    }
    pub async fn read_text(&self, path: &str) -> Result<(String, String, FileAttributes), Error> {
        let before = self.attrs(path).await?;
        if kind(&before) != EntryKind::File || before.size.is_none_or(|n| n > TEXT_LIMIT as u64) {
            return Err(fail(
                "TEXT_UNSUPPORTED",
                "只可编辑不超过 2 MiB 的普通 UTF-8 文件，不能直接编辑链接或特殊文件",
            ));
        }
        let handle = self
            .raw
            .open(path, OpenFlags::READ, FileAttributes::default())
            .await
            .map_err(map)?
            .handle;
        let result = async {
            let mut content = Vec::new();
            loop {
                match self.raw.read(&handle, content.len() as u64, 32768).await {
                    Ok(data) => {
                        if data.data.is_empty() {
                            break;
                        }
                        content.extend_from_slice(&data.data);
                        if content.len() > TEXT_LIMIT {
                            return Err(fail("TEXT_LIMIT", "文件已增大到文本编辑上限，请重新加载"));
                        }
                    }
                    Err(SftpError::Status(status)) if status.status_code == StatusCode::Eof => {
                        break;
                    }
                    Err(error) => return Err(map(error)),
                }
            }
            let after = self.attrs(path).await?;
            if !same(&before, &after) {
                return Err(Error::Conflict);
            }
            if before.size != Some(content.len() as u64) {
                return Err(fail(
                    "TEXT_SIZE_MISMATCH",
                    "文件实际长度与报告大小不一致，不能作为可编辑文件读取；/proc、/sys 等动态信息请使用系统采样查询",
                ));
            }
            if content.contains(&0) {
                return Err(fail("TEXT_BINARY", "文件含 NUL，不能作为文本编辑"));
            }
            let hash = format!("{:x}", Sha256::digest(&content));
            let text = String::from_utf8(content)
                .map_err(|_| fail("TEXT_ENCODING", "文件不是有效 UTF-8，未进行有损解码"))?;
            Ok((text, hash, after))
        }
        .await;
        let closing = self.raw.close(handle).await.map_err(map);
        match result {
            Ok(value) => {
                closing?;
                Ok(value)
            }
            Err(error) => Err(error),
        }
    }
    pub async fn hash(&self, path: &str) -> Result<String, Error> {
        self.hash_cancellable(path, None).await
    }
    pub async fn hash_cancellable(
        &self,
        path: &str,
        cancel: Option<&CancellationToken>,
    ) -> Result<String, Error> {
        check_editor_cancel(cancel)?;
        let handle = self
            .raw
            .open(path, OpenFlags::READ, FileAttributes::default())
            .await
            .map_err(map)?
            .handle;
        let result = async {
            let mut digest = Sha256::new();
            let mut offset = 0;
            loop {
                check_editor_cancel(cancel)?;
                match self.raw.read(&handle, offset, 32768).await {
                    Ok(value) if value.data.is_empty() => break,
                    Ok(value) => {
                        offset += value.data.len() as u64;
                        digest.update(&value.data);
                    }
                    Err(SftpError::Status(status)) if status.status_code == StatusCode::Eof => {
                        break;
                    }
                    Err(error) => return Err(map(error)),
                }
            }
            Ok(format!("{:x}", digest.finalize()))
        }
        .await;
        let closing = self.raw.close(handle).await.map_err(map);
        match result {
            Ok(value) => {
                closing?;
                Ok(value)
            }
            Err(error) => Err(error),
        }
    }
    pub async fn mkdir(&self, path: &str) -> Result<(), Error> {
        self.raw
            .mkdir(
                path,
                FileAttributes {
                    permissions: Some(0o700),
                    ..Default::default()
                },
            )
            .await
            .map_err(map)?;
        Ok(())
    }
    pub async fn replace(&self, from: &str, to: &str, overwrite: bool) -> Result<(), Error> {
        if !overwrite {
            self.raw.rename(from, to).await.map_err(map)?;
            return Ok(());
        }
        if !self.atomic {
            return Err(fail(
                "SFTP_ATOMIC_UNSUPPORTED",
                "服务器缺少 posix-rename 原子替换扩展，拒绝覆盖原文件",
            ));
        }
        let mut bytes = Vec::new();
        for path in [from, to] {
            bytes.extend_from_slice(&(path.len() as u32).to_be_bytes());
            bytes.extend_from_slice(path.as_bytes());
        }
        match self
            .raw
            .extended("posix-rename@openssh.com", bytes)
            .await
            .map_err(map)?
        {
            Packet::Status(status) if status.status_code == StatusCode::Ok => Ok(()),
            Packet::Status(status) => Err(map(SftpError::Status(status))),
            _ => Err(fail("SFTP_PROTOCOL", "原子替换响应无效，未尝试删除原文件")),
        }
    }
    pub async fn stage(&self, path: &str) -> Result<String, Error> {
        Ok(self
            .raw
            .open(
                path,
                OpenFlags::CREATE | OpenFlags::EXCLUDE | OpenFlags::WRITE,
                FileAttributes {
                    permissions: Some(0o600),
                    ..Default::default()
                },
            )
            .await
            .map_err(map)?
            .handle)
    }
    pub async fn close_write(&self, handle: String) -> Result<(), Error> {
        let sync = if self.fsync {
            self.raw.fsync(&handle).await.map(|_| ()).map_err(map)
        } else {
            Ok(())
        };
        let closing = self.raw.close(handle).await.map_err(map);
        sync?;
        closing?;
        Ok(())
    }
    pub async fn preserve(&self, temp: &str, attrs: &FileAttributes) -> Result<(), Error> {
        // A replacement must retain ownership and mode; never silently reset them.
        if attrs.uid.is_none() || attrs.gid.is_none() || attrs.permissions.is_none() {
            return Err(fail(
                "SFTP_ATTRIBUTES",
                "服务器缺少属主或权限信息，无法安全覆盖",
            ));
        }
        self.raw
            .setstat(
                temp,
                FileAttributes {
                    uid: attrs.uid,
                    gid: attrs.gid,
                    permissions: attrs.permissions.map(|p| p & 0o7777),
                    ..Default::default()
                },
            )
            .await
            .map_err(map)?;
        let actual = self.attrs(temp).await?;
        if actual.uid != attrs.uid
            || actual.gid != attrs.gid
            || actual.permissions.map(|p| p & 0o7777) != attrs.permissions.map(|p| p & 0o7777)
        {
            return Err(fail(
                "SFTP_ATTRIBUTES",
                "无法保留原文件属主或权限，未替换原文件",
            ));
        }
        Ok(())
    }
    pub async fn writable(&self, path: &str) -> Result<(), Error> {
        let handle = self
            .raw
            .open(path, OpenFlags::WRITE, FileAttributes::default())
            .await
            .map_err(map)?
            .handle;
        self.raw.close(handle).await.map_err(map)?;
        Ok(())
    }
}
pub(crate) fn same(a: &FileAttributes, b: &FileAttributes) -> bool {
    a.size == b.size
        && a.mtime == b.mtime
        && a.uid == b.uid
        && a.gid == b.gid
        && a.permissions == b.permissions
}
pub(crate) fn kind(attrs: &FileAttributes) -> EntryKind {
    match attrs.permissions.map(|v| v & 0o170000) {
        Some(0o100000) => EntryKind::File,
        Some(0o040000) => EntryKind::Directory,
        Some(0o120000) => EntryKind::Symlink,
        _ => EntryKind::Other,
    }
}
pub(crate) fn entry(name: String, path: String, attrs: &FileAttributes) -> FileEntry {
    FileEntry {
        name,
        path,
        kind: kind(attrs),
        size: attrs.size,
        modified: attrs.mtime.map(u64::from),
        permissions: attrs.permissions.map(|p| p & 0o7777),
        owner: attrs.user.clone(),
        uid: attrs.uid,
        gid: attrs.gid,
    }
}

// SFTP v3 carries numeric IDs in ATTRS. Common Unix servers provide the display
// name in NAME.longname; only accept its recognizable ls-style prefix.
fn owner_name(longname: &str) -> Option<String> {
    let mut fields = longname.split_whitespace();
    let mode = fields.next()?.as_bytes();
    if !(mode.len() == 10 || (mode.len() == 11 && b"+.@".contains(&mode[10])))
        || !b"-dlbcps".contains(&mode[0])
        || mode[1..10].iter().enumerate().any(|(index, value)| {
            !match index {
                0 | 3 | 6 => b"r-".as_slice(),
                1 | 4 | 7 => b"w-".as_slice(),
                2 | 5 => b"xsS-".as_slice(),
                _ => b"xtT-".as_slice(),
            }
            .contains(value)
        })
    {
        return None;
    }
    fields.next()?.parse::<u64>().ok()?;
    let owner = fields.next()?;
    if owner.len() > 256 || owner.chars().any(char::is_control) {
        return None;
    }
    Some(owner.to_owned())
}

#[cfg(test)]
mod owner_tests {
    use super::owner_name;
    #[test]
    fn reads_server_supplied_names_without_guessing_from_uid_or_filename() {
        for text in [
            "-rw-r--r-- 1 root root 12 Nov 2 12:00 file name.txt",
            "drwxr-xr-x+ 2 root root 4096 Nov 2 12:00 folder",
            "lrwxrwxrwx 1 root root 5 Nov 2 12:00 link -> other file",
            "-rwsr-Sr-t 1 root wheel 5 Nov 2 12:00 executable",
        ] {
            assert_eq!(owner_name(text).as_deref(), Some("root"));
        }
        assert_eq!(
            owner_name("-rw-r--r-- 1 deploy wheel 1 Nov 2 12:00 root.txt").as_deref(),
            Some("deploy")
        );
        for text in [
            "",
            "root",
            "a file called root",
            "-rw-r--r-- invalid root",
            "-zz-r--r-- 1 root",
            "-rw-r--r-- 1 ro\0ot",
            "drwxr-xr-x",
        ] {
            assert_eq!(owner_name(text), None, "{text:?}");
        }
    }
}
