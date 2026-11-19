//! Windows 上窗口那点事：显示、鼠标穿透、不进任务栏，以及把真实样式读回来。
//!
//! 为什么不用 tao 的 `set_visible` / `set_ignore_cursor_events`：2026-11-19 在实机上，
//! mini 窗口建出来之后 `vis=False`，exstyle 里既没有 `WS_EX_TRANSPARENT` 也没有
//! `WS_EX_LAYERED`（`0x8040118`）——这两个调用没有落到窗口上。这里直接对 HWND 做，
//! 每一步都把结果读回来返回，好让 `%LOCALAPPDATA%\dev.otae.otm\otm.log` 里看得见成没成。
//!
//! 别的系统上这些函数什么都不做，只返回一句说明（构建和回归不依赖 Windows）。

#[cfg(windows)]
pub use imp::{
    click_through, describe, fits, fits_size, force_show, hide, hide_from_taskbar, in_taskbar,
    is_click_through, is_visible, place, size,
};

#[cfg(not(windows))]
pub use stub::{
    click_through, describe, fits, fits_size, force_show, hide, hide_from_taskbar, in_taskbar,
    is_click_through, is_visible, place, size,
};

#[cfg(windows)]
mod imp {
    use tauri::Window;
    use windows_sys::Win32::Foundation::{HWND, RECT};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetWindowLongW, GetWindowRect, IsWindowVisible, SetLayeredWindowAttributes, SetWindowLongW,
        SetWindowPos, ShowWindow, GWL_EXSTYLE, LWA_ALPHA, SWP_FRAMECHANGED, SWP_NOACTIVATE,
        SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, SW_HIDE, SW_SHOWNOACTIVATE, WS_EX_APPWINDOW,
        WS_EX_LAYERED, WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_EX_TRANSPARENT,
    };

    fn hwnd(win: &Window) -> Option<HWND> {
        win.hwnd().ok().map(|h| h.0 as HWND)
    }

    fn ex_style(h: HWND) -> u32 {
        unsafe { GetWindowLongW(h, GWL_EXSTYLE) as u32 }
    }

    fn put_ex_style(h: HWND, ex: u32) {
        unsafe {
            SetWindowLongW(h, GWL_EXSTYLE, ex as i32);
            // 扩展样式改完要刷一次窗口框架，否则有的位不生效
            SetWindowPos(
                h,
                std::ptr::null_mut(),
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED,
            );
        }
    }

    /// 窗口现在的样子：`vis=… ex=0x… layered=… transparent=… rect=…`。
    pub fn describe(win: &Window) -> String {
        let Some(h) = hwnd(win) else {
            return "拿不到 HWND".into();
        };
        let ex = ex_style(h);
        let mut r = RECT {
            left: 0,
            top: 0,
            right: 0,
            bottom: 0,
        };
        unsafe { GetWindowRect(h, &mut r) };
        format!(
            "vis={} ex=0x{ex:08x} layered={} transparent={} topmost={} appwindow={} toolwindow={} rect={},{},{},{}",
            unsafe { IsWindowVisible(h) } != 0,
            ex & WS_EX_LAYERED != 0,
            ex & WS_EX_TRANSPARENT != 0,
            ex & WS_EX_TOPMOST != 0,
            ex & WS_EX_APPWINDOW != 0,
            ex & WS_EX_TOOLWINDOW != 0,
            r.left,
            r.top,
            r.right,
            r.bottom,
        )
    }

    /// 窗口在 Windows 眼里到底可不可见（tao 自己记的那个标志有可能是错的）。
    pub fn is_visible(win: &Window) -> Option<bool> {
        Some(unsafe { IsWindowVisible(hwnd(win)?) } != 0)
    }

    /// 直接让它出来，不抢焦点。
    pub fn force_show(win: &Window) -> String {
        let Some(h) = hwnd(win) else {
            return "显示：拿不到 HWND".into();
        };
        unsafe { ShowWindow(h, SW_SHOWNOACTIVATE) };
        format!(
            "显示：IsWindowVisible={}",
            unsafe { IsWindowVisible(h) } != 0
        )
    }

    /// 窗口矩形（物理像素）：`(left, top, right, bottom)`。
    fn rect(h: HWND) -> Option<(i32, i32, i32, i32)> {
        let mut r = RECT {
            left: 0,
            top: 0,
            right: 0,
            bottom: 0,
        };
        if unsafe { GetWindowRect(h, &mut r) } == 0 {
            return None;
        }
        Some((r.left, r.top, r.right, r.bottom))
    }

    fn rect_of(h: HWND) -> String {
        let Some((l, t, r, b)) = rect(h) else {
            return "拿不到矩形".into();
        };
        format!("{l},{t},{r},{b}({}×{})", r - l, b - t)
    }

    /// 位置和大小一次设好（逻辑像素，按屏幕缩放换成物理像素），返回设完读回来的矩形。
    ///
    /// tao 的 `set_position` / `set_size` 也是派发回事件循环的，实机上这类派发整个没生效，
    /// 所以这里直接 `SetWindowPos`；两边设的是同一组数，谁成功都一样。
    pub fn place(win: &Window, x: f64, y: f64, w: f64, h: f64) -> String {
        // 注意别把 `h`（高度）遮住，两个都在用
        let Some(hw) = hwnd(win) else {
            return "改位置：拿不到 HWND".into();
        };
        let scale = win.scale_factor().unwrap_or(1.0);
        let (x, y, w, hh) = (
            (x * scale).round() as i32,
            (y * scale).round() as i32,
            (w * scale).round() as i32,
            (h * scale).round() as i32,
        );
        unsafe {
            SetWindowPos(
                hw,
                std::ptr::null_mut(),
                x,
                y,
                w,
                hh,
                SWP_NOZORDER | SWP_NOACTIVATE,
            );
        }
        format!(
            "改位置：要 {x},{y} {w}×{hh}（缩放 {scale}）→ 现在 {}",
            rect_of(hw)
        )
    }

    /// 现在的矩形跟要的差得远不远（逻辑像素，容忍 2px）：判断 tao 的位置/大小有没有生效。
    pub fn fits(win: &Window, x: f64, y: f64, w: f64, h: f64) -> Option<bool> {
        let scale = win.scale_factor().unwrap_or(1.0);
        let (l, t, r, b) = rect(hwnd(win)?)?;
        let (lx, ly) = (l as f64 / scale, t as f64 / scale);
        let (lw, lh) = ((r - l) as f64 / scale, (b - t) as f64 / scale);
        let near = |a: f64, b: f64| (a - b).abs() <= 2.0;
        Some(near(lx, x) && near(ly, y) && near(lw, w) && near(lh, h))
    }

    /// 只比大小（逻辑像素，容忍 2px）。
    pub fn fits_size(win: &Window, w: f64, h: f64) -> Option<bool> {
        let scale = win.scale_factor().unwrap_or(1.0);
        let (l, t, r, b) = rect(hwnd(win)?)?;
        let near = |a: f64, b: f64| (a - b).abs() <= 2.0;
        Some(near((r - l) as f64 / scale, w) && near((b - t) as f64 / scale, h))
    }

    /// 只改大小。
    pub fn size(win: &Window, w: f64, h: f64) -> String {
        let Some(hwnd) = hwnd(win) else {
            return "改大小：拿不到 HWND".into();
        };
        let scale = win.scale_factor().unwrap_or(1.0);
        let (w, hh) = ((w * scale).round() as i32, (h * scale).round() as i32);
        unsafe {
            SetWindowPos(
                hwnd,
                std::ptr::null_mut(),
                0,
                0,
                w,
                hh,
                SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE,
            );
        }
        format!(
            "改大小：要 {w}×{hh}（缩放 {scale}）→ 现在 {}",
            rect_of(hwnd)
        )
    }

    /// 藏起来。
    pub fn hide(win: &Window) -> String {
        let Some(h) = hwnd(win) else {
            return "藏起来：拿不到 HWND".into();
        };
        unsafe { ShowWindow(h, SW_HIDE) };
        format!(
            "藏起来：IsWindowVisible={}",
            unsafe { IsWindowVisible(h) } != 0
        )
    }

    /// 鼠标穿透：`WS_EX_LAYERED | WS_EX_TRANSPARENT`（顶层窗口光有 TRANSPARENT 不算数），
    /// 加 LAYERED 之后必须给一次 alpha，否则窗口会整个看不见。
    pub fn click_through(win: &Window, on: bool) -> String {
        let Some(h) = hwnd(win) else {
            return "穿透：拿不到 HWND".into();
        };
        let before = ex_style(h);
        let want = if on {
            before | WS_EX_LAYERED | WS_EX_TRANSPARENT
        } else {
            before & !(WS_EX_LAYERED | WS_EX_TRANSPARENT)
        };
        if want != before {
            unsafe { SetWindowLongW(h, GWL_EXSTYLE, want as i32) };
            if on {
                // 255 = 不透明，只是把鼠标事件让出去
                unsafe { SetLayeredWindowAttributes(h, 0, 255, LWA_ALPHA) };
            }
            put_ex_style(h, want);
        }
        let back = ex_style(h);
        format!(
            "穿透={on}：ex 0x{before:08x} → 0x{back:08x}（transparent={} layered={}）",
            back & WS_EX_TRANSPARENT != 0,
            back & WS_EX_LAYERED != 0,
        )
    }

    /// 不占任务栏：换成工具窗口，去掉 APPWINDOW。
    /// 穿透的位在不在（`LAYERED` + `TRANSPARENT`）：判断 Tauri 那次调用有没有生效。
    pub fn is_click_through(win: &Window) -> Option<bool> {
        let h = hwnd(win)?;
        let ex = ex_style(h);
        Some(ex & WS_EX_TRANSPARENT != 0 && ex & WS_EX_LAYERED != 0)
    }

    /// 还在不在任务栏里。判定按"`TOOLWINDOW` 在、`APPWINDOW` 不在"算已离开
    /// （tao 设 `skip_taskbar` 就是这么做的），只看样式位，够用来判断有没有生效。
    pub fn in_taskbar(win: &Window) -> Option<bool> {
        let ex = ex_style(hwnd(win)?);
        Some(!(ex & WS_EX_TOOLWINDOW != 0 && ex & WS_EX_APPWINDOW == 0))
    }

    pub fn hide_from_taskbar(win: &Window) -> String {
        let Some(h) = hwnd(win) else {
            return "任务栏：拿不到 HWND".into();
        };
        let before = ex_style(h);
        let want = (before | WS_EX_TOOLWINDOW) & !WS_EX_APPWINDOW;
        if want != before {
            put_ex_style(h, want);
        }
        let back = ex_style(h);
        format!(
            "任务栏：ex 0x{before:08x} → 0x{back:08x}（appwindow={} toolwindow={}）",
            back & WS_EX_APPWINDOW != 0,
            back & WS_EX_TOOLWINDOW != 0,
        )
    }
}

