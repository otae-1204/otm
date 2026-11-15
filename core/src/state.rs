//! 状态机：吃进日志行和截图文件名，维护状态快照，吐出事件。
//!
//! 它不认识文件，只认识"某一时刻发生了什么事"，所以监听（[`crate::watcher`]）和
//! 回放（[`replay`]）可以喂同一份数据、得到同一串事件。
//!
//! 几条规则：
//!
//! - 进局记录里的角色编号等于 PMC 编号加一，这一局就是 Scav。两个编号不知道哪个时
//!   一律按 PMC 算（见 [`State::is_scav`]）。
//! - `GameStarted` 之后出现的 `Disposing BEClient` 表示离开对局，清空本局轨迹。
//!   对局开始前出现的 `Disposing BEClient`（游戏启动时 BattleEye 的初始化）不算。
//! - 日志里的 `Position:` 只在 `GameStarted` 之后、离开对局之前算数。加载地图之前的那几条
//!   是上一局残留的坐标，此时地图还不知道是哪张；`GameStarted` 之前 8 毫秒的那条是出生点，
//!   紧接着会再报一次。
//! - 截图是直接观测，什么时候拍的都算一次定位；轨迹在每次开始加载地图和离开对局时清空，
//!   所以快照里的轨迹就是这一局的。
//! - 同一时刻、同一坐标的重复记录只算一次（日志里偶尔有完全一样的连续两行）。
//! - 轨迹按到达顺序追加。调用方按时间喂进来，所以就是时间顺序；截图的时间只到分钟，
//!   同一分钟里的一张截图可能比前一条日志定位的时间早不到一分钟。

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

    /// 当前是否在一局里（从 `GameStarted` 到离开对局）。
    pub fn in_raid(&self) -> bool {
        self.raid.as_ref().is_some_and(|r| r.started)
    }

    /// 游戏重启（换到新的日志目录）时调用：上一次启动留下的东西都不算了。
    ///
    /// 返回要说给界面的事件：当时还在一局里（或者正在加载）就补一个 `raid_ended`，
    /// 否则界面会一直显示那一局。
    pub fn start_game_session(&mut self, time: Timestamp) -> Vec<Event> {
        let was_in_raid = self.raid.is_some();
        self.raid = None;
        self.pending_profile_id = None;
        self.pmc_profile_id = None;
        self.position = None;
        self.trail.clear();
        if was_in_raid {
            vec![Event::RaidEnded { time }]
        } else {
            Vec::new()
        }
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
                // 同一张图连着报两次加载，只算一次。
                if self
                    .raid
                    .as_ref()
                    .is_some_and(|r| r.map == *map && !r.started)
                {
                    return events;
                }
                // 新的一局：上一局的轨迹和定位都不算了。
                self.clear_positions();
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
                let raid_mode = raid_mode.as_deref().and_then(RaidMode::from_log);
                // 先记下角色编号，`GameStarted` 时要用它判断是不是 Scav。
                if let Some(id) = profile_id {
                    self.pending_profile_id = Some(id.clone());
                }
                match self.raid.as_mut() {
                    Some(raid) => {
                        raid.map = map.clone();
                        raid.raid_mode = raid_mode.or(raid.raid_mode);
                    }
                    None => {
                        // 没有加载记录就进局（日志被截断过）：从这里开始算新的一局。
                        self.clear_positions();
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
                // 新的对局从空轨迹开始。
                self.clear_positions();
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
                if !self.in_raid() {
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
    ///
    /// 两个编号缺一个，或者两个都对不上（换了账号、日志里漏了 PMC 编号），一律当 PMC。
    /// 宁可把 Scav 局显示成 PMC，也不要把 PMC 局显示成 Scav。
    fn is_scav(&self) -> bool {
        let (Some(pending), Some(pmc)) = (&self.pending_profile_id, &self.pmc_profile_id) else {
            return false;
        };
        pending != pmc && is_one_more(pending, pmc)
    }

    fn end_raid(&mut self) {
        self.raid = None;
        self.pending_profile_id = None;
        self.clear_positions();
    }

    fn clear_positions(&mut self) {
        self.position = None;
        self.trail.clear();
    }

    /// 记一次定位，追加到轨迹末尾。和上一个点完全一样时忽略。
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
        self.trail.push(TrailPoint { x, y, z, time });
        if self.trail.len() > MAX_TRAIL {
            self.trail.remove(0);
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

/// 把一份日志文本和一份截图文件名清单按时间合起来喂给状态机，返回事件和最终状态。
///
/// 截图清单每行一个文件名（可以带路径），空行跳过。清单里的顺序不重要，按文件名里的时间排。
/// 同一时间点上日志在先、截图在后：日志里的定位精确到毫秒，截图只到分钟，
/// 这样同一分钟里截图排在日志之后，截图（带朝向）就是这一刻最新的定位。
///
/// 回放（`otm-replay`）和测试都用它，保证两边看到的是同一串事件。
pub fn replay(log_text: &str, shot_names: &str) -> (Vec<Event>, State) {
    enum Input {
        Log(Timestamp, LogLine),
        Shot(Screenshot),
    }

    let mut inputs: Vec<Input> = Vec::new();
    for line in log_text.lines() {
        if let Some(parsed) = crate::log::parse_line(line) {
            if parsed.kind != LogLine::Other {
                inputs.push(Input::Log(parsed.time, parsed.kind));
            }
        }
    }
    for line in shot_names.lines() {
        if let Some(shot) = crate::screenshot::parse_screenshot_name(line) {
            inputs.push(Input::Shot(shot));
        }
    }

    // 排序是稳定的，同一时间、同一类的相对顺序保持不变。
    inputs.sort_by(|a, b| {
        let (ta, ra) = match a {
            Input::Log(t, _) => (*t, 0u8),
            Input::Shot(s) => (s.time, 1u8),
        };
        let (tb, rb) = match b {
            Input::Log(t, _) => (*t, 0u8),
            Input::Shot(s) => (s.time, 1u8),
        };
        ta.cmp(&tb).then(ra.cmp(&rb))
    });

    let mut state = State::new();
    let mut events = Vec::new();
    for input in inputs {
        let new = match input {
            Input::Log(time, kind) => state.on_log(time, &kind),
            Input::Shot(shot) => state.on_screenshot(&shot),
        };
        events.extend(new);
    }
    (events, state)
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

    fn scene(map: &str) -> String {
        format!("scene preset path:maps/x.bundle rcid:{map}.scenespreset.asset")
    }

    fn game_create(profile: &str, raid_mode: &str) -> String {
        format!(
            "TRACE-NetworkGameCreate profileStatus: 'Profileid: {profile}, Status: Busy, \
             RaidMode: {raid_mode}, Ip: 1.2.3.4, Port: 17000, Location: bigmap, Sid: x, \
             GameMode: deathmatch, shortId: y'"
        )
    }

    /// 走到"地图已知、对局已开始"。
    fn into_raid(state: &mut State, map: &str, profile: &str) -> Vec<Event> {
        feed_log(state, &line("2026-11-15 17:53:17.104", &scene(map)));
        feed_log(state, &line("2026-11-15 17:58:38.249", &game_create(profile, "Online")));
        feed_log(state, &line("2026-11-15 18:00:40.493", "GameStarted:1(1) real:2(2) diff:3"))
    }

    #[test]
    fn scav_is_pmc_id_plus_one() {
        let mut state = State::new();
        feed_log(
            &mut state,
            &line("2026-11-15 17:47:56.021", &format!("PrepareSelectedProfileLocally ProfileId:{PMC} AccountId:1000000")),
        );
        let events = into_raid(&mut state, "bigmap", SCAV);
        assert_eq!(
            events.last(),
            Some(&Event::RaidStarted {
                time: ts("2026-11-15T18:00:40.493"),
                map: "bigmap".into(),
                scav: true,
                raid_mode: RaidMode::Online,
            })
        );
    }

    #[test]
    fn pmc_is_not_scav() {
        let mut state = State::new();
        feed_log(
            &mut state,
            &line("2026-11-15 17:47:56.021", &format!("PrepareSelectedProfileLocally ProfileId:{PMC} AccountId:1000000")),
        );
        let events = into_raid(&mut state, "bigmap", PMC);
        match events.last() {
            Some(Event::RaidStarted { scav, .. }) => assert!(!scav),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn unknown_pmc_id_is_not_scav() {
        // 核心启动晚了，没看到 PrepareSelectedProfileLocally：只能当 PMC。
        let mut state = State::new();
        let events = into_raid(&mut state, "bigmap", SCAV);
        match events.last() {
            Some(Event::RaidStarted { scav, .. }) => assert!(!scav),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn unrelated_profile_id_is_not_scav() {
        let mut state = State::new();
        feed_log(
            &mut state,
            &line("2026-11-15 17:47:56.021", &format!("PrepareSelectedProfileLocally ProfileId:{PMC} AccountId:1000000")),
        );
        let events = into_raid(&mut state, "bigmap", "bbbbbbbbbbbbbbbbbbbb0000");
        match events.last() {
            Some(Event::RaidStarted { scav, .. }) => assert!(!scav),
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
        feed_log(&mut state, &line("2026-11-15 17:48:13.422", "Disposing BEClient"));
        assert_eq!(state.snapshot().raid, None);
    }

    #[test]
    fn raid_end_clears_trail() {
        let mut state = State::new();
        into_raid(&mut state, "bigmap", PMC);
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
    fn new_loading_clears_previous_trail() {
        // 上一局没收到 Disposing，直接开始加载下一局。
        let mut state = State::new();
        into_raid(&mut state, "bigmap", PMC);
        feed_shot(
            &mut state,
            "2026-11-15[18-02]_-232.18, 21.77, 16.87_0.00034, 0.97530, 0.00399, 0.22086_5.20 (0).png",
        );
        assert_eq!(state.snapshot().trail.len(), 1);
        let events = feed_log(&mut state, &line("2026-11-15 18:18:10.277", &scene("factory4_day")));
        assert_eq!(
            events,
            vec![
                Event::RaidEnded { time: ts("2026-11-15T18:18:10.277") },
                Event::RaidLoading {
                    time: ts("2026-11-15T18:18:10.277"),
                    map: "factory4_day".into()
                },
            ]
        );
        let snap = state.snapshot();
        assert!(snap.trail.is_empty());
        assert_eq!(snap.position, None);
    }

    #[test]
    fn repeated_loading_of_the_same_map_is_one_event() {
        let mut state = State::new();
        let first = feed_log(&mut state, &line("2026-11-15 17:53:17.104", &scene("bigmap")));
        assert_eq!(first.len(), 1);
        let second = feed_log(&mut state, &line("2026-11-15 17:55:28.231", &scene("bigmap")));
        assert!(second.is_empty(), "{second:?}");
    }

    #[test]
    fn log_position_needs_known_map() {
        let mut state = State::new();
        let events = feed_log(
            &mut state,
            &line("2026-11-15 18:00:40.485", "Reason:Lift, Position:(1.0, 2.0, 3.0), SpeedLimit:0.6"),
        );
        assert!(events.is_empty());
    }

    #[test]
    fn log_position_needs_game_started() {
        // 地图已知但还没 GameStarted：出生点那条不算。
        let mut state = State::new();
        feed_log(&mut state, &line("2026-11-15 17:53:17.104", &scene("bigmap")));
        let events = feed_log(
            &mut state,
            &line("2026-11-15 18:00:40.485", "Reason:Lift, Position:(1.0, 2.0, 3.0), SpeedLimit:0.6"),
        );
        assert!(events.is_empty());
        assert!(state.snapshot().trail.is_empty());
    }

    #[test]
    fn duplicate_positions_are_merged() {
        let mut state = State::new();
        into_raid(&mut state, "bigmap", PMC);
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
    fn positions_keep_arrival_order() {
        let mut state = State::new();
        into_raid(&mut state, "bigmap", PMC);
        feed_log(
            &mut state,
            &line("2026-11-15 18:10:00.000", "Reason:PacketsQueue, Position:(9.0, 9.0, 9.0)"),
        );
        // 截图只精确到分钟：18:10 拍的截图时间记成 18:10:00，比上一条日志早 0 秒，
        // 但它确实是后到的，轨迹按到达顺序追加，位置也是它。
        feed_shot(
            &mut state,
            "2026-11-15[18-10]_-232.18, 21.77, 16.87_0.00034, 0.97530, 0.00399, 0.22086_5.20 (0).png",
        );
        let snap = state.snapshot();
        assert_eq!(snap.trail.len(), 2);
        assert_eq!(snap.trail[0].x, 9.0);
        assert_eq!(snap.trail[1].x, -232.18);
        assert_eq!(snap.position.unwrap().source, PositionSource::Screenshot);
    }

    #[test]
    fn trail_is_capped_by_dropping_the_oldest() {
        let mut state = State::new();
        into_raid(&mut state, "bigmap", PMC);
        for i in 0..(MAX_TRAIL + 10) {
            let t = Timestamp::from_ymd_hms_milli(2026, 11, 15, 18, 0, 0, 0).unwrap();
            state.push_position(t, i as f64, 0.0, 0.0, None, PositionSource::Log);
        }
        let trail = state.snapshot().trail;
        assert_eq!(trail.len(), MAX_TRAIL);
        // 最早的点被丢掉了，最新的还在。
        assert_eq!(trail[0].x, 10.0);
        assert_eq!(trail.last().unwrap().x, (MAX_TRAIL + 9) as f64);
    }

    #[test]
    fn start_game_session_ends_the_raid() {
        let mut state = State::new();
        into_raid(&mut state, "bigmap", PMC);
        let events = state.start_game_session(ts("2026-11-15T18:40:00.000"));
        assert_eq!(
            events,
            vec![Event::RaidEnded { time: ts("2026-11-15T18:40:00.000") }]
        );
        let snap = state.snapshot();
        assert_eq!(snap.raid, None);
        assert!(snap.trail.is_empty());

        // 不在对局里时什么也不说。
        assert!(state.start_game_session(ts("2026-11-15T18:41:00.000")).is_empty());
    }

    #[test]
    fn session_mode_is_reported_once() {
        let mut state = State::new();
        let first = feed_log(&mut state, &line("2026-11-15 17:47:10.253", "Session mode: PvpSeason"));
        assert_eq!(
            first,
            vec![Event::Session { time: ts("2026-11-15T17:47:10.253"), mode: Mode::PvpSeason }]
        );
        assert!(feed_log(&mut state, &line("2026-11-15 17:48:10.253", "Session mode: PvpSeason")).is_empty());
        let changed = feed_log(&mut state, &line("2026-11-15 17:49:10.253", "Session mode: Pve"));
        assert_eq!(changed.len(), 1);
    }

    #[test]
    fn replay_merges_log_and_screenshots_in_time_order() {
        let log_text = concat!(
            "2026-11-15 17:53:17.104|1.3.0.2.48779|Info|application|scene preset path:maps/x.bundle rcid:bigmap.scenespreset.asset\n",
            "2026-11-15 18:00:40.493|1.3.0.2.48779|Info|application|GameStarted:1(1) real:2(2) diff:3\n",
            "2026-11-15 18:10:00.000|1.3.0.2.48779|Info|application|Reason:PacketsQueue, Position:(9.0, 9.0, 9.0)\n",
        );
        let shots = "2026-11-15[18-05]_-232.18, 21.77, 16.87_0.00034, 0.97530, 0.00399, 0.22086_5.20 (0).png\n";
        let (events, state) = replay(log_text, shots);
        let kinds: Vec<&str> = events
            .iter()
            .map(|e| match e {
                Event::RaidLoading { .. } => "loading",
                Event::RaidStarted { .. } => "started",
                Event::Position { source: PositionSource::Screenshot, .. } => "shot",
                Event::Position { .. } => "log",
                _ => "other",
            })
            .collect();
        assert_eq!(kinds, vec!["loading", "started", "shot", "log"]);
        assert_eq!(state.snapshot().trail.len(), 2);
    }
}
