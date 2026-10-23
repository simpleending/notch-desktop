#![windows_subsystem = "windows"]

use std::{
    ffi::{OsStr, OsString},
    fs::{File, OpenOptions},
    io::{Read, Write},
    mem::size_of,
    os::windows::{
        ffi::OsStrExt,
        io::{FromRawHandle, OwnedHandle},
    },
};
use windows::{
    Win32::{
        Foundation::{
            CloseHandle, HANDLE, HANDLE_FLAG_INHERIT, SetHandleInformation, WAIT_OBJECT_0,
        },
        System::{
            Console::{COORD, ClosePseudoConsole, CreatePseudoConsole, HPCON},
            Pipes::CreatePipe,
            Threading::{
                CREATE_NEW_PROCESS_GROUP, CreateProcessW, DETACHED_PROCESS,
                DeleteProcThreadAttributeList, EXTENDED_STARTUPINFO_PRESENT, GetExitCodeProcess,
                INFINITE, InitializeProcThreadAttributeList, LPPROC_THREAD_ATTRIBUTE_LIST,
                PROC_THREAD_ATTRIBUTE_HANDLE_LIST, PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE,
                PROCESS_INFORMATION, STARTF_USESTDHANDLES, STARTUPINFOEXW,
                UpdateProcThreadAttribute, WaitForSingleObject,
            },
        },
    },
    core::{PCWSTR, PWSTR},
};

struct Console(HPCON);
impl Drop for Console {
    fn drop(&mut self) {
        unsafe {
            ClosePseudoConsole(self.0);
        }
    }
}
struct Attributes {
    storage: Vec<usize>,
    list: LPPROC_THREAD_ATTRIBUTE_LIST,
}
impl Attributes {
    unsafe fn new(
        attribute: usize,
        value: *const std::ffi::c_void,
        length: usize,
    ) -> windows::core::Result<Self> {
        let mut bytes = 0;
        let _ = unsafe { InitializeProcThreadAttributeList(None, 1, None, &mut bytes) };
        let mut storage = vec![0usize; bytes.div_ceil(size_of::<usize>())];
        let list = LPPROC_THREAD_ATTRIBUTE_LIST(storage.as_mut_ptr().cast());
        unsafe {
            InitializeProcThreadAttributeList(Some(list), 1, None, &mut bytes)?;
        }
        let result = Self { storage, list };
        unsafe {
            UpdateProcThreadAttribute(list, 0, attribute, Some(value), length, None, None)?;
        }
        Ok(result)
    }
}
impl Drop for Attributes {
    fn drop(&mut self) {
        unsafe {
            DeleteProcThreadAttributeList(self.list);
        }
        let _ = &self.storage;
    }
}
fn wide(value: &OsStr) -> Vec<u16> {
    value.encode_wide().chain(Some(0)).collect()
}
fn quoted(values: &[&OsStr]) -> Vec<u16> {
    let mut result = OsString::new();
    for value in values {
        result.push("\"");
        result.push(value);
        result.push("\" ");
    }
    wide(&result)
}
fn detach(executable: &OsStr, log: &OsStr) -> Result<u32, Box<dyn std::error::Error>> {
    use std::os::windows::io::AsRawHandle;
    if !std::path::Path::new(executable).is_absolute()
        || !std::path::Path::new(log).is_absolute()
        || executable.to_string_lossy().contains('"')
        || log.to_string_lossy().contains('"')
    {
        return Err("Expected absolute executable and log paths".into());
    }
    if !std::fs::metadata(executable)?.is_file() {
        return Err("Missing Ollama executable".into());
    }
    // Do not let a persistent daemon retain Electron's sockets, pipes or program handles.
    let file = OpenOptions::new().create(true).append(true).open(log)?;
    let handles = [HANDLE(file.as_raw_handle())];
    let current = std::env::current_exe()?;
    let program = wide(current.as_os_str());
    let mut command = quoted(&[current.as_os_str(), executable]);
    unsafe {
        SetHandleInformation(handles[0], HANDLE_FLAG_INHERIT.0, HANDLE_FLAG_INHERIT)?;
        let attributes = Attributes::new(
            PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
            handles.as_ptr().cast(),
            size_of::<HANDLE>(),
        )?;
        let mut startup = STARTUPINFOEXW::default();
        startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
        startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        startup.StartupInfo.hStdOutput = handles[0];
        startup.StartupInfo.hStdError = handles[0];
        startup.lpAttributeList = attributes.list;
        let mut process = PROCESS_INFORMATION::default();
        CreateProcessW(
            PCWSTR(program.as_ptr()),
            Some(PWSTR(command.as_mut_ptr())),
            None,
            None,
            true,
            EXTENDED_STARTUPINFO_PRESENT | DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP,
            None,
            PCWSTR::null(),
            &startup.StartupInfo,
            &mut process,
        )?;
        CloseHandle(process.hThread)?;
        CloseHandle(process.hProcess)?;
    }
    Ok(0)
}
unsafe fn pipe() -> windows::core::Result<(File, File)> {
    let (mut read, mut write) = (HANDLE::default(), HANDLE::default());
    unsafe {
        CreatePipe(&mut read, &mut write, None, 0)?;
    }
    Ok(unsafe {
        (
            File::from_raw_handle(read.0),
            File::from_raw_handle(write.0),
        )
    })
}

