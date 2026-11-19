//! 叠加层：第二个窗口 `mini`、全局热键、展开与调整模式。
//!
//! 界面是同一个前端（`app/`），用 `?view=mini` 认出自己在叠加层里（见 `app/src/mini/`）。
//! 窗口本身的事放在外壳这边：置顶、透明、无边框、不在任务栏、不抢焦点、默认鼠标穿透，
//! 以及需要在游戏外面按的全局热键；界面只通过这里的命令改窗口。
//!
//! 位置和大小记在配置目录的 `overlay.json`，下次打开还在原地。
//!
//! 红线：全局热键只收按键，不往游戏里发键；窗口只是画在地图上，不碰游戏进程。

use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

/// 叠加层窗口的 label，`app/src/overlay/bridge.ts` 里也认这个名字。
pub const MINI: &str = "mini";
/// 窗口状态变了就发这个事件，两个窗口都听。
pub const OVERLAY_EVENT: &str = "otm-overlay";
/// 界面自己处理的热键（预设轮换、详情卡片）走这个事件。
pub const HOTKEY_EVENT: &str = "otm-hotkey";

/// 详情卡片的高度由界面量了报上来（有照片和没照片差很多）；这是界面报过来之前用的那一档。
const CARD_H_FALLBACK: f64 = 304.0;
/// 小地图和详情卡片之间的空隙。
const CARD_GAP: f64 = 12.0;
/// 第一次打开时的边长。
const DEFAULT_SIZE: f64 = 320.0;
/// 设置里「大小」的范围。
const MIN_SIZE: f64 = 160.0;
const MAX_SIZE: f64 = 900.0;
/// 默认离屏幕边缘多远。
const EDGE: f64 = 28.0;
/// 展开时占显示器可用区域的比例。
const EXPAND_RATIO: f64 = 0.8;
/// 展开时的最大尺寸（和 design/mockups/v2-expand.png 一致）。
const EXPAND_MAX: (f64, f64) = (1320.0, 825.0);
/// 拖动时写配置文件的最小间隔，别每帧都写。
const SAVE_EVERY: Duration = Duration::from_millis(500);

/// 窗口的位置和大小（逻辑像素，跟界面里的 CSS 像素一致）。
#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize)]
pub struct Bounds {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// 展开前的样子：从哪来、原来是不是藏在屏幕外。
#[derive(Clone, Copy)]
struct ExpandedFrom {
    bounds: Bounds,
    visible: bool,
}

/// 发给界面的窗口状态。
#[derive(Serialize, Clone)]
pub struct OverlayState {
    pub visible: bool,
    /// 正展开着（按住展开的大地图）。
    pub expanded: bool,
    /// 调整模式：关了鼠标穿透，可以拖动改大小。
    pub adjust: bool,
    /// 没展开、没开详情卡片时的边长。
    pub w: f64,
    pub h: f64,
}

/// 界面交来的一条热键。
#[derive(Deserialize)]
pub struct Binding {
    pub action: String,
    pub accelerator: String,
}

/// 一条热键的注册结果：注册不上（被别的程序占了）就在设置里标红。
#[derive(Serialize, Clone)]
pub struct HotkeyStatus {
    pub action: String,
    pub accelerator: String,
    pub ok: bool,
    pub error: Option<String>,
}

/// 叠加层自己记着的东西。
pub struct Overlay {
    /// 配置文件的路径。
    path: PathBuf,
    /// 没展开、没开详情卡片时的位置和大小。
    bounds: Mutex<Option<Bounds>>,
    /// 展开前的那一份；`Some` 表示正展开着。
    expanded_from: Mutex<Option<ExpandedFrom>>,
    adjust: AtomicBool,
    /// 卡片开没开（「想不想要」，展开的时候窗口不长卡片，但这里照样记着）。
    detail: AtomicBool,
    /// 卡片实际有多高，界面量的。
    card_h: Mutex<f64>,
    /// 上次写盘的时间。
    saved_at: Mutex<Option<Instant>>,
}

impl Overlay {
    pub fn new(path: PathBuf) -> Self {
        let bounds = fs::read_to_string(&path)
            .ok()
            .and_then(|text| serde_json::from_str::<Bounds>(&text).ok())
            .filter(|b| b.w >= MIN_SIZE * 0.5 && b.h >= MIN_SIZE * 0.5);
        Self {
            path,
            bounds: Mutex::new(bounds),
            expanded_from: Mutex::new(None),
            adjust: AtomicBool::new(false),
            detail: AtomicBool::new(false),
            card_h: Mutex::new(CARD_H_FALLBACK),
            saved_at: Mutex::new(None),
        }
    }

