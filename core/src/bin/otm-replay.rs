//! otm-replay：把一份 `application` 日志和一份截图文件名清单按时间合起来喂给状态机，
//! 每行打印一个 JSON 事件到标准输出。界面开发用它当假数据。
//!
//! 用法：
//!
//! ```text
//! otm-replay <application 日志> <截图文件名清单>
//! ```
//!
//! 截图文件名清单每行一个文件名（可以带路径），空行跳过。清单里的顺序不重要，按文件名里的时间排。
//! 同一个时间点上，日志在先、截图在后：日志里的定位精确到毫秒，截图只到分钟，
//! 同一分钟里截图排在日志之后，这样截图（带朝向）就是这一刻最新的定位。

use std::io::{self, BufWriter, Write};
use std::path::PathBuf;
use std::process::ExitCode;

use otm_core::event::Event;
use otm_core::log::{parse_line, LogLine};
use otm_core::screenshot::parse_screenshot_name;
use otm_core::state::State;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.len() != 2 || args.iter().any(|a| a == "-h" || a == "--help") {
        eprintln!("用法: otm-replay <application 日志> <截图文件名清单>");
        return if args.iter().any(|a| a == "-h" || a == "--help") {
            ExitCode::SUCCESS
        } else {
            ExitCode::from(2)
        };
    }

    match run(PathBuf::from(&args[0]), PathBuf::from(&args[1])) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("otm-replay: {e}");
            ExitCode::FAILURE
        }
    }
}

/// 合成后的一条输入。
enum Input {
    Log(otm_core::time::Timestamp, LogLine),
    Shot(otm_core::screenshot::Screenshot),
}

impl Input {
    fn time(&self) -> otm_core::time::Timestamp {
        match self {
            Input::Log(t, _) => *t,
            Input::Shot(s) => s.time,
        }
    }
}

fn run(log_path: PathBuf, shots_path: PathBuf) -> io::Result<()> {
    let log_text = std::fs::read_to_string(&log_path)
        .map_err(|e| io::Error::new(e.kind(), format!("读不了日志 {}: {e}", log_path.display())))?;
    let shots_text = std::fs::read_to_string(&shots_path).map_err(|e| {
        io::Error::new(
            e.kind(),
            format!("读不了截图清单 {}: {e}", shots_path.display()),
        )
    })?;

    let mut inputs: Vec<Input> = Vec::new();
    for line in log_text.lines() {
        if let Some(parsed) = parse_line(line) {
            if parsed.kind != LogLine::Other {
                inputs.push(Input::Log(parsed.time, parsed.kind));
            }
        }
    }
    for line in shots_text.lines() {
        let name = line.trim();
        if name.is_empty() {
            continue;
        }
        if let Some(shot) = parse_screenshot_name(name) {
            inputs.push(Input::Shot(shot));
        }
    }

    // 按时间排；同一时间日志在前、截图在后。排序是稳定的，同一类的相对顺序保持不变。
    inputs.sort_by(|a, b| {
        a.time()
            .cmp(&b.time())
            .then_with(|| rank(a).cmp(&rank(b)))
    });

    let mut state = State::new();
    let stdout = io::stdout();
    let mut out = BufWriter::new(stdout.lock());
    for input in inputs {
        let events: Vec<Event> = match input {
            Input::Log(time, kind) => state.on_log(time, &kind),
            Input::Shot(shot) => state.on_screenshot(&shot),
        };
        for event in events {
            let json = serde_json::to_string(&event)?;
            writeln!(out, "{json}")?;
        }
    }
    out.flush()?;
    Ok(())
}

fn rank(input: &Input) -> u8 {
    match input {
        Input::Log(..) => 0,
        Input::Shot(..) => 1,
    }
}
