use super::*;
use serverdeck_core::{
    files::TREE_LIMIT,
    terminal::{TerminalDropGrant, TerminalDropPrepared, TerminalDropSelection},
};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    io::{self, Write},
    path::Path,
    time::{Duration, Instant},
};

const BLOCK: usize = 65536;
const GRANT_TTL: Duration = Duration::from_secs(120);
#[derive(Default)]
pub(super) struct Grants(HashMap<String, (Instant, Vec<PathBuf>)>);
impl Grants {
    pub(super) fn clear(&mut self) {
        self.0.clear();
    }
    fn prune(&mut self) {
        self.0
            .retain(|_, (created, _)| created.elapsed() < GRANT_TTL);
    }
    fn register(&mut self, paths: Vec<PathBuf>) -> Result<TerminalDropGrant, Error> {
        self.prune();
        if paths.is_empty() || paths.len() > 256 {
            return Err(Error::Validation("每次拖放请选择 1–256 个文件或文件夹"));
        }
        if self.0.len() >= 32 {
            return Err(Error::Busy);
        }
        let names = paths
            .iter()
            .map(|p| name(p))
            .collect::<Result<Vec<_>, _>>()?;
        let grant = uuid::Uuid::new_v4().to_string();
        self.0.insert(grant.clone(), (Instant::now(), paths));
        Ok(TerminalDropGrant { grant, names })
    }
    fn take(&mut self, grant: &str) -> Result<Vec<PathBuf>, Error> {
        self.prune();
        self.0
            .remove(grant)
            .map(|(_, paths)| paths)
            .ok_or(Error::NotFound)
    }
}

