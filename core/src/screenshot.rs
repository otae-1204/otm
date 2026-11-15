//! 截图文件名。
//!
//! 游戏里的截图键会存下形如
//!
//! ```text
//! 2026-11-12[20-18]_-232.18, 21.77, 16.87_0.00034, 0.97530, 0.00399, 0.22086_5.20 (0).png
//! ```
//!
//! 的文件名，用下划线分段：
//!
//! 1. `2026-11-12[20-18]`：日期和时分（本地墙上时间，没有秒）
//! 2. `-232.18, 21.77, 16.87`：游戏坐标 x y z，y 是高度
//! 3. `0.00034, 0.97530, 0.00399, 0.22086`：Unity 的四元数，依次是 x y z w
//! 4. `5.20 (0)`：一个数字和同名的计数，用不上
//!
//! 菜单里拍的截图没有坐标和四元数这两段（例如 `2026-11-15[15-24]_6.66 (0).png`），
//! 解析结果为 [`None`]。
//!
//! 文件名只精确到分钟，同一分钟里拍的多张截图分不出先后：这里只按文件名给时间，
//! 顺序由调用方按到达顺序决定。

use crate::time::Timestamp;

/// 从一张截图文件名里读出来的东西。
#[derive(Debug, Clone, PartialEq)]
pub struct Screenshot {
    /// 文件名里的时间（精确到分钟）。
    pub time: Timestamp,
    /// 游戏坐标，y 是高度。
    pub x: f64,
    pub y: f64,
    pub z: f64,
    /// 绕竖直轴的朝向，单位度，范围 [0, 360)。约定见 [`yaw_from_quaternion`]。
    pub yaw: f64,
}

/// 解析一个截图文件名。带路径时只看最后一段（`/` 和 `\` 都认）。
///
/// 没有坐标部分的文件名（菜单截图、别的文件）返回 `None`。
pub fn parse_screenshot_name(name: &str) -> Option<Screenshot> {
    let stem = strip_png(last_component(name.trim()))?;
    let mut parts = stem.split('_');

    let time = parse_time_part(parts.next()?)?;
    let xyz = parse_floats::<3>(parts.next()?)?;
    let quat = parse_floats::<4>(parts.next()?)?;

    Some(Screenshot {
        time,
        x: xyz[0],
        y: xyz[1],
        z: xyz[2],
        yaw: yaw_from_quaternion(quat[0], quat[1], quat[2], quat[3]),
    })
}

/// 从 Unity 的四元数 (x, y, z, w) 算出绕竖直轴的朝向，单位度，范围 [0, 360)。
///
/// 约定：
///
/// - 游戏世界是左手坐标系，x 向右、y 向上、z 向前。水平方向上前方是 **+z**，右方是 **+x**。
/// - 0 度朝 **+z**；角度增大时朝 **+x** 转，也就是从上往下看是**顺时针**。
///   （90 度朝 +x，180 度朝 -z，270 度朝 -x。）
/// - 只取水平朝向：低头、抬头不影响结果。
///
/// 公式是 `atan2(2(wy + xz), 1 - 2(y² + x²))`，即 Unity 欧拉角里绕 y 的偏航角。
/// 这个朝向和上游 tarkov.dev 地图数据里的 `coordinateToCardinalRotation` 是同一套约定
/// （那张表只是把"朝哪"换算成东南西北，不影响这里的角度本身）。
pub fn yaw_from_quaternion(x: f64, y: f64, z: f64, w: f64) -> f64 {
    let sin_yaw = 2.0 * (w * y + x * z);
    let cos_yaw = 1.0 - 2.0 * (y * y + x * x);
    let deg = sin_yaw.atan2(cos_yaw).to_degrees();
    // atan2 的结果在 (-180, 180]，挪到 [0, 360)。极小的负数挪完会舍入成 360.0，收回来。
    let deg = deg.rem_euclid(360.0);
    if deg >= 360.0 {
        0.0
    } else {
        deg
    }
}

/// 取路径的最后一段。`/` 和 `\` 都当分隔符，这样 Windows 的路径在哪台机器上都能认。
fn last_component(name: &str) -> &str {
    match name.rfind(['/', '\\']) {
        Some(i) => &name[i + 1..],
        None => name,
    }
}

/// 去掉 `.png` 后缀（大小写不敏感）。不是 png 的返回 `None`。
fn strip_png(name: &str) -> Option<&str> {
    let (stem, ext) = name.rsplit_once('.')?;
    if stem.is_empty() || !ext.eq_ignore_ascii_case("png") {
        return None;
    }
    Some(stem)
}

