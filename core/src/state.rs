//! 状态机：吃进日志行和截图文件名，维护状态快照，吐出事件。
//!
//! 它不认识文件，只认识"某一时刻发生了什么事"，所以监听（[`crate::watcher`]）和
//! 回放（`otm-replay`）可以喂同一份数据、得到同一串事件。
//!
//! 几条规则：
//!
//! - 进局记录里的角色编号等于 PMC 编号加一，这一局就是 Scav。
//! - `GameStarted` 之后出现的 `Disposing BEClient` 表示离开对局，清空本局轨迹。
//!   对局开始前出现的 `Disposing BEClient`（游戏启动时 BattleEye 的初始化）不算。
//! - 日志里的 `Position:` 只在加载完地图之后、离开对局之前算数。
//!   加载地图之前的那几条是上一局残留的坐标，此时地图还不知道是哪张。
//! - 同一时刻、同一坐标的重复记录只算一次（日志里偶尔有完全一样的连续两行）。

use crate::event::{
    Event, Mode, PositionSource, RaidMode, Snapshot, SnapshotPaths, SnapshotPosition,
    SnapshotRaid, TrailPoint,
};
use crate::log::LogLine;
use crate::screenshot::Screenshot;
use crate::time::Timestamp;

/// 本局轨迹最多留多少个点。超出后丢最早的点，防止一局打太久把内存撑爆。
pub const MAX_TRAIL: usize = 5000;

/// 一局的状态。
#[derive(Debug, Clone, PartialEq)]
struct RaidState {
    map: String,
    started: bool,
    scav: bool,
    started_at: Option<Timestamp>,
    raid_mode: Option<RaidMode>,
}

/// 核心的状态机。
#[derive(Debug, Clone, Default)]
pub struct State {
    paths: SnapshotPaths,
    mode: Option<Mode>,
    raid: Option<RaidState>,
    /// 进局记录里出现的角色编号，等 `GameStarted` 时再判断是 PMC 还是 Scav。
    pending_profile_id: Option<String>,
    /// 本次启动里第一次在 `PrepareSelectedProfileLocally` 见到的编号，即 PMC 的编号。
    pmc_profile_id: Option<String>,
    position: Option<SnapshotPosition>,
    trail: Vec<TrailPoint>,
}

impl State {
    pub fn new() -> Self {
        Self::default()
    }

    /// 换一份目录（找到游戏目录、切换日志目录时）。
    pub fn set_paths(
        &mut self,
        game_dir: Option<String>,
        screenshot_dir: Option<String>,
        log_dir: Option<String>,
    ) {
        self.paths = SnapshotPaths {
            game_dir,
            screenshot_dir,
            log_dir,
        };
    }

    /// 当前状态快照。
    pub fn snapshot(&self) -> Snapshot {
        Snapshot {
            paths: self.paths.clone(),
            mode: self.mode,
            raid: self.raid.as_ref().map(|r| SnapshotRaid {
                map: r.map.clone(),
                started: r.started,
                scav: r.scav,
                started_at: r.started_at,
            }),
            position: self.position.clone(),
            trail: self.trail.clone(),
        }
    }

    /// 当前已经知道的地图名（加载中或对局中）。
    pub fn current_map(&self) -> Option<&str> {
        self.raid.as_ref().map(|r| r.map.as_str())
    }

    /// 当前是否在一局里（从 `GameStarted` 到离开对局）。
    pub fn in_raid(&self) -> bool {
        self.raid.as_ref().is_some_and(|r| r.started)
    }

