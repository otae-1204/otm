//! 事件和状态快照，字段名与 `core/EVENTS.md` 一字不差。

use serde::{Deserialize, Serialize};

use crate::time::Timestamp;

/// 核心交给界面的一件事。序列化成 JSON 时 `type` 区分种类。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Event {
    /// 核心找到的目录。找不到的为 `null`。
    Paths {
        time: Timestamp,
        game_dir: Option<String>,
        screenshot_dir: Option<String>,
        log_dir: Option<String>,
    },
    /// 当前游戏模式（日志里的 `Session mode: X`）。
    Session { time: Timestamp, mode: Mode },
    /// 开始匹配/加载，已经知道是哪张图。
    RaidLoading { time: Timestamp, map: String },
    /// 对局开始（日志里的 `GameStarted`）。
    RaidStarted {
        time: Timestamp,
        map: String,
        scav: bool,
        raid_mode: RaidMode,
    },
    /// 对局结束。
    RaidEnded { time: Timestamp },
    /// 一次定位。
    Position {
        time: Timestamp,
        x: f64,
        y: f64,
        z: f64,
        yaw: Option<f64>,
        source: PositionSource,
    },
}

impl Event {
    /// 事件发生的时间。
    pub fn time(&self) -> Timestamp {
        match self {
            Event::Paths { time, .. }
            | Event::Session { time, .. }
            | Event::RaidLoading { time, .. }
            | Event::RaidStarted { time, .. }
            | Event::RaidEnded { time }
            | Event::Position { time, .. } => *time,
        }
    }
}

/// 游戏模式。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Mode {
    Regular,
    Pve,
    PvpSeason,
}

impl Mode {
    /// 从日志里的写法认模式。认不出来返回 `None`。
    pub fn from_log(s: &str) -> Option<Self> {
        match s.trim() {
            "Regular" => Some(Mode::Regular),
            "Pve" => Some(Mode::Pve),
            "PvpSeason" => Some(Mode::PvpSeason),
            _ => None,
        }
    }
}

/// 进局记录里的 RaidMode。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum RaidMode {
    Online,
    Coop,
}

impl RaidMode {
    /// 从日志里的写法认 RaidMode。认不出来返回 `None`。
    pub fn from_log(s: &str) -> Option<Self> {
        match s.trim() {
            "Online" => Some(RaidMode::Online),
            "Coop" => Some(RaidMode::Coop),
            _ => None,
        }
    }
}

/// 定位从哪来。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PositionSource {
    Screenshot,
    Log,
}

/// 状态快照里的一个定位。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SnapshotPosition {
    pub x: f64,
    pub y: f64,
    pub z: f64,
    pub yaw: Option<f64>,
    pub source: PositionSource,
    pub time: Timestamp,
}

/// 状态快照里的轨迹点。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TrailPoint {
    pub x: f64,
    pub y: f64,
    pub z: f64,
    pub time: Timestamp,
}

/// 状态快照里的目录。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct SnapshotPaths {
    pub game_dir: Option<String>,
    pub screenshot_dir: Option<String>,
    pub log_dir: Option<String>,
}

/// 状态快照里的当前对局。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SnapshotRaid {
    pub map: String,
    pub started: bool,
    pub scav: bool,
    pub started_at: Option<Timestamp>,
}

/// 界面启动或重连时拿到的一份当前状态。没有的部分为 `null`。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Snapshot {
    pub paths: SnapshotPaths,
    pub mode: Option<Mode>,
    pub raid: Option<SnapshotRaid>,
    pub position: Option<SnapshotPosition>,
    /// 本局所有定位，按时间排序。
    pub trail: Vec<TrailPoint>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn t() -> Timestamp {
        "2026-11-15T18:00:40.493".parse().unwrap()
    }

    #[test]
    fn event_json_matches_contract() {
        assert_eq!(
            serde_json::to_value(Event::RaidStarted {
                time: t(),
                map: "bigmap".into(),
                scav: false,
                raid_mode: RaidMode::Online,
            })
            .unwrap(),
            json!({
                "type": "raid_started",
                "time": "2026-11-15T18:00:40.493",
                "map": "bigmap",
                "scav": false,
                "raid_mode": "Online",
            })
        );

        assert_eq!(
            serde_json::to_value(Event::Position {
                time: t(),
                x: 1.5,
                y: 2.0,
                z: -3.0,
                yaw: None,
                source: PositionSource::Log,
            })
            .unwrap(),
            json!({
                "type": "position",
                "time": "2026-11-15T18:00:40.493",
                "x": 1.5,
                "y": 2.0,
                "z": -3.0,
                "yaw": null,
                "source": "log",
            })
        );

        assert_eq!(
            serde_json::to_value(Event::Paths {
                time: t(),
                game_dir: Some("D:/EFT".into()),
                screenshot_dir: None,
                log_dir: None,
            })
            .unwrap(),
            json!({
                "type": "paths",
                "time": "2026-11-15T18:00:40.493",
                "game_dir": "D:/EFT",
                "screenshot_dir": null,
                "log_dir": null,
            })
        );

        assert_eq!(
            serde_json::to_value(Event::RaidEnded { time: t() }).unwrap(),
            json!({ "type": "raid_ended", "time": "2026-11-15T18:00:40.493" })
        );
    }

    #[test]
    fn event_round_trips() {
        let e = Event::Session {
            time: t(),
            mode: Mode::PvpSeason,
        };
        let s = serde_json::to_string(&e).unwrap();
        assert_eq!(
            s,
            r#"{"type":"session","time":"2026-11-15T18:00:40.493","mode":"PvpSeason"}"#
        );
        assert_eq!(serde_json::from_str::<Event>(&s).unwrap(), e);
    }

    #[test]
    fn empty_snapshot_has_nulls() {
        let snap = Snapshot {
            paths: SnapshotPaths {
                game_dir: None,
                screenshot_dir: None,
                log_dir: None,
            },
            mode: None,
            raid: None,
            position: None,
            trail: vec![],
        };
        assert_eq!(
            serde_json::to_value(&snap).unwrap(),
            json!({
                "paths": { "game_dir": null, "screenshot_dir": null, "log_dir": null },
                "mode": null,
                "raid": null,
                "position": null,
                "trail": [],
            })
        );
    }
}
