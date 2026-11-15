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

/// 把场景预设名换成地点名。查不到时原样返回（去掉首尾空白）。
pub fn location_from_preset(preset: &str) -> &str {
    let preset = preset.trim();
    PRESET_TO_LOCATION
        .iter()
        .find(|(name, _)| name.eq_ignore_ascii_case(preset))
        .map_or(preset, |(_, location)| *location)
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

    #[test]
    fn unknown_presets_are_passed_through() {
        assert_eq!(location_from_preset("factory4_day"), "factory4_day");
        assert_eq!(location_from_preset("Some_New_Preset"), "Some_New_Preset");
        assert_eq!(location_from_preset("  bigmap  "), "bigmap");
        assert_eq!(location_from_preset(""), "");
    }

    #[test]
    fn table_keys_are_lowercase_and_values_are_not_empty() {
        for (preset, location) in PRESET_TO_LOCATION {
            assert_eq!(*preset, preset.to_ascii_lowercase(), "{preset} 应该小写");
            assert!(!location.is_empty(), "{preset} 没有地点名");
        }
    }
}
