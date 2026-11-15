//! 找目录：截图目录、游戏目录、`Logs` 下最新的日志目录。
//!
//! 只用文件系统，不碰注册表、不碰游戏进程。路径用 [`std::path`] 拼，不写死分隔符。

use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};

use crate::time::Timestamp;

/// 找出来的目录，找不到的为 `None`。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Dirs {
    pub game_dir: Option<PathBuf>,
    pub screenshot_dir: Option<PathBuf>,
    pub log_dir: Option<PathBuf>,
}

impl Dirs {
    /// 换成事件和快照里用的字符串，统一用 `/` 作分隔符。
    pub fn to_strings(&self) -> (Option<String>, Option<String>, Option<String>) {
        (
            self.game_dir.as_deref().map(path_to_string),
            self.screenshot_dir.as_deref().map(path_to_string),
            self.log_dir.as_deref().map(path_to_string),
        )
    }
}

/// 路径转字符串，分隔符统一成 `/`。Windows 上 `C:\a\b` 变成 `C:/a/b`。
pub fn path_to_string(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

/// 默认的截图目录：`<文档>/Escape from Tarkov/Screenshots`。
///
/// Windows 上优先读 `USERPROFILE\Documents`，其次 `USERPROFILE\OneDrive\Documents`
/// （文档被 OneDrive 接管时在那里）。别的系统上用 `$HOME/Documents`。
/// 只返回真实存在的目录。
pub fn default_screenshot_dir() -> Option<PathBuf> {
    let home = home_dir()?;
    let candidates = [
        home.join("Documents").join("Escape from Tarkov").join("Screenshots"),
        home.join("OneDrive")
            .join("Documents")
            .join("Escape from Tarkov")
            .join("Screenshots"),
    ];
    candidates
        .into_iter()
        .find(|p| p.is_dir())
        .map(|p| clean_path(&p))
}

/// 用户主目录。
pub fn home_dir() -> Option<PathBuf> {
    let var = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    std::env::var_os(var)
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
}

/// 从截图目录反推游戏目录：`<文档>/Escape from Tarkov/Screenshots` 往上两级是
/// `<文档>/Escape from Tarkov`，里面如果有 `Logs` 目录，那就是游戏目录。
pub fn game_dir_from_screenshot_dir(screenshot_dir: &Path) -> Option<PathBuf> {
    let dir = clean_path(screenshot_dir);
    let game_dir = dir.parent()?.parent()?;
    if game_dir.join("Logs").is_dir() {
        Some(game_dir.to_path_buf())
    } else {
        None
    }
}

/// 游戏目录下的 `Logs`。
pub fn logs_dir(game_dir: &Path) -> PathBuf {
    game_dir.join("Logs")
}

/// 一个日志目录的名字：`log_2026.11.15_18-34-46_1.3.0.2.48779`。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LogDirName {
    /// 目录名里的时间，精确到秒。
    pub time: Timestamp,
    /// 版本号，例如 `1.3.0.2.48779`。
    pub version: String,
}

impl LogDirName {
    /// 解析日志目录名。不是这种形状的返回 `None`。
    pub fn parse(name: &str) -> Option<Self> {
        let rest = name.strip_prefix("log_")?;
        // 日期、时分秒、版本；版本里可能还有下划线，所以只切前三段。
        let mut it = rest.splitn(3, '_');
        let date = it.next()?;
        let clock = it.next()?;
        let version = it.next()?;

        let mut d = date.split('.');
        let year: i32 = d.next()?.parse().ok()?;
        let month: u8 = d.next()?.parse().ok()?;
        let day: u8 = d.next()?.parse().ok()?;
        if d.next().is_some() {
            return None;
        }

        let mut c = clock.split('-');
        let hour: u8 = c.next()?.parse().ok()?;
        let minute: u8 = c.next()?.parse().ok()?;
        let second: u8 = c.next()?.parse().ok()?;
        if c.next().is_some() {
            return None;
        }

        Some(Self {
            time: Timestamp::from_ymd_hms(year, month, day, hour, minute, second)?,
            version: version.to_string(),
        })
    }
}

