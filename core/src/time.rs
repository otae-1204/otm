//! 时间：把截图文件名和日志里的时间解析成 [`Timestamp`]，再输出成 ISO 8601 本地时间。
//!
//! 游戏日志和截图文件名里的时间都是玩家本机的墙上时间，不带时区。
//! 这里一律按"本地墙上时间"处理，输出时原样带毫秒、不带时区后缀，
//! 例如 `2026-11-15T18:00:40.493`。界面把它当本地时间显示即可。

use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Serialize};
use time::{Date, Month, Time};

/// 一个本地墙上时间，精确到毫秒。可以比较、可以排序。
///
/// 序列化成 ISO 8601 本地时间字符串，例如 `2026-11-15T18:00:40.493`。
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct Timestamp {
    date: Date,
    time: Time,
}

impl Timestamp {
    /// 用年月日时分秒毫秒构造。月份或日期越界时返回 `None`。
    pub fn from_ymd_hms_milli(
        year: i32,
        month: u8,
        day: u8,
        hour: u8,
        minute: u8,
        second: u8,
        milli: u16,
    ) -> Option<Self> {
        let month = Month::try_from(month).ok()?;
        let date = Date::from_calendar_date(year, month, day).ok()?;
        let time = Time::from_hms_milli(hour, minute, second, milli).ok()?;
        Some(Self { date, time })
    }

    /// 用年月日时分秒构造，毫秒为 0。
    pub fn from_ymd_hms(
        year: i32,
        month: u8,
        day: u8,
        hour: u8,
        minute: u8,
        second: u8,
    ) -> Option<Self> {
        Self::from_ymd_hms_milli(year, month, day, hour, minute, second, 0)
    }

    /// 用年月日时分构造，秒和毫秒为 0。
    pub fn from_ymd_hm(year: i32, month: u8, day: u8, hour: u8, minute: u8) -> Option<Self> {
        Self::from_ymd_hms_milli(year, month, day, hour, minute, 0, 0)
    }

    /// 年月日。
    pub fn date(&self) -> (i32, u8, u8) {
        (self.date.year(), self.date.month() as u8, self.date.day())
    }

    /// 时分秒毫秒。
    pub fn clock(&self) -> (u8, u8, u8, u16) {
        (
            self.time.hour(),
            self.time.minute(),
            self.time.second(),
            self.time.millisecond(),
        )
    }

    /// 现在（本地墙上时间）。拿不到本地时区时退回 UTC。
    pub fn now_local() -> Self {
        let now =
            time::OffsetDateTime::now_local().unwrap_or_else(|_| time::OffsetDateTime::now_utc());
        Self::from_ymd_hms_milli(
            now.year(),
            now.month() as u8,
            now.day(),
            now.hour(),
            now.minute(),
            now.second(),
            now.millisecond(),
        )
        .unwrap_or_else(|| Self {
            date: Date::from_calendar_date(1970, Month::January, 1)
                .expect("1970 年 1 月 1 日总是合法的"),
            time: Time::MIDNIGHT,
        })
    }
}

impl fmt::Display for Timestamp {
    /// ISO 8601 本地时间，带毫秒，不带时区后缀：`2026-11-15T18:00:40.493`。
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let (y, mo, d) = self.date();
        let (h, mi, s, ms) = self.clock();
        write!(f, "{y:04}-{mo:02}-{d:02}T{h:02}:{mi:02}:{s:02}.{ms:03}")
    }
}

impl From<Timestamp> for String {
    fn from(t: Timestamp) -> String {
        t.to_string()
    }
}

/// 解析失败的原因：字符串不是 `YYYY-MM-DDTHH:MM:SS[.fff]` 这种形状。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParseTimestampError;

impl fmt::Display for ParseTimestampError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("不是 ISO 8601 本地时间")
    }
}

impl std::error::Error for ParseTimestampError {}

