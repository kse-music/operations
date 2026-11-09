#![allow(unsafe_code)]

use serverdeck_core::{Error, files::LocalDrive};
use windows::{
    Win32::Storage::FileSystem::{GetDriveTypeW, GetLogicalDrives},
    core::PCWSTR,
};

pub fn local_drives() -> Result<Vec<LocalDrive>, Error> {
    // This Win32 query takes no pointers and does not open or read any drive.
    let mask = unsafe { GetLogicalDrives() };
    if mask == 0 {
        return Err(Error::Connection {
            code: "LOCAL_DRIVES",
            message: "无法读取本地磁盘列表，请重试",
            source: Some(Box::new(std::io::Error::last_os_error())),
        });
    }
    Ok((b'A'..=b'Z')
        .filter(|letter| mask & (1 << (letter - b'A')) != 0)
        .map(|letter| {
            let path = format!("{}:\\", char::from(letter));
            let root = [u16::from(letter), u16::from(b':'), u16::from(b'\\'), 0];
            // The root is a live, NUL-terminated UTF-16 buffer with a trailing backslash.
            let kind = unsafe { GetDriveTypeW(PCWSTR(root.as_ptr())) };
            let name = match kind {
                2 => "可移动磁盘",
                3 => "本地磁盘",
                4 => "网络驱动器",
                5 => "光驱",
                6 => "内存磁盘",
                _ => "磁盘",
            };
            LocalDrive {
                path,
                name: format!("{}: {name}", char::from(letter)),
            }
        })
        .collect())
}
