//! 找目录：截图目录、游戏目录、`Logs` 下最新的日志目录。
//!
//! 只用文件系统和系统接口（Windows 上读注册表、问系统"文档"在哪），不碰游戏进程。
//! 路径用 [`std::path`] 拼，不写死分隔符。

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
/// "文档"用系统接口问（见 [`documents_dir`]），不拼 `C:\Users\...`。
/// 只返回真实存在的目录。
pub fn default_screenshot_dir() -> Option<PathBuf> {
    let dir = documents_dir()?
        .join("Escape from Tarkov")
        .join("Screenshots");
    dir.is_dir().then(|| clean_path(&dir))
}

/// 系统里的"文档"目录。
///
/// Windows 上走 `SHGetKnownFolderPath(FOLDERID_Documents)`（`dirs` 包了一层），
/// 文档被 OneDrive 接管、被组策略改到别的盘时都跟着走。别的系统上走 XDG。
/// 系统接口没给出来（少见）时退回用户主目录下的常见位置。
pub fn documents_dir() -> Option<PathBuf> {
    if let Some(dir) = dirs::document_dir() {
        return Some(dir);
    }
    let home = home_dir()?;
    [
        home.join("Documents"),
        home.join("OneDrive").join("Documents"),
    ]
    .into_iter()
    .find(|p| p.is_dir())
}

/// 用户主目录。
pub fn home_dir() -> Option<PathBuf> {
    let var = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    std::env::var_os(var)
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
}

/// 默认的游戏目录：Windows 上读注册表里 EFT 的安装位置。
///
/// 键是 `HKLM\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\EscapeFromTarkov`
/// （EFT 的安装程序是 32 位的，所以落在 `WOW6432Node` 下），值是 `InstallLocation`。
/// 只返回真实存在的目录；别的系统上没有这个概念，返回 `None`。
///
/// 查到一次就记住：游戏是 otm 跑起来之后才装上的话，得重开 otm 才认。
pub fn default_game_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        use std::sync::OnceLock;

        static CACHE: OnceLock<PathBuf> = OnceLock::new();
        if let Some(dir) = CACHE.get() {
            return Some(dir.clone());
        }
        let dir = game_dir_from_registry()?;
        // 两个线程同时查到同一个目录时 set 会失败，值一样，不用管。
        let _ = CACHE.set(dir.clone());
        Some(dir)
    }
    #[cfg(not(windows))]
    {
        None
    }
}

/// 从注册表读 EFT 的安装目录。键不在、值不在、目录不存在都返回 `None`。
#[cfg(windows)]
fn game_dir_from_registry() -> Option<PathBuf> {
    use winreg::enums::{HKEY_LOCAL_MACHINE, KEY_READ};
    use winreg::RegKey;

    /// EFT 的卸载信息。32 位安装程序写在 `WOW6432Node` 下，
    /// 64 位的那份也看一眼，免得以后换了安装程序就不认。
    const KEYS: [&str; 2] = [
        r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\EscapeFromTarkov",
        r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\EscapeFromTarkov",
    ];

    let machine = RegKey::predef(HKEY_LOCAL_MACHINE);
    for key in KEYS {
        let Ok(key) = machine.open_subkey_with_flags(key, KEY_READ) else {
            continue;
        };
        let Ok(install) = key.get_value::<String, _>("InstallLocation") else {
            continue;
        };
        // 有的安装程序会在值里带引号，末尾可能带分隔符。
        let dir = clean_path(Path::new(install.trim().trim_matches('"')));
        if dir.is_dir() {
            return Some(dir);
        }
    }
    None
}

/// 从截图目录反推游戏目录：`<文档>/Escape from Tarkov/Screenshots` 往上一级是
/// `<文档>/Escape from Tarkov`，里面如果有 `Logs` 目录，那就是游戏目录。
pub fn game_dir_from_screenshot_dir(screenshot_dir: &Path) -> Option<PathBuf> {
    let dir = clean_path(screenshot_dir);
    let game_dir = dir.parent()?;
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
///
/// 时间相同的两个目录（同一秒启动两次）取名字大的那个，保证每次挑到同一个。
pub fn latest_log_dir(logs_dir: &Path) -> Option<PathBuf> {
    let mut best: Option<(Timestamp, String, PathBuf)> = None;
    for entry in fs::read_dir(logs_dir).ok()?.flatten() {
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        let Some(parsed) = LogDirName::parse(&name) else {
            continue;
        };
        let better = match &best {
            None => true,
            Some((time, old_name, _)) => (parsed.time, &name) > (*time, old_name),
        };
        if better {
            best = Some((parsed.time, name, entry.path()));
        }
    }
    best.map(|(_, _, p)| p)
}

/// 一个日志目录里的 `application` 日志文件。
///
/// 优先 `application.log`；没有时在所有 `application` 日志里取名字最大的那个
/// （日志轮换出来的 `application_001.log` 比 `application_000.log` 新，
/// `read_dir` 的顺序不保证，所以按名字排）。
///
/// 实机上这两种名字都出现过：
///
/// ```text
/// application.log
/// log_2026.11.15_17-46-54_1.3.0.2.48779 application_000.log   ← 带目录名前缀
/// ```
///
/// 名字前面带什么不管，`application` 得是完整的一个词：`backend_000.log`、
/// `network-messages_000.log` 这些同目录下的别的日志不能认成它。
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
        if is_application_log(&name.to_string_lossy()) && found.as_ref().is_none_or(|f| name > *f) {
            found = Some(name);
        }
    }
    found.map(|n| log_dir.join(n))
}

