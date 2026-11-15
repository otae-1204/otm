//! `application` 日志的一行。
//!
//! 每行长这样：
//!
//! ```text
//! 2026-11-15 18:00:40.493|1.3.0.2.48779|Info|application|GameStarted:293.32(293.32) real:315.92(315.92) diff:22.6
//! ```
//!
//! 依次是时间、版本、级别、类别、正文。这里只认 [`EVENTS.md`](../../EVENTS.md) 里
//! "数据来源"列出的那几种正文，其余一律当作 [`LogLine::Other`] 忽略。
//!
//! 注意日志里 `TRACE-NetworkGameCreate 0` 到 `6` 这些行也以同样的前缀开头，
//! 只有带 `profileStatus:` 的那一行才有地图和 RaidMode。

use crate::time::Timestamp;

/// 从日志里认出的一条有用记录。
#[derive(Debug, Clone, PartialEq)]
pub enum LogLine {
    /// `Session mode: Pve`
    SessionMode { mode: String },
    /// `scene preset path:maps/customs_preset.bundle rcid:bigmap.scenespreset.asset`
    /// 开始加载地图，`map` 是 `rcid` 里第一个点号前面的部分。
    ScenePreset { map: String },
    /// `TRACE-NetworkGameCreate profileStatus: '... Location: Interchange ... RaidMode: Online ...'`
    GameCreate {
        map: String,
        raid_mode: String,
        profile_id: Option<String>,
    },
    /// `GameStarted:...`
    GameStarted,
    /// `Reason:PacketsQueue, Position:(166.309, -0.593, 153.791), SpeedLimit:...`
    Position { x: f64, y: f64, z: f64 },
    /// `Disposing BEClient`
    DisposingBeClient,
    /// `PrepareSelectedProfileLocally ProfileId:<id>`
    PrepareSelectedProfile { profile_id: String },
    /// 别的行，不关心。
    Other,
}

/// 解析出来的一行：时间加正文。
#[derive(Debug, Clone, PartialEq)]
pub struct ParsedLine {
    pub time: Timestamp,
    pub kind: LogLine,
}

/// 解析日志的一行。整行认不出来（没有时间戳之类）返回 `None`。
pub fn parse_line(line: &str) -> Option<ParsedLine> {
    let line = line.trim_end_matches(['\r', '\n']);
    let mut fields = line.splitn(5, '|');
    let time = fields.next()?;
    let _version = fields.next()?;
    let _level = fields.next()?;
    let _category = fields.next()?;
    let message = fields.next()?;

    let time = parse_log_time(time)?;
    Some(ParsedLine {
        time,
        kind: parse_message(message),
    })
}

/// 只看正文部分，认记录的种类。没有时间戳的正文也能单独用。
pub fn parse_message(message: &str) -> LogLine {
    let message = message.trim();

    if let Some(rest) = message.strip_prefix("Session mode:") {
        let mode = rest.trim();
        if !mode.is_empty() {
            return LogLine::SessionMode {
                mode: mode.to_string(),
            };
        }
        return LogLine::Other;
    }

    if message.starts_with("scene preset path:") {
        if let Some(map) = message.split_whitespace().find_map(|w| w.strip_prefix("rcid:")) {
            let map = map.split('.').next().unwrap_or_default();
            if !map.is_empty() {
                return LogLine::ScenePreset {
                    map: map.to_string(),
                };
            }
        }
        return LogLine::Other;
    }

    if message.starts_with("TRACE-NetworkGameCreate") && message.contains("profileStatus:") {
        let map = field_value(message, "Location: ");
        let raid_mode = field_value(message, "RaidMode: ");
        let profile_id = field_value(message, "Profileid: ");
        if let (Some(map), Some(raid_mode)) = (map, raid_mode) {
            return LogLine::GameCreate {
                map,
                raid_mode,
                profile_id,
            };
        }
        return LogLine::Other;
    }

    if message.starts_with("GameStarted:") {
        return LogLine::GameStarted;
    }

    if message.starts_with("Reason:") {
        if let Some(pos) = message.find("Position:(") {
            let rest = &message[pos + "Position:(".len()..];
            if let Some(end) = rest.find(')') {
                let mut it = rest[..end].split(',');
                let x = it.next().and_then(|v| v.trim().parse::<f64>().ok());
                let y = it.next().and_then(|v| v.trim().parse::<f64>().ok());
                let z = it.next().and_then(|v| v.trim().parse::<f64>().ok());
                if let (Some(x), Some(y), Some(z)) = (x, y, z) {
                    if x.is_finite() && y.is_finite() && z.is_finite() {
                        return LogLine::Position { x, y, z };
                    }
                }
            }
        }
        return LogLine::Other;
    }

    if message.starts_with("Disposing BEClient") {
        return LogLine::DisposingBeClient;
    }

    if message.starts_with("PrepareSelectedProfileLocally") {
        if let Some(id) = field_value(message, "ProfileId:") {
            return LogLine::PrepareSelectedProfile { profile_id: id };
        }
        return LogLine::Other;
    }

    LogLine::Other
}