    fn lock_bounds(&self) -> std::sync::MutexGuard<'_, Option<Bounds>> {
        self.bounds.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn lock_expanded(&self) -> std::sync::MutexGuard<'_, Option<ExpandedFrom>> {
        self.expanded_from.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn current(&self, fallback: Bounds) -> Bounds {
        self.lock_bounds().unwrap_or(fallback)
    }

    fn remember(&self, b: Bounds) {
        *self.lock_bounds() = Some(b);
    }

    fn expanded(&self) -> bool {
        self.lock_expanded().is_some()
    }

    fn detail(&self) -> bool {
        self.detail.load(Ordering::Relaxed)
    }

    /// 卡片要多高（界面量过就用它量的）。
    fn card_h(&self) -> f64 {
        *self.card_h.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn set_card_h(&self, h: f64) {
        if h.is_finite() && h > 0.0 {
            *self.card_h.lock().unwrap_or_else(|e| e.into_inner()) = h;
        }
    }

    /// 窗口现在该不该多出一块放卡片：没展开、而且卡片开着。
    fn wants_card(&self) -> bool {
        self.detail() && !self.expanded()
    }

    /// 窗口总高度 = 小地图 + （要卡片时的空隙和卡片）。
    fn card_area(&self) -> f64 {
        if self.wants_card() {
            CARD_GAP + self.card_h()
        } else {
            0.0
        }
    }

    /// 写配置文件。`force` 之外的最多每 500ms 写一次：拖动时窗口事件很密。
    fn persist(&self, force: bool) {
        let mut at = self.saved_at.lock().unwrap_or_else(|e| e.into_inner());
        if !force && at.is_some_and(|t| t.elapsed() < SAVE_EVERY) {
            return;
        }
        *at = Some(Instant::now());
        let Some(b) = *self.lock_bounds() else { return };
        if let Some(dir) = self.path.parent() {
            let _ = fs::create_dir_all(dir);
        }
        if let Ok(text) = serde_json::to_string(&b) {
            let _ = fs::write(&self.path, text);
        }
    }
}

// —— 命令（界面调的） ——

/// 打开或关掉叠加层。关掉时连窗口一起关，位置大小先记下来。
#[tauri::command]
pub fn overlay_set_enabled(enabled: bool, app: AppHandle) -> Result<(), String> {
    set_enabled(&app, enabled).map_err(|e| e.to_string())
}

/// 调整模式：关掉鼠标穿透、允许拖动改大小，再按一次回到穿透。
#[tauri::command]
pub fn overlay_set_adjust(on: bool, app: AppHandle) {
    let overlay = app.state::<Overlay>();
    if overlay.adjust.load(Ordering::Relaxed) == on {
        return;
    }
    if on && overlay.expanded() {
        collapse(&app);
    }
    let Some(win) = app.get_webview_window(MINI) else {
        return;
    };
    overlay.adjust.store(on, Ordering::Relaxed);
    let _ = win.set_ignore_cursor_events(!on);
    let _ = win.set_resizable(on);
    if on {
        let _ = win.show();
    } else if let Some(b) = bounds_of(&win, overlay.wants_card().then(|| overlay.card_h())) {
        // 拖动改过的位置大小从这里起算。拖出来的窗口不一定是正方形，
        // 边长按宽度算、高度跟着边长（小地图是方的，多出来的空会让它缩在一边）
        let size = clamp_size(b.w);
        overlay.remember(Bounds {
            w: size,
            h: size,
            ..b
        });
        if !overlay.expanded() {
            let h = size + overlay.card_area();
            let _ = win.set_size(LogicalSize::new(size, h));
        }
        overlay.persist(true);
    }
    emit_state(&app);
}

/// 详情卡片：窗口往下长出一块给它，收起时缩回去。
///
/// 卡片多高由界面量（有没有照片差一大截），`height` 就是界面上报的实际高度；
/// 展开的大地图铺满窗口，那时只记下开没开，不动窗口。
#[tauri::command]
pub fn overlay_set_detail(open: bool, height: Option<f64>, app: AppHandle) {
    let overlay = app.state::<Overlay>();
    let old_card = overlay.card_h();
    let was = overlay.detail.swap(open, Ordering::Relaxed);
    if let Some(h) = height {
        overlay.set_card_h(h);
    }
    if overlay.expanded() {
        emit_state(&app);
        return;
    }
    let Some(win) = app.get_webview_window(MINI) else {
        emit_state(&app);
        return;
    };
    let Some((w, h)) = size_of(&win) else { return };
    let base = h - if was { CARD_GAP + old_card } else { 0.0 };
    let want = base
        + if open {
            CARD_GAP + overlay.card_h()
        } else {
            0.0
        };
    if (want - h).abs() > 0.5 {
        let _ = win.set_size(LogicalSize::new(w, want));
    }
    emit_state(&app);
}

/// 设置里的「大小」：正方形边长。
#[tauri::command]
pub fn overlay_set_size(size: f64, app: AppHandle) {
    let overlay = app.state::<Overlay>();
    let s = clamp_size(size);
    let mut g = overlay.lock_bounds();
    if let Some(b) = *g {
        *g = Some(Bounds { w: s, h: s, ..b });
    }
    drop(g);
    overlay.persist(true);
    if overlay.expanded() {
        return;
    }
    if let Some(win) = app.get_webview_window(MINI) {
        let h = s + overlay.card_area();
        let _ = win.set_size(LogicalSize::new(s, h));
        emit_state(&app);
    }
}

#[tauri::command]
pub fn overlay_state(app: AppHandle) -> OverlayState {
    snapshot(&app)
}

/// 重新注册全部全局热键。返回每一条的结果，注册不上的在设置里标红。
#[tauri::command]
pub fn overlay_set_hotkeys(bindings: Vec<Binding>, app: AppHandle) -> Vec<HotkeyStatus> {
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();
    let mut out = Vec::new();
    for b in bindings {
        let accelerator = b.accelerator.trim().to_string();
        if accelerator.is_empty() {
            continue;
        }
        let action = b.action.clone();
        let result = gs.on_shortcut(accelerator.as_str(), move |app, _shortcut, event| {
            handle_hotkey(app, &action, event.state);
        });
        out.push(match result {
            Ok(()) => HotkeyStatus {
                action: b.action,
                accelerator,
                ok: true,
                error: None,
            },
            Err(e) => HotkeyStatus {
                action: b.action,
                accelerator,
                ok: false,
                error: Some(e.to_string()),
            },
        });
    }
    out
}

/// 窗口事件：主窗口关掉就跟着关叠加层（没有托盘，留着也没法再叫回来），
/// 小窗口移动、改大小时记下新的位置大小（展开时的那些不算）。
pub fn on_window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    if window.label() != MINI {
        if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
            if let Some(mini) = window.app_handle().get_webview_window(MINI) {
                let _ = mini.close();
            }
        }
        return;
    }
    if !matches!(
        event,
        tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_)
    ) {
        return;
    }
    let app = window.app_handle();
    let overlay = app.state::<Overlay>();
    if overlay.expanded() {
        return;
    }
    let Some(win) = app.get_webview_window(MINI) else {
        return;
    };
    if let Some(b) = bounds_of(&win, overlay.wants_card().then(|| overlay.card_h())) {
        overlay.remember(b);
        overlay.persist(false);
    }
}