/// 这个文件名是不是 `application` 日志。
///
/// `application` 要在词首（开头或空格之后），后面紧跟 `.log`、`_` 或字符串结尾。
/// 所以 `application.log`、`<目录名> application_000.log`、`application_2026.11.14.log`
/// 都算，`my-application-notes.txt`、`backend_000.log` 不算。
fn is_application_log(name: &str) -> bool {
    const WORD: &str = "application";
    let lower = name.to_ascii_lowercase();
    if !lower.ends_with(".log") {
        return false;
    }
    let mut from = 0;
    while let Some(pos) = lower[from..].find(WORD) {
        let at = from + pos;
        let after = &lower[at + WORD.len()..];
        let before_ok = at == 0 || lower.as_bytes()[at - 1] == b' ';
        let after_ok = after.is_empty() || after.starts_with('.') || after.starts_with('_');
        if before_ok && after_ok {
            return true;
        }
        from = at + WORD.len();
    }
    false
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
        assert_eq!(
            path_to_string(Path::new("/home/otae/EFT")),
            "/home/otae/EFT"
        );
    }

    /// 注册表只在 Windows 上有，别的系统上找游戏目录这条路要干脆地空着。
    #[cfg(not(windows))]
    #[test]
    fn no_game_dir_from_registry_off_windows() {
        assert_eq!(default_game_dir(), None);
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
        assert_eq!(
            application_log_file(&root).unwrap(),
            root.join("application.log")
        );
        // 没有 application.log 时取名字最大的那个轮换文件。
        fs::remove_file(root.join("application.log")).unwrap();
        fs::write(root.join("application_2026.11.14.log"), "x").unwrap();
        fs::write(root.join("application_2026.11.15.log"), "x").unwrap();
        assert_eq!(
            application_log_file(&root).unwrap(),
            root.join("application_2026.11.15.log")
        );
        fs::remove_dir_all(&root).unwrap();
    }

    /// 实机上的名字带目录名前缀：`log_.../2026.11.15_17-46-53_1.3.0.2.48779 application_000.log`。
    /// 按 `starts_with("application")` 找的话一个都找不到，日志就整个读不到了。
    #[test]
    fn finds_the_prefixed_application_log_the_game_writes() {
        let root = std::env::temp_dir().join(format!("otm-app-prefixed-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        for name in [
            "2026.11.15_17-46-53_1.3.0.2.48779 application_000.log",
            "2026.11.15_17-46-53_1.3.0.2.48779 backend_000.log",
            "2026.11.15_17-46-53_1.3.0.2.48779 network-messages_000.log",
            "2026.11.15_17-46-53_1.3.0.2.48779 errors_000.log",
        ] {
            fs::write(root.join(name), "x").unwrap();
        }
        assert_eq!(
            application_log_file(&root).unwrap(),
            root.join("2026.11.15_17-46-53_1.3.0.2.48779 application_000.log")
        );

        // 轮换成 001 时跟新的那个。
        fs::write(
            root.join("2026.11.15_17-46-53_1.3.0.2.48779 application_001.log"),
            "x",
        )
        .unwrap();
        assert_eq!(
            application_log_file(&root).unwrap(),
            root.join("2026.11.15_17-46-53_1.3.0.2.48779 application_001.log")
        );

        // 有 application.log 时还是先认它。
        fs::write(root.join("application.log"), "x").unwrap();
        assert_eq!(
            application_log_file(&root).unwrap(),
            root.join("application.log")
        );
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn application_log_name_is_a_whole_word() {
        assert!(is_application_log("application.log"));
        assert!(is_application_log("APPLICATION.LOG"));
        assert!(is_application_log(
            "2026.11.15_17-46-53_1.3.0.2.48779 application_000.log"
        ));
        assert!(is_application_log("application_2026.11.14.log"));
        // 别的日志、别的程序的文件都不算。
        assert!(!is_application_log(
            "2026.11.15_17-46-53_1.3.0.2.48779 backend_000.log"
        ));
        assert!(!is_application_log("network-messages_000.log"));
        assert!(!is_application_log("my-application-notes.log"));
        assert!(!is_application_log("application.log.bak"));
        assert!(!is_application_log("applications_000.log"));
    }

    #[test]
    fn game_dir_from_screenshot_dir_works() {
        // 实机上的布局：`文档/Escape from Tarkov/{Logs,Screenshots}`。
        let docs = std::env::temp_dir().join(format!("otm-game-{}", std::process::id()));
        let _ = fs::remove_dir_all(&docs);
        let game = docs.join("Escape from Tarkov");
        let shots = game.join("Screenshots");
        fs::create_dir_all(&shots).unwrap();
        assert!(game_dir_from_screenshot_dir(&shots).is_none());
        fs::create_dir_all(game.join("Logs")).unwrap();
        assert_eq!(game_dir_from_screenshot_dir(&shots).unwrap(), game);
        // 上一级（文档目录）里的 Logs 不算。
        fs::create_dir_all(docs.join("Logs")).unwrap();
        assert_eq!(game_dir_from_screenshot_dir(&shots).unwrap(), game);
        fs::remove_dir_all(&docs).unwrap();
    }
}
