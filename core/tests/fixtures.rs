//! 用 `core/tests/fixtures/` 里的真实日志和截图文件名清单跑状态机，断言具体结果。

use std::collections::HashSet;
use std::path::PathBuf;

use otm_core::event::{Event, Mode, PositionSource, RaidMode};
use otm_core::log::{parse_line, LogLine};
use otm_core::screenshot::{parse_screenshot_name, Screenshot};
use otm_core::state::State;
use otm_core::time::Timestamp;

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests").join("fixtures").join(name)
}

fn ts(s: &str) -> Timestamp {
    s.parse().unwrap()
}

/// 和 `otm-replay` 一样把日志和截图合起来喂给状态机。
fn replay(log: &str, shots: &str) -> (Vec<Event>, State) {
    let log_text = std::fs::read_to_string(fixture(log)).unwrap();
    let shots_text = std::fs::read_to_string(fixture(shots)).unwrap();

    enum Input {
        Log(Timestamp, LogLine),
        Shot(Screenshot),
    }
    let mut inputs = Vec::new();
    for line in log_text.lines() {
        if let Some(p) = parse_line(line) {
            if p.kind != LogLine::Other {
                inputs.push(Input::Log(p.time, p.kind));
            }
        }
    }
    for line in shots_text.lines() {
        if let Some(s) = parse_screenshot_name(line.trim()) {
            inputs.push(Input::Shot(s));
        }
    }
    inputs.sort_by_key(|i| match i {
        Input::Log(t, _) => (*t, 0u8),
        Input::Shot(s) => (s.time, 1u8),
    });

    let mut state = State::new();
    let mut events = Vec::new();
    for input in inputs {
        match input {
            Input::Log(t, k) => events.extend(state.on_log(t, &k)),
            Input::Shot(s) => events.extend(state.on_screenshot(&s)),
        }
    }
    (events, state)
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
    let (events, _) = replay(
        "season_session.application.log",
        "screenshot_names.txt",
    );
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
    let (events, state) = replay(
        "season_session.application.log",
        "screenshot_names.txt",
    );
    let started: Vec<_> = events
        .iter()
        .filter_map(|e| match e {
            Event::RaidStarted { map, scav, .. } => Some((map.clone(), *scav)),
            _ => None,
        })
        .collect();
    assert_eq!(started, vec![("bigmap".to_string(), false), ("bigmap".to_string(), false)]);

    let ended = events.iter().filter(|e| matches!(e, Event::RaidEnded { .. })).count();
    assert_eq!(ended, 2);

    // 日志在 18:34:47 离开对局，之后没有新的加载，所以最后没有进行中的对局。
    assert_eq!(state.snapshot().raid, None);
    assert_eq!(state.snapshot().mode, Some(Mode::PvpSeason));
}

#[test]
fn season_session_log_positions() {
    let (events, _) = replay(
        "season_session.application.log",
        "screenshot_names.txt",
    );
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
    let (events, _) = replay(
        "season_session.application.log",
        "screenshot_names.txt",
    );
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
    assert_eq!((shots[0].1, shots[0].2, shots[0].3), (117.47, 1.78, -264.17));
    // 四元数 (-0.00566, -0.14087, 0.00132, -0.99001) 的偏航角约 16.20 度。
    assert!((shots[0].4 - 16.1963).abs() < 0.001, "yaw = {}", shots[0].4);

    // 菜单截图 `2026-11-15[15-24]_6.66 (0).png` 不在里面。
    assert!(!shots.iter().any(|s| s.0 == ts("2026-11-15T15:24:00.000")));

    // 朝向都在 [0, 360)。
    assert!(shots.iter().all(|s| (0.0..360.0).contains(&s.4)));
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
            // 加载时日志里是 Shopping_Mall，进局记录里是 Interchange，以进局记录为准。
            Event::RaidLoading {
                time: ts("2026-11-12T20:15:03.031"),
                map: "Shopping_Mall".into()
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
fn trail_holds_only_the_current_raid() {
    // 赛季日志：两局。第二局开始到结束之间没有截图（截图都在 11-14 和 11-15 白天），
    // 所以第二局的轨迹只有日志里的定位。
    let (_, state) = replay(
        "season_session.application.log",
        "screenshot_names.txt",
    );
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
    let (events, _) = replay(
        "season_session.application.log",
        "screenshot_names.txt",
    );
    for e in &events {
        let s = serde_json::to_value(e).unwrap();
        let time = s["time"].as_str().unwrap();
        assert!(
            time.len() == 23 && time.as_bytes()[10] == b'T' && time.ends_with(|c: char| c.is_ascii_digit()),
            "{time}"
        );
        assert_eq!(time.parse::<Timestamp>().unwrap().to_string(), time);
    }
}

#[test]
fn event_types_are_the_ones_in_the_contract() {
    let (events, _) = replay(
        "season_session.application.log",
        "screenshot_names.txt",
    );
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