impl TryFrom<String> for Timestamp {
    type Error = ParseTimestampError;

    fn try_from(s: String) -> Result<Self, Self::Error> {
        s.parse()
    }
}

impl FromStr for Timestamp {
    type Err = ParseTimestampError;

    /// 接受 `2026-11-15T18:00:40.493`、`2026-11-15 18:00:40.493` 这类写法，小数部分可以是 0 到 9 位。
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        let s = s.trim();
        let (date_part, time_part) = s.split_once(['T', 't', ' ']).ok_or(ParseTimestampError)?;
        let mut d = date_part.split('-');
        let year: i32 = d
            .next()
            .ok_or(ParseTimestampError)?
            .parse()
            .map_err(|_| ParseTimestampError)?;
        let month: u8 = d
            .next()
            .ok_or(ParseTimestampError)?
            .parse()
            .map_err(|_| ParseTimestampError)?;
        let day: u8 = d
            .next()
            .ok_or(ParseTimestampError)?
            .parse()
            .map_err(|_| ParseTimestampError)?;
        if d.next().is_some() {
            return Err(ParseTimestampError);
        }

        let (clock_part, frac) = match time_part.split_once('.') {
            Some((c, f)) => (c, Some(f)),
            None => (time_part, None),
        };
        let mut t = clock_part.split(':');
        let hour: u8 = t
            .next()
            .ok_or(ParseTimestampError)?
            .parse()
            .map_err(|_| ParseTimestampError)?;
        let minute: u8 = t
            .next()
            .ok_or(ParseTimestampError)?
            .parse()
            .map_err(|_| ParseTimestampError)?;
        let second: u8 = match t.next() {
            Some(v) => v.parse().map_err(|_| ParseTimestampError)?,
            None => 0,
        };
        if t.next().is_some() {
            return Err(ParseTimestampError);
        }
        let milli = match frac {
            None => 0,
            Some(f) => {
                if f.is_empty() || f.len() > 9 || !f.bytes().all(|b| b.is_ascii_digit()) {
                    return Err(ParseTimestampError);
                }
                let head: String = f.chars().chain(std::iter::repeat('0')).take(3).collect();
                head.parse().map_err(|_| ParseTimestampError)?
            }
        };

        Self::from_ymd_hms_milli(year, month, day, hour, minute, second, milli)
            .ok_or(ParseTimestampError)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn display_is_iso_local_with_millis() {
        let t = Timestamp::from_ymd_hms_milli(2026, 11, 15, 18, 0, 40, 493).unwrap();
        assert_eq!(t.to_string(), "2026-11-15T18:00:40.493");
    }

    #[test]
    fn round_trip() {
        let s = "2026-11-15T18:00:40.493";
        let t: Timestamp = s.parse().unwrap();
        assert_eq!(t.to_string(), s);
        let t2: Timestamp = "2026-11-15 18:00:40.493".parse().unwrap();
        assert_eq!(t, t2);
    }

    #[test]
    fn fractional_digits_are_padded() {
        let t: Timestamp = "2026-01-02T03:04:05.5".parse().unwrap();
        assert_eq!(t.to_string(), "2026-01-02T03:04:05.500");
        let t: Timestamp = "2026-01-02T03:04:05.123456".parse().unwrap();
        assert_eq!(t.to_string(), "2026-01-02T03:04:05.123");
    }

    #[test]
    fn ordering() {
        let a: Timestamp = "2026-11-15T17:59:59.999".parse().unwrap();
        let b: Timestamp = "2026-11-15T18:00:00.000".parse().unwrap();
        assert!(a < b);
    }

    #[test]
    fn rejects_garbage() {
        for s in [
            "",
            "2026-11-15",
            "2026-13-01T00:00:00",
            "2026-11-15T25:00:00",
            "x",
        ] {
            assert!(s.parse::<Timestamp>().is_err(), "{s} 应该解析失败");
        }
    }
}
