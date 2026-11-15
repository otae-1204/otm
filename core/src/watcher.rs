//! 监听：定时轮询截图目录和最新的日志目录，把新东西喂给状态机，每产生一个事件就交出去。
//!
//! 用轮询而不是文件系统通知：截图目录可能被同步软件改名、日志文件由游戏持续追加，
//! 轮询在 Windows 和 Linux 上行为一致，也不会漏掉"先写文件后改名"的情况。
//! 默认 500 毫秒看一次，代价可以忽略。
//!
//! 启动时先把当前日志目录里已有的内容读一遍来恢复状态；截图目录里已有的截图不算新文件，
//! 只记下它们的名字，之后新出现的才处理。游戏重启会建一个新的日志目录，
//! 发现目录变了就先把旧目录里没读完的读完，再从新目录的开头读一遍。

use std::collections::HashSet;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use crate::event::{Event, Snapshot};
use crate::paths::{self, Dirs};
use crate::screenshot::parse_screenshot_name;
use crate::state::State;
use crate::tail::LogTail;
use crate::time::Timestamp;

/// 监听器怎么配。
#[derive(Debug, Clone)]
pub struct WatchOptions {
    /// 游戏目录（里面有 `Logs`）。给 `None` 时先问系统（Windows 上读注册表），
    /// 再退回到从截图目录反推。
    pub game_dir: Option<PathBuf>,
    /// 截图目录。给 `None` 时用默认位置。
    pub screenshot_dir: Option<PathBuf>,
    /// 多久看一次，默认 500 毫秒。
    pub poll_interval: Duration,
    /// 启动时日志读到哪里。默认从头读，用来恢复状态。
    pub start: LogStart,
}

/// 启动时日志从哪读。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum LogStart {
    /// 从头读整个日志目录，恢复出当前状态。
    #[default]
    Beginning,
    /// 只读从现在开始新写的部分，不恢复状态。
    Now,
}

impl Default for WatchOptions {
    fn default() -> Self {
        Self {
            game_dir: None,
            screenshot_dir: None,
            poll_interval: Duration::from_millis(500),
            start: LogStart::Beginning,
        }
    }
}

impl WatchOptions {
    /// 指定游戏目录。
    pub fn game_dir(mut self, dir: impl Into<PathBuf>) -> Self {
        self.game_dir = Some(dir.into());
        self
    }

    /// 指定截图目录。
    pub fn screenshot_dir(mut self, dir: impl Into<PathBuf>) -> Self {
        self.screenshot_dir = Some(dir.into());
        self
    }

    /// 指定轮询间隔。
    pub fn poll_interval(mut self, interval: Duration) -> Self {
        self.poll_interval = interval;
        self
    }

    /// 启动时日志从哪读。
    pub fn start(mut self, start: LogStart) -> Self {
        self.start = start;
        self
    }
}

/// 正在跑的监听器。丢掉它（或者调 [`Watcher::stop`]）就停。
pub struct Watcher {
    events: Receiver<Event>,
    stop: Sender<()>,
    thread: Option<JoinHandle<()>>,
    map_mismatches: Arc<Mutex<Vec<(String, String)>>>,
    /// 状态机，和监听线程共用一份：事件从它来，快照也从它来。
    state: Arc<Mutex<State>>,
    /// 用户手选的游戏目录，[`Watcher::set_game_dir`] 写，监听线程每轮读。
    game_dir: Arc<Mutex<Option<PathBuf>>>,
}