fn run() -> Result<u32, Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args_os().collect();
    if args.get(1).is_some_and(|value| value == "--detach") {
        if args.len() != 4 {
            return Err("Expected executable and log paths".into());
        }
        return detach(&args[2], &args[3]);
    }
    let executable = std::env::args_os()
        .nth(1)
        .ok_or("Missing Ollama executable")?;
    if std::env::args_os().len() != 2
        || !std::path::Path::new(&executable).is_absolute()
        || executable.to_string_lossy().contains('"')
    {
        return Err("Expected an absolute executable path".into());
    }
    let program = wide(&executable);
    let mut arguments = OsString::from("\"");
    arguments.push(&executable);
    arguments.push("\" serve");
    let mut command = wide(&arguments);
    unsafe {
        let (input_read, input_write) = pipe()?;
        let (mut output_read, output_write) = pipe()?;
        use std::os::windows::io::AsRawHandle;
        let console = Console(CreatePseudoConsole(
            COORD { X: 160, Y: 40 },
            HANDLE(input_read.as_raw_handle()),
            HANDLE(output_write.as_raw_handle()),
            0,
        )?);
        // Drain throughout startup and shutdown; a full ConPTY output pipe otherwise deadlocks.
        let output = std::thread::spawn(move || {
            let mut buffer = [0u8; 16384];
            let mut log = std::io::stdout().lock();
            while let Ok(count) = output_read.read(&mut buffer) {
                if count == 0 {
                    break;
                }
                let _ = log.write_all(&buffer[..count]);
            }
        });
        let result = (|| -> windows::core::Result<u32> {
            let attributes = Attributes::new(
                PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE as usize,
                console.0.0 as *const _,
                size_of::<HPCON>(),
            )?;
            let mut startup = STARTUPINFOEXW::default();
            startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
            startup.lpAttributeList = attributes.list;
            let mut process = PROCESS_INFORMATION::default();
            CreateProcessW(
                PCWSTR(program.as_ptr()),
                Some(PWSTR(command.as_mut_ptr())),
                None,
                None,
                false,
                EXTENDED_STARTUPINFO_PRESENT,
                None,
                PCWSTR::null(),
                &startup.StartupInfo,
                &mut process,
            )?;
            let process_handle = OwnedHandle::from_raw_handle(process.hProcess.0);
            CloseHandle(process.hThread)?;
            drop(input_read);
            drop(output_write);
            if WaitForSingleObject(HANDLE(process_handle.as_raw_handle()), INFINITE)
                != WAIT_OBJECT_0
            {
                return Err(windows::core::Error::from_thread());
            }
            let mut code = 1;
            GetExitCodeProcess(HANDLE(process_handle.as_raw_handle()), &mut code)?;
            Ok(code)
        })();
        // Also close our pipe copies on failed CreateProcess before waiting for the reader.
        drop(console);
        drop(input_write);
        // On a failed spawn the closure's remaining pipe handles are dropped here.
        let _ = output.join();
        Ok(result?)
    }
}

fn main() {
    match run() {
        Ok(code) => std::process::exit(code as i32),
        Err(error) => {
            eprintln!("Hidden Ollama console: {error}");
            std::process::exit(1);
        }
    }
}
