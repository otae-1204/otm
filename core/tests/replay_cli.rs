//! 跑真正的 `otm-replay` 程序，检查它的输出：每行一个 JSON 事件，能解析，顺序对。

use std::path::PathBuf;
use std::process::Command;

use otm_core::event::Event;

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests").join("fixtures").join(name)
}

fn run_replay(log: &str, shots: &str) -> Vec<Event> {
    let output = Command::new(env!("CARGO_BIN_EXE_otm-replay"))
        .arg(fixture(log))
        .arg(fixture(shots))
        .output()
        .expect("跑不了 otm-replay");
    assert!(
        output.status.success(),
        "otm-replay 退出码 {:?}，stderr: {}",
        output.status.code(),
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8(output.stdout).expect("输出不是 UTF-8");
    assert!(stdout.ends_with('\n'), "最后一行也要有换行");
    stdout
        .lines()
        .map(|line| {
            serde_json::from_str(line)
                .unwrap_or_else(|e| panic!("这一行不是事件 JSON: {line} ({e})"))
        })
        .collect()
}

#[test]
fn replay_season_session() {
    let events = run_replay("season_session.application.log", "screenshot_names.txt");
    // 59 条截图定位 + 8 条日志定位 + 7 个里程碑。
    assert_eq!(events.len(), 74);

    // 第一行是 11-14 最早的那张截图。
    match &events[0] {
        Event::Position { time, x, source, .. } => {
            assert_eq!(time.to_string(), "2026-11-14T00:44:00.000");
            assert_eq!(*x, 117.47);
            assert_eq!(*source, otm_core::event::PositionSource::Screenshot);
        }
        other => panic!("{other:?}"),
    }

    // 时间不倒退。
    assert!(events.windows(2).all(|w| w[0].time() <= w[1].time()));

    // 两局。
    let started = events
        .iter()
        .filter(|e| matches!(e, Event::RaidStarted { .. }))
        .count();
    let ended = events
        .iter()
        .filter(|e| matches!(e, Event::RaidEnded { .. }))
        .count();
    assert_eq!((started, ended), (2, 2));
}

#[test]
fn replay_pve_session() {
    let events = run_replay("pve_session.application.log", "screenshot_names.txt");
    let first = events.first().expect("应该有事件");
    assert_eq!(
        first,
        &Event::Session {
            time: "2026-11-12T20:08:41.144".parse().unwrap(),
            mode: otm_core::event::Mode::Pve
        }
    );
    assert!(events.iter().any(
        |e| matches!(e, Event::RaidStarted { map, .. } if map == "Interchange")
    ));
}

#[test]
fn replay_rejects_missing_arguments() {
    let output = Command::new(env!("CARGO_BIN_EXE_otm-replay"))
        .output()
        .expect("跑不了 otm-replay");
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("用法"));
}
