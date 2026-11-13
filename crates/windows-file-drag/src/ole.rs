#![allow(unsafe_code)]

use serverdeck_core::IpcError;
use std::{
    mem::ManuallyDrop,
    os::windows::ffi::OsStrExt,
    path::{Path, PathBuf},
    ptr,
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicBool, Ordering},
    },
};
use windows::{
    Win32::{
        Foundation::{
            DATA_S_SAMEFORMATETC, DRAGDROP_S_CANCEL, DRAGDROP_S_DROP, DRAGDROP_S_USEDEFAULTCURSORS,
            DV_E_DVASPECT, DV_E_FORMATETC, DV_E_LINDEX, DV_E_TYMED, E_ABORT, E_FAIL, E_NOTIMPL,
            E_POINTER, ERROR_CANCELLED, GlobalFree, OLE_E_ADVISENOTSUPPORTED, S_OK,
        },
        Storage::FileSystem::FILE_ATTRIBUTE_NORMAL,
        System::{
            Com::{
                DATADIR_GET, DVASPECT_CONTENT, FORMATETC, IAdviseSink, IBindCtx, IDataObject,
                IDataObject_Impl, IEnumFORMATETC, IEnumSTATDATA, STGM_READ, STGM_SHARE_DENY_WRITE,
                STGMEDIUM, STGMEDIUM_0, TYMED_HGLOBAL, TYMED_ISTREAM,
            },
            DataExchange::RegisterClipboardFormatW,
            Memory::{GMEM_MOVEABLE, GMEM_ZEROINIT, GlobalAlloc, GlobalLock, GlobalUnlock},
            Ole::{
                DROPEFFECT, DROPEFFECT_COPY, DoDragDrop, IDropSource, IDropSource_Impl,
                OleInitialize, OleUninitialize,
            },
            SystemServices::{MK_LBUTTON, MODIFIERKEYS_FLAGS},
        },
        UI::{
            Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON},
            Shell::{
                CFSTR_FILECONTENTS, CFSTR_FILEDESCRIPTORW, CFSTR_INDRAGLOOP,
                CFSTR_PREFERREDDROPEFFECT, FD_ATTRIBUTES, FD_UNICODE, FILEDESCRIPTORW,
                IDataObjectAsyncCapability, IDataObjectAsyncCapability_Impl, SHCreateStdEnumFmtEtc,
                SHCreateStreamOnFileEx,
            },
        },
    },
    core::{BOOL, HRESULT, PCWSTR, Ref, implement},
};

static DRAG_ACTIVE: AtomicBool = AtomicBool::new(false);
type StageDownload = Box<dyn FnOnce(&Path) -> Result<(), IpcError> + Send>;

pub async fn start(
    names: Vec<String>,
    stage: impl FnOnce(&Path) -> Result<(), IpcError> + Send + 'static,
    on_ui_thread: impl FnOnce(Box<dyn FnOnce() + Send>) -> Result<(), IpcError>,
) -> Result<(), IpcError> {
    if DRAG_ACTIVE.swap(true, Ordering::AcqRel) {
        return Err(drag_error("已有拖放下载正在处理"));
    }
    let guard = Arc::new(DragGuard);
    let ui_guard = guard.clone();
    let state = Arc::new(DropState::default());
    let drag_state = state.clone();
    let (send, result) = tokio::sync::oneshot::channel();
    on_ui_thread(Box::new(move || {
        let _ = send.send(drag_files(names, Box::new(stage), drag_state));
        drop(ui_guard);
    }))?;
    let status = result
        .await
        .map_err(|_| drag_error("Windows 拖放意外中断"))??;
    if status == DRAGDROP_S_CANCEL {
        return Ok(());
    }
    if state.extracting.load(Ordering::Acquire) {
        tokio::time::timeout(
            std::time::Duration::from_secs(30 * 60),
            state.ended.notified(),
        )
        .await
        .map_err(|_| drag_error("等待 Windows 完成拖放复制超时"))?;
    }
    if let Some(error) = state.error.get() {
        return Err(IpcError {
            code: error.code,
            message: error.message.clone(),
        });
    }
    let completion = state.result.get().copied().unwrap_or(status);
    if completion == E_ABORT || completion == HRESULT::from_win32(ERROR_CANCELLED.0) {
        return Ok(());
    }
    completion
        .ok()
        .map_err(|_| drag_error("Windows 未完成拖放复制"))
}