    /// 吃一条日志记录。返回它引起的事件。
    pub fn on_log(&mut self, time: Timestamp, line: &LogLine) -> Vec<Event> {
        match line {
            LogLine::SessionMode { mode } => match Mode::from_log(mode) {
                Some(mode) if self.mode != Some(mode) => {
                    self.mode = Some(mode);
                    vec![Event::Session { time, mode }]
                }
                _ => Vec::new(),
            },

            LogLine::ScenePreset { map } => {
                // 加载地图：上一局如果没收到"离开对局"，到这里也就结束了。
                let mut events = Vec::new();
                if self.in_raid() {
                    self.end_raid();
                    events.push(Event::RaidEnded { time });
                }
                let same_map = self
                    .raid
                    .as_ref()
                    .is_some_and(|r| r.map == *map && !r.started);
                if same_map {
                    return events;
                }
                self.pending_profile_id = None;
                self.raid = Some(RaidState {
                    map: map.clone(),
                    started: false,
                    scav: false,
                    started_at: None,
                    raid_mode: None,
                });
                events.push(Event::RaidLoading {
                    time,
                    map: map.clone(),
                });
                events
            }

            LogLine::GameCreate {
                map,
                raid_mode,
                profile_id,
            } => {
                let raid_mode = RaidMode::from_log(raid_mode);
                // 先记下角色编号，`GameStarted` 时要用它判断是不是 Scav。
                if let Some(id) = profile_id {
                    self.pending_profile_id = Some(id.clone());
                }
                match self.raid.as_mut() {
                    Some(raid) => {
                        raid.map = map.clone();
                        raid.raid_mode = raid_mode;
                    }
                    None => {
                        self.raid = Some(RaidState {
                            map: map.clone(),
                            started: false,
                            scav: false,
                            started_at: None,
                            raid_mode,
                        });
                    }
                }
                Vec::new()
            }

            LogLine::GameStarted => {
                let Some(raid) = self.raid.as_ref() else {
                    return Vec::new();
                };
                if raid.started {
                    return Vec::new();
                }
                let raid_mode = raid.raid_mode.unwrap_or(RaidMode::Online);
                let scav = self.is_scav();
                let map = raid.map.clone();
                if let Some(raid) = self.raid.as_mut() {
                    raid.started = true;
                    raid.scav = scav;
                    raid.started_at = Some(time);
                }
                vec![Event::RaidStarted {
                    time,
                    map,
                    scav,
                    raid_mode,
                }]
            }

            LogLine::Position { x, y, z } => {
                let Some(raid) = self.raid.as_ref() else {
                    return Vec::new();
                };
                if !raid.started {
                    return Vec::new();
                }
                self.push_position(time, *x, *y, *z, None, PositionSource::Log)
                    .into_iter()
                    .collect()
            }

            LogLine::DisposingBeClient => {
                if !self.in_raid() {
                    return Vec::new();
                }
                self.end_raid();
                vec![Event::RaidEnded { time }]
            }

            LogLine::PrepareSelectedProfile { profile_id } => {
                if self.pmc_profile_id.is_none() {
                    self.pmc_profile_id = Some(profile_id.clone());
                }
                Vec::new()
            }

            LogLine::Other => Vec::new(),
        }
    }

    /// 吃一张截图（文件名里的时间和坐标）。返回它引起的事件。
    ///
    /// 菜单里的截图解析出来是 `None`，调用方直接跳过。
    /// 截图的时间只精确到分钟，所以轨迹按时间排序时会和日志里的定位交错。
    pub fn on_screenshot(&mut self, shot: &Screenshot) -> Vec<Event> {
        self.push_position(
            shot.time,
            shot.x,
            shot.y,
            shot.z,
            Some(shot.yaw),
            PositionSource::Screenshot,
        )
        .into_iter()
        .collect()
    }

    /// 进局记录里的角色编号是不是 PMC 编号加一。
    fn is_scav(&self) -> bool {
        let (Some(pending), Some(pmc)) = (&self.pending_profile_id, &self.pmc_profile_id) else {
            return false;
        };
        if pending == pmc {
            return false;
        }
        is_one_more(pending, pmc)
    }

    fn end_raid(&mut self) {
        self.raid = None;
        self.pending_profile_id = None;
        self.position = None;
        self.trail.clear();
    }

    /// 记一次定位。和上一个点完全一样时忽略。
    fn push_position(
        &mut self,
        time: Timestamp,
        x: f64,
        y: f64,
        z: f64,
        yaw: Option<f64>,
        source: PositionSource,
    ) -> Option<Event> {
        if let Some(last) = self.trail.last() {
            if last.time == time && last.x == x && last.y == y && last.z == z {
                return None;
            }
        }

        self.position = Some(SnapshotPosition {
            x,
            y,
            z,
            yaw,
            source,
            time,
        });

        // 按时间插进去，保持轨迹有序。同一时间的新点排在已有的后面。
        let point = TrailPoint { x, y, z, time };
        let insert_at = self.trail.partition_point(|p| p.time <= time);
        let at_end = insert_at == self.trail.len();
        self.trail.insert(insert_at, point);
        if self.trail.len() > MAX_TRAIL {
            if at_end {
                self.trail.remove(0);
            } else {
                self.trail.pop();
            }
        }

        Some(Event::Position {
            time,
            x,
            y,
            z,
            yaw,
            source,
        })
    }
}

/// 判断 `id` 是不是 `base` 加一。角色编号是 24 位十六进制，超出 u64 的范围，
/// 所以按十六进制字符串做加一。
fn is_one_more(id: &str, base: &str) -> bool {
    let id = id.trim().to_ascii_lowercase();
    let base = base.trim().to_ascii_lowercase();
    if id.len() != base.len() || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
        return false;
    }
    let Some(digits) = hex_increment(&base) else {
        return false;
    };
    digits == id
}