/// 解析 `2026-11-12[20-18]` 这种日期和时分。
fn parse_time_part(s: &str) -> Option<Timestamp> {
    let (date, rest) = s.split_once('[')?;
    let clock = rest.strip_suffix(']')?;

    let mut d = date.split('-');
    let year: i32 = d.next()?.parse().ok()?;
    let month: u8 = d.next()?.parse().ok()?;
    let day: u8 = d.next()?.parse().ok()?;
    if d.next().is_some() {
        return None;
    }

    let mut c = clock.split('-');
    let hour: u8 = c.next()?.parse().ok()?;
    let minute: u8 = c.next()?.parse().ok()?;
    if c.next().is_some() {
        return None;
    }

    Timestamp::from_ymd_hm(year, month, day, hour, minute)
}

/// 解析 `-232.18, 21.77, 16.87` 这种逗号分隔的数字，必须正好 `N` 个。
fn parse_floats<const N: usize>(s: &str) -> Option<[f64; N]> {
    let mut out = [0.0; N];
    let mut pieces = s.split(',');
    for slot in out.iter_mut() {
        *slot = pieces.next()?.trim().parse::<f64>().ok()?;
    }
    if pieces.next().is_some() || !out.iter().all(|v| v.is_finite()) {
        return None;
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    const REAL: &str =
        "2026-11-12[20-18]_-232.18, 21.77, 16.87_0.00034, 0.97530, 0.00399, 0.22086_5.20 (0).png";

    #[test]
    fn parses_real_name() {
        let s = parse_screenshot_name(REAL).expect("应该能解析");
        assert_eq!(s.time.to_string(), "2026-11-12T20:18:00.000");
        assert_eq!((s.x, s.y, s.z), (-232.18, 21.77, 16.87));
        // 四元数 (0.00034, 0.97530, 0.00399, 0.22086) 的偏航角约 154.48 度。
        assert!((s.yaw - 154.48).abs() < 0.01, "yaw = {}", s.yaw);
    }

    #[test]
    fn parses_path_with_directories() {
        let windows = format!(r"C:\Users\otae\Documents\Escape from Tarkov\Screenshots\{REAL}");
        let s = parse_screenshot_name(&windows).expect("Windows 路径应该能解析");
        assert_eq!((s.x, s.y, s.z), (-232.18, 21.77, 16.87));

        let unix = format!("/home/otae/Pictures/Escape from Tarkov/{REAL}");
        assert!(parse_screenshot_name(&unix).is_some());
    }

    #[test]
    fn menu_screenshot_has_no_position() {
        assert!(parse_screenshot_name("2026-11-15[15-24]_6.66 (0).png").is_none());
    }

    #[test]
    fn ignores_other_files() {
        assert!(parse_screenshot_name("desktop.ini").is_none());
        assert!(parse_screenshot_name("notes.txt").is_none());
        assert!(parse_screenshot_name("").is_none());
        assert!(parse_screenshot_name(".png").is_none());
        assert!(parse_screenshot_name("2026-11-15[15-24]_-1, 2_x, 0, 0, 1_1 (0).png").is_none());
        assert!(parse_screenshot_name("2026-11-15[15-24]_-1, 2, 3_0, 0, 1_1 (0).png").is_none());
        // 多一段或少一段数字都不算。
        assert!(parse_screenshot_name("2026-11-15[15-24]_-1, 2, 3, 4_0, 0, 0, 1_1 (0).png").is_none());
        assert!(parse_screenshot_name("2026-11-15[15-24]_-1, 2, 3_0, 0, 0, 1, 1_1 (0).png").is_none());
    }

    #[test]
    fn non_ascii_names_do_not_panic() {
        // 截图目录里可能有中文名或别的文件，按字节切后缀会切在半个字符上。
        for name in ["日本語", "截图", "aé", "截图.png", "日本語.PNG", "x.截图"] {
            assert!(parse_screenshot_name(name).is_none(), "{name}");
        }
    }

    #[test]
    fn suffix_is_case_insensitive() {
        let upper = REAL.replace(".png", ".PNG");
        assert!(parse_screenshot_name(&upper).is_some());
    }

    #[test]
    fn yaw_zero_is_plus_z() {
        // 单位四元数：没有旋转，朝 +z。
        assert_eq!(yaw_from_quaternion(0.0, 0.0, 0.0, 1.0), 0.0);
    }

    #[test]
    fn yaw_turns_clockwise_towards_plus_x() {
        // 绕 y 转 90 度：+z 转到 +x。
        let s = std::f64::consts::FRAC_1_SQRT_2;
        let yaw = yaw_from_quaternion(0.0, s, 0.0, s);
        assert!((yaw - 90.0).abs() < 1e-9, "yaw = {yaw}");

        // 绕 y 转 180 度：朝 -z。
        let yaw = yaw_from_quaternion(0.0, 1.0, 0.0, 0.0);
        assert!((yaw - 180.0).abs() < 1e-9, "yaw = {yaw}");

        // 绕 y 转 -90 度（也就是 270 度）：朝 -x。
        let yaw = yaw_from_quaternion(0.0, -s, 0.0, s);
        assert!((yaw - 270.0).abs() < 1e-9, "yaw = {yaw}");
    }

    #[test]
    fn yaw_is_always_in_range() {
        for deg in [-720.0f64, -180.0, -1.0, 0.0, 1.0, 359.0, 360.0, 721.0] {
            let half = (deg / 2.0).to_radians();
            let yaw = yaw_from_quaternion(0.0, half.sin(), 0.0, half.cos());
            assert!((0.0..360.0).contains(&yaw), "yaw = {yaw}");
            let expected = deg.rem_euclid(360.0);
            let diff = ((yaw - expected + 180.0).rem_euclid(360.0)) - 180.0;
            assert!(diff.abs() < 1e-9, "deg = {deg}, yaw = {yaw}");
        }
    }

    #[test]
    fn pitch_does_not_change_yaw() {
        // 先绕 y 转 30 度，再低头 20 度：水平朝向仍然是 30 度。
        let (yaw_deg, pitch_deg) = (30.0f64, -20.0f64);
        let (hy, hp) = ((yaw_deg / 2.0).to_radians(), (pitch_deg / 2.0).to_radians());
        let qy = (0.0, hy.sin(), 0.0, hy.cos());
        let qx = (hp.sin(), 0.0, 0.0, hp.cos());
        // q = qy * qx
        let (x1, y1, z1, w1) = qy;
        let (x2, y2, z2, w2) = qx;
        let x = w1 * x2 + x1 * w2 + y1 * z2 - z1 * y2;
        let y = w1 * y2 - x1 * z2 + y1 * w2 + z1 * x2;
        let z = w1 * z2 + x1 * y2 - y1 * x2 + z1 * w2;
        let w = w1 * w2 - x1 * x2 - y1 * y2 - z1 * z2;
        let yaw = yaw_from_quaternion(x, y, z, w);
        assert!((yaw - yaw_deg).abs() < 1e-9, "yaw = {yaw}");
    }

    #[test]
    fn yaw_matches_rotated_forward_vector() {
        // 换一条路算：把 +z 用四元数乘法转过去，取 atan2(x, z)。
        // 和实现里的公式不是同一个写法，能抓住符号、顺序上的错。
        let s = std::f64::consts::FRAC_1_SQRT_2;
        let cases = [
            (0.0, 0.0, 0.0, 1.0),
            (0.0, 0.38268343, 0.0, 0.92387953),
            (0.0, -s, 0.0, s),
            (0.00034, 0.97530, 0.00399, 0.22086),
            (-0.00566, -0.14087, 0.00132, -0.99001),
            (0.02147, 0.54854, -0.01831, 0.83565),
        ];
        for (x, y, z, w) in cases {
            // v' = v + 2w(q×v) + 2q×(q×v)，v = (0, 0, 1)；这里用两次叉乘直接算。
            let (qx, qy, qz) = (x, y, z);
            let (vx, vy, vz) = (0.0, 0.0, 1.0);
            let (cx, cy, cz) = (
                qy * vz - qz * vy,
                qz * vx - qx * vz,
                qx * vy - qy * vx,
            );
            let (ccx, _ccy, ccz) = (
                qy * cz - qz * cy,
                qz * cx - qx * cz,
                qx * cy - qy * cx,
            );
            let fx = vx + 2.0 * w * cx + 2.0 * ccx;
            let fz = vz + 2.0 * w * cz + 2.0 * ccz;
            let expected = fx.atan2(fz).to_degrees().rem_euclid(360.0);
            let yaw = yaw_from_quaternion(x, y, z, w);
            let diff = ((yaw - expected + 180.0).rem_euclid(360.0)) - 180.0;
            assert!(diff.abs() < 1e-9, "q = ({x}, {y}, {z}, {w}), yaw = {yaw}, expected = {expected}");
        }
    }
}
