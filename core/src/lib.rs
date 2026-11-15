//! otm 的核心：只读游戏截图的文件名和游戏日志，算出状态，产出事件。
//!
//! 模块：
//!
//! - [`screenshot`]：解析截图文件名，取出时间、坐标、朝向。
//! - [`log`]：解析 `application` 日志的一行。
//! - [`maps`]：场景预设名换成地点名。
//! - [`state`]：状态机，吃日志行和截图，维护状态快照，吐出事件。
//! - [`paths`]：找截图目录、游戏目录、最新的日志目录。
//! - [`tail`]：跟读日志文件。
//! - [`watcher`]：监听截图目录和日志，把事件交给调用方。
//! - [`event`]：事件和状态快照的类型，字段见 `core/EVENTS.md`。
//!
//! 两条入口：
//!
//! ```no_run
//! use otm_core::watcher::{Watcher, WatchOptions};
//!
//! let watcher = Watcher::start(WatchOptions::default());
//! while let Some(event) = watcher.recv() {
//!     println!("{}", serde_json::to_string(&event).unwrap());
//! }
//! ```
//!
//! 回放用 [`state::State`] 直接喂数据，见 `otm-replay`。
//!
//! 红线：只读上面这些文件，不读游戏内存，不抓包，不向游戏进程注入，不发送模拟按键。

pub mod event;
pub mod log;
pub mod maps;
pub mod paths;
pub mod screenshot;
pub mod state;
pub mod tail;
pub mod time;
pub mod watcher;

pub use event::{Event, Mode, PositionSource, RaidMode, Snapshot};
pub use state::State;
pub use time::Timestamp;