/// 十六进制字符串加一，长度不变；全 F 时返回 `None`。
fn hex_increment(s: &str) -> Option<String> {
    let mut digits: Vec<u8> = s.bytes().collect();
    let mut carry = true;
    for d in digits.iter_mut().rev() {
        if !carry {
            break;
        }
        let v = (*d as char).to_digit(16)?;
        if v == 15 {
            *d = b'0';
        } else {
            *d = char::from_digit(v + 1, 16)? as u8;
            carry = false;
        }
    }
    if carry {
        return None;
    }
    String::from_utf8(digits).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::log::parse_line;

    fn ts(s: &str) -> Timestamp {
        s.parse().unwrap()
    }

    fn feed_log(state: &mut State, line: &str) -> Vec<Event> {
        let parsed = parse_line(line).expect("日志行应该能解析");
        state.on_log(parsed.time, &parsed.kind)
    }

    fn feed_shot(state: &mut State, name: &str) -> Vec<Event> {
        match crate::screenshot::parse_screenshot_name(name) {
            Some(shot) => state.on_screenshot(&shot),
            None => Vec::new(),
        }
    }

    const PMC: &str = "aaaaaaaaaaaaaaaaaaaa5f81";
    const SCAV: &str = "aaaaaaaaaaaaaaaaaaaa5f82";

    fn line(t: &str, msg: &str) -> String {
        format!("{t}|1.3.0.2.48779|Info|application|{msg}")
    }

    #[test]
    fn scav_is_pmc_id_plus_one() {
        let mut state = State::new();
        feed_log(
            &mut state,
            &line(
                "2026-11-15 17:47:56.021",
                &format!("PrepareSelectedProfileLocally ProfileId:{PMC} AccountId:1000000"),
            ),
        );
        feed_log(
            &mut state,
            &line(
                "2026-11-15 17:53:17.104",
                "scene preset path:maps/customs_preset.bundle rcid:bigmap.scenespreset.asset",
            ),
        );
        feed_log(
            &mut state,
            &line(
                "2026-11-15 17:58:38.249",
                &format!("TRACE-NetworkGameCreate profileStatus: 'Profileid: {SCAV}, Status: Busy, RaidMode: Online, Ip: 1.2.3.4, Port: 17000, Location: bigmap, Sid: x, GameMode: deathmatch, shortId: y'"),
            ),
        );
        let events = feed_log(&mut state, &line("2026-11-15 18:00:40.493", "GameStarted:1(1) real:2(2) diff:3"));
        assert_eq!(
            events,
            vec![Event::RaidStarted {
                time: ts("2026-11-15T18:00:40.493"),
                map: "bigmap".into(),
                scav: true,
                raid_mode: RaidMode::Online,
            }]
        );
    }

    #[test]
    fn pmc_is_not_scav() {
        let mut state = State::new();
        feed_log(
            &mut state,
            &line(
                "2026-11-15 17:47:56.021",
                &format!("PrepareSelectedProfileLocally ProfileId:{PMC} AccountId:1000000"),
            ),
        );
        feed_log(
            &mut state,
            &line(
                "2026-11-15 17:53:17.104",
                "scene preset path:maps/customs_preset.bundle rcid:bigmap.scenespreset.asset",
            ),
        );
        feed_log(
            &mut state,
            &line(
                "2026-11-15 17:58:38.249",
                &format!("TRACE-NetworkGameCreate profileStatus: 'Profileid: {PMC}, Status: Busy, RaidMode: Online, Ip: 1.2.3.4, Port: 17000, Location: bigmap, Sid: x, GameMode: deathmatch, shortId: y'"),
            ),
        );
        let events = feed_log(&mut state, &line("2026-11-15 18:00:40.493", "GameStarted:1(1) real:2(2) diff:3"));
        match events.as_slice() {
            [Event::RaidStarted { scav, .. }] => assert!(!scav),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn hex_increment_wraps_digits() {
        assert_eq!(hex_increment("5f81").unwrap(), "5f82");
        assert_eq!(hex_increment("0f").unwrap(), "10");
        // 全 F 时长度不变就装不下，返回 None。
        assert_eq!(hex_increment("ff"), None);
        assert!(is_one_more("aaaaaaaaaaaaaaaaaaaa5f82", "aaaaaaaaaaaaaaaaaaaa5f81"));
        assert!(!is_one_more("aaaaaaaaaaaaaaaaaaaa5f81", "aaaaaaaaaaaaaaaaaaaa5f81"));
        assert!(!is_one_more("bbbbbbbbbbbbbbbbbbbb5f82", "aaaaaaaaaaaaaaaaaaaa5f81"));
        assert!(!is_one_more("zz", "aa"));
    }

    #[test]
    fn disposing_before_game_started_is_ignored() {
        let mut state = State::new();
        feed_log(
            &mut state,
            &line(
                "2026-11-15 17:48:13.422",
                "Disposing BEClient",
            ),
        );
        assert_eq!(state.snapshot().raid, None);
    }

    #[test]
    fn raid_end_clears_trail() {
        let mut state = State::new();
        feed_log(
            &mut state,
            &line(
                "2026-11-15 17:53:17.104",
                "scene preset path:maps/customs_preset.bundle rcid:bigmap.scenespreset.asset",
            ),
        );
        feed_log(&mut state, &line("2026-11-15 18:00:40.493", "GameStarted:1(1) real:2(2) diff:3"));
        feed_shot(
            &mut state,
            "2026-11-15[18-02]_-232.18, 21.77, 16.87_0.00034, 0.97530, 0.00399, 0.22086_5.20 (0).png",
        );
        assert_eq!(state.snapshot().trail.len(), 1);
        let events = feed_log(&mut state, &line("2026-11-15 18:34:47.489", "Disposing BEClient"));
        assert_eq!(events, vec![Event::RaidEnded { time: ts("2026-11-15T18:34:47.489") }]);
        let snap = state.snapshot();
        assert_eq!(snap.trail.len(), 0);
        assert_eq!(snap.raid, None);
        assert_eq!(snap.position, None);
    }

    #[test]
    fn log_position_needs_known_map() {
        let mut state = State::new();
        let events = feed_log(
            &mut state,
            &line(
                "2026-11-15 18:00:40.485",
                "Reason:Lift, Position:(1.0, 2.0, 3.0), SpeedLimit:0.6",
            ),
        );
        assert!(events.is_empty());
    }

    #[test]
    fn duplicate_positions_are_merged() {
        let mut state = State::new();
        feed_log(
            &mut state,
            &line(
                "2026-11-15 17:53:17.104",
                "scene preset path:maps/customs_preset.bundle rcid:bigmap.scenespreset.asset",
            ),
        );
        feed_log(&mut state, &line("2026-11-15 18:00:40.493", "GameStarted:1(1) real:2(2) diff:3"));
        let p = "Reason:PacketsQueue, Position:(351.830, 1.268, -60.684), SpeedLimit:0.6";
        assert_eq!(feed_log(&mut state, &line("2026-11-15 18:24:17.607", p)).len(), 1);
        // 同一坐标、同一时刻的重复行只算一次。
        assert_eq!(feed_log(&mut state, &line("2026-11-15 18:24:17.607", p)).len(), 0);
        assert_eq!(state.snapshot().trail.len(), 1);
        // 同一坐标但时刻不同（真的没动）仍然算一次定位。
        assert_eq!(feed_log(&mut state, &line("2026-11-15 18:24:18.815", p)).len(), 1);
        assert_eq!(state.snapshot().trail.len(), 2);
    }

    #[test]
    fn trail_is_sorted_by_time() {
        let mut state = State::new();
        feed_log(
            &mut state,
            &line(
                "2026-11-15 17:53:17.104",
                "scene preset path:maps/customs_preset.bundle rcid:bigmap.scenespreset.asset",
            ),
        );
        feed_log(&mut state, &line("2026-11-15 18:00:40.493", "GameStarted:1(1) real:2(2) diff:3"));
        feed_log(
            &mut state,
            &line("2026-11-15 18:10:00.000", "Reason:PacketsQueue, Position:(9.0, 9.0, 9.0)"),
        );
        // 截图只精确到分钟，18:05 的截图排在 18:10 的日志定位之前。
        feed_shot(
            &mut state,
            "2026-11-15[18-05]_-232.18, 21.77, 16.87_0.00034, 0.97530, 0.00399, 0.22086_5.20 (0).png",
        );
        assert_eq!(state.snapshot().trail.len(), 2);
        let trail = state.snapshot().trail;
        assert_eq!(trail.len(), 2);
        assert_eq!(trail[0].x, -232.18);
        assert_eq!(trail[1].x, 9.0);
    }

    #[test]
    fn screenshot_after_log_position_goes_last() {
        let mut state = State::new();
        feed_log(
            &mut state,
            &line(
                "2026-11-15 17:53:17.104",
                "scene preset path:maps/customs_preset.bundle rcid:bigmap.scenespreset.asset",
            ),
        );
        feed_log(&mut state, &line("2026-11-15 18:00:40.493", "GameStarted:1(1) real:2(2) diff:3"));
        feed_log(
            &mut state,
            &line("2026-11-15 18:10:00.000", "Reason:PacketsQueue, Position:(9.0, 9.0, 9.0)"),
        );
        feed_shot(
            &mut state,
            "2026-11-15[18-20]_-232.18, 21.77, 16.87_0.00034, 0.97530, 0.00399, 0.22086_5.20 (0).png",
        );
        let trail = state.snapshot().trail;
        assert_eq!(trail.len(), 2);
        assert_eq!(trail[0].x, 9.0);
        assert_eq!(trail[1].x, -232.18);
        assert_eq!(
            state.snapshot().position.unwrap().source,
            PositionSource::Screenshot
        );
    }
}