/// 在 `Logs` 下找最新的日志目录（按目录名里的时间排，不看修改时间）。
pub fn latest_log_dir(logs_dir: &Path) -> Option<PathBuf> {
    let mut best: Option<(Timestamp, PathBuf)> = None;
    for entry in fs::read_dir(logs_dir).ok()?.flatten() {
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let name = entry.file_name();
        let Some(parsed) = LogDirName::parse(&name.to_string_lossy()) else {
            continue;
        };
        let better = match &best {
            None => true,
            Some((t, _)) => parsed.time > *t,
        };
        if better {
            best = Some((parsed.time, entry.path()));
        }
    }
    best.map(|(_, p)| p)
}

/// 一个日志目录里的 `application` 日志文件。目录里没有时，退而找名字以 `application` 开头的文件。
pub fn application_log_file(log_dir: &Path) -> Option<PathBuf> {
    let exact = log_dir.join("application.log");
    if exact.is_file() {
        return Some(exact);
    }
    let mut found: Option<OsString> = None;
    for entry in fs::read_dir(log_dir).ok()?.flatten() {
        if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
            continue;
        }
        let name = entry.file_name();
        if name.to_string_lossy().starts_with("application") {
            found = Some(name);
            break;
        }
    }
    found.map(|n| log_dir.join(n))
}

/// 去掉路径里的 `.` 和多余的结尾分隔符，不碰文件系统。
fn clean_path(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in path.components() {
        match c {
            std::path::Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn log_dir_name() {
        let n = LogDirName::parse("log_2026.11.15_18-34-46_1.3.0.2.48779").unwrap();
        assert_eq!(n.time.to_string(), "2026-11-15T18:34:46.000");
        assert_eq!(n.version, "1.3.0.2.48779");

        assert!(LogDirName::parse("log_2026.11.15_18-34-46_1.3.0.2.48779_extra").is_some());
        assert!(LogDirName::parse("Logs").is_none());
        assert!(LogDirName::parse("log_2026.11.15_18-34").is_none());
        assert!(LogDirName::parse("log_2026.13.15_18-34-46_1.0").is_none());
    }

    #[test]
    fn path_strings_use_forward_slashes() {
        assert_eq!(path_to_string(Path::new(r"C:\EFT\Logs")), "C:/EFT/Logs");
        assert_eq!(path_to_string(Path::new("/home/otae/EFT")), "/home/otae/EFT");
    }

    #[test]
    fn picks_latest_log_dir() {
        let root = std::env::temp_dir().join(format!("otm-logs-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        for name in [
            "log_2026.11.12_20-08-24_1.3.0.1.48558",
            "log_2026.11.15_17-46-54_1.3.0.2.48779",
            "log_2026.11.14_19-00-00_1.3.0.1.48558",
            "Crashes",
        ] {
            fs::create_dir_all(root.join(name)).unwrap();
        }
        let latest = latest_log_dir(&root).unwrap();
        assert_eq!(
            latest.file_name().unwrap().to_string_lossy(),
            "log_2026.11.15_17-46-54_1.3.0.2.48779"
        );
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn finds_application_log() {
        let root = std::env::temp_dir().join(format!("otm-app-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        assert!(application_log_file(&root).is_none());
        fs::write(root.join("notepad.log"), "x").unwrap();
        assert!(application_log_file(&root).is_none());
        fs::write(root.join("application.log"), "x").unwrap();
        assert_eq!(application_log_file(&root).unwrap(), root.join("application.log"));
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn game_dir_from_screenshot_dir_works() {
        let root = std::env::temp_dir().join(format!("otm-game-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let shots = root.join("Escape from Tarkov").join("Screenshots");
        fs::create_dir_all(&shots).unwrap();
        assert!(game_dir_from_screenshot_dir(&shots).is_none());
        fs::create_dir_all(root.join("Logs")).unwrap();
        assert_eq!(game_dir_from_screenshot_dir(&shots).unwrap(), root);
        fs::remove_dir_all(&root).unwrap();
    }
}
