//! 用 `core/tests/fixtures/` 里的真实日志和截图文件名清单跑状态机，断言具体结果。

use std::collections::HashSet;
use std::path::PathBuf;

use otm_core::event::{Event, Mode, PositionSource, RaidMode};
use otm_core::log::parse_line;
use otm_core::screenshot::parse_screenshot_name;
use otm_core::state::State;
use otm_core::time::Timestamp;

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join(name)
}

fn ts(s: &str) -> Timestamp {
    s.parse().unwrap()
}

/// 用 `otm-replay` 同一套合并逻辑跑一份 fixtures。
fn replay(log: &str, shots: &str) -> (Vec<Event>, State) {
    let log_text = std::fs::read_to_string(fixture(log)).unwrap();
    let shots_text = std::fs::read_to_string(fixture(shots)).unwrap();
    otm_core::state::replay(&log_text, &shots_text)
}

/// 只跑一份日志（没有截图）。
fn replay_log(log: &str) -> (Vec<Event>, State) {
    let log_text = std::fs::read_to_string(fixture(log)).unwrap();
    otm_core::state::replay(&log_text, "")
}

/// 只要不是定位的事件。
fn milestones(events: &[Event]) -> Vec<Event> {
    events
        .iter()
        .filter(|e| !matches!(e, Event::Position { .. }))
        .cloned()
        .collect()
}

#[test]
fn season_session_milestones() {
    let (events, _) = replay("season_session.application.log", "screenshot_names.txt");
    assert_eq!(
        milestones(&events),
        vec![
            Event::Session {
                time: ts("2026-11-15T17:47:10.253"),
                mode: Mode::PvpSeason
            },
            Event::RaidLoading {
                time: ts("2026-11-15T17:53:17.104"),
                map: "bigmap".into()
            },
            Event::RaidStarted {
                time: ts("2026-11-15T18:00:40.493"),
                map: "bigmap".into(),
                scav: false,
                raid_mode: RaidMode::Online
            },
            Event::RaidEnded {
                time: ts("2026-11-15T18:08:21.524")
            },
            Event::RaidLoading {
                time: ts("2026-11-15T18:18:10.277"),
                map: "bigmap".into()
            },
            Event::RaidStarted {
                time: ts("2026-11-15T18:21:03.074"),
                map: "bigmap".into(),
                scav: false,
                raid_mode: RaidMode::Online
            },
            Event::RaidEnded {
                time: ts("2026-11-15T18:34:47.489")
            },
        ]
    );
}

#[test]
fn season_session_has_two_raids_on_bigmap() {
    let (events, state) = replay("season_session.application.log", "screenshot_names.txt");
    let started: Vec<_> = events
        .iter()
        .filter_map(|e| match e {
            Event::RaidStarted { map, scav, .. } => Some((map.clone(), *scav)),
            _ => None,
        })
        .collect();
    assert_eq!(
        started,
        vec![("bigmap".to_string(), false), ("bigmap".to_string(), false)]
    );

    let ended = events
        .iter()
        .filter(|e| matches!(e, Event::RaidEnded { .. }))
        .count();
    assert_eq!(ended, 2);

    // 日志在 18:34:47 离开对局，之后没有新的加载，所以最后没有进行中的对局。
    assert_eq!(state.snapshot().raid, None);
    assert_eq!(state.snapshot().mode, Some(Mode::PvpSeason));
}

