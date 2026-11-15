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

use otm_core::state::replay;

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
        // 接管道给 head 之类用，下游关了不算出错。
        Err(e) if e.kind() == io::ErrorKind::BrokenPipe => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("otm-replay: {e}");
            ExitCode::FAILURE
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

    let (events, state) = replay(&log_text, &shots_text);
    let stdout = io::stdout();
    let mut out = BufWriter::new(stdout.lock());
    for event in events {
        let json = serde_json::to_string(&event)?;
        writeln!(out, "{json}")?;
    }
    out.flush()?;

    // 加载时的场景预设名和进局记录里的地点名对不上：标准输出只放事件，
    // 这几行给补 `src/maps.rs` 用。
    for (preset, location) in state.map_mismatches() {
        eprintln!("未收录的场景预设: {preset} → {location}");
    }
    Ok(())
}