/// 退出前把位置大小写下来。
pub fn persist_on_exit(app: &AppHandle) {
    let overlay = app.state::<Overlay>();
    if let Some(win) = app.get_webview_window(MINI) {
        if let Some(b) = bounds_of(&win, overlay.wants_card().then(|| overlay.card_h())) {
            overlay.remember(b);
        }
    }
    overlay.persist(true);
}

// —— 内部 ——

fn set_enabled(app: &AppHandle, enabled: bool) -> tauri::Result<()> {
    let overlay = app.state::<Overlay>();
    if !enabled {
        if let Some(win) = app.get_webview_window(MINI) {
            if let Some(b) = bounds_of(&win, overlay.wants_card().then(|| overlay.card_h())) {
                overlay.remember(b);
            }
            overlay.persist(true);
            let _ = win.close();
        }
        let _ = app.global_shortcut().unregister_all();
        *overlay.lock_expanded() = None;
        overlay.adjust.store(false, Ordering::Relaxed);
        overlay.detail.store(false, Ordering::Relaxed);
        emit_state(app);
        return Ok(());
    }
    if let Some(win) = app.get_webview_window(MINI) {
        let _ = win.show();
        emit_state(app);
        return Ok(());
    }
    create(app)
}

fn create(app: &AppHandle) -> tauri::Result<()> {
    let overlay = app.state::<Overlay>();
    let b = overlay.current(default_bounds(app));
    let win = WebviewWindowBuilder::new(app, MINI, WebviewUrl::App("index.html?view=mini".into()))
        .title("otm")
        .inner_size(b.w, b.h)
        .position(b.x, b.y)
        .transparent(true)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        // 不抢焦点：点它、热键把它叫出来都不打断游戏
        .focused(false)
        .focusable(false)
        .visible(false)
        .shadow(false)
        .build()?;
    // 默认鼠标穿透：不挡准星、不挡拖动
    let _ = win.set_ignore_cursor_events(true);
    let _ = win.show();
    emit_state(app);
    Ok(())
}

