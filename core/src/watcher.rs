//! 监听：定时轮询截图目录和最新的日志目录，把新东西喂给状态机，每产生一个事件就交出去。
//!
//! 用轮询而不是文件系统通知：截图目录可能被同步软件改名、日志文件由游戏持续追加，
//! 轮询在 Windows 和 Linux 上行为一致，也不会漏掉"先写文件后改名"的情况。
//! 默认 500 毫秒看一次，代价可以忽略。
//!
//! 启动时先把当前日志目录里已有的内容读一遍来恢复状态，截图目录里已有的截图不算新文件，
//! 只记下它们的名字，之后新出现的才处理。

use std::collections::HashSet;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use crate::event::Event;
use crate::paths::{self, Dirs};
use crate::screenshot::parse_screenshot_name;
use crate::state::State;
use crate::tail::LogTail;
use crate::time::Timestamp;

/// 监听器怎么配。
#[derive(Debug, Clone)]
pub struct WatchOptions {
    /// 游戏目录（里面有 `Logs`）。给 `None` 时从截图目录反推。
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
}

impl Watcher {
    /// 开始监听。立刻在后台线程里找目录、读已有日志，事件从 [`Watcher::events`] 里拿。
    pub fn start(options: WatchOptions) -> Self {
        let (event_tx, event_rx) = mpsc::channel();
        let (stop_tx, stop_rx) = mpsc::channel();
        let thread = thread::Builder::new()
            .name("otm-watch".into())
            .spawn(move || {
                let mut loop_ = WatchLoop::new(options, event_tx);
                loop_.run(&stop_rx);
            })
            .expect("起不了监听线程");
        Self {
            events: event_rx,
            stop: stop_tx,
            thread: Some(thread),
        }
    }

    /// 事件。监听器停了（或者线程出错）之后会断开。
    pub fn events(&self) -> &Receiver<Event> {
        &self.events
    }