/// 在 `..., Key: value, ...` 这种正文里取某个键后面的值。
///
/// 值到下一个逗号或空白为止，去掉引号。`Location: bigmap` 和
/// `Profileid: aaaa..., Status: Busy` 两种写法都能取对。
fn field_value(message: &str, key: &str) -> Option<String> {
    let start = message.find(key)? + key.len();
    let rest = &message[start..];
    let end = rest
        .find(|c: char| c == ',' || c.is_whitespace())
        .unwrap_or(rest.len());
    let value = rest[..end].trim().trim_matches('\'').trim();
    if value.is_empty() {
        None
    } else {
        Some(value.to_string())
    }
}

/// 解析 `2026-11-15 18:00:40.493`。
fn parse_log_time(s: &str) -> Option<Timestamp> {
    let s = s.trim();
    let (date, clock) = s.split_once(' ')?;

    let mut d = date.split('-');
    let year: i32 = d.next()?.parse().ok()?;
    let month: u8 = d.next()?.parse().ok()?;
    let day: u8 = d.next()?.parse().ok()?;
    if d.next().is_some() {
        return None;
    }

    let (hms, frac) = match clock.split_once('.') {
        Some((a, b)) => (a, Some(b)),
        None => (clock, None),
    };
    let mut c = hms.split(':');
    let hour: u8 = c.next()?.parse().ok()?;
    let minute: u8 = c.next()?.parse().ok()?;
    let second: u8 = c.next()?.parse().ok()?;
    if c.next().is_some() {
        return None;
    }
    let milli: u16 = match frac {
        None => 0,
        Some(f) => {
            if f.is_empty() || f.len() > 9 || !f.bytes().all(|b| b.is_ascii_digit()) {
                return None;
            }
            let head: String = f.chars().chain(std::iter::repeat('0')).take(3).collect();
            head.parse().ok()?
        }
    };

    Timestamp::from_ymd_hms_milli(year, month, day, hour, minute, second, milli)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kind(line: &str) -> LogLine {
        parse_line(line).expect("应该能解析").kind
    }

    #[test]
    fn session_mode() {
        assert_eq!(
            kind("2026-11-15 17:47:10.253|1.3.0.2.48779|Info|application|Session mode: PvpSeason"),
            LogLine::SessionMode {
                mode: "PvpSeason".into()
            }
        );
        assert_eq!(
            kind("2026-11-12 20:08:41.144|1.3.0.1.48558|Info|application|Session mode: Pve"),
            LogLine::SessionMode { mode: "Pve".into() }
        );
    }

    #[test]
    fn scene_preset() {
        assert_eq!(
            kind("2026-11-15 17:53:17.104|1.3.0.2.48779|Info|application|scene preset path:maps/customs_preset.bundle rcid:bigmap.scenespreset.asset"),
            LogLine::ScenePreset {
                map: "bigmap".into()
            }
        );
        assert_eq!(
            kind("2026-11-12 20:15:03.031|1.3.0.1.48558|Info|application|scene preset path:maps/shopping_mall.bundle rcid:Shopping_Mall.ScenesPreset.asset"),
            LogLine::ScenePreset {
                map: "Shopping_Mall".into()
            }
        );
    }

    #[test]
    fn game_create() {
        assert_eq!(
            kind("2026-11-12 20:16:23.863|1.3.0.1.48558|Debug|application|TRACE-NetworkGameCreate profileStatus: 'Profileid: aaaaaaaaaaaaaaaaaaaaf17e, Status: Busy, RaidMode: Online, Ip: 10.0.0.1, Port: 17000, Location: Interchange, Sid: sn-sin03lgs018_aaaaaaaaaaaaaaaaaaaaba8b_12.11.26_15-15-20, GameMode: deathmatch, shortId: MGZHNF'"),
            LogLine::GameCreate {
                map: "Interchange".into(),
                raid_mode: "Online".into(),
                profile_id: Some("aaaaaaaaaaaaaaaaaaaaf17e".into()),
            }
        );
    }

    #[test]
    fn game_create_without_profile_status_is_ignored() {
        for n in 0..=6 {
            let line = format!(
                "2026-11-15 18:00:40.511|1.3.0.2.48779|Debug|application|TRACE-NetworkGameCreate {n}"
            );
            assert_eq!(kind(&line), LogLine::Other, "{line}");
        }
    }

    #[test]
    fn game_started() {
        assert_eq!(
            kind("2026-11-15 18:00:40.493|1.3.0.2.48779|Info|application|GameStarted:293.32(293.32) real:315.92(315.92) diff:22.6"),
            LogLine::GameStarted
        );
        // GameStarting / GameSpawned 之类不是 GameStarted。
        assert_eq!(
            kind("2026-11-12 20:18:37.371|1.3.0.1.48558|Info|application|GameStarting:197.09(3.05) real:217.88(3.08) diff:20.79"),
            LogLine::Other
        );
    }

    #[test]
    fn position() {
        assert_eq!(
            kind("2026-11-15 18:02:03.442|1.3.0.2.48779|Info|application|Reason:PacketsQueue, Position:(166.309, -0.593, 153.791), SpeedLimit:4.1, CurrentState:Run, StrengthSummaryLevel:10, WalkSpeedLimit:1"),
            LogLine::Position {
                x: 166.309,
                y: -0.593,
                z: 153.791
            }
        );
        assert_eq!(
            kind("2026-11-12 20:42:59.382|1.3.0.1.48558|Info|application|Reason:Lift, Position:(405.836, 33.281, 145.699), SpeedLimit:0.8, CurrentState:Idle, StrengthSummaryLevel:18, WalkSpeedLimit:1"),
            LogLine::Position {
                x: 405.836,
                y: 33.281,
                z: 145.699
            }
        );
    }

    #[test]
    fn disposing() {
        assert_eq!(
            kind("2026-11-15 18:34:47.489|1.3.0.2.48779|Info|application|Disposing BEClient"),
            LogLine::DisposingBeClient
        );
        assert_eq!(
            kind("2026-11-15 18:34:47.489|1.3.0.2.48779|Info|application|BEClient exit"),
            LogLine::Other
        );
    }

    #[test]
    fn prepare_selected_profile() {
        assert_eq!(
            kind("2026-11-15 17:47:56.021|1.3.0.2.48779|Info|application|PrepareSelectedProfileLocally ProfileId:aaaaaaaaaaaaaaaaaaaa5f81 AccountId:1000000"),
            LogLine::PrepareSelectedProfile {
                profile_id: "aaaaaaaaaaaaaaaaaaaa5f81".into()
            }
        );
        assert_eq!(
            kind("2026-11-15 17:47:56.022|1.3.0.2.48779|Info|application|CompleteSelectedProfile ProfileId:aaaaaaaaaaaaaaaaaaaa5f81 AccountId:1000000"),
            LogLine::Other
        );
    }

    #[test]
    fn timestamp_is_read() {
        let l = parse_line("2026-11-15 18:00:40.493|1.3.0.2.48779|Info|application|GameStarted:293.32(293.32) real:315.92(315.92) diff:22.6")
            .unwrap();
        assert_eq!(l.time.to_string(), "2026-11-15T18:00:40.493");
    }

    #[test]
    fn crlf_and_garbage() {
        let l = parse_line("2026-11-15 18:00:40.493|1.3.0.2.48779|Info|application|GameStarted:x\r\n")
            .unwrap();
        assert_eq!(l.kind, LogLine::GameStarted);
        assert!(parse_line("not a log line").is_none());
        assert!(parse_line("").is_none());
    }
}
