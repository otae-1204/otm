//! 现在是不是管理员——只用来写日志，没有别的用处。
//!
//! 为什么要知道：全局热键走 `RegisterHotKey`（`global-hotkey` 0.8 的 Windows 实现，
//! 见 `platform_impl/windows/mod.rs`，不是键盘钩子）。前台窗口属于权限更高的进程时，
//! 低权限进程的 `RegisterHotKey` 收不到按键——游戏以管理员身份跑着，普通权限的 otm
//! 就一个热键都收不到。实机上一度以为是这个原因，读日志发现热键都收到了，所以这里
//! 只留一行日志备查：真要提权，启动日志里能看出两边权限对不对得上。

#[cfg(windows)]
pub use imp::is_elevated;

#[cfg(not(windows))]
pub use stub::is_elevated;

#[cfg(windows)]
mod imp {
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::Security::{
        GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY,
    };
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    /// 当前进程有没有管理员权限（`TokenElevation`）。
    pub fn is_elevated() -> bool {
        unsafe {
            let mut token: HANDLE = std::ptr::null_mut();
            if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
                return false;
            }
            let mut elev = TOKEN_ELEVATION { TokenIsElevated: 0 };
            let mut got = 0u32;
            let ok = GetTokenInformation(
                token,
                TokenElevation,
                &mut elev as *mut _ as *mut std::ffi::c_void,
                std::mem::size_of::<TOKEN_ELEVATION>() as u32,
                &mut got,
            );
            CloseHandle(token);
            ok != 0 && elev.TokenIsElevated != 0
        }
    }
}

#[cfg(not(windows))]
mod stub {
    pub fn is_elevated() -> bool {
        false
    }
}
