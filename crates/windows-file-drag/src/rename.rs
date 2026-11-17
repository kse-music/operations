#![allow(unsafe_code)]

use serverdeck_core::{Error, files::LocalRename};
use std::{
    os::windows::ffi::OsStrExt,
    path::{Path, PathBuf},
};
use windows::{
    Win32::Storage::FileSystem::{MOVE_FILE_FLAGS, MoveFileExW},
    core::PCWSTR,
};

fn failure(error: impl std::error::Error + Send + Sync + 'static) -> Error {
    Error::Connection {
        code: "LOCAL_RENAME",
        message: "本地重命名失败，请检查名称、权限或同名目标；不会覆盖目标",
        source: Some(Box::new(error)),
    }
}

fn destination(input: &LocalRename) -> Result<PathBuf, Error> {
    serverdeck_core::files::valid_path(&input.parent)?;
    serverdeck_core::files::valid_path(&input.path)?;
    let parent = Path::new(&input.parent);
    let source = Path::new(&input.path);
    if !parent.is_absolute() || std::fs::canonicalize(parent).map_err(failure)? != parent {
        return Err(Error::Validation("本地目录已变化，请刷新后重新选择"));
    }
    if !source.is_absolute() || source.parent() != Some(parent) || source.file_name().is_none() {
        return Err(Error::Validation("只能重命名当前目录中的直接子项目"));
    }
    let name = &input.name;
    let stem = name
        .split('.')
        .next()
        .unwrap_or_default()
        .trim_end_matches(' ')
        .to_ascii_uppercase();
    let device_suffix = stem
        .strip_prefix("COM")
        .or_else(|| stem.strip_prefix("LPT"));
    if name.is_empty()
        || matches!(name.as_str(), "." | "..")
        || name.encode_utf16().count() > 255
        || name.contains(['/', '\\', ':', '<', '>', '"', '|', '?', '*'])
        || name.chars().any(char::is_control)
        || name.ends_with(['.', ' '])
        || ["CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$"].contains(&stem.as_str())
        || matches!(
            device_suffix,
            Some("1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³")
        )
    {
        return Err(Error::Validation("名称不符合 Windows 文件命名规则"));
    }
    // Inspect the entry itself, including a link, without resolving its target.
    std::fs::symlink_metadata(source).map_err(failure)?;
    let destination = parent.join(name);
    serverdeck_core::files::valid_path(
        destination
            .to_str()
            .ok_or(Error::Validation("本地路径不是有效 Unicode"))?,
    )?;
    Ok(destination)
}

pub fn rename(input: LocalRename) -> Result<String, Error> {
    let destination = destination(&input)?;
    let source: Vec<u16> = Path::new(&input.path)
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    let target: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    // Both buffers stay alive during the call. Zero flags prohibit replacement,
    // cross-volume copy/delete fallback, and deferred operations on reboot.
    unsafe {
        MoveFileExW(
            PCWSTR(source.as_ptr()),
            PCWSTR(target.as_ptr()),
            MOVE_FILE_FLAGS(0),
        )
    }
    .map_err(failure)?;
    destination
        .to_str()
        .map(str::to_owned)
        .ok_or(Error::Validation("本地路径不是有效 Unicode"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(parent: &Path, source: &str, name: &str) -> LocalRename {
        LocalRename {
            parent: parent.to_str().unwrap().into(),
            path: parent.join(source).to_str().unwrap().into(),
            name: name.into(),
        }
    }

    #[test]
    fn renames_real_files_directories_unicode_and_case_only_without_changing_contents() {
        let temp = tempfile::tempdir().unwrap();
        let parent = temp.path().canonicalize().unwrap();
        std::fs::write(parent.join("config.json"), b"preserved").unwrap();
        let result = rename(input(&parent, "config.json", "中文 config.json")).unwrap();
        assert_eq!(Path::new(&result), parent.join("中文 config.json"));
        assert_eq!(std::fs::read(&result).unwrap(), b"preserved");
        assert!(!parent.join("config.json").exists());
        rename(input(&parent, "中文 config.json", "中文 CONFIG.json")).unwrap();
        assert!(
            std::fs::read_dir(&parent)
                .unwrap()
                .any(|entry| entry.unwrap().file_name() == "中文 CONFIG.json")
        );
        std::fs::create_dir(parent.join("old-dir")).unwrap();
        std::fs::write(parent.join("old-dir/child"), b"child").unwrap();
        rename(input(&parent, "old-dir", "new-dir")).unwrap();
        assert_eq!(
            std::fs::read(parent.join("new-dir/child")).unwrap(),
            b"child"
        );
        assert!(!parent.join("old-dir").exists());
    }

    #[test]
    fn existing_file_or_directory_is_never_overwritten() {
        let temp = tempfile::tempdir().unwrap();
        let parent = temp.path().canonicalize().unwrap();
        std::fs::write(parent.join("source"), b"source").unwrap();
        std::fs::write(parent.join("target"), b"target").unwrap();
        assert!(rename(input(&parent, "source", "target")).is_err());
        std::fs::create_dir(parent.join("folder")).unwrap();
        assert!(rename(input(&parent, "source", "folder")).is_err());
        assert_eq!(std::fs::read(parent.join("source")).unwrap(), b"source");
        assert_eq!(std::fs::read(parent.join("target")).unwrap(), b"target");
        assert!(parent.join("folder").is_dir());
    }

    #[test]
    fn rejects_invalid_names_missing_sources_roots_and_paths_outside_the_parent() {
        let temp = tempfile::tempdir().unwrap();
        let parent = temp.path().canonicalize().unwrap();
        std::fs::write(parent.join("source"), b"source").unwrap();
        for name in [
            "",
            ".",
            "..",
            "../escape",
            "a/b",
            "a\\b",
            "C:\\escape",
            "CON.txt",
            "LPT1",
            "COM¹",
            "bad.",
            "bad ",
            "bad\0name",
        ] {
            assert!(rename(input(&parent, "source", name)).is_err(), "{name:?}");
        }
        assert!(rename(input(&parent, "missing", "new")).is_err());
        assert!(
            rename(LocalRename {
                parent: parent.to_str().unwrap().into(),
                path: parent.to_str().unwrap().into(),
                name: "new".into()
            })
            .is_err()
        );
        assert!(rename(input(&parent, "../outside", "new")).is_err());
        assert_eq!(std::fs::read(parent.join("source")).unwrap(), b"source");
    }
}
