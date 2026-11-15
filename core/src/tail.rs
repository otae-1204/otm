//! 跟读一个日志文件：记住读到哪了，下次只读新增的部分。
//!
//! 只读完整的行：最后没有换行的那半行先不读，等它写完了再读。
//! 游戏重启后日志目录会换，[`LogTail`] 可以换到新文件重新开始。

use std::fs;
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use crate::log::{parse_line, LogLine};
use crate::time::Timestamp;

/// 一条读出来的日志记录。
#[derive(Debug, Clone, PartialEq)]
pub struct LogRecord {
    pub time: Timestamp,
    pub kind: LogLine,
}

/// 跟读一个 `application` 日志。
#[derive(Debug, Clone, Default)]
pub struct LogTail {
    path: Option<PathBuf>,
    offset: u64,
}

impl LogTail {
    pub fn new() -> Self {
        Self::default()
    }

    /// 当前跟读的文件。
    pub fn path(&self) -> Option<&Path> {
        self.path.as_deref()
    }

    /// 当前读到的位置（字节）。
    pub fn offset(&self) -> u64 {
        self.offset
    }

    /// 换一个文件从头读。和当前是同一个文件时什么也不做。
    pub fn switch_to(&mut self, path: &Path) {
        let path = path.to_path_buf();
        if self.path.as_ref() == Some(&path) {
            return;
        }
        self.path = Some(path);
        self.offset = 0;
    }

    /// 跳过已经写好的内容，只读之后新写的部分。文件还不存在时从 0 开始（也就是等它出现）。
    pub fn skip_to_end(&mut self) {
        if let Some(path) = self.path.as_ref() {
            if let Ok(meta) = fs::metadata(path) {
                self.offset = meta.len();
            }
        }
    }