struct DragGuard;
impl Drop for DragGuard {
    fn drop(&mut self) {
        DRAG_ACTIVE.store(false, Ordering::Release);
    }
}

struct OleApartment;
impl Drop for OleApartment {
    fn drop(&mut self) {
        // The guard is created only after successful initialization on this thread.
        unsafe { OleUninitialize() }
    }
}

fn drag_error(message: &str) -> IpcError {
    IpcError {
        code: "WINDOWS_FILE_DRAG",
        message: message.into(),
    }
}

#[derive(Clone, Copy)]
struct Formats {
    descriptors: u16,
    contents: u16,
    preferred_effect: u16,
    in_drag: u16,
}
impl Formats {
    fn register() -> windows::core::Result<Self> {
        fn register(format: PCWSTR) -> windows::core::Result<u16> {
            // Each pointer is one of the static, null-terminated Shell format strings.
            let id = unsafe { RegisterClipboardFormatW(format) };
            if id == 0 {
                return Err(windows::core::Error::from_thread());
            }
            u16::try_from(id).map_err(|_| E_FAIL.into())
        }
        Ok(Self {
            descriptors: register(CFSTR_FILEDESCRIPTORW)?,
            contents: register(CFSTR_FILECONTENTS)?,
            preferred_effect: register(CFSTR_PREFERREDDROPEFFECT)?,
            in_drag: register(CFSTR_INDRAGLOOP)?,
        })
    }
}

#[derive(Default)]
struct DropState {
    dropped: AtomicBool,
    extracting: AtomicBool,
    ended: tokio::sync::Notify,
    result: OnceLock<HRESULT>,
    error: OnceLock<IpcError>,
}

#[implement(IDropSource, Agile = false)]
struct DropSource(Arc<DropState>);
impl IDropSource_Impl for DropSource_Impl {
    fn QueryContinueDrag(&self, escape: BOOL, keys: MODIFIERKEYS_FLAGS) -> HRESULT {
        if escape.as_bool() {
            DRAGDROP_S_CANCEL
        } else if !keys.contains(MK_LBUTTON) {
            self.0.dropped.store(true, Ordering::Release);
            DRAGDROP_S_DROP
        } else {
            S_OK
        }
    }

    fn GiveFeedback(&self, _: DROPEFFECT) -> HRESULT {
        DRAGDROP_S_USEDEFAULTCURSORS
    }
}

struct StagedDirectory {
    path: PathBuf,
    _temporary: tempfile::TempDir,
}

#[implement()]
struct StreamRelease {
    _directory: Arc<StagedDirectory>,
}

// Explorer's worker may call the data object directly during asynchronous extraction.
#[implement(IDataObject, IDataObjectAsyncCapability)]
struct DragData {
    names: Vec<String>,
    formats: Formats,
    state: Arc<DropState>,
    async_mode: AtomicBool,
    stage: Mutex<Option<StageDownload>>,
    directory: OnceLock<Option<Arc<StagedDirectory>>>,
}
impl DragData {
    fn new(
        names: Vec<String>,
        formats: Formats,
        state: Arc<DropState>,
        stage: StageDownload,
    ) -> Self {
        Self {
            names,
            formats,
            state,
            async_mode: AtomicBool::new(true),
            stage: Mutex::new(Some(stage)),
            directory: OnceLock::new(),
        }
    }