#[test]
fn season_session_log_positions() {
    let (events, _) = replay("season_session.application.log", "screenshot_names.txt");
    let log_positions: Vec<(Timestamp, f64, f64, f64)> = events
        .iter()
        .filter_map(|e| match e {
            Event::Position {
                time,
                x,
                y,
                z,
                source: PositionSource::Log,
                ..
            } => Some((*time, *x, *y, *z)),
            _ => None,
        })
        .collect();
    assert_eq!(
        log_positions,
        vec![
            // GameStarted 之前那条 Reason:Lift 在加载地图之前，地图还不知道，丢掉。
            (ts("2026-11-15T18:00:42.405"), -19.772, -8.492, 113.284),
            (ts("2026-11-15T18:02:03.442"), 166.309, -0.593, 153.791),
            (ts("2026-11-15T18:02:04.655"), 166.229, -0.593, 153.12),
            (ts("2026-11-15T18:02:05.926"), 165.811, -0.593, 152.048),
            (ts("2026-11-15T18:21:05.740"), 617.72, -0.35, -96.86),
            (ts("2026-11-15T18:24:17.607"), 351.83, 1.268, -60.684),
            (ts("2026-11-15T18:24:18.815"), 351.83, 1.268, -60.684),
            (ts("2026-11-15T18:24:49.771"), 324.558, 4.855, -60.292),
        ]
    );

    // 日志来源的定位没有朝向。
    assert!(events.iter().all(|e| match e {
        Event::Position { source, yaw, .. } => {
            *source != PositionSource::Log || yaw.is_none()
        }
        _ => true,
    }));
}

#[test]
fn season_session_screenshot_positions() {
    let (events, _) = replay("season_session.application.log", "screenshot_names.txt");
    let shots: Vec<_> = events
        .iter()
        .filter_map(|e| match e {
            Event::Position {
                time,
                x,
                y,
                z,
                yaw,
                source: PositionSource::Screenshot,
            } => Some((*time, *x, *y, *z, yaw.unwrap())),
            _ => None,
        })
        .collect();

    // 清单里 60 个文件名，其中 1 个是菜单截图（没有坐标），其余 59 个都算定位。
    assert_eq!(shots.len(), 59);

    // 第一张：2026-11-14[00-44]_117.47, 1.78, -264.17
    assert_eq!(shots[0].0, ts("2026-11-14T00:44:00.000"));
    assert_eq!(
        (shots[0].1, shots[0].2, shots[0].3),
        (117.47, 1.78, -264.17)
    );
    // 四元数 (-0.00566, -0.14087, 0.00132, -0.99001) 的偏航角约 16.20 度。
    assert!((shots[0].4 - 16.1963).abs() < 0.001, "yaw = {}", shots[0].4);

    // 菜单截图 `2026-11-15[15-24]_6.66 (0).png` 不在里面。
    assert!(!shots.iter().any(|s| s.0 == ts("2026-11-15T15:24:00.000")));

    // 朝向都在 [0, 360)。
    assert!(shots.iter().all(|s| (0.0..360.0).contains(&s.4)));
}

#[test]
fn yaw_matches_the_direction_the_player_walked() {
    // 2026-11-14 00:44–00:45 是一串边走边拍的截图：相邻两张之间走的方向和第一张的朝向
    // 基本一致（差几度）。这条只用坐标和文件名里的朝向，不经过 yaw 公式，
    // 所以能抓住"0 度朝哪、往哪边转"这类约定错误：反过来（-yaw）或者差 90 度都对不上。
    let shots_text = std::fs::read_to_string(fixture("screenshot_names.txt")).unwrap();
    let walk: Vec<_> = shots_text
        .lines()
        .map(str::trim)
        .filter(|n| n.starts_with("2026-11-14[00-4"))
        .filter_map(parse_screenshot_name)
        .collect();
    assert!(walk.len() >= 10, "这一串截图少了几张：{}", walk.len());

    let mut checked = 0;
    for pair in walk.windows(2) {
        let (a, b) = (&pair[0], &pair[1]);
        let (dx, dz) = (b.x - a.x, b.z - a.z);
        let dist = dx.hypot(dz);
        if !(1.0..15.0).contains(&dist) {
            continue;
        }
        // 走的方向，和 yaw 同一套约定：0 度朝 +z，顺时针增大。
        let walked = dx.atan2(dz).to_degrees().rem_euclid(360.0);
        let diff = ((walked - a.yaw + 180.0).rem_euclid(360.0)) - 180.0;
        assert!(
            diff.abs() < 12.0,
            "{} 走到 {walked:.1} 度，朝向 {:.1} 度，差 {diff:.1} 度",
            a.time,
            a.yaw
        );
        checked += 1;
    }
    assert!(checked >= 10, "checked = {checked}");
}

