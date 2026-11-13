#![allow(unsafe_code)]

use serverdeck_core::{Error, files::LocalRecycle};
use std::{
    cell::RefCell,
    collections::HashSet,
    os::windows::ffi::OsStrExt,
    path::{Path, PathBuf},
    rc::Rc,
};
use windows::{
    Win32::{
        Foundation::{E_ABORT, E_FAIL},
        System::Com::{
            CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, CoCreateInstance, CoInitializeEx,
            CoUninitialize,
        },
        UI::Shell::{
            FOF_NO_CONNECTED_ELEMENTS, FOF_NO_UI, FOFX_ADDUNDORECORD, FOFX_EARLYFAILURE,
            FOFX_RECYCLEONDELETE, FileOperation, IFileOperation, IFileOperationProgressSink,
            IFileOperationProgressSink_Impl, IShellItem, SHCreateItemFromParsingName,
            TSF_DELETE_RECYCLE_IF_POSSIBLE,
        },
    },
    core::{HRESULT, PCWSTR, Ref, implement},
};

fn failure(error: impl std::error::Error + Send + Sync + 'static) -> Error {
    Error::Connection {
        code: "LOCAL_RECYCLE",
        message: "未能将全部本地项目移入回收站，请刷新核对剩余项目及系统回收站；不会改为永久删除",
        source: Some(Box::new(error)),
    }
}

fn validate(input: &LocalRecycle) -> Result<Vec<PathBuf>, Error> {
    if !input.confirmed || input.paths.is_empty() || input.paths.len() > 256 {
        return Err(Error::Validation("移入回收站须确认 1–256 个明确路径"));
    }
    if input.paths.iter().map(String::len).sum::<usize>() + input.parent.len() > 64 * 1024 {
        return Err(Error::Validation(
            "一次删除的路径总长不能超过 64 KiB，请分批操作",
        ));
    }
    serverdeck_core::files::valid_path(&input.parent)?;
    let parent = Path::new(&input.parent);
    if !parent.is_absolute() || std::fs::canonicalize(parent).map_err(failure)? != parent {
        return Err(Error::Validation("本地目录已变化，请刷新后重新选择"));
    }
    let mut unique = HashSet::new();
    let mut paths = Vec::with_capacity(input.paths.len());
    for value in &input.paths {
        serverdeck_core::files::valid_path(value)?;
        let path = Path::new(value);
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or(Error::Validation("不能删除本地根目录"))?;
        if !path.is_absolute()
            || path.parent() != Some(parent)
            || name.contains([':', '*', '?'])
            || !unique.insert(path.to_owned())
        {
            return Err(Error::Validation("只能删除当前目录中不重复的直接子项目"));
        }
        // Inspect the entry itself. Do not resolve a selected link to its target.
        std::fs::symlink_metadata(path).map_err(failure)?;
        paths.push(path.to_owned());
    }
    Ok(paths)
}

struct Apartment;
impl Apartment {
    fn new() -> Result<Self, Error> {
        // Every caller is a blocking worker with its own STA and balanced COM lifetime.
        unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok() }.map_err(failure)?;
        Ok(Self)
    }
}
impl Drop for Apartment {
    fn drop(&mut self) {
        unsafe { CoUninitialize() };
    }
}