fn name(path: &Path) -> Result<String, Error> {
    path.file_name()
        .and_then(|v| v.to_str())
        .filter(|v| {
            !v.is_empty()
                && *v != "."
                && *v != ".."
                && !v.chars().any(|c| c.is_control() || c == '/' || c == '\\')
        })
        .map(str::to_owned)
        .ok_or(Error::Validation(
            "上传名称无效，不能含控制字符或路径分隔符",
        ))
}
fn linked(metadata: &std::fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}
fn safe_path(path: &Path) -> Result<std::fs::Metadata, Error> {
    if !path.is_absolute() {
        return Err(Error::Validation("拖放源必须是本地绝对路径"));
    }
    for parent in path.ancestors() {
        if linked(&std::fs::symlink_metadata(parent).map_err(io_error)?) {
            return Err(Error::Validation("拖放上传不跟随符号链接或重解析点"));
        }
    }
    std::fs::symlink_metadata(path).map_err(io_error)
}
fn check(released: &tokio::sync::watch::Receiver<()>) -> Result<(), Error> {
    if released.has_changed().is_err() {
        Err(Error::NotFound)
    } else {
        Ok(())
    }
}
struct CancellableReader<'a> {
    file: &'a mut File,
    released: &'a tokio::sync::watch::Receiver<()>,
}
impl Read for CancellableReader<'_> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if self.released.has_changed().is_err() {
            return Err(io::Error::other("upload cancelled"));
        }
        self.file.read(buffer)
    }
}
fn append(
    builder: &mut tar::Builder<&mut File>,
    path: &Path,
    relative: &Path,
    depth: usize,
    count: &mut usize,
    released: &tokio::sync::watch::Receiver<()>,
) -> Result<(), Error> {
    check(released)?;
    *count += 1;
    if depth > 128 || *count > TREE_LIMIT {
        return Err(Error::Validation(
            "上传目录超过 128 层或 100000 个项目，请分批上传",
        ));
    }
    let before = safe_path(path)?;
    let mut header = tar::Header::new_gnu();
    header.set_uid(0);
    header.set_gid(0);
    header.set_mtime(0);
    if before.is_dir() {
        header.set_entry_type(tar::EntryType::Directory);
        header.set_size(0);
        header.set_mode(0o755);
        builder
            .append_data(&mut header, relative, io::empty())
            .map_err(io_error)?;
        for child in std::fs::read_dir(path).map_err(io_error)? {
            let child = child.map_err(io_error)?;
            let child_name = name(&child.path())?;
            append(
                builder,
                &child.path(),
                &relative.join(child_name),
                depth + 1,
                count,
                released,
            )?;
        }
    } else if before.is_file() {
        let mut file = File::open(path).map_err(io_error)?;
        let opened = file.metadata().map_err(io_error)?;
        if opened.len() != before.len()
            || opened.modified().map_err(io_error)? != before.modified().map_err(io_error)?
        {
            return Err(Error::Validation("上传源已变化，请重新拖放"));
        }
        header.set_entry_type(tar::EntryType::Regular);
        header.set_size(opened.len());
        header.set_mode(0o644);
        builder
            .append_data(
                &mut header,
                relative,
                CancellableReader {
                    file: &mut file,
                    released,
                },
            )
            .map_err(io_error)?;
        let after = file.metadata().map_err(io_error)?;
        if after.len() != opened.len()
            || after.modified().map_err(io_error)? != opened.modified().map_err(io_error)?
        {
            return Err(Error::Validation("上传文件在读取期间变化，请重新拖放"));
        }
    } else {
        return Err(Error::Validation("拖放上传仅支持普通文件和目录"));
    }
    let after = safe_path(path)?;
    if before.len() != after.len()
        || before.modified().map_err(io_error)? != after.modified().map_err(io_error)?
        || before.file_type() != after.file_type()
    {
        return Err(Error::Validation("上传源在打包期间变化，请重新拖放"));
    }
    check(released)
}
fn archive(
    paths: Vec<PathBuf>,
    released: &tokio::sync::watch::Receiver<()>,
) -> Result<(tempfile::NamedTempFile, u64, String), Error> {
    let mut temporary = tempfile::NamedTempFile::new().map_err(io_error)?;
    {
        let mut builder = tar::Builder::new(temporary.as_file_mut());
        builder.follow_symlinks(false);
        let mut names = HashSet::new();
        let mut count = 0;
        for path in paths {
            let name = name(&path)?;
            if !names.insert(name.clone()) {
                return Err(Error::Validation("所选项目存在相同的目标名称，请分批上传"));
            }
            append(
                &mut builder,
                &path,
                Path::new(&name),
                0,
                &mut count,
                released,
            )?;
        }
        builder.finish().map_err(io_error)?;
    }
    temporary.flush().map_err(io_error)?;
    temporary.seek(SeekFrom::Start(0)).map_err(io_error)?;
    let mut digest = Sha256::new();
    let mut buffer = [0; BLOCK];
    loop {
        check(released)?;
        let n = temporary.read(&mut buffer).map_err(io_error)?;
        if n == 0 {
            break;
        }
        digest.update(&buffer[..n]);
    }
    let size = temporary.as_file().metadata().map_err(io_error)?.len();
    if size > 9_007_199_254_740_991 {
        return Err(Error::Validation("上传归档超过安全计数范围"));
    }
    Ok((temporary, size, format!("{:x}", digest.finalize())))
}
fn command(nonce: &str, size: u64, digest: &str) -> String {
    let script = include_str!("receiver.sh").replace('\'', "'\\''");
    // All arguments are generated internally, never local paths or file names.
    format!(
        "/bin/sh -c '{script}' serverdeck-upload {nonce} {size} {digest}; printf '\\036SDU:{nonce}:RETURN\\037'\r"
    )
}