    /// 读出自上次以来新写进来的完整行。
    ///
    /// 文件还没出现、或者被删了，就当作没有新内容；下次再试。
    /// 文件变短了（被清空或替换）时从头读。
    ///
    /// 按字节读、再按 UTF-8 宽松解码：游戏写到一半的行可能停在一个多字节字符中间，
    /// 那半个字符先留在文件里不读，等写完了再一起读，不会卡住。
    pub fn poll(&mut self) -> Vec<LogRecord> {
        let Some(path) = self.path.clone() else {
            return Vec::new();
        };
        let Ok(meta) = fs::metadata(&path) else {
            return Vec::new();
        };
        let len = meta.len();
        if len < self.offset {
            // 被清空或者换成了别的文件：从头读。
            self.offset = 0;
        }
        if len == self.offset {
            return Vec::new();
        }

        let Ok(mut file) = fs::File::open(&path) else {
            return Vec::new();
        };
        if file.seek(SeekFrom::Start(self.offset)).is_err() {
            return Vec::new();
        }

        let mut reader = BufReader::new(file);
        let mut out = Vec::new();
        let mut consumed = self.offset;
        let mut buf = Vec::new();
        loop {
            buf.clear();
            match reader.read_until(b'\n', &mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    // 最后一行还没写完（没有换行）时先不读，下次从这一行的开头再来。
                    if !buf.ends_with(b"\n") {
                        break;
                    }
                    consumed += n as u64;
                    let line = String::from_utf8_lossy(&buf);
                    if let Some(parsed) = parse_line(&line) {
                        out.push(LogRecord {
                            time: parsed.time,
                            kind: parsed.kind,
                        });
                    }
                }
                Err(_) => break,
            }
        }
        self.offset = consumed;
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn tmp(name: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("otm-tail-{}-{name}", std::process::id()));
        let _ = fs::remove_file(&p);
        p
    }

    fn line(t: &str, msg: &str) -> String {
        format!("{t}|1.3.0.2.48779|Info|application|{msg}\n")
    }

    #[test]
    fn reads_only_complete_lines_once() {
        let path = tmp("a.log");
        let mut tail = LogTail::new();
        tail.switch_to(&path);
        assert!(tail.poll().is_empty(), "文件不存在时没有内容");

        let mut f = fs::File::create(&path).unwrap();
        write!(
            f,
            "{}",
            line("2026-11-15 18:00:40.493", "GameStarted:1").replace('\n', "\r\n")
        )
        .unwrap();
        f.flush().unwrap();
        let recs = tail.poll();
        assert_eq!(recs.len(), 1);
        assert_eq!(recs[0].kind, LogLine::GameStarted);
        assert!(tail.poll().is_empty(), "第二次不该重复读");

        // 半行先不读。
        write!(
            f,
            "2026-11-15 18:00:41.000|1.3.0.2.48779|Info|application|Disposing BECli"
        )
        .unwrap();
        f.flush().unwrap();
        assert!(tail.poll().is_empty());
        write!(f, "ent\r\n").unwrap();
        f.flush().unwrap();
        let recs = tail.poll();
        assert_eq!(recs.len(), 1);
        assert_eq!(recs[0].kind, LogLine::DisposingBeClient);

        fs::remove_file(&path).unwrap();
    }

    #[test]
    fn half_a_character_waits_for_the_rest() {
        // 游戏正在写一行中文，正好停在字符中间：先不读，写完了整行再读。
        let path = tmp("d.log");
        let mut tail = LogTail::new();
        tail.switch_to(&path);
        let full = line("2026-11-15 18:00:40.493", "GameStarted:1 中文");
        let bytes = full.as_bytes();
        let cut = full.find('中').unwrap() + 1;
        fs::write(&path, &bytes[..cut]).unwrap();
        assert!(tail.poll().is_empty(), "停在半个字符上时不该读");
        fs::write(&path, bytes).unwrap();
        let recs = tail.poll();
        assert_eq!(recs.len(), 1);
        assert_eq!(recs[0].kind, LogLine::GameStarted);
        fs::remove_file(&path).unwrap();
    }

    #[test]
    fn invalid_utf8_does_not_stall_the_tail() {
        let path = tmp("e.log");
        let mut tail = LogTail::new();
        tail.switch_to(&path);
        let mut bytes = line("2026-11-15 18:00:40.493", "GameStarted:1").into_bytes();
        bytes.extend_from_slice(&[0xff, 0xfe, b'\n']);
        bytes.extend_from_slice(line("2026-11-15 18:00:41.000", "Disposing BEClient").as_bytes());
        fs::write(&path, bytes).unwrap();
        let recs = tail.poll();
        assert_eq!(recs.len(), 2, "{recs:?}");
        assert_eq!(recs[0].kind, LogLine::GameStarted);
        assert_eq!(recs[1].kind, LogLine::DisposingBeClient);
        fs::remove_file(&path).unwrap();
    }

    #[test]
    fn switching_files_starts_over() {
        let a = tmp("b1.log");
        let b = tmp("b2.log");
        fs::write(&a, line("2026-11-15 18:00:40.493", "GameStarted:1")).unwrap();
        fs::write(&b, line("2026-11-15 19:00:40.493", "GameStarted:2")).unwrap();

        let mut tail = LogTail::new();
        tail.switch_to(&a);
        assert_eq!(tail.poll().len(), 1);
        tail.switch_to(&b);
        let recs = tail.poll();
        assert_eq!(recs.len(), 1);
        assert_eq!(recs[0].time.to_string(), "2026-11-15T19:00:40.493");

        fs::remove_file(&a).unwrap();
        fs::remove_file(&b).unwrap();
    }

    #[test]
    fn truncated_file_is_read_from_start() {
        let path = tmp("c.log");
        let long = line(
            "2026-11-15 18:00:40.493",
            "GameStarted:293.32(293.32) real:315.92(315.92) diff:22.6",
        );
        fs::write(&path, &long).unwrap();
        let mut tail = LogTail::new();
        tail.switch_to(&path);
        assert_eq!(tail.poll().len(), 1);
        assert_eq!(tail.offset(), long.len() as u64);

        // 被清空后重新写，文件比上次读到的位置短：从头读。
        let short = line("2026-11-15 18:00:41.000", "Disposing BEClient");
        assert!(short.len() < long.len(), "这个测试要求新内容真的更短");
        fs::write(&path, &short).unwrap();
        let recs = tail.poll();
        assert_eq!(recs.len(), 1, "{recs:?}");
        assert_eq!(recs[0].kind, LogLine::DisposingBeClient);
        assert_eq!(recs[0].time.to_string(), "2026-11-15T18:00:41.000");
        assert_eq!(tail.offset(), short.len() as u64);

        fs::remove_file(&path).unwrap();
    }

    #[test]
    fn skip_to_end_ignores_what_is_already_there() {
        let path = tmp("f.log");
        fs::write(&path, line("2026-11-15 18:00:40.493", "GameStarted:1")).unwrap();
        let mut tail = LogTail::new();
        tail.switch_to(&path);
        tail.skip_to_end();
        assert!(tail.poll().is_empty());
        let mut f = fs::OpenOptions::new().append(true).open(&path).unwrap();
        write!(
            f,
            "{}",
            line("2026-11-15 18:00:41.000", "Disposing BEClient")
        )
        .unwrap();
        drop(f);
        let recs = tail.poll();
        assert_eq!(recs.len(), 1);
        assert_eq!(recs[0].kind, LogLine::DisposingBeClient);
        fs::remove_file(&path).unwrap();
    }
}
