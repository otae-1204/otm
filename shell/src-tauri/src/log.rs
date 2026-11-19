//! 外壳的日志：出问题时只有这个文件能看。
//!
//! 位置是 `%LOCALAPPDATA%\dev.otae.otm\otm.log`（拿不到就退回临时目录），
//! 每行 `时间 级别 内容`，时间是世界时（`Z`）。超过 1 MB 改成 `otm.log.1`，下次从头写。
//!
//! 界面也能写：`overlay_log` 命令，见 `overlay.rs`；界面那边只在出错和挂载时说一句。

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

/// 日志文件到多大就换一个。
const MAX_BYTES: u64 = 1024 * 1024;
/// 一行最长多少字（界面报上来的错误可能很长）。
const MAX_LINE: usize = 2000;

static FILE: OnceLock<Mutex<Option<PathBuf>>> = OnceLock::new();

fn slot() -> &'static Mutex<Option<PathBuf>> {
    FILE.get_or_init(|| Mutex::new(None))
}

/// 定下日志文件，顺手写一行头。只有第一次生效。
pub fn init(path: PathBuf) {
    let mut g = slot().lock().unwrap_or_else(|e| e.into_inner());
    if g.is_some() {
        return;
    }
    if let Some(dir) = path.parent() {
        let _ = fs::create_dir_all(dir);
    }
    // 太大就挪走，别让日志无限长
    if fs::metadata(&path)
        .map(|m| m.len() > MAX_BYTES)
        .unwrap_or(false)
    {
        let _ = fs::rename(&path, path.with_extension("log.1"));
    }
    *g = Some(path.clone());
    drop(g);
    info(format!(
        "otm {} 启动，日志写在 {}",
        env!("CARGO_PKG_VERSION"),
        path.display()
    ));
}

/// tao / wry / tauri 自己的警告也接进这个文件（比如事件循环里派发失败，
/// 那种错误只在它们自己的 `log` 里，控制台看不见）。
pub fn bridge_crates() {
    ::log::set_logger(&CRATES).ok();
    ::log::set_max_level(::log::LevelFilter::Info);
}

static CRATES: Crates = Crates;

struct Crates;

impl ::log::Log for Crates {
    fn enabled(&self, metadata: &::log::Metadata) -> bool {
        metadata.level() <= ::log::Level::Info
    }

    fn log(&self, record: &::log::Record) {
        if !self.enabled(record.metadata()) {
            return;
        }
        let level = match record.level() {
            ::log::Level::Error => "ERROR",
            ::log::Level::Warn => "WARN",
            _ => "INFO",
        };
        write(level, format!("[{}] {}", record.target(), record.args()));
    }

    fn flush(&self) {}
}

/// 写一行。没定下日志文件时什么都不做。
pub fn write(level: &str, msg: impl AsRef<str>) {
    let g = slot().lock().unwrap_or_else(|e| e.into_inner());
    let Some(path) = g.as_ref() else { return };
    let mut line = msg.as_ref().trim().replace('\n', " ⏎ ");
    if line.chars().count() > MAX_LINE {
        line = line.chars().take(MAX_LINE).collect::<String>() + "…";
    }
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, "{} {level} {line}", now());
    }
}

pub fn info(msg: impl AsRef<str>) {
    write("INFO", msg);
}

pub fn warn(msg: impl AsRef<str>) {
    write("WARN", msg);
}

pub fn error(msg: impl AsRef<str>) {
    write("ERROR", msg);
}

/// 崩溃也留一行：实机上窗口没出来、程序自己退掉，日志里得看得见。
pub fn install_panic_hook() {
    let prev = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        error(format!("崩溃（panic）：{info}"));
        prev(info);
    }));
}

/// 世界时，`2026-11-19T08:34:50Z`。不想为一行时间引一个日期库，自己算。
fn now() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let (days, rem) = ((secs / 86_400) as i64, secs % 86_400);
    let (h, mi, s) = (rem / 3600, rem % 3600 / 60, rem % 60);
    // 公历从「天数」倒推（Howard Hinnant 的 civil_from_days）
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe as i64 + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}T{h:02}:{mi:02}:{s:02}Z")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_timestamp_looks_like_a_date() {
        let t = now();
        assert_eq!(t.len(), 20, "{t}");
        assert!(t.ends_with('Z'), "{t}");
        assert_eq!(&t[4..5], "-");
        assert_eq!(&t[10..11], "T");
    }

    #[test]
    fn lines_go_to_the_file() {
        let dir = std::env::temp_dir().join("otm-log-test");
        let _ = fs::remove_dir_all(&dir);
        let path = dir.join("otm.log");
        init(path.clone());
        info("第一行");
        error("第二行\n带换行");
        let text = fs::read_to_string(&path).unwrap();
        assert!(text.contains("INFO 第一行"), "{text}");
        assert!(text.contains("ERROR 第二行 ⏎ 带换行"), "{text}");
        let _ = fs::remove_dir_all(&dir);
    }
}
