#![allow(unsafe_code)]

use serverdeck_core::Error;
use std::{os::windows::ffi::OsStrExt, path::Path};
use windows::{
    Win32::{
        Foundation::{ERROR_CANCELLED, HWND},
        System::Com::{COINIT_APARTMENTTHREADED, CoInitializeEx, CoUninitialize},
        UI::Shell::{OAIF_EXEC, OAIF_HIDE_REGISTRATION, OPENASINFO, SHOpenWithDialog},
    },
    core::{HRESULT, PCWSTR},
};

fn failure(error: impl std::error::Error + Send + Sync + 'static) -> Error {
    Error::Connection {
        code: "LOCAL_OPEN",
        message: "无法显示系统打开方式，请检查文件和系统应用后重试",
        source: Some(Box::new(error)),
    }
}

pub fn open_with(path: &str, parent: Option<isize>) -> Result<bool, Error> {
    serverdeck_core::files::valid_path(path)?;
    let path = Path::new(path);
    if !path.is_absolute() {
        return Err(Error::Validation("打开方式需要本地绝对文件路径"));
    }
    let metadata = std::fs::symlink_metadata(path).map_err(failure)?;
    use std::os::windows::fs::MetadataExt;
    if !metadata.is_file() || metadata.file_attributes() & 0x400 != 0 {
        return Err(Error::Validation(
            "打开方式只支持普通文件，不能直接打开链接或特殊文件",
        ));
    }
    // Shell APIs use ordinary DOS/UNC paths instead of Rust's canonical verbatim prefix.
    let text = path.as_os_str().to_string_lossy();
    let shell_path = if let Some(unc) = text.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{unc}")
    } else {
        text.strip_prefix(r"\\?\").unwrap_or(&text).to_owned()
    };
    let wide: Vec<u16> = std::ffi::OsStr::new(&shell_path)
        .encode_wide()
        .chain(Some(0))
        .collect();
    // The blocking worker owns its STA initialization; buffers live until the dialog returns.
    unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok() }.map_err(failure)?;
    let info = OPENASINFO {
        pcszFile: PCWSTR(wide.as_ptr()),
        pcszClass: PCWSTR::null(),
        oaifInFlags: OAIF_EXEC | OAIF_HIDE_REGISTRATION,
    };
    // Only a user-selected application opens the file; no shell command or default execution.
    let result = unsafe { SHOpenWithDialog(parent.map(|handle| HWND(handle as *mut _)), &info) };
    unsafe { CoUninitialize() };
    match result {
        Ok(()) => Ok(true),
        Err(error) if error.code() == HRESULT::from_win32(ERROR_CANCELLED.0) => Ok(false),
        Err(error) => Err(failure(error)),
    }
}

#[cfg(test)]
mod tests {
    #[test]
    #[ignore = "interactive Windows Open With dialog; use an isolated fixture"]
    fn native_open_with_dialog_accepts_fixture() {
        // Modern Windows may return as soon as the separate chooser is launched.
        let directory = tempfile::tempdir().unwrap().keep();
        let path = directory.join("ServerDeck 打开方式验证.ini");
        std::fs::write(&path, b"[server]\r\nport=8080\r\n").unwrap();
        println!("Opening isolated INI fixture; cancel the system dialog.");
        super::open_with(path.to_str().unwrap(), None).unwrap();
    }
}