fn toggle_visible(app: &AppHandle) {
    let Some(win) = app.get_webview_window(MINI) else {
        return;
    };
    let visible = win.is_visible().unwrap_or(false);
    if visible {
        let _ = win.hide();
    } else {
        let _ = win.show();
    }
    emit_state(app);
}

fn expand(app: &AppHandle) {
    let overlay = app.state::<Overlay>();
    let Some(win) = app.get_webview_window(MINI) else {
        return;
    };
    if overlay.expanded() {
        return;
    }
    let from = bounds_of(&win, overlay.wants_card().then(|| overlay.card_h()))
        .unwrap_or_else(|| overlay.current(default_bounds(app)));
    // 原来藏着的话，松开以后还得藏回去
    let visible = win.is_visible().unwrap_or(true);
    *overlay.lock_expanded() = Some(ExpandedFrom {
        bounds: from,
        visible,
    });

    let (mx, my, mw, mh) = monitor_area(&win);
    let w = (mw * EXPAND_RATIO).min(EXPAND_MAX.0).max(MIN_SIZE);
    let h = (w * EXPAND_MAX.1 / EXPAND_MAX.0).min(mh * EXPAND_RATIO);
    let _ = win.set_position(LogicalPosition::new(
        mx + (mw - w) / 2.0,
        my + (mh - h) / 2.0,
    ));
    let _ = win.set_size(LogicalSize::new(w, h));
    let _ = win.show();
    emit_state(app);
}

fn collapse(app: &AppHandle) {
    let overlay = app.state::<Overlay>();
    let Some(from) = overlay.lock_expanded().take() else {
        return;
    };
    if let Some(win) = app.get_webview_window(MINI) {
        let h = from.bounds.h + overlay.card_area();
        let _ = win.set_size(LogicalSize::new(from.bounds.w, h));
        let _ = win.set_position(LogicalPosition::new(from.bounds.x, from.bounds.y));
        if !from.visible {
            let _ = win.hide();
        }
    }
    emit_state(app);
}

/// 热键按下、松开时该做什么。窗口的事直接做，界面的事交给界面（预设轮换、详情卡片）。
fn handle_hotkey(app: &AppHandle, action: &str, state: ShortcutState) {
    let pressed = matches!(state, ShortcutState::Pressed);
    match action {
        "show" => {
            if pressed {
                toggle_visible(app);
            }
        }
        "expand" => {
            if pressed {
                expand(app);
            } else {
                collapse(app);
            }
        }
        "adjust" => {
            if pressed {
                let overlay = app.state::<Overlay>();
                let on = !overlay.adjust.load(Ordering::Relaxed);
                overlay_set_adjust(on, app.clone());
            }
        }
        other => {
            let payload = serde_json::json!({ "action": other, "pressed": pressed });
            let _ = app.emit_to(MINI, HOTKEY_EVENT, payload);
        }
    }
}

/// 正方形边长夹在设置里的范围内，取整像素。
fn clamp_size(size: f64) -> f64 {
    if size.is_nan() {
        return DEFAULT_SIZE;
    }
    size.clamp(MIN_SIZE, MAX_SIZE).round()
}

fn snapshot(app: &AppHandle) -> OverlayState {
    let overlay = app.state::<Overlay>();
    let visible = app
        .get_webview_window(MINI)
        .and_then(|w| w.is_visible().ok())
        .unwrap_or(false);
    let b = overlay.current(Bounds::default());
    OverlayState {
        visible,
        expanded: overlay.expanded(),
        adjust: overlay.adjust.load(Ordering::Relaxed),
        w: b.w,
        h: b.h,
    }
}

fn emit_state(app: &AppHandle) {
    let _ = app.emit(OVERLAY_EVENT, snapshot(app));
}

/// 窗口现在的位置和大小；窗口长着详情卡片就把卡片那一段去掉（`card` 是卡片高度）。
fn bounds_of(win: &WebviewWindow, card: Option<f64>) -> Option<Bounds> {
    let pos = win.outer_position().ok()?;
    let (w, h) = size_of(win)?;
    let scale = win.scale_factor().ok()?;
    let base = match card {
        Some(card) => (h - CARD_GAP - card).max(1.0),
        None => h,
    };
    Some(Bounds {
        x: pos.x as f64 / scale,
        y: pos.y as f64 / scale,
        w,
        h: base,
    })
}