    fn directory(&self) -> windows::core::Result<&Arc<StagedDirectory>> {
        if !self.state.dropped.load(Ordering::Acquire) {
            return Err(DV_E_FORMATETC.into());
        }
        self.directory
            .get_or_init(|| {
                let result = (|| {
                    let stage = self
                        .stage
                        .lock()
                        .map_err(|_| drag_error("Windows 拖放状态不可用"))?
                        .take()
                        .ok_or_else(|| drag_error("下载请求已经处理"))?;
                    let directory = tempfile::Builder::new()
                        .prefix("serverdeck-drag-")
                        .tempdir()
                        .map_err(|_| drag_error("无法创建拖放下载临时目录"))?;
                    stage(directory.path())?;
                    // Keep Windows' extended path prefix when a staged file has a long name.
                    let path = directory
                        .path()
                        .canonicalize()
                        .map_err(|_| drag_error("无法读取拖放下载临时目录"))?;
                    Ok(Arc::new(StagedDirectory {
                        path,
                        _temporary: directory,
                    }))
                })();
                match result {
                    Ok(directory) => Some(directory),
                    Err(error) => {
                        let _ = self.state.error.set(error);
                        None
                    }
                }
            })
            .as_ref()
            .ok_or_else(|| E_FAIL.into())
    }

    fn descriptors(&self) -> windows::core::Result<STGMEDIUM> {
        global_medium(
            size_of::<u32>() + self.names.len() * size_of::<FILEDESCRIPTORW>(),
            |memory| {
                // FILEGROUPDESCRIPTORW is a count followed by packed FILEDESCRIPTORW records.
                unsafe {
                    memory
                        .cast::<u32>()
                        .write_unaligned(self.names.len() as u32)
                };
                for (index, name) in self.names.iter().enumerate() {
                    let mut filename = [0u16; 260];
                    for (unit, value) in filename.iter_mut().zip(name.encode_utf16()) {
                        *unit = value;
                    }
                    let descriptor = FILEDESCRIPTORW {
                        // ServerDeck owns transfer progress; do not request Shell copy UI.
                        dwFlags: (FD_ATTRIBUTES.0 | FD_UNICODE.0) as u32,
                        dwFileAttributes: FILE_ATTRIBUTE_NORMAL.0,
                        cFileName: filename,
                        ..Default::default()
                    };
                    // The allocation covers the count and every descriptor. The array is packed.
                    unsafe {
                        memory
                            .add(size_of::<u32>() + index * size_of::<FILEDESCRIPTORW>())
                            .cast::<FILEDESCRIPTORW>()
                            .write_unaligned(descriptor);
                    }
                }
            },
        )
    }
}

fn global_medium(size: usize, fill: impl FnOnce(*mut u8)) -> windows::core::Result<STGMEDIUM> {
    // Ownership of a successful HGLOBAL is transferred to the caller via STGMEDIUM.
    let memory = unsafe { GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, size)? };
    let address = unsafe { GlobalLock(memory) }.cast::<u8>();
    if address.is_null() {
        let error = windows::core::Error::from_thread();
        let _ = unsafe { GlobalFree(Some(memory)) };
        return Err(error);
    }
    fill(address);
    // GlobalUnlock returns zero on a successful final unlock as well.
    let _ = unsafe { GlobalUnlock(memory) };
    Ok(STGMEDIUM {
        tymed: TYMED_HGLOBAL.0 as u32,
        u: STGMEDIUM_0 { hGlobal: memory },
        pUnkForRelease: ManuallyDrop::new(None),
    })
}

fn dword(value: u32) -> windows::core::Result<STGMEDIUM> {
    global_medium(size_of::<u32>(), |memory| {
        // global_medium provides writable storage of exactly four bytes.
        unsafe { memory.cast::<u32>().write_unaligned(value) };
    })
}