impl Watcher {
    /// 开始监听。立刻在后台线程里找目录、读已有日志，事件从 [`Watcher::events`] 里拿。
    pub fn start(options: WatchOptions) -> Self {
        let (event_tx, event_rx) = mpsc::channel();
        let (stop_tx, stop_rx) = mpsc::channel();
        let map_mismatches = Arc::new(Mutex::new(Vec::new()));
        let shared = Arc::clone(&map_mismatches);
        let state = Arc::new(Mutex::new(State::new()));
        let loop_state = Arc::clone(&state);
        let game_dir = Arc::new(Mutex::new(None));
        let loop_game_dir = Arc::clone(&game_dir);
        let thread = thread::Builder::new()
            .name("otm-watch".into())
            .spawn(move || {
                let mut loop_ =
                    WatchLoop::new(options, event_tx, shared, loop_state, loop_game_dir);
                loop_.run(&stop_rx);
            })
            .expect("起不了监听线程");
        Self {
            events: event_rx,
            stop: stop_tx,
            thread: Some(thread),
            map_mismatches,
            state,
            game_dir,
        }
    }

    /// 事件。监听器停了（或者线程出错）之后会断开。
    pub fn events(&self) -> &Receiver<Event> {
        &self.events
    }

    /// 等下一个事件。监听器停了返回 `None`。
    pub fn recv(&self) -> Option<Event> {
        self.events.recv().ok()
    }

    /// 取下一个事件，最多等 `timeout`。超时返回 `None`，监听器停了也返回 `None`。
    pub fn recv_timeout(&self, timeout: Duration) -> Option<Event> {
        self.events.recv_timeout(timeout).ok()
    }

    /// 监听线程还在跑吗。
    ///
    /// [`Watcher::recv_timeout`] 超时和"线程不在了"都返回 `None`，用它分清楚：
    /// 线程 panic 掉之后 `recv_timeout` 会立刻返回，照着超时轮询会变成空转。
    pub fn is_running(&self) -> bool {
        self.thread.as_ref().is_some_and(|t| !t.is_finished())
    }

    /// 加载时给出的地图名和进局记录里的 `Location` 对不上的那些对，`(预设名, 地点名)`。
    ///
    /// 正常情况下是空的。有记录说明 [`crate::maps`] 的对照表缺一条，把这对补进去就行。
    /// 接界面时建议把它写进日志，方便以后补表。
    pub fn map_mismatches(&self) -> Vec<(String, String)> {
        lock(&self.map_mismatches).clone()
    }

    /// 当前状态快照，字段见 `core/EVENTS.md`。
    ///
    /// 和事件是同一份状态机算出来的，不用自己把事件再拼一遍。
    pub fn snapshot(&self) -> Snapshot {
        lock(&self.state).snapshot()
    }

    /// 换游戏目录（界面上用户手选的）。下一轮轮询就生效。
    ///
    /// 目录变了会重新找日志目录，找到的目录和上次不一样时报一个 `paths` 事件；
    /// 新的游戏目录里没有 `Logs` 时，`paths` 里的 `log_dir` 是 `null`。
    /// 给 `None` 就退回自动找（先问系统，再从截图目录反推）。
    pub fn set_game_dir(&self, dir: Option<PathBuf>) {
        *lock(&self.game_dir) = dir;
    }

    /// 停下监听线程并等它结束。
    pub fn stop(mut self) {
        self.shutdown();
    }

