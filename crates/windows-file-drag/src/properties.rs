#![allow(unsafe_code)]

use serverdeck_core::{Error, files::valid_path};
use std::{os::windows::ffi::OsStrExt, path::Path};
use windows::{
    Win32::{
        Foundation::HWND,
        System::Com::{COINIT_APARTMENTTHREADED, CoInitializeEx, CoUninitialize},
        UI::Shell::{SHOP_FILEPATH, SHObjectProperties},
    },
    core::PCWSTR,
};

fn failure(error: impl std::error::Error + Send + Sync + 'static) -> Error {
    Error::Connection {
        code: "LOCAL_PROPERTIES",
        message: "无法打开系统属性窗口，请检查路径及系统权限",
        source: Some(Box::new(error)),
    }
}

pub fn properties(path: &str, parent: Option<isize>) -> Result<(), Error> {
    valid_path(path)?;
    if !Path::new(path).is_absolute() || path.starts_with(r"\\.\") {
        return Err(Error::Validation("属性查看需要本地绝对文件或目录路径"));
    }
    std::fs::symlink_metadata(path).map_err(failure)?;
    let shell_path = if let Some(unc) = path.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{unc}")
    } else {
        path.strip_prefix(r"\\?\").unwrap_or(path).to_owned()
    };
    let wide: Vec<u16> = std::ffi::OsStr::new(&shell_path)
        .encode_wide()
        .chain(Some(0))
        .collect();
    // A dedicated STA owns the Shell property sheet and keeps its buffers alive.
    unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok() }.map_err(failure)?;
    let result = unsafe {
        SHObjectProperties(
            parent.map(|handle| HWND(handle as *mut _)),
            SHOP_FILEPATH,
            PCWSTR(wide.as_ptr()),
            PCWSTR::null(),
        )
    };
    unsafe { CoUninitialize() };
    if result.as_bool() {
        Ok(())
    } else {
        Err(failure(std::io::Error::other(
            "Shell property sheet could not be displayed",
        )))
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn rejects_non_file_paths_and_missing_entries_before_opening_shell() {
        for path in [
            "relative.txt",
            "https://example.com/file",
            r"\\.\PhysicalDrive0",
            "C:\\bad\0name",
        ] {
            assert!(super::properties(path, None).is_err(), "{path:?}");
        }
        let directory = tempfile::tempdir().unwrap();
        assert!(
            super::properties(directory.path().join("missing").to_str().unwrap(), None).is_err()
        );
    }
}