impl IDataObject_Impl for DragData_Impl {
    fn GetData(&self, request: *const FORMATETC) -> windows::core::Result<STGMEDIUM> {
        self.QueryGetData(request).ok()?;
        // QueryGetData validated the non-null COM argument.
        let request = unsafe { &*request };
        if request.cfFormat == self.formats.descriptors {
            return self.descriptors();
        }
        if request.cfFormat == self.formats.preferred_effect {
            return dword(DROPEFFECT_COPY.0);
        }
        if request.cfFormat == self.formats.in_drag {
            return dword(u32::from(!self.state.dropped.load(Ordering::Acquire)));
        }
        let directory = self.directory()?;
        let path = directory.path.join(&self.names[request.lindex as usize]);
        let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        // The path is owned by this operation and the null-terminated buffer lives across the call.
        let stream = unsafe {
            SHCreateStreamOnFileEx(
                PCWSTR(wide.as_ptr()),
                (STGM_READ | STGM_SHARE_DENY_WRITE).0,
                FILE_ATTRIBUTE_NORMAL.0,
                false,
                None,
            )?
        };
        Ok(STGMEDIUM {
            tymed: TYMED_ISTREAM.0 as u32,
            u: STGMEDIUM_0 {
                pstm: ManuallyDrop::new(Some(stream)),
            },
            pUnkForRelease: ManuallyDrop::new(Some(
                StreamRelease {
                    _directory: directory.clone(),
                }
                .into(),
            )),
        })
    }

    fn QueryGetData(&self, request: *const FORMATETC) -> HRESULT {
        // COM supplies a readable FORMATETC for the duration of the call.
        let Some(request) = (unsafe { request.as_ref() }) else {
            return E_POINTER;
        };
        if request.dwAspect != DVASPECT_CONTENT.0 {
            return DV_E_DVASPECT;
        }
        let medium = if request.cfFormat == self.formats.contents {
            if request.lindex < 0 || request.lindex as usize >= self.names.len() {
                return DV_E_LINDEX;
            }
            TYMED_ISTREAM
        } else if [
            self.formats.descriptors,
            self.formats.preferred_effect,
            self.formats.in_drag,
        ]
        .contains(&request.cfFormat)
        {
            TYMED_HGLOBAL
        } else {
            return DV_E_FORMATETC;
        };
        if request.tymed & medium.0 as u32 == 0 {
            DV_E_TYMED
        } else {
            S_OK
        }
    }

    fn EnumFormatEtc(&self, direction: u32) -> windows::core::Result<IEnumFORMATETC> {
        if direction != DATADIR_GET.0 as u32 {
            return Err(E_NOTIMPL.into());
        }
        let format = |id, index, medium| FORMATETC {
            cfFormat: id,
            ptd: ptr::null_mut(),
            dwAspect: DVASPECT_CONTENT.0,
            lindex: index,
            tymed: medium,
        };
        // The Shell copies the format descriptors into its own enumerator.
        unsafe {
            SHCreateStdEnumFmtEtc(&[
                format(self.formats.descriptors, -1, TYMED_HGLOBAL.0 as u32),
                format(self.formats.contents, 0, TYMED_ISTREAM.0 as u32),
                format(self.formats.preferred_effect, -1, TYMED_HGLOBAL.0 as u32),
                format(self.formats.in_drag, -1, TYMED_HGLOBAL.0 as u32),
            ])
        }
    }

    fn GetDataHere(&self, _: *const FORMATETC, _: *mut STGMEDIUM) -> windows::core::Result<()> {
        Err(DV_E_TYMED.into())
    }

    fn GetCanonicalFormatEtc(&self, _: *const FORMATETC, output: *mut FORMATETC) -> HRESULT {
        if output.is_null() {
            return E_POINTER;
        }
        // The caller owns this output structure and requires a null target-device pointer.
        unsafe { (*output).ptd = ptr::null_mut() };
        DATA_S_SAMEFORMATETC
    }

    fn SetData(
        &self,
        _: *const FORMATETC,
        _: *const STGMEDIUM,
        _: BOOL,
    ) -> windows::core::Result<()> {
        Err(E_NOTIMPL.into())
    }