impl Application {
    /// Called only from the native window drop event, never from IPC.
    pub fn terminal_upload_register_drop(
        &self,
        paths: Vec<PathBuf>,
    ) -> Result<TerminalDropGrant, Error> {
        locked(&self.terminal_uploads.2)?.register(paths)
    }
    pub fn terminal_upload_claim_drop(
        &self,
        id: &str,
        grant: &str,
    ) -> Result<TerminalDropSelection, Error> {
        self.terminal_upload_target(id)?;
        let token = self.terminal_upload_begin(id)?;
        let result = (|| {
            let paths = locked(&self.terminal_uploads.2)?.take(grant)?;
            let names = paths
                .iter()
                .map(|p| name(p))
                .collect::<Result<Vec<_>, _>>()?;
            locked(&self.terminal_uploads.0)?
                .get_mut(id)
                .filter(|s| s.token == token)
                .ok_or(Error::NotFound)?
                .drop_paths = Some(paths);
            Ok(TerminalDropSelection {
                token: token.clone(),
                names,
            })
        })();
        if result.is_err() {
            self.terminal_upload_release(id, &token)?;
        }
        result
    }
    pub async fn terminal_upload_prepare_drop(
        &self,
        id: String,
        token: String,
        confirmed: bool,
    ) -> Result<TerminalDropPrepared, Error> {
        if !confirmed {
            return Err(Error::Validation("拖放上传须用户确认"));
        }
        self.terminals.terminal_connected(&id)?;
        let uploads = self.terminal_uploads.clone();
        let permit = uploads
            .1
            .clone()
            .try_acquire_owned()
            .map_err(|_| Error::Busy)?;
        let (paths, released) = {
            let mut selections = locked(&uploads.0)?;
            let selected = selections
                .get_mut(&id)
                .filter(|s| s.token == token)
                .ok_or(Error::NotFound)?;
            (
                selected.drop_paths.take().ok_or(Error::NotFound)?,
                selected.released.subscribe(),
            )
        };
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            let (temporary, size, sha256) = archive(paths, &released)?;
            let file = temporary.reopen().map_err(io_error)?;
            let modified = file
                .metadata()
                .map_err(io_error)?
                .modified()
                .map_err(io_error)?;
            let nonce = uuid::Uuid::new_v4().simple().to_string();
            let command = command(&nonce, size, &sha256);
            let mut selections = locked(&uploads.0)?;
            let selected = selections
                .get_mut(&id)
                .filter(|s| s.token == token)
                .ok_or(Error::NotFound)?;
            selected.files = vec![Arc::new(Mutex::new(SelectedFile {
                file,
                size,
                modified,
                chunk: BLOCK,
            }))];
            selected.temporary = Some(temporary);
            Ok(TerminalDropPrepared {
                size,
                sha256,
                command,
                nonce,
            })
        })
        .await
        .map_err(|e| Error::Worker(Box::new(e)))?
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn grants_are_one_shot_bounded_and_expire() {
        let mut grants = Grants::default();
        let dir = tempfile::tempdir().unwrap();
        let grant = grants.register(vec![dir.path().join("file")]).unwrap();
        assert_eq!(grants.take(&grant.grant).unwrap().len(), 1);
        assert!(grants.take(&grant.grant).is_err());
        let grant = grants.register(vec![dir.path().join("expired")]).unwrap();
        grants.0.get_mut(&grant.grant).unwrap().0 = Instant::now() - GRANT_TTL;
        assert!(grants.take(&grant.grant).is_err());
        assert!(grants.register(vec![]).is_err());
    }
    #[test]
    fn archive_preserves_binary_unicode_hidden_and_empty_directories() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("中文 文件夹");
        std::fs::create_dir_all(root.join("empty")).unwrap();
        std::fs::write(root.join(".hidden"), [0, 255, 13, 10]).unwrap();
        let (tx, rx) = tokio::sync::watch::channel(());
        let (mut file, size, hash) = archive(vec![root], &rx).unwrap();
        assert!(size > 0);
        assert_eq!(hash.len(), 64);
        file.seek(SeekFrom::Start(0)).unwrap();
        let mut archive = tar::Archive::new(file);
        let mut entries = HashMap::new();
        for entry in archive.entries().unwrap() {
            let mut entry = entry.unwrap();
            let path = entry.path().unwrap().to_string_lossy().into_owned();
            let mut bytes = vec![];
            entry.read_to_end(&mut bytes).unwrap();
            entries.insert(path, bytes);
        }
        assert_eq!(
            entries.get("中文 文件夹/.hidden").unwrap(),
            &[0, 255, 13, 10]
        );
        assert!(entries.contains_key("中文 文件夹/empty"));
        drop(tx);
        assert!(check(&rx).is_err());
    }
    #[test]
    fn refuses_duplicate_names_links_and_cancelled_packing() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("file");
        std::fs::write(&file, b"test").unwrap();
        let (tx, rx) = tokio::sync::watch::channel(());
        assert!(archive(vec![file.clone(), file.clone()], &rx).is_err());
        #[cfg(unix)]
        {
            let link = dir.path().join("link");
            std::os::unix::fs::symlink(&file, &link).unwrap();
            assert!(archive(vec![link], &rx).is_err());
        }
        drop(tx);
        assert!(archive(vec![file], &rx).is_err());
    }
}