/// 窗口的逻辑宽高。
fn size_of(win: &WebviewWindow) -> Option<(f64, f64)> {
    let size = win.inner_size().ok()?;
    let scale = win.scale_factor().ok()?;
    Some((size.width as f64 / scale, size.height as f64 / scale))
}

/// 窗口所在显示器的可用区域（逻辑像素、左上角坐标）。拿不到就按 1920×1080 算。
fn monitor_area(win: &WebviewWindow) -> (f64, f64, f64, f64) {
    let monitor = win.current_monitor().ok().flatten();
    match monitor {
        Some(m) => {
            let scale = m.scale_factor();
            let size = m.size();
            let pos = m.position();
            let scale = if scale > 0.0 { scale } else { 1.0 };
            (
                pos.x as f64 / scale,
                pos.y as f64 / scale,
                size.width as f64 / scale,
                size.height as f64 / scale,
            )
        }
        None => (0.0, 0.0, 1920.0, 1080.0),
    }
}

/// 第一次打开时：屏幕右上角，留一点边。
fn default_bounds(app: &AppHandle) -> Bounds {
    let (sw, sh) = app
        .primary_monitor()
        .ok()
        .flatten()
        .map(|m| {
            let scale = m.scale_factor();
            let size = m.size();
            let scale = if scale > 0.0 { scale } else { 1.0 };
            (size.width as f64 / scale, size.height as f64 / scale)
        })
        .unwrap_or((1920.0, 1080.0));
    let size = DEFAULT_SIZE.min(sw / 3.0).max(MIN_SIZE);
    Bounds {
        x: (sw - size - EDGE).max(0.0),
        y: EDGE.min((sh - size).max(0.0)),
        w: size,
        h: size,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn size_is_clamped_and_rounded() {
        assert_eq!(clamp_size(320.4), 320.0);
        assert_eq!(clamp_size(12.0), MIN_SIZE);
        assert_eq!(clamp_size(5000.0), MAX_SIZE);
        assert_eq!(clamp_size(f64::NAN), DEFAULT_SIZE);
    }

    #[test]
    fn bounds_survive_a_round_trip() {
        // overlay.json 就是这个格式；改字段名会让上次记的位置丢掉
        let b = Bounds {
            x: 1440.0,
            y: 28.0,
            w: 320.0,
            h: 320.0,
        };
        let text = serde_json::to_string(&b).unwrap();
        assert_eq!(text, r#"{"x":1440.0,"y":28.0,"w":320.0,"h":320.0}"#);
        let back: Bounds = serde_json::from_str(&text).unwrap();
        assert_eq!(
            (back.x, back.y, back.w, back.h),
            (1440.0, 28.0, 320.0, 320.0)
        );
    }

    #[test]
    fn the_window_grows_only_when_the_card_is_open() {
        let dir = std::env::temp_dir().join("otm-overlay-test-card");
        let _ = fs::create_dir_all(&dir);
        let o = Overlay::new(dir.join("overlay.json"));
        assert_eq!(o.card_area(), 0.0);
        o.detail.store(true, Ordering::Relaxed);
        assert_eq!(o.card_area(), CARD_GAP + CARD_H_FALLBACK);
        // 界面量出来的高度说了算
        o.set_card_h(76.0);
        assert_eq!(o.card_area(), CARD_GAP + 76.0);
        // 展开时窗口是整张大地图，不长卡片；松展开以后卡片照旧开着
        *o.lock_expanded() = Some(ExpandedFrom {
            bounds: Bounds::default(),
            visible: false,
        });
        assert_eq!(o.card_area(), 0.0);
        assert!(!o.lock_expanded().as_ref().unwrap().visible);
        *o.lock_expanded() = None;
        assert_eq!(o.card_area(), CARD_GAP + 76.0);
        // 界面报个疯值不用
        o.set_card_h(f64::NAN);
        o.set_card_h(0.0);
        o.set_card_h(-5.0);
        assert_eq!(o.card_h(), 76.0);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_broken_config_file_is_ignored() {
        let dir = std::env::temp_dir().join("otm-overlay-test-broken");
        let _ = fs::create_dir_all(&dir);
        let path = dir.join("overlay.json");
        fs::write(&path, "{ 这不是 json").unwrap();
        assert!(Overlay::new(path.clone()).current(Bounds::default()).w == 0.0);
        // 太小的一份（比如窗口被压到 1px）也不用，按默认位置打开
        fs::write(&path, r#"{"x":0,"y":0,"w":20,"h":20}"#).unwrap();
        assert!(Overlay::new(path).current(Bounds::default()).w == 0.0);
        let _ = fs::remove_dir_all(&dir);
    }
}