#[cfg(not(windows))]
mod stub {
    use tauri::Window;

    pub fn describe(_win: &Window) -> String {
        "（只有 Windows 才读窗口样式）".into()
    }

    pub fn force_show(_win: &Window) -> String {
        "（只有 Windows 才直接显示）".into()
    }

    pub fn click_through(_win: &Window, _on: bool) -> String {
        "（只有 Windows 才设穿透）".into()
    }

    pub fn hide_from_taskbar(_win: &Window) -> String {
        "（只有 Windows 才动任务栏）".into()
    }

    pub fn place(_win: &Window, _x: f64, _y: f64, _w: f64, _h: f64) -> String {
        "（只有 Windows 才直接改位置）".into()
    }

    pub fn size(_win: &Window, _w: f64, _h: f64) -> String {
        "（只有 Windows 才直接改大小）".into()
    }

    pub fn hide(_win: &Window) -> String {
        "（只有 Windows 才直接藏）".into()
    }

    pub fn is_visible(_win: &Window) -> Option<bool> {
        None
    }

    pub fn is_click_through(_win: &Window) -> Option<bool> {
        None
    }

    pub fn fits(_win: &Window, _x: f64, _y: f64, _w: f64, _h: f64) -> Option<bool> {
        None
    }

    pub fn fits_size(_win: &Window, _w: f64, _h: f64) -> Option<bool> {
        None
    }

    pub fn in_taskbar(_win: &Window) -> Option<bool> {
        None
    }
}