    fn DAdvise(
        &self,
        _: *const FORMATETC,
        _: u32,
        _: Ref<IAdviseSink>,
    ) -> windows::core::Result<u32> {
        Err(OLE_E_ADVISENOTSUPPORTED.into())
    }

    fn DUnadvise(&self, _: u32) -> windows::core::Result<()> {
        Err(OLE_E_ADVISENOTSUPPORTED.into())
    }

    fn EnumDAdvise(&self) -> windows::core::Result<IEnumSTATDATA> {
        Err(OLE_E_ADVISENOTSUPPORTED.into())
    }
}

impl IDataObjectAsyncCapability_Impl for DragData_Impl {
    fn SetAsyncMode(&self, enabled: BOOL) -> windows::core::Result<()> {
        self.async_mode.store(enabled.as_bool(), Ordering::Release);
        Ok(())
    }
    fn GetAsyncMode(&self) -> windows::core::Result<BOOL> {
        Ok(self.async_mode.load(Ordering::Acquire).into())
    }
    fn StartOperation(&self, _: Ref<IBindCtx>) -> windows::core::Result<()> {
        self.state.extracting.store(true, Ordering::Release);
        Ok(())
    }
    fn InOperation(&self) -> windows::core::Result<BOOL> {
        Ok(self.state.extracting.load(Ordering::Acquire).into())
    }
    fn EndOperation(&self, status: HRESULT, _: Ref<IBindCtx>, _: u32) -> windows::core::Result<()> {
        let _ = self.state.result.set(status);
        self.state.extracting.store(false, Ordering::Release);
        self.state.ended.notify_one();
        Ok(())
    }
}