    /// 取下一个事件，最多等 `timeout`。超时返回 `None`。
    pub fn recv_timeout(&self, timeout: Duration) -> Option<Event> {
        match self.events.recv_timeout(timeout) {
            Ok(e) => Some(e),
            Err(RecvTimeoutError::Timeout) => None,
            Err(RecvTimeoutError::Disconnected) => None,
        }
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

/// 后台线程里的东西。
struct WatchLoop {
    options: WatchOptions,
    events: Sender<Event>,
    state: State,
    tail: LogTail,
    /// 已经处理过的截图文件名。
    seen_shots: HashSet<OsString>,
    /// 已经报过的目录。
    reported: Option<Dirs>,
    /// 日志目录换过没有（启动时那次不算）。
    log_dir_ready: bool,
}

impl WatchLoop {
    fn new(options: WatchOptions, events: Sender<Event>) -> Self {
        Self {
            options,
            events,
            state: State::new(),
            tail: LogTail::new(),
            seen_shots: HashSet::new(),
            reported: None,
            log_dir_ready: false,
        }
    }

    fn run(&mut self, stop: &Receiver<()>) {
        let interval = self.options.poll_interval.max(Duration::from_millis(50));

        // 第一步：找目录、报目录、读已有日志恢复状态。
        self.refresh_dirs();
        self.prime_screenshots();
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

    /// 重新找目录。找到的目录和上次不一样时，报一个 `paths` 事件。
    fn refresh_dirs(&mut self) {
        let screenshot_dir = self
            .options
            .screenshot_dir
            .clone()
            .or_else(paths::default_screenshot_dir)
            .filter(|p| p.is_dir());

        let game_dir = self
            .options
            .game_dir
            .clone()
            .or_else(|| screenshot_dir.as_deref().and_then(paths::game_dir_from_screenshot_dir))
            .filter(|p| p.is_dir());

        let log_dir = game_dir
            .as_deref()
            .and_then(|g| paths::latest_log_dir(&paths::logs_dir(g)));

        let dirs = Dirs {
            game_dir,
            screenshot_dir,
            log_dir,
        };

        if self.reported.as_ref() == Some(&dirs) {
            return;
        }
        let (game_dir_s, screenshot_dir_s, log_dir_s) = dirs.to_strings();

        // 先把目录交出去，再交日志读出来的事件：界面先知道日志在哪，再收到状态。
        let time = self.now();
        self.state.set_paths(game_dir_s.clone(), screenshot_dir_s.clone(), log_dir_s.clone());
        self.reported = Some(dirs.clone());
        self.emit(vec![Event::Paths {
            time,
            game_dir: game_dir_s,
            screenshot_dir: screenshot_dir_s,
            log_dir: log_dir_s,
        }]);

        // 日志目录换了：游戏重启过。旧目录里没读完的先读完，再从头读新目录恢复状态。
        if let Some(new_log_dir) = dirs.log_dir.clone() {
            let current = self.tail.path().map(|p| p.parent().map(Path::to_path_buf));
            let changed = current.as_ref() != Some(&Some(new_log_dir.clone()));
            if changed {
                if self.log_dir_ready {
                    self.poll_log();
                }
                if let Some(file) = paths::application_log_file(&new_log_dir) {
                    self.tail.switch_to(&file);
                    if self.options.start == LogStart::Now {
                        self.tail.skip_to_end();
                    }
                    self.poll_log();
                }
                self.log_dir_ready = true;
            }
        }
    }

    /// 启动时把截图目录里已有的文件名记下来，不当新文件。
    fn prime_screenshots(&mut self) {
        let Some(dir) = self.reported.as_ref().and_then(|d| d.screenshot_dir.clone()) else {
            return;
        };
        if let Ok(entries) = fs::read_dir(&dir) {
            for entry in entries.flatten() {
                self.seen_shots.insert(entry.file_name());
            }
        }
    }

    /// 看截图目录里有没有新文件。按文件名的顺序处理，保证按时间先后。
    fn poll_screenshots(&mut self) {
        let Some(dir) = self.reported.as_ref().and_then(|d| d.screenshot_dir.clone()) else {
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
            let events = self.state.on_screenshot(&shot);
            self.emit(events);
        }
    }

    /// 读日志新增的部分。
    fn poll_log(&mut self) {
        for record in self.tail.poll() {
            let events = self.state.on_log(record.time, &record.kind);
            self.emit(events);
        }
    }

    /// 现在的时间，精确到毫秒。用于 `paths` 这类由核心自己发起的事件。
    fn now(&self) -> Timestamp {
        let now = time::OffsetDateTime::now_local().unwrap_or_else(|_| time::OffsetDateTime::now_utc());
        Timestamp::from_ymd_hms_milli(
            now.year(),
            now.month() as u8,
            now.day(),
            now.hour(),
            now.minute(),
            now.second(),
            now.millisecond(),
        )
        .unwrap_or_else(|| {
            Timestamp::from_ymd_hms(1970, 1, 1, 0, 0, 0).expect("1970 年 1 月 1 日总是合法的")
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::event::Event;
    use std::io::Write;

    fn tmp_root(tag: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("otm-watch-{}-{tag}", std::process::id()));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
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
        let logs = root.join("Logs");
        let log_dir = logs.join("log_2026.11.15_17-46-54_1.3.0.2.48779");
        fs::create_dir_all(&log_dir).unwrap();
        let log = log_dir.join("application.log");
        fs::write(
            &log,
            "2026-11-15 17:47:10.253|1.3.0.2.48779|Info|application|Session mode: PvpSeason\r\n\
             2026-11-15 17:53:17.104|1.3.0.2.48779|Info|application|scene preset path:maps/customs_preset.bundle rcid:bigmap.scenespreset.asset\r\n\
             2026-11-15 18:00:40.493|1.3.0.2.48779|Info|application|GameStarted:293.32(293.32) real:315.92(315.92) diff:22.6\r\n",
        )
        .unwrap();

        // 启动前就有的截图不算新文件。
        fs::write(shots.join("2026-11-15[17-00]_1.00, 2.00, 3.00_0.0, 0.0, 0.0, 1.0_1.0 (0).png"), b"x").unwrap();

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
        assert!(matches!(events.first(), Some(Event::Paths { .. })), "{events:?}");
        assert!(events
            .iter()
            .any(|e| matches!(e, Event::Session { mode: crate::event::Mode::PvpSeason, .. })));
        assert!(events
            .iter()
            .any(|e| matches!(e, Event::RaidLoading { map, .. } if map == "bigmap")));
        assert!(!events.iter().any(|e| matches!(e, Event::Position { .. })));

        // 新截图。
        fs::write(shots.join("2026-11-15[18-02]_-232.18, 21.77, 16.87_0.00034, 0.97530, 0.00399, 0.22086_5.20 (0).png"), b"x").unwrap();
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
        writeln!(f, "2026-11-15 18:34:47.489|1.3.0.2.48779|Info|application|Disposing BEClient").unwrap();
        drop(f);
        let events = collect(
            &w,
            |evs| evs.iter().any(|e| matches!(e, Event::RaidEnded { .. })),
            Duration::from_secs(5),
        );
        assert!(events.iter().any(|e| matches!(e, Event::RaidEnded { .. })), "{events:?}");

        w.stop();
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn switches_to_newer_log_dir() {
        let root = tmp_root("switch");
        let shots = root.join("Escape from Tarkov").join("Screenshots");
        fs::create_dir_all(&shots).unwrap();
        let old_dir = root.join("Logs").join("log_2026.11.15_17-46-54_1.3.0.2.48779");
        fs::create_dir_all(&old_dir).unwrap();
        fs::write(
            old_dir.join("application.log"),
            "2026-11-15 17:47:10.253|1.3.0.2.48779|Info|application|Session mode: Pve\r\n",
        )
        .unwrap();

        let w = Watcher::start(
            WatchOptions::default()
                .game_dir(&root)
                .screenshot_dir(&shots)
                .poll_interval(Duration::from_millis(50)),
        );
        let events = collect(
            &w,
            |evs| evs.iter().any(|e| matches!(e, Event::Session { .. })),
            Duration::from_secs(5),
        );
        assert!(events.iter().any(|e| matches!(e, Event::Session { .. })));

        // 游戏重启：新目录。
        let new_dir = root.join("Logs").join("log_2026.11.15_19-00-00_1.3.0.2.48779");
        fs::create_dir_all(&new_dir).unwrap();
        fs::write(
            new_dir.join("application.log"),
            "2026-11-15 19:00:05.000|1.3.0.2.48779|Info|application|Session mode: PvpSeason\r\n",
        )
        .unwrap();

        let events = collect(
            &w,
            |evs| {
                evs.iter()
                    .any(|e| matches!(e, Event::Session { mode: crate::event::Mode::PvpSeason, .. }))
            },
            Duration::from_secs(5),
        );
        assert!(
            events
                .iter()
                .any(|e| matches!(e, Event::Session { mode: crate::event::Mode::PvpSeason, .. })),
            "{events:?}"
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
}
