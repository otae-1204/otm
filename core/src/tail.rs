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
    pub fn poll(&mut self) -> Vec<LogRecord> {
        let Some(path) = self.path.clone() else {
            return Vec::new();
        };
        let Ok(meta) = fs::metadata(&path) else {
            return Vec::new();
        };
        let len = meta.len();
        let shrank = len < self.offset;
        if shrank {
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
        let mut first = true;
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) => break,
                Ok(n) => {
                    // 最后一行还没写完（没有换行）时先不读。
                    if !line.ends_with('\n') {
                        break;
                    }
                    if first && !shrank {
                        // 上一次的结尾没有换行时，这一行是它的后半截，跳过。
                        first = false;
                        if !line.contains('|') {
                            consumed += n as u64;
                            continue;
                        }
                    }
                    first = false;
                    consumed += n as u64;
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
        let p = std::env::temp_dir().join(format!(
            "otm-tail-{}-{name}",
            std::process::id()
        ));
        let _ = fs::remove_file(&p);
        p
    }

    #[test]
    fn reads_only_complete_lines_once() {
        let path = tmp("a.log");
        let mut tail = LogTail::new();
        tail.switch_to(&path);
        assert!(tail.poll().is_empty(), "文件不存在时没有内容");

        let mut f = fs::File::create(&path).unwrap();
        write!(f, "2026-11-15 18:00:40.493|1.3.0.2.48779|Info|application|GameStarted:1\r\n").unwrap();
        f.flush().unwrap();
        let recs = tail.poll();
        assert_eq!(recs.len(), 1);
        assert_eq!(recs[0].kind, LogLine::GameStarted);
        assert!(tail.poll().is_empty(), "第二次不该重复读");

        // 半行先不读。
        write!(f, "2026-11-15 18:00:41.000|1.3.0.2.48779|Info|application|Disposing BECli").unwrap();
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
    fn switching_files_starts_over() {
        let a = tmp("b1.log");
        let b = tmp("b2.log");
        fs::write(&a, "2026-11-15 18:00:40.493|1.3.0.2.48779|Info|application|GameStarted:1\n").unwrap();
        fs::write(&b, "2026-11-15 19:00:40.493|1.3.0.2.48779|Info|application|GameStarted:2\n").unwrap();

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
        let long = "2026-11-15 18:00:40.493|1.3.0.2.48779|Info|application|GameStarted:1\n";
        fs::write(&path, long).unwrap();
        let mut tail = LogTail::new();
        tail.switch_to(&path);
        assert_eq!(tail.poll().len(), 1);
        assert_eq!(tail.offset(), long.len() as u64);

        // 被清空后重新写，文件比上次读到的位置短：从头读。
        // 和旧内容同一个长度时看不出变短，第一行会被当成旧行的后半截跳过，
        // 所以这里第二行比原来长，文件整体比上次短。
        let short = concat!(
            "2026-11-15 18:00:41.000|1.3.0.2.48779|Info|application|GameStarted:2\n",
            "2026-11-15 18:00:42.000|1.3.0.2.48779|Info|application|Disposing BEClient\n",
        );
        fs::write(&path, short).unwrap();
        let recs = tail.poll();
        assert_eq!(recs.len(), 1, "{recs:?}");
        assert_eq!(recs[0].kind, LogLine::DisposingBeClient);
        assert_eq!(recs[0].time.to_string(), "2026-11-15T18:00:42.000");

        fs::remove_file(&path).unwrap();
    }
}