    fn shutdown(&mut self) {
        let _ = self.stop.send(());
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

impl Drop for Watcher {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// 拿锁。别的线程 panic 过（锁中毒）也照用：状态坏了总比监听线程跟着挂掉强。
fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// 后台线程里的东西。
struct WatchLoop {
    options: WatchOptions,
    events: Sender<Event>,
    /// 状态机，和 [`Watcher`] 共用一份。
    state: Arc<Mutex<State>>,
    /// 用户手选的游戏目录，优先于 `options.game_dir`。
    game_dir: Arc<Mutex<Option<PathBuf>>>,
    tail: LogTail,
    /// 已经处理过的截图文件名。
    seen_shots: HashSet<OsString>,
    /// 已经报过的目录。
    reported: Option<Dirs>,
    /// 转给 [`Watcher::map_mismatches`] 的对，和状态机共用一份。
    map_mismatches: Arc<Mutex<Vec<(String, String)>>>,
    /// 已经转过去多少条。
    published_mismatches: usize,
}

impl WatchLoop {
    fn new(
        options: WatchOptions,
        events: Sender<Event>,
        map_mismatches: Arc<Mutex<Vec<(String, String)>>>,
        state: Arc<Mutex<State>>,
        game_dir: Arc<Mutex<Option<PathBuf>>>,
    ) -> Self {
        Self {
            options,
            events,
            state,
            game_dir,
            tail: LogTail::new(),
            seen_shots: HashSet::new(),
            reported: None,
            map_mismatches,
            published_mismatches: 0,
        }
    }

    fn run(&mut self, stop: &Receiver<()>) {
        let interval = self.options.poll_interval.max(Duration::from_millis(50));

        // 顺序要紧：先把已有的截图登记下来，再找目录、读日志。
        // 读日志会立刻报出对局开始（`refresh_dirs` 换日志目录时就会读一遍），
        // 界面收到就开始拍截图，晚一步登记就会把刚拍的那张当成旧文件吞掉。
        self.prime_screenshots();
        self.refresh_dirs();
        self.poll_log();

        loop {
            let started = Instant::now();
            self.refresh_dirs();
            self.poll_screenshots();
            self.poll_log();
            let elapsed = started.elapsed();
            let wait = interval.saturating_sub(elapsed);
            match stop.recv_timeout(wait) {
                Ok(()) | Err(RecvTimeoutError::Disconnected) => break,
                Err(RecvTimeoutError::Timeout) => {}
            }
        }
    }

    fn emit(&self, events: Vec<Event>) {
        for e in events {
            if self.events.send(e).is_err() {
                return;
            }
        }
    }

    /// 重新找目录，并且保证日志跟的是最新的日志目录。
    ///
    /// 找到的目录和上次不一样时报一个 `paths` 事件；日志目录换了（游戏重启）时，
    /// 先把旧目录里没读完的读完，再从新目录的开头读一遍。
    fn refresh_dirs(&mut self) {
        let screenshot_dir = self
            .options
            .screenshot_dir
            .clone()
            .or_else(paths::default_screenshot_dir)
            .filter(|p| p.is_dir());

        // 用户手选的 > 启动时给的 > 系统里的（Windows 注册表）> 从截图目录反推。
        let picked = lock(&self.game_dir).clone();
        let game_dir = picked
            .or_else(|| self.options.game_dir.clone())
            .or_else(paths::default_game_dir)
            .or_else(|| {
                screenshot_dir
                    .as_deref()
                    .and_then(paths::game_dir_from_screenshot_dir)
            })
            .filter(|p| p.is_dir());

        let log_dir = game_dir
            .as_deref()
            .and_then(|g| paths::latest_log_dir(&paths::logs_dir(g)));

        let dirs = Dirs {
            game_dir,
            screenshot_dir,
            log_dir,
        };

        if self.reported.as_ref() != Some(&dirs) {
            let (game_dir_s, screenshot_dir_s, log_dir_s) = dirs.to_strings();
            // 先把目录交出去，再交日志读出来的事件：界面先知道日志在哪，再收到状态。
            let time = Timestamp::now_local();
            lock(&self.state).set_paths(
                game_dir_s.clone(),
                screenshot_dir_s.clone(),
                log_dir_s.clone(),
            );
            self.reported = Some(dirs.clone());
            self.emit(vec![Event::Paths {
                time,
                game_dir: game_dir_s,
                screenshot_dir: screenshot_dir_s,
                log_dir: log_dir_s,
            }]);
        }

        // 日志目录每次都核对：目录先建出来、application.log 晚一步出现的情况也得跟上。
        let current = self
            .tail
            .path()
            .and_then(|p| p.parent())
            .map(Path::to_path_buf);
        if current == dirs.log_dir {
            return;
        }
        // 旧目录里可能还有没读完的（游戏正在退出）。
        self.poll_log();
        let Some(new_log_dir) = dirs.log_dir.clone() else {
            return;
        };
        let Some(file) = paths::application_log_file(&new_log_dir) else {
            return;
        };
        let time = Timestamp::now_local();
        let ended = lock(&self.state).start_game_session(time);
        self.emit(ended);
        self.tail.switch_to(&file);
        if self.options.start == LogStart::Now {
            self.tail.skip_to_end();
        }
        self.poll_log();
    }

    /// 启动时把截图目录里已有的文件名记下来，之后新出现的才处理。
    ///
    /// 不这样做的话，一启动就会把几百张历史截图重放一遍。只登记一次，
    /// 所以截图目录如果是在监听开始之后才建出来的（游戏拍第一张截图时建），
    /// 里面那张会被当成新文件处理。
    ///
    /// 目录自己找，不看 [`Self::reported`]：登记得赶在第一条日志事件之前（见 [`Self::run`]），
    /// 那会儿目录还没报出去。
    fn prime_screenshots(&mut self) {
        let dir = self
            .options
            .screenshot_dir
            .clone()
            .or_else(paths::default_screenshot_dir)
            .filter(|p| p.is_dir());
        let Some(dir) = dir else {
            return;
        };
        let Ok(entries) = fs::read_dir(&dir) else {
            return;
        };
        for entry in entries.flatten() {
            self.seen_shots.insert(entry.file_name());
        }
    }

    /// 看截图目录里有没有新文件。
    ///
    /// 新文件按文件名排序处理：文件名开头就是日期和时分，所以基本就是时间顺序；
    /// 同一分钟里的几张分不出先后，只能按名字排。
    fn poll_screenshots(&mut self) {
        let Some(dir) = self
            .reported
            .as_ref()
            .and_then(|d| d.screenshot_dir.clone())
        else {
            return;
        };
        let Ok(entries) = fs::read_dir(&dir) else {
            return;
        };
        let mut fresh: Vec<OsString> = Vec::new();
        for entry in entries.flatten() {
            if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
                continue;
            }
            let name = entry.file_name();
            if self.seen_shots.contains(&name) {
                continue;
            }
            fresh.push(name);
        }
        if fresh.is_empty() {
            return;
        }

        fresh.sort();
        for name in fresh {
            let name_str = name.to_string_lossy().to_string();
            self.seen_shots.insert(name);
            let Some(shot) = parse_screenshot_name(&name_str) else {
                continue;
            };
            let events = lock(&self.state).on_screenshot(&shot);
            self.emit(events);
        }
    }

    /// 读日志新增的部分。
    fn poll_log(&mut self) {
        for record in self.tail.poll() {
            let events = lock(&self.state).on_log(record.time, &record.kind);
            self.emit(events);
            self.publish_map_mismatches();
        }
    }

    /// 状态机新记下的"预设名和地点名对不上"的对，转给 [`Watcher::map_mismatches`]。
    fn publish_map_mismatches(&mut self) {
        let state = lock(&self.state);
        let all = state.map_mismatches();
        if all.len() <= self.published_mismatches {
            return;
        }
        if let Ok(mut out) = self.map_mismatches.lock() {
            for pair in &all[self.published_mismatches..] {
                if !out.contains(pair) {
                    out.push(pair.clone());
                }
            }
        }
        self.published_mismatches = all.len();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::event::{Event, Mode};
    use std::io::Write;

    fn tmp_root(tag: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("otm-watch-{}-{tag}", std::process::id()));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }

    fn line(t: &str, msg: &str) -> String {
        format!("{t}|1.3.0.2.48779|Info|application|{msg}\r\n")
    }

    fn shot_name(t: &str, x: f64) -> String {
        format!("{t}_{x:.2}, 2.00, 3.00_0.0, 0.0, 0.0, 1.0_1.0 (0).png")
    }

    fn collect(w: &Watcher, until: impl Fn(&[Event]) -> bool, timeout: Duration) -> Vec<Event> {
        let deadline = Instant::now() + timeout;
        let mut out: Vec<Event> = Vec::new();
        while Instant::now() < deadline {
            match w.events().recv_timeout(Duration::from_millis(100)) {
                Ok(e) => {
                    out.push(e);
                    if until(&out) {
                        break;
                    }
                }
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => break,
            }
        }
        out
    }

    #[test]
    fn recovers_state_then_follows_new_lines() {
        let root = tmp_root("recover");
        let shots = root.join("Escape from Tarkov").join("Screenshots");
        fs::create_dir_all(&shots).unwrap();
        let log_dir = root
            .join("Logs")
            .join("log_2026.11.15_17-46-54_1.3.0.2.48779");
        fs::create_dir_all(&log_dir).unwrap();
        let log = log_dir.join("application.log");
        let mut text = String::new();
        text += &line("2026-11-15 17:47:10.253", "Session mode: PvpSeason");
        text += &line(
            "2026-11-15 17:53:17.104",
            "scene preset path:maps/customs_preset.bundle rcid:bigmap.scenespreset.asset",
        );
        text += &line(
            "2026-11-15 18:00:40.493",
            "GameStarted:293.32(293.32) real:315.92(315.92) diff:22.6",
        );
        fs::write(&log, text).unwrap();

        // 启动前就有的截图不算新文件。
        fs::write(shots.join(shot_name("2026-11-15[17-00]", 1.0)), b"x").unwrap();

        let w = Watcher::start(
            WatchOptions::default()
                .game_dir(&root)
                .screenshot_dir(&shots)
                .poll_interval(Duration::from_millis(50)),
        );

        let events = collect(
            &w,
            |evs| evs.iter().any(|e| matches!(e, Event::RaidStarted { .. })),
            Duration::from_secs(5),
        );
        assert!(
            matches!(events.first(), Some(Event::Paths { .. })),
            "{events:?}"
        );
        assert!(events.iter().any(|e| matches!(
            e,
            Event::Session {
                mode: Mode::PvpSeason,
                ..
            }
        )));
        assert!(events
            .iter()
            .any(|e| matches!(e, Event::RaidLoading { map, .. } if map == "bigmap")));
        assert!(
            !events.iter().any(|e| matches!(e, Event::Position { .. })),
            "{events:?}"
        );

        // 新截图。
        fs::write(shots.join(shot_name("2026-11-15[18-02]", -232.18)), b"x").unwrap();
        let events = collect(
            &w,
            |evs| evs.iter().any(|e| matches!(e, Event::Position { .. })),
            Duration::from_secs(5),
        );
        match events.iter().find(|e| matches!(e, Event::Position { .. })) {
            Some(Event::Position { source, yaw, x, .. }) => {
                assert_eq!(*source, crate::event::PositionSource::Screenshot);
                assert_eq!(*x, -232.18);
                assert!(yaw.is_some());
            }
            other => panic!("{other:?}"),
        }

        // 新日志行。
        let mut f = fs::OpenOptions::new().append(true).open(&log).unwrap();
        write!(
            f,
            "{}",
            line("2026-11-15 18:34:47.489", "Disposing BEClient")
        )
        .unwrap();
        drop(f);
        let events = collect(
            &w,
            |evs| evs.iter().any(|e| matches!(e, Event::RaidEnded { .. })),
            Duration::from_secs(5),
        );
        assert!(
            events.iter().any(|e| matches!(e, Event::RaidEnded { .. })),
            "{events:?}"
        );

        w.stop();
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn switches_to_newer_log_dir() {
        let root = tmp_root("switch");
        let shots = root.join("Escape from Tarkov").join("Screenshots");
        fs::create_dir_all(&shots).unwrap();
        let old_dir = root
            .join("Logs")
            .join("log_2026.11.15_17-46-54_1.3.0.2.48779");
        fs::create_dir_all(&old_dir).unwrap();
        let mut text = String::new();
        text += &line("2026-11-15 17:47:10.253", "Session mode: Pve");
        text += &line(
            "2026-11-15 17:53:17.104",
            "scene preset path:maps/customs_preset.bundle rcid:bigmap.scenespreset.asset",
        );
        text += &line(
            "2026-11-15 18:00:40.493",
            "GameStarted:293.32(293.32) real:315.92(315.92) diff:22.6",
        );
        fs::write(old_dir.join("application.log"), text).unwrap();

        let w = Watcher::start(
            WatchOptions::default()
                .game_dir(&root)
                .screenshot_dir(&shots)
                .poll_interval(Duration::from_millis(50)),
        );
        let events = collect(
            &w,
            |evs| evs.iter().any(|e| matches!(e, Event::RaidStarted { .. })),
            Duration::from_secs(5),
        );
        assert!(
            events
                .iter()
                .any(|e| matches!(e, Event::RaidStarted { .. })),
            "{events:?}"
        );

        // 游戏重启：新目录。上一局没收到 Disposing，也要补一个 raid_ended。
        let new_dir = root
            .join("Logs")
            .join("log_2026.11.15_19-00-00_1.3.0.2.48779");
        fs::create_dir_all(&new_dir).unwrap();
        fs::write(
            new_dir.join("application.log"),
            line("2026-11-15 19:00:05.000", "Session mode: PvpSeason"),
        )
        .unwrap();

        let events = collect(
            &w,
            |evs| {
                evs.iter().any(|e| {
                    matches!(
                        e,
                        Event::Session {
                            mode: Mode::PvpSeason,
                            ..
                        }
                    )
                })
            },
            Duration::from_secs(5),
        );
        assert!(
            events.iter().any(|e| matches!(
                e,
                Event::Session {
                    mode: Mode::PvpSeason,
                    ..
                }
            )),
            "{events:?}"
        );
        assert!(
            events.iter().any(|e| matches!(e, Event::RaidEnded { .. })),
            "换日志目录时应该结束上一局：{events:?}"
        );
        let new_dir_str = paths::path_to_string(&new_dir);
        assert!(
            events
                .iter()
                .any(|e| matches!(e, Event::Paths { log_dir: Some(d), .. } if *d == new_dir_str)),
            "{events:?}"
        );

        w.stop();
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn follows_a_log_file_that_appears_later() {
        // 游戏先建目录、后写 application.log。
        let root = tmp_root("late-log");
        let shots = root.join("Escape from Tarkov").join("Screenshots");
        fs::create_dir_all(&shots).unwrap();
        let log_dir = root
            .join("Logs")
            .join("log_2026.11.15_17-46-54_1.3.0.2.48779");
        fs::create_dir_all(&log_dir).unwrap();

        let w = Watcher::start(
            WatchOptions::default()
                .game_dir(&root)
                .screenshot_dir(&shots)
                .poll_interval(Duration::from_millis(50)),
        );
        let events = collect(
            &w,
            |evs| evs.iter().any(|e| matches!(e, Event::Paths { .. })),
            Duration::from_secs(5),
        );
        assert!(
            events.iter().any(|e| matches!(e, Event::Paths { .. })),
            "{events:?}"
        );

        fs::write(
            log_dir.join("application.log"),
            line("2026-11-15 17:47:10.253", "Session mode: Pve"),
        )
        .unwrap();
        let events = collect(
            &w,
            |evs| evs.iter().any(|e| matches!(e, Event::Session { .. })),
            Duration::from_secs(5),
        );
        assert!(
            events.iter().any(|e| matches!(
                e,
                Event::Session {
                    mode: Mode::Pve,
                    ..
                }
            )),
            "{events:?}"
        );

        w.stop();
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn reports_preset_names_it_could_not_translate() {
        // 对照表里没有的预设：加载时报原样，进局记录里是地点名，这一对要能拿出来。
        let root = tmp_root("mismatch");
        let shots = root.join("Escape from Tarkov").join("Screenshots");
        fs::create_dir_all(&shots).unwrap();
        let log_dir = root
            .join("Logs")
            .join("log_2026.11.15_17-46-54_1.3.0.2.48779");
        fs::create_dir_all(&log_dir).unwrap();
        let mut text = String::new();
        text += &line(
            "2026-11-15 17:53:17.104",
            "scene preset path:maps/streets_preset.bundle rcid:Some_New_Preset.scenespreset.asset",
        );
        text += &line(
            "2026-11-15 17:58:38.249",
            "TRACE-NetworkGameCreate profileStatus: 'Profileid: aaaaaaaaaaaaaaaaaaaa5f81, Status: Busy, RaidMode: Online, Ip: 1.2.3.4, Port: 17000, Location: TarkovStreets, Sid: x, GameMode: deathmatch, shortId: y'",
        );
        fs::write(log_dir.join("application.log"), text).unwrap();

        let w = Watcher::start(
            WatchOptions::default()
                .game_dir(&root)
                .screenshot_dir(&shots)
                .poll_interval(Duration::from_millis(50)),
        );
        let events = collect(
            &w,
            |evs| evs.iter().any(|e| matches!(e, Event::RaidLoading { .. })),
            Duration::from_secs(5),
        );
        assert!(
            events
                .iter()
                .any(|e| matches!(e, Event::RaidLoading { map, .. } if map == "Some_New_Preset")),
            "{events:?}"
        );

        // 进局记录读进来之后，这一对应该出现在 map_mismatches 里。
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if w.map_mismatches()
                == vec![("Some_New_Preset".to_string(), "TarkovStreets".to_string())]
            {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "没等到对照表缺口：{:?}",
                w.map_mismatches()
            );
            thread::sleep(Duration::from_millis(20));
        }

        w.stop();
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn picks_up_a_screenshot_dir_that_appears_later() {
        // 截图目录是游戏拍第一张截图时建出来的：那一张要算数。
        let root = tmp_root("late-shots");
        let shots = root.join("Escape from Tarkov").join("Screenshots");
        let w = Watcher::start(
            WatchOptions::default()
                .game_dir(&root)
                .screenshot_dir(&shots)
                .poll_interval(Duration::from_millis(50)),
        );
        let events = collect(
            &w,
            |evs| evs.iter().any(|e| matches!(e, Event::Paths { .. })),
            Duration::from_secs(5),
        );
        assert!(
            events.iter().any(|e| matches!(e, Event::Paths { .. })),
            "{events:?}"
        );

        fs::create_dir_all(&shots).unwrap();
        fs::write(shots.join(shot_name("2026-11-15[18-02]", -232.18)), b"x").unwrap();
        let events = collect(
            &w,
            |evs| evs.iter().any(|e| matches!(e, Event::Position { .. })),
            Duration::from_secs(5),
        );
        assert!(
            events
                .iter()
                .any(|e| matches!(e, Event::Position { x, .. } if *x == -232.18)),
            "{events:?}"
        );

        w.stop();
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn snapshot_is_the_same_state_the_events_come_from() {
        let root = tmp_root("snapshot");
        let shots = root.join("Escape from Tarkov").join("Screenshots");
        fs::create_dir_all(&shots).unwrap();
        let log_dir = root
            .join("Logs")
            .join("log_2026.11.15_17-46-54_1.3.0.2.48779");
        fs::create_dir_all(&log_dir).unwrap();
        let mut text = String::new();
        text += &line("2026-11-15 17:47:10.253", "Session mode: Pve");
        text += &line(
            "2026-11-15 17:53:17.104",
            "scene preset path:maps/customs_preset.bundle rcid:bigmap.scenespreset.asset",
        );
        text += &line(
            "2026-11-15 18:00:40.493",
            "GameStarted:293.32(293.32) real:315.92(315.92) diff:22.6",
        );
        fs::write(log_dir.join("application.log"), text).unwrap();

        let w = Watcher::start(
            WatchOptions::default()
                .game_dir(&root)
                .screenshot_dir(&shots)
                .poll_interval(Duration::from_millis(50)),
        );
        collect(
            &w,
            |evs| evs.iter().any(|e| matches!(e, Event::RaidStarted { .. })),
            Duration::from_secs(5),
        );

        // 快照要从还没收到事件的时候就能取到（界面启动时先 invoke 一次）。
        let snap = w.snapshot();
        assert_eq!(
            snap.paths.game_dir.as_deref(),
            Some(paths::path_to_string(&root).as_str())
        );
        assert_eq!(snap.mode, Some(Mode::Pve));
        let raid = snap.raid.expect("快照里应该有当前对局");
        assert_eq!(raid.map, "bigmap");
        assert!(raid.started);
        assert!(!raid.scav);
        assert_eq!(
            raid.started_at.map(|t| t.to_string()).as_deref(),
            Some("2026-11-15T18:00:40.493")
        );
        assert!(snap.position.is_none());
        assert!(snap.trail.is_empty());

        // 新截图进来后，快照跟着变。
        fs::write(shots.join(shot_name("2026-11-15[18-02]", -232.18)), b"x").unwrap();
        collect(
            &w,
            |evs| evs.iter().any(|e| matches!(e, Event::Position { .. })),
            Duration::from_secs(5),
        );
        let snap = w.snapshot();
        let position = snap.position.expect("快照里应该有定位");
        assert_eq!(position.x, -232.18);
        assert_eq!(snap.trail.len(), 1);
        assert_eq!(snap.trail[0].x, -232.18);

        w.stop();
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn set_game_dir_switches_where_the_logs_come_from() {
        // 一开始游戏目录是空的（没装游戏、或者装在我们不知道的地方）。
        let root = tmp_root("pick-dir");
        let shots = root.join("Escape from Tarkov").join("Screenshots");
        fs::create_dir_all(&shots).unwrap();
        let w = Watcher::start(
            WatchOptions::default()
                .screenshot_dir(&shots)
                .poll_interval(Duration::from_millis(50)),
        );
        let events = collect(
            &w,
            |evs| evs.iter().any(|e| matches!(e, Event::Paths { .. })),
            Duration::from_secs(5),
        );
        assert!(
            events
                .iter()
                .any(|e| matches!(e, Event::Paths { log_dir: None, .. })),
            "一开始没有游戏目录：{events:?}"
        );

        // 用户在界面上手选了游戏目录。
        let picked = root.join("EFT");
        let log_dir = picked
            .join("Logs")
            .join("log_2026.11.15_17-46-54_1.3.0.2.48779");
        fs::create_dir_all(&log_dir).unwrap();
        fs::write(
            log_dir.join("application.log"),
            line("2026-11-15 17:47:10.253", "Session mode: Pve"),
        )
        .unwrap();
        w.set_game_dir(Some(picked.clone()));

        let events = collect(
            &w,
            |evs| evs.iter().any(|e| matches!(e, Event::Session { .. })),
            Duration::from_secs(5),
        );
        let picked_str = paths::path_to_string(&picked);
        let log_str = paths::path_to_string(&log_dir);
        assert!(
            events.iter().any(|e| matches!(
                e,
                Event::Paths { game_dir: Some(g), log_dir: Some(l), .. }
                    if *g == picked_str && *l == log_str
            )),
            "{events:?}"
        );
        assert!(
            events.iter().any(|e| matches!(
                e,
                Event::Session {
                    mode: Mode::Pve,
                    ..
                }
            )),
            "{events:?}"
        );
        assert_eq!(
            w.snapshot().paths.game_dir.as_deref(),
            Some(picked_str.as_str())
        );

        w.stop();
        fs::remove_dir_all(&root).unwrap();
    }
}