fn item(path: &Path) -> windows::core::Result<IShellItem> {
    let text = path.as_os_str().to_string_lossy();
    let shell = text
        .strip_prefix(r"\\?\UNC\")
        .map(|unc| format!(r"\\{unc}"))
        .unwrap_or_else(|| text.strip_prefix(r"\\?\").unwrap_or(&text).to_owned());
    let wide: Vec<u16> = std::ffi::OsStr::new(&shell)
        .encode_wide()
        .chain(Some(0))
        .collect();
    // The UTF-16 buffer remains valid for the entire parsing call.
    unsafe { SHCreateItemFromParsingName(PCWSTR(wide.as_ptr()), None) }
}

#[derive(Default)]
struct Outcome {
    error: Option<HRESULT>,
    recycled: Vec<IShellItem>,
}
#[implement(IFileOperationProgressSink)]
struct RecycleSink(Rc<RefCell<Outcome>>);

#[allow(non_snake_case)]
impl IFileOperationProgressSink_Impl for RecycleSink_Impl {
    fn StartOperations(&self) -> windows::core::Result<()> {
        Ok(())
    }
    fn FinishOperations(&self, result: HRESULT) -> windows::core::Result<()> {
        if result.is_err() {
            self.0.borrow_mut().error.get_or_insert(result);
        }
        Ok(())
    }
    fn PreDeleteItem(&self, flags: u32, _: Ref<'_, IShellItem>) -> windows::core::Result<()> {
        // Veto a Shell operation that proposes permanent deletion.
        if flags & TSF_DELETE_RECYCLE_IF_POSSIBLE.0 as u32 == 0 {
            self.0.borrow_mut().error.get_or_insert(E_ABORT);
            return Err(E_ABORT.into());
        }
        Ok(())
    }
    fn PostDeleteItem(
        &self,
        _: u32,
        _: Ref<'_, IShellItem>,
        result: HRESULT,
        recycled: Ref<'_, IShellItem>,
    ) -> windows::core::Result<()> {
        let mut outcome = self.0.borrow_mut();
        if result.is_err() {
            outcome.error.get_or_insert(result);
        } else if let Some(item) = recycled.as_ref() {
            outcome.recycled.push(item.clone());
        } else {
            outcome.error.get_or_insert(E_FAIL);
        }
        Ok(())
    }
    fn PreRenameItem(
        &self,
        _: u32,
        _: Ref<'_, IShellItem>,
        _: &PCWSTR,
    ) -> windows::core::Result<()> {
        Err(E_ABORT.into())
    }
    fn PostRenameItem(
        &self,
        _: u32,
        _: Ref<'_, IShellItem>,
        _: &PCWSTR,
        _: HRESULT,
        _: Ref<'_, IShellItem>,
    ) -> windows::core::Result<()> {
        Ok(())
    }
    fn PreMoveItem(
        &self,
        _: u32,
        _: Ref<'_, IShellItem>,
        _: Ref<'_, IShellItem>,
        _: &PCWSTR,
    ) -> windows::core::Result<()> {
        Err(E_ABORT.into())
    }
    fn PostMoveItem(
        &self,
        _: u32,
        _: Ref<'_, IShellItem>,
        _: Ref<'_, IShellItem>,
        _: &PCWSTR,
        _: HRESULT,
        _: Ref<'_, IShellItem>,
    ) -> windows::core::Result<()> {
        Ok(())
    }
    fn PreCopyItem(
        &self,
        _: u32,
        _: Ref<'_, IShellItem>,
        _: Ref<'_, IShellItem>,
        _: &PCWSTR,
    ) -> windows::core::Result<()> {
        Err(E_ABORT.into())
    }
    fn PostCopyItem(
        &self,
        _: u32,
        _: Ref<'_, IShellItem>,
        _: Ref<'_, IShellItem>,
        _: &PCWSTR,
        _: HRESULT,
        _: Ref<'_, IShellItem>,
    ) -> windows::core::Result<()> {
        Ok(())
    }
    fn PreNewItem(&self, _: u32, _: Ref<'_, IShellItem>, _: &PCWSTR) -> windows::core::Result<()> {
        Err(E_ABORT.into())
    }
    fn PostNewItem(
        &self,
        _: u32,
        _: Ref<'_, IShellItem>,
        _: &PCWSTR,
        _: &PCWSTR,
        _: u32,
        _: HRESULT,
        _: Ref<'_, IShellItem>,
    ) -> windows::core::Result<()> {
        Ok(())
    }
    fn UpdateProgress(&self, _: u32, _: u32) -> windows::core::Result<()> {
        Ok(())
    }
    fn ResetTimer(&self) -> windows::core::Result<()> {
        Ok(())
    }
    fn PauseTimer(&self) -> windows::core::Result<()> {
        Ok(())
    }
    fn ResumeTimer(&self) -> windows::core::Result<()> {
        Ok(())
    }
}

fn perform(paths: &[PathBuf]) -> Result<Vec<IShellItem>, Error> {
    let outcome = Rc::new(RefCell::new(Outcome::default()));
    let sink: IFileOperationProgressSink = RecycleSink(outcome.clone()).into();
    // All COM objects and callbacks stay on this initialized STA until completion.
    unsafe {
        let operation: IFileOperation =
            CoCreateInstance(&FileOperation, None, CLSCTX_INPROC_SERVER).map_err(failure)?;
        operation
            .SetOperationFlags(
                FOF_NO_UI
                    | FOF_NO_CONNECTED_ELEMENTS
                    | FOFX_ADDUNDORECORD
                    | FOFX_EARLYFAILURE
                    | FOFX_RECYCLEONDELETE,
            )
            .map_err(failure)?;
        for path in paths {
            operation
                .DeleteItem(&item(path).map_err(failure)?, &sink)
                .map_err(failure)?;
        }
        let result = operation.PerformOperations();
        if let Some(error) = outcome.borrow().error {
            return Err(failure(windows::core::Error::from(error)));
        }
        result.map_err(failure)?;
        if operation
            .GetAnyOperationsAborted()
            .map_err(failure)?
            .as_bool()
            || outcome.borrow().recycled.len() != paths.len()
        {
            return Err(failure(windows::core::Error::from(E_ABORT)));
        }
    }
    Ok(std::mem::take(&mut outcome.borrow_mut().recycled))
}

pub fn recycle(input: LocalRecycle) -> Result<(), Error> {
    let paths = validate(&input)?;
    let _apartment = Apartment::new()?;
    perform(&paths).map(|_| ())
}

#[cfg(test)]
mod tests;
