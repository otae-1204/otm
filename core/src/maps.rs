//! 场景预设名 → 地点名。
//!
//! 日志里有两处给出地图，写法不一定一样：
//!
//! - 加载时：`scene preset path:maps/shopping_mall.bundle rcid:Shopping_Mall.ScenesPreset.asset`，
//!   `rcid` 里第一个点号前面的是**场景预设名**。
//! - 进局记录里：`TRACE-NetworkGameCreate ... Location: Interchange`，这是**地点名**。
//!
//! 界面只认地点名（`bigmap`、`Interchange`、`factory4_day`……），所以加载阶段报出去的
//! 地图名要先在这里换一次。查不到时原样给出预设名，等进局记录来了再以它为准
//! （对不上的那一对会记进 [`crate::state::State::map_mismatches`]）。
//!
//! # 怎么补表
//!
//! 表里只放能从真实日志里确认的条目，不要凭印象填。确认的办法：跑一遍
//! `otm-replay <application 日志> <截图清单>`，它对不上时会往标准错误打一行
//! `未收录的场景预设: <预设名> → <地点名>`，把那一对抄进来即可。每条都写清楚依据。
//!
//! 键是小写的预设名，比较时不分大小写；值必须是进局记录里 `Location` 的原样写法。

/// 场景预设名（小写）到地点名的对照表。
const PRESET_TO_LOCATION: &[(&str, &str)] = &[
    // core/tests/fixtures/pve_session.application.log:
    //   scene preset path:maps/shopping_mall.bundle rcid:Shopping_Mall.ScenesPreset.asset
    //   TRACE-NetworkGameCreate ... Location: Interchange ...
    ("shopping_mall", "Interchange"),
    // core/tests/fixtures/season_session.application.log:
    //   scene preset path:maps/customs_preset.bundle rcid:bigmap.scenespreset.asset
    //   TRACE-NetworkGameCreate ... Location: bigmap ...
    ("bigmap", "bigmap"),
    // 以下各条来自 2026-11-15 对一台真实机器上最近 700 次启动的 application 日志的统计：
    // 同一局里 "scene preset path ... rcid:<预设名>" 与随后的 "Location: <地点名>" 配成对，
    // 括号里是这一对出现的次数。
    ("shoreline", "Shoreline"),               // 156
    ("woods", "Woods"),                       // 141
    ("city", "TarkovStreets"),                // 85
    ("factory_day", "factory4_day"),          // 84
    ("rezerv_base", "RezervBase"),            // 82
    ("lighthouse", "Lighthouse"),             // 52
    ("laboratory", "laboratory"),             // 46
    ("sandbox_high", "Sandbox_high"),         // 35
    ("factory_night", "factory4_night"),      // 33
    ("icebreaker", "Icebreaker"),             // 25
    ("labyrinth", "Labyrinth"),               // 25
    ("laboratory_dark", "laboratory_dark"),   // 16
    ("sandbox", "Sandbox"),                   // 12
    ("factory_event", "factory_event"),       // 5
    ("laboratory_event", "laboratory_event"), // 1
];

/// 去掉预设名后面的 `_preset`（1.3.0.2 的加载行文件名这么写）。
///
/// `lighthouse_preset` → `lighthouse`；没有这个尾巴时原样返回。
pub fn strip_preset_suffix(name: &str) -> &str {
    let trimmed = name.trim();
    // 用 is_char_boundary 判断，别按字节切：预设名里要是混了非 ASCII，切点会落在字符中间。
    let cut = trimmed.len().wrapping_sub(7);
    if trimmed.is_char_boundary(cut) && trimmed[cut..].eq_ignore_ascii_case("_preset") {
        &trimmed[..cut]
    } else {
        trimmed
    }
}