fn drag_files(
    names: Vec<String>,
    stage: StageDownload,
    state: Arc<DropState>,
) -> Result<HRESULT, IpcError> {
    // Check the real button so an IPC that arrived after release cannot create a drop.
    if unsafe { GetAsyncKeyState(i32::from(VK_LBUTTON.0)) } >= 0 {
        return Ok(DRAGDROP_S_CANCEL);
    }
    // The window's own thread runs OLE's mouse-capture loop. The data object is agile
    // so Shell worker threads can extract the files after the UI drag loop returns.
    unsafe { OleInitialize(None) }.map_err(|_| drag_error("无法初始化 Windows 拖放"))?;
    let _apartment = OleApartment;
    let formats = Formats::register().map_err(|_| drag_error("无法注册 Windows 拖放格式"))?;
    let data: IDataObject = DragData::new(names, formats, state.clone(), stage).into();
    let source: IDropSource = DropSource(state).into();
    let mut effect = DROPEFFECT::default();
    // OLE may retain the data object while the Shell copies on its worker thread.
    Ok(unsafe { DoDragDrop(&data, &source, DROPEFFECT_COPY, &mut effect) })
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows::{
        Win32::{
            Foundation::POINTL,
            System::Ole::{IDropTarget, ReleaseStgMedium},
            UI::{
                Shell::{BHID_SFUIObject, FD_PROGRESSUI, IShellItem, SHCreateItemFromParsingName},
                WindowsAndMessaging::{EnumWindows, GetWindowThreadProcessId, IsWindowVisible},
            },
        },
        core::Interface,
    };

    struct VisibleWindowObserver {
        stop: Arc<AtomicBool>,
        shown: Arc<AtomicBool>,
        worker: Option<std::thread::JoinHandle<()>>,
    }
    impl VisibleWindowObserver {
        fn start() -> Self {
            use windows::Win32::Foundation::{HWND, LPARAM};
            unsafe extern "system" fn observe(window: HWND, parameter: LPARAM) -> BOOL {
                let mut process = 0;
                // EnumWindows keeps each HWND and the callback parameter valid for the call.
                unsafe { GetWindowThreadProcessId(window, Some(&mut process)) };
                if process == std::process::id() && unsafe { IsWindowVisible(window) }.as_bool() {
                    // The observer worker owns the Arc until enumeration has returned.
                    unsafe { &*(parameter.0 as *const AtomicBool) }.store(true, Ordering::Release);
                }
                true.into()
            }
            let stop = Arc::new(AtomicBool::new(false));
            let shown = Arc::new(AtomicBool::new(false));
            let ending = stop.clone();
            let visible = shown.clone();
            let worker = std::thread::spawn(move || {
                while !ending.load(Ordering::Acquire) {
                    // The callback only observes windows; it never manipulates other applications.
                    unsafe { EnumWindows(Some(observe), LPARAM(Arc::as_ptr(&visible) as isize)) }
                        .expect("enumerate native windows");
                    std::thread::sleep(std::time::Duration::from_millis(10));
                }
            });
            Self {
                stop,
                shown,
                worker: Some(worker),
            }
        }
    }
    impl Drop for VisibleWindowObserver {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::Release);
            if let Some(worker) = self.worker.take() {
                worker.join().expect("window observer");
            }
        }
    }

    fn format(id: u16, index: i32, medium: u32) -> FORMATETC {
        FORMATETC {
            cfFormat: id,
            dwAspect: DVASPECT_CONTENT.0,
            lindex: index,
            tymed: medium,
            ..Default::default()
        }
    }

    #[test]
    fn publishes_unicode_descriptors_and_streams_only_after_drop() {
        unsafe { OleInitialize(None) }.expect("OLE");
        let _apartment = OleApartment;
        let formats = Formats::register().expect("formats");
        let state = Arc::new(DropState::default());
        let long_name = format!("{}.txt", "测".repeat(250));
        let names = ["sample.txt".to_owned(), long_name.clone()];
        let staged = Arc::new(OnceLock::<PathBuf>::new());
        let stage = {
            let staged = staged.clone();
            let names = names.clone();
            move |directory: &Path| {
                staged.set(directory.to_owned()).expect("only stage once");
                std::fs::write(directory.join(&names[0]), b"first").expect("fixture");
                std::fs::write(directory.join(&names[1]), b"second").expect("fixture");
                Ok(())
            }
        };
        let data: IDataObject =
            DragData::new(names.into(), formats, state.clone(), Box::new(stage)).into();
        let source: IDropSource = DropSource(state.clone()).into();
        let descriptors = format(formats.descriptors, -1, TYMED_HGLOBAL.0 as u32);
        let second = format(formats.contents, 1, TYMED_ISTREAM.0 as u32);
        let invalid = format(formats.contents, 2, TYMED_ISTREAM.0 as u32);
        let mut medium = unsafe { data.GetData(&descriptors) }.expect("file descriptors");
        unsafe {
            let memory = medium.u.hGlobal;
            let bytes = GlobalLock(memory).cast::<u8>();
            assert!(!bytes.is_null());
            assert_eq!(bytes.cast::<u32>().read_unaligned(), 2);
            let descriptor = bytes
                .add(size_of::<u32>() + size_of::<FILEDESCRIPTORW>())
                .cast::<FILEDESCRIPTORW>()
                .read_unaligned();
            let filename = descriptor.cFileName;
            assert_eq!(descriptor.dwFlags & FD_PROGRESSUI.0 as u32, 0);
            let end = filename.iter().position(|unit| *unit == 0).unwrap();
            assert_eq!(String::from_utf16(&filename[..end]).unwrap(), long_name);
            let _ = GlobalUnlock(memory);
            ReleaseStgMedium(&mut medium);
        }
        assert_eq!(unsafe { data.QueryGetData(&invalid) }, DV_E_LINDEX);
        assert!(unsafe { data.GetData(&second) }.is_err());
        assert_eq!(
            unsafe { source.QueryContinueDrag(true, MK_LBUTTON) },
            DRAGDROP_S_CANCEL
        );
        assert!(staged.get().is_none());
        assert_eq!(
            unsafe { source.QueryContinueDrag(false, MODIFIERKEYS_FLAGS(0)) },
            DRAGDROP_S_DROP
        );
        let async_data: IDataObjectAsyncCapability = data.cast().expect("async extraction");
        unsafe { async_data.StartOperation(None) }.expect("start operation");
        assert!(state.extracting.load(Ordering::Acquire));
        let mut first =
            unsafe { data.GetData(&format(formats.contents, 0, TYMED_ISTREAM.0 as u32)) }
                .expect("first stream");
        let mut second = unsafe { data.GetData(&second) }.expect("second stream");
        unsafe { async_data.EndOperation(S_OK, None, DROPEFFECT_COPY.0) }.expect("end operation");
        assert!(!state.extracting.load(Ordering::Acquire));
        drop(async_data);
        drop(data);
        let directory = staged.get().expect("staged");
        assert!(directory.exists());
        for (medium, expected) in [(&mut first, b"first".as_slice()), (&mut second, b"second")] {
            unsafe {
                let stream = medium.u.pstm.as_ref().expect("IStream");
                let mut bytes = [0u8; 16];
                let mut read = 0;
                stream
                    .Read(
                        bytes.as_mut_ptr().cast(),
                        bytes.len() as u32,
                        Some(&mut read),
                    )
                    .ok()
                    .expect("read staged bytes");
                assert_eq!(&bytes[..read as usize], expected);
                ReleaseStgMedium(medium);
            }
        }
        assert!(!directory.exists());
    }

    #[tokio::test]
    async fn windows_folder_drop_target_copies_virtual_files_without_system_progress() {
        unsafe { OleInitialize(None) }.expect("OLE");
        let _apartment = OleApartment;
        let target_directory = tempfile::tempdir().expect("isolated drop folder");
        let path: Vec<_> = target_directory
            .path()
            .as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect();
        let folder: IShellItem =
            unsafe { SHCreateItemFromParsingName(PCWSTR(path.as_ptr()), None) }
                .expect("folder Shell item");
        let target: IDropTarget = unsafe { folder.BindToHandler(None, &BHID_SFUIObject) }
            .expect("Windows filesystem drop target");
        let formats = Formats::register().expect("formats");
        let state = Arc::new(DropState::default());
        let name = "Shell 验收.txt";
        let bytes = vec![42; 8 * 1024 * 1024];
        let expected = bytes.clone();
        let observer = VisibleWindowObserver::start();
        let data: IDataObject = DragData::new(
            vec![name.into()],
            formats,
            state.clone(),
            Box::new(move |directory| {
                std::fs::write(directory.join(name), bytes).expect("staged fixture");
                // Give the real Shell enough time to show its progress UI if requested.
                std::thread::sleep(std::time::Duration::from_secs(2));
                Ok(())
            }),
        )
        .into();
        let mut effect = DROPEFFECT_COPY;
        let point = POINTL::default();
        unsafe { target.DragEnter(&data, MK_LBUTTON, point, &mut effect) }.expect("drag enter");
        assert_eq!(effect, DROPEFFECT_COPY);
        assert!(!target_directory.path().join(name).exists());
        state.dropped.store(true, Ordering::Release);
        let drop_started = std::time::Instant::now();
        unsafe { target.Drop(&data, MODIFIERKEYS_FLAGS(0), point, &mut effect) }.expect("drop");
        assert!(
            drop_started.elapsed() < std::time::Duration::from_secs(1),
            "Shell must extract asynchronously so application progress and cancellation remain responsive"
        );
        if state.extracting.load(Ordering::Acquire) {
            tokio::time::timeout(std::time::Duration::from_secs(10), state.ended.notified())
                .await
                .expect("Shell completed extraction");
        }
        assert!(state.error.get().is_none());
        assert_eq!(
            std::fs::read(target_directory.path().join(name)).expect("Shell copied the file"),
            expected
        );
        assert!(
            !observer.shown.load(Ordering::Acquire),
            "Shell displayed its own progress window"
        );
    }
}
