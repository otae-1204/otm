//! otm 的桌面外壳：起 otm-core 的监听，把核心的事件转给界面。
//!
//! 界面（`app/`）在 Tauri 里通过 `window.__TAURI__` 认出自己跑在外壳里，
//! 监听 `otm-event`、启动时 `invoke("get_state")` 取快照，见 `app/src/events/source.ts`。
//!
//! 红线：只读游戏截图的文件名和游戏日志，不碰游戏进程。

// 发布版不要带控制台窗口。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

use otm_core::event::{Snapshot, SnapshotPaths};
use otm_core::watcher::{WatchOptions, Watcher};
use tauri::webview::PageLoadEvent;
use tauri::{Emitter, Manager};

/// 事件名，和 `app/src/events/source.ts` 里监听的一致。
const EVENT_NAME: &str = "otm-event";

/// 等核心事件时多久醒一次，顺带看一眼有没有换游戏目录的请求。
const RECV_TIMEOUT: Duration = Duration::from_millis(200);

/// 窗口藏到页面画完再露出来。页面迟迟没画完（加载卡住）也到这个点就露，
/// 免得用户对着一个看不见的程序。
const SHOW_FALLBACK: Duration = Duration::from_secs(5);

/// 外壳手里的东西，命令和转发线程共用。
struct Shell {
    /// 最近一次快照。转发线程每收到一个事件就更新，`get_state` 直接读。
    snapshot: Mutex<Snapshot>,
    /// 换游戏目录的请求（`None` 是退回自动找）。监听器在转发线程手里，只能把请求递过去。
    game_dir: Mutex<Sender<Option<PathBuf>>>,
}

fn main() {
    tauri::Builder::default()
        // 界面里"用系统浏览器打开链接"走 plugin:opener|open_url，权限见 capabilities/default.json
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let watcher = Watcher::start(WatchOptions::default());
            let (game_dir_tx, game_dir_rx) = mpsc::channel();
            app.manage(Shell {
                snapshot: Mutex::new(empty_snapshot()),
                game_dir: Mutex::new(game_dir_tx),
            });
            forward_events(app.handle().clone(), watcher, game_dir_rx);
            show_window_fallback(app.handle().clone());
            Ok(())
        })
        .on_page_load(|webview, payload| {
            // 窗口建出来时是藏着的（tauri.conf.json 里 visible: false），
            // 等页面画完再露出来，免得先闪一下白底。
            if matches!(payload.event(), PageLoadEvent::Finished) {
                let _ = webview.window().show();
            }
        })
        .invoke_handler(tauri::generate_handler![get_state, set_game_dir])
        .run(tauri::generate_context!())
        .expect("otm 起不来");
}

/// 页面一直没画完时的兜底：到点把窗口露出来。
fn show_window_fallback(app: tauri::AppHandle) {
    std::thread::Builder::new()
        .name("otm-show".into())
        .spawn(move || {
            std::thread::sleep(SHOW_FALLBACK);
            let Some(window) = app.get_webview_window("main") else {
                return;
            };
            // 页面正常画完的话，`on_page_load` 已经露过了。
            if window.is_visible().is_ok_and(|visible| !visible) {
                let _ = window.show();
            }
        })
        .expect("起不了兜底线程");
}

/// 把核心的事件转给界面。
///
/// 监听器只能一条线程读（[`Watcher::recv`] 要独占），所以它跟着这条线程走；
/// 界面要的快照和"换游戏目录"都从这里过。
fn forward_events(app: tauri::AppHandle, watcher: Watcher, game_dir: Receiver<Option<PathBuf>>) {
    std::thread::Builder::new()
        .name("otm-forward".into())
        .spawn(move || loop {
            // 换目录的请求先办：下一轮轮询就按新目录找日志。
            while let Ok(dir) = game_dir.try_recv() {
                watcher.set_game_dir(dir);
            }
            let Some(event) = watcher.recv_timeout(RECV_TIMEOUT) else {
                // 超时是常态。监听线程没了的话 `recv_timeout` 会立刻返回，
                // 再照超时轮询就是空转，收工。
                if !watcher.is_running() {
                    return;
                }
                continue;
            };
            // 先更新快照再发事件：界面收到事件后马上 invoke("get_state")，
            // 拿到的也是含这条事件的状态。
            if let Some(shell) = app.try_state::<Shell>() {
                *lock(&shell.snapshot) = watcher.snapshot();
            }
            let _ = app.emit(EVENT_NAME, &event);
        })
        .expect("起不了转发线程");
}

/// 当前状态快照，字段见 `core/EVENTS.md`。
#[tauri::command]
fn get_state(shell: tauri::State<'_, Shell>) -> Snapshot {
    lock(&shell.snapshot).clone()
}

/// 用户手选的游戏目录（里面有 `Logs` 的那个）。下一轮轮询生效，
/// 之后会收到一个新的 `paths` 事件。不给目录（`null`、空串）就退回自动找。
#[tauri::command]
fn set_game_dir(dir: Option<String>, shell: tauri::State<'_, Shell>) -> Result<(), String> {
    let picked = dir
        .map(|d| PathBuf::from(d.trim()))
        .filter(|p| !p.as_os_str().is_empty());
    if let Some(path) = &picked {
        if !path.is_dir() {
            return Err(format!("不是目录：{}", path.display()));
        }
    }
    lock(&shell.game_dir)
        .send(picked)
        .map_err(|_| "监听线程已经停了".to_string())
}

/// 还没收到任何事件时的快照：什么都还不知道。
fn empty_snapshot() -> Snapshot {
    Snapshot {
        paths: SnapshotPaths::default(),
        mode: None,
        raid: None,
        position: None,
        trail: Vec::new(),
    }
}

/// 拿锁。别的线程 panic 过也照用：快照坏了总比整个外壳挂掉强。
fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}