#[test]
fn pve_session_milestones() {
    let (events, state) = replay("pve_session.application.log", "screenshot_names.txt");
    assert_eq!(
        milestones(&events),
        vec![
            Event::Session {
                time: ts("2026-11-12T20:08:41.144"),
                mode: Mode::Pve
            },
            // 加载时日志里是场景预设名 Shopping_Mall，报出去时换成地点名 Interchange，
            // 和下面 raid_started 的名字一致。
            Event::RaidLoading {
                time: ts("2026-11-12T20:15:03.031"),
                map: "Interchange".into()
            },
            Event::RaidStarted {
                time: ts("2026-11-12T20:18:49.379"),
                map: "Interchange".into(),
                scav: false,
                raid_mode: RaidMode::Online
            },
            Event::RaidEnded {
                time: ts("2026-11-12T21:16:10.906")
            },
        ]
    );
    assert_eq!(state.snapshot().raid, None);
}

#[test]
fn pve_session_log_positions() {
    let (events, _) = replay("pve_session.application.log", "screenshot_names.txt");
    let log_positions: Vec<(f64, f64, f64)> = events
        .iter()
        .filter_map(|e| match e {
            Event::Position {
                x,
                y,
                z,
                source: PositionSource::Log,
                ..
            } => Some((*x, *y, *z)),
            _ => None,
        })
        .collect();
    assert_eq!(
        log_positions,
        vec![
            (-205.637, 21.354, 127.143),
            (-28.478, 27.168, -168.274),
            (405.836, 33.281, 145.699),
            (470.755, 33.117, 68.776),
            (470.918, 33.911, 73.59),
            (470.918, 33.911, 73.59),
        ]
    );
}

#[test]
fn map_names_agree_between_loading_and_started() {
    // 加载和开始给的地图名必须是同一套：界面拿到 raid_loading 就去找地图，
    // 名字不一样它就得自己猜。
    for (log, shots) in [
        ("season_session.application.log", "screenshot_names.txt"),
        ("pve_session.application.log", "screenshot_names.txt"),
    ] {
        let (events, _) = replay(log, shots);
        let mut loading: Option<&str> = None;
        let mut pairs = 0;
        for e in &events {
            match e {
                Event::RaidLoading { map, .. } => loading = Some(map),
                Event::RaidStarted { map, .. } => {
                    assert_eq!(
                        loading,
                        Some(map.as_str()),
                        "{log}: raid_loading 和 raid_started 的地图名不一样"
                    );
                    pairs += 1;
                    loading = None;
                }
                Event::RaidEnded { .. } => loading = None,
                _ => {}
            }
        }
        assert!(pairs > 0, "{log} 里没有一局？");
    }
}

#[test]
fn fixtures_need_no_extra_preset_mappings() {
    // 这两份日志里的场景预设都在对照表里，不该留下待补的对。
    for log in [
        "season_session.application.log",
        "pve_session.application.log",
    ] {
        let (_, state) = replay(log, "screenshot_names.txt");
        assert_eq!(state.map_mismatches(), &[], "{log}");
    }
}

#[test]
fn trail_holds_only_the_current_raid() {
    // 赛季日志：两局。第二局开始到结束之间没有截图（截图都在 11-14 和 11-15 白天），
    // 所以第二局的轨迹只有日志里的定位。
    let (_, state) = replay("season_session.application.log", "screenshot_names.txt");
    // 对局已结束，轨迹清空。
    assert!(state.snapshot().trail.is_empty());
}

