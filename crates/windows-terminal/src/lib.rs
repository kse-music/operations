#![cfg(windows)]
#![allow(unsafe_code)]

// Keep the elevation FFI out of the application and its WebView process setup.
use std::{
    ffi::OsStr,
    io,
    os::windows::{ffi::OsStrExt, io::AsRawHandle},
    path::Path,
};
use tokio::net::windows::named_pipe::{NamedPipeClient, NamedPipeServer, ServerOptions};
use windows::{
    Win32::{
        Foundation::{HANDLE, HLOCAL, LocalFree, WAIT_OBJECT_0, WAIT_TIMEOUT},
        Security::{
            Authorization::{
                ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
                SDDL_REVISION_1,
            },
            GetTokenInformation, PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES, TOKEN_ELEVATION,
            TOKEN_QUERY, TOKEN_USER, TokenElevation, TokenUser,
        },
        System::{
            Com::{COINIT_APARTMENTTHREADED, CoInitializeEx, CoUninitialize},
            JobObjects::{
                AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
                JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
                SetInformationJobObject,
            },
            Pipes::{GetNamedPipeClientProcessId, GetNamedPipeServerProcessId},
            Threading::{
                GetCurrentProcess, GetProcessId, OpenProcess, OpenProcessToken, PROCESS_NAME_WIN32,
                PROCESS_QUERY_LIMITED_INFORMATION, QueryFullProcessImageNameW, WaitForSingleObject,
            },
        },
        UI::{
            Shell::{
                SEE_MASK_FLAG_NO_UI, SEE_MASK_NOASYNC, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW,
                ShellExecuteExW,
            },
            WindowsAndMessaging::SW_HIDE,
        },
    },
    core::{PCWSTR, PWSTR, w},
};

fn os_error(error: windows::core::Error) -> io::Error {
    io::Error::from_raw_os_error(error.code().0 & 0xffff)
}

pub struct Process(std::os::windows::io::OwnedHandle);
impl Process {
    fn handle(&self) -> HANDLE {
        HANDLE(self.0.as_raw_handle())
    }
    pub fn id(&self) -> io::Result<u32> {
        // The owned handle keeps the launched process identity alive through authentication.
        let id = unsafe { GetProcessId(self.handle()) };
        if id == 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(id)
        }
    }
    pub fn has_exited(&self) -> io::Result<bool> {
        match unsafe { WaitForSingleObject(self.handle(), 0) } {
            WAIT_OBJECT_0 => Ok(true),
            WAIT_TIMEOUT => Ok(false),
            _ => Err(io::Error::last_os_error()),
        }
    }
}
fn owned(handle: HANDLE) -> io::Result<Process> {
    use std::os::windows::io::FromRawHandle;
    if handle.is_invalid() {
        return Err(io::Error::last_os_error());
    }
    Ok(Process(unsafe {
        std::os::windows::io::OwnedHandle::from_raw_handle(handle.0)
    }))
}

pub fn is_elevated() -> io::Result<bool> {
    let mut token = HANDLE::default();
    unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) }.map_err(os_error)?;
    let token = owned(token)?;
    let mut elevation = TOKEN_ELEVATION::default();
    let mut length = 0;
    unsafe {
        GetTokenInformation(
            token.handle(),
            TokenElevation,
            Some((&mut elevation as *mut TOKEN_ELEVATION).cast()),
            std::mem::size_of::<TOKEN_ELEVATION>() as u32,
            &mut length,
        )
    }
    .map_err(os_error)?;
    Ok(elevation.TokenIsElevated != 0)
}

pub fn create_pipe(name: &str) -> io::Result<NamedPipeServer> {
    let mut token = HANDLE::default();
    unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) }.map_err(os_error)?;
    let token = owned(token)?;
    let mut length = 0;
    // The first call obtains the variable-sized TOKEN_USER buffer length.
    let query = unsafe { GetTokenInformation(token.handle(), TokenUser, None, 0, &mut length) };
    if !matches!(query, Err(ref error) if error.code().0 as u32 == 0x8007007a) || length == 0 {
        return Err(io::Error::other("Cannot determine pipe owner"));
    }
    let mut user = vec![0usize; (length as usize).div_ceil(std::mem::size_of::<usize>())];
    unsafe {
        GetTokenInformation(
            token.handle(),
            TokenUser,
            Some(user.as_mut_ptr().cast()),
            length,
            &mut length,
        )
    }
    .map_err(os_error)?;
    let mut sid = PWSTR::null();
    unsafe { ConvertSidToStringSidW((*user.as_ptr().cast::<TOKEN_USER>()).User.Sid, &mut sid) }
        .map_err(os_error)?;
    let owner = unsafe { sid.to_string() }.map_err(io::Error::other);
    unsafe { LocalFree(Some(HLOCAL(sid.0.cast()))) };
    let descriptor_text: Vec<_> = format!("D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GA;;;{})", owner?)
        .encode_utf16()
        .chain(Some(0))
        .collect();
    let mut descriptor = PSECURITY_DESCRIPTOR::default();
    // Local System, administrators (including a different UAC admin), and the owner only.
    unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            PCWSTR(descriptor_text.as_ptr()),
            SDDL_REVISION_1,
            &mut descriptor,
            None,
        )
    }
    .map_err(os_error)?;
    let attributes = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: descriptor.0,
        bInheritHandle: false.into(),
    };
    // Tokio copies the descriptor in CreateNamedPipe before returning. No inheritable handles.
    let result = unsafe {
        ServerOptions::new()
            .first_pipe_instance(true)
            .reject_remote_clients(true)
            .max_instances(1)
            .in_buffer_size(65536)
            .out_buffer_size(65536)
            .create_with_security_attributes_raw(
                name,
                (&attributes as *const SECURITY_ATTRIBUTES)
                    .cast_mut()
                    .cast(),
            )
    };
    unsafe { LocalFree(Some(HLOCAL(descriptor.0))) };
    result
}