/// 把场景预设名换成地点名。查不到时原样返回（去掉首尾空白）。
///
/// 新旧两种写法都收：`Shopping_Mall` / `shopping_mall`，以及带 `_preset` 尾巴的
/// `lighthouse_preset`（1.3.0.2 的文件名）。查表时先按原样、再去掉 `_preset` 试一次；
/// 表里没有的名字一律原样给出，不偷偷改名——`Some_New_Preset` 还是 `Some_New_Preset`。
pub fn location_from_preset(preset: &str) -> &str {
    let preset = preset.trim();
    lookup(preset)
        .or_else(|| lookup(strip_preset_suffix(preset)))
        .unwrap_or(preset)
}

fn lookup(preset: &str) -> Option<&'static str> {
    PRESET_TO_LOCATION
        .iter()
        .find(|(name, _)| name.eq_ignore_ascii_case(preset))
        .map(|(_, location)| *location)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_presets_are_translated() {
        // 立交桥：预设叫 Shopping_Mall，地点叫 Interchange。
        assert_eq!(location_from_preset("Shopping_Mall"), "Interchange");
        assert_eq!(location_from_preset("shopping_mall"), "Interchange");
        // 海关：两边同名。
        assert_eq!(location_from_preset("bigmap"), "bigmap");
    }

    /// 1.3.0.2 的文件名写法（`<名字>_preset.bundle`）也要查得出来。
    #[test]
    fn preset_suffix_is_ignored_when_looking_up() {
        assert_eq!(location_from_preset("lighthouse_preset"), "Lighthouse");
        assert_eq!(location_from_preset("Rezerv_Base_preset"), "RezervBase");
        assert_eq!(location_from_preset("shoreline_PRESET"), "Shoreline");
        // 表里没有的名字不会被改名，`_Preset` 也不再当成尾巴去掉。
        assert_eq!(location_from_preset("Some_New_Preset"), "Some_New_Preset");
        assert_eq!(location_from_preset("unknown_preset"), "unknown_preset");
    }

    #[test]
    fn stripping_the_preset_suffix_is_safe_on_odd_input() {
        assert_eq!(strip_preset_suffix("lighthouse_preset"), "lighthouse");
        assert_eq!(strip_preset_suffix("lighthouse"), "lighthouse");
        // 整串就是后缀时剩下空的：调用方据此当作没给出名字。
        assert_eq!(strip_preset_suffix("_preset"), "");
        assert_eq!(strip_preset_suffix(""), "");
        // 别按字节切：非 ASCII 的名字不能被切成半个字符。
        assert_eq!(strip_preset_suffix("海关"), "海关");
        assert_eq!(strip_preset_suffix("海关地图"), "海关地图");
        assert_eq!(strip_preset_suffix("海关_preset"), "海关");
    }

    #[test]
    fn unknown_presets_are_passed_through() {
        assert_eq!(location_from_preset("factory4_day"), "factory4_day");
        assert_eq!(location_from_preset("Some_New_Preset"), "Some_New_Preset");
        assert_eq!(location_from_preset("  bigmap  "), "bigmap");
        assert_eq!(location_from_preset(""), "");
    }

    /// 整张表：大小写随便写、带不带 `_preset`，都换成同一个地点名。
    #[test]
    fn every_entry_survives_case_and_suffix() {
        for (preset, location) in PRESET_TO_LOCATION {
            assert_eq!(location_from_preset(preset), *location);
            assert_eq!(
                location_from_preset(&preset.to_ascii_uppercase()),
                *location
            );
            assert_eq!(location_from_preset(&format!("{preset}_preset")), *location);
            assert_eq!(
                location_from_preset(&format!("{}_PRESET", preset.to_ascii_uppercase())),
                *location
            );
        }
    }

    #[test]
    fn table_keys_are_lowercase_and_values_are_not_empty() {
        for (preset, location) in PRESET_TO_LOCATION {
            assert_eq!(*preset, preset.to_ascii_lowercase(), "{preset} 应该小写");
            assert!(!location.is_empty(), "{preset} 没有地点名");
        }
    }
}