#[test]
fn trail_is_sorted_and_complete_inside_a_raid() {
    let log_text = std::fs::read_to_string(fixture("season_session.application.log")).unwrap();
    let shots_text = std::fs::read_to_string(fixture("screenshot_names.txt")).unwrap();

    // 只喂到第二局 GameStarted 之后、离开对局之前。
    let mut state = State::new();
    let mut shot_count = 0;
    for line in log_text.lines() {
        let Some(p) = parse_line(line) else { continue };
        if p.time > ts("2026-11-15T18:30:00.000") {
            break;
        }
        state.on_log(p.time, &p.kind);
        if p.time == ts("2026-11-15T18:21:03.074") {
            for name in shots_text.lines() {
                if let Some(s) = parse_screenshot_name(name.trim()) {
                    if s.time >= ts("2026-11-15T18:21:00.000") {
                        state.on_screenshot(&s);
                        shot_count += 1;
                    }
                }
            }
        }
    }
    let snap = state.snapshot();
    assert!(snap.raid.as_ref().unwrap().started);
    // 第二局到 18:30 之前日志里有 4 条定位，截图里 18:21 之后没有。
    assert_eq!(shot_count, 0);
    assert_eq!(snap.trail.len(), 4);
    assert!(snap.trail.windows(2).all(|w| w[0].time <= w[1].time));
    assert!(snap.position.is_some());
}

#[test]
fn every_event_time_is_iso_local() {
    let (events, _) = replay("season_session.application.log", "screenshot_names.txt");
    for e in &events {
        let s = serde_json::to_value(e).unwrap();
        let time = s["time"].as_str().unwrap();
        assert!(
            time.len() == 23
                && time.as_bytes()[10] == b'T'
                && time.ends_with(|c: char| c.is_ascii_digit()),
            "{time}"
        );
        assert_eq!(time.parse::<Timestamp>().unwrap().to_string(), time);
    }
}

#[test]
fn event_types_are_the_ones_in_the_contract() {
    let (events, _) = replay("season_session.application.log", "screenshot_names.txt");
    let types: HashSet<String> = events
        .iter()
        .map(|e| {
            serde_json::to_value(e).unwrap()["type"]
                .as_str()
                .unwrap()
                .to_string()
        })
        .collect();
    assert_eq!(
        types,
        HashSet::from([
            "session".to_string(),
            "raid_loading".to_string(),
            "raid_started".to_string(),
            "raid_ended".to_string(),
            "position".to_string(),
        ])
    );
}

/// 游戏 1.3.0.2 把加载那一行改了写法：全小写，文件名后面多了 `_preset`。
///
/// 真实日志摘录（已脱敏），`D:/Battlestate Games/EFT/Logs/log_2026.11.17_22-10-01_1.3.0.2.48779`：
///
/// ```text
/// scene preset path:maps/rezerv_base_preset.bundle rcid:Rezerv_Base.scenespreset.asset
/// scene preset path:maps/lighthouse_preset.bundle rcid:lighthouse.scenespreset.asset
/// ```
///
/// 三局都要认出来，报的是地点名（`RezervBase`、`Lighthouse`），不是预设名。
#[test]
fn the_1302_preset_spelling_still_switches_the_map() {
    let (events, state) = replay_log("pvpseason_1302.application.log");

    let loading: Vec<&str> = events
        .iter()
        .filter_map(|e| match e {
            Event::RaidLoading { map, .. } => Some(map.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(loading, vec!["RezervBase", "Lighthouse"]);

    let started: Vec<&str> = events
        .iter()
        .filter_map(|e| match e {
            Event::RaidStarted { map, scav, .. } => {
                assert!(!scav, "这一局是 PMC");
                Some(map.as_str())
            }
            _ => None,
        })
        .collect();
    assert_eq!(started, vec!["RezervBase", "Lighthouse"]);

    assert_eq!(
        events
            .iter()
            .filter(|e| matches!(e, Event::RaidEnded { .. }))
            .count(),
        2,
        "{events:?}"
    );
    // 进局记录里的 Location 和加载时给出的名字一致，不该记下缺口。
    assert!(
        state.map_mismatches().is_empty(),
        "{:?}",
        state.map_mismatches()
    );
    // 两局之间的定位都算得出来。
    assert!(events.iter().any(|e| matches!(
        e,
        Event::Position {
            source: PositionSource::Log,
            ..
        }
    )));
}