pub fn launch(executable: &Path, arguments: &str) -> io::Result<Process> {
    let file: Vec<_> = executable
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    let args: Vec<_> = OsStr::new(arguments).encode_wide().chain(Some(0)).collect();
    unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok() }.map_err(os_error)?;
    let mut info = SHELLEXECUTEINFOW {
        cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
        fMask: SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC | SEE_MASK_FLAG_NO_UI,
        lpVerb: w!("runas"),
        lpFile: PCWSTR(file.as_ptr()),
        lpParameters: PCWSTR(args.as_ptr()),
        nShow: SW_HIDE.0,
        ..Default::default()
    };
    let result = unsafe { ShellExecuteExW(&mut info) }.map_err(os_error);
    unsafe { CoUninitialize() };
    result?;
    owned(info.hProcess)
}

pub fn authenticate_client(pipe: &NamedPipeServer, process: &Process) -> io::Result<()> {
    let mut id = 0;
    unsafe { GetNamedPipeClientProcessId(HANDLE(pipe.as_raw_handle()), &mut id) }
        .map_err(os_error)?;
    if id != process.id()? {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "Unexpected terminal helper",
        ));
    }
    Ok(())
}

pub fn authenticate_server(pipe: &NamedPipeClient, expected: u32) -> io::Result<Process> {
    let mut id = 0;
    unsafe { GetNamedPipeServerProcessId(HANDLE(pipe.as_raw_handle()), &mut id) }
        .map_err(os_error)?;
    if id != expected {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "Unexpected terminal host",
        ));
    }
    let process = owned(
        unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, id) }.map_err(os_error)?,
    )?;
    let mut path = vec![0u16; 32768];
    let mut length = path.len() as u32;
    unsafe {
        QueryFullProcessImageNameW(
            process.handle(),
            PROCESS_NAME_WIN32,
            PWSTR(path.as_mut_ptr()),
            &mut length,
        )
    }
    .map_err(os_error)?;
    use std::os::windows::ffi::OsStringExt;
    let path = std::ffi::OsString::from_wide(&path[..length as usize]);
    if std::fs::canonicalize(path)? != std::fs::canonicalize(std::env::current_exe()?)? {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "Terminal host executable differs",
        ));
    }
    Ok(process)
}

// Keep this handle alive until helper process exit. The shell and its descendants inherit
// this job, so a lost host/pipe or helper crash cannot leave elevated commands behind.
pub struct Job {
    _handle: Process,
}
pub fn contain_helper() -> io::Result<Job> {
    let job = owned(unsafe { CreateJobObjectW(None, None) }.map_err(os_error)?)?;
    let limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
        BasicLimitInformation:
            windows::Win32::System::JobObjects::JOBOBJECT_BASIC_LIMIT_INFORMATION {
                LimitFlags: JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
                ..Default::default()
            },
        ..Default::default()
    };
    unsafe {
        SetInformationJobObject(
            job.handle(),
            JobObjectExtendedLimitInformation,
            (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
            std::mem::size_of_val(&limits) as u32,
        )
    }
    .map_err(os_error)?;
    unsafe { AssignProcessToJobObject(job.handle(), GetCurrentProcess()) }.map_err(os_error)?;
    Ok(Job { _handle: job })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::windows::named_pipe::ClientOptions;

    #[tokio::test]
    async fn private_pipe_authenticates_actual_process_and_rejects_spoofed_host() {
        let name = format!(
            r"\\.\pipe\ServerDeck-terminal-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let pipe = create_pipe(&name).unwrap();
        assert!(
            create_pipe(&name).is_err(),
            "a pipe name cannot be preempted or shared"
        );
        let client = ClientOptions::new().open(&name).unwrap();
        pipe.connect().await.unwrap();
        let process = authenticate_server(&client, std::process::id()).unwrap();
        authenticate_client(&pipe, &process).unwrap();
        assert!(authenticate_server(&client, std::process::id() + 1).is_err());
        assert_eq!(process.id().unwrap(), std::process::id());
        is_elevated().unwrap();
    }
}
