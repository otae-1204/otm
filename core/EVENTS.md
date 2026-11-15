# 核心与界面之间的约定

核心（Rust，`core/`）只负责读文件和算状态，界面（`app/`）只负责显示。两边通过一串 JSON 事件对接。
这份文件是两边共同遵守的约定，改动要同时改两边。

## 事件

每个事件是一个 JSON 对象，`type` 字段区分种类，`time` 是 ISO 8601 的本地时间字符串。

| type | 字段 | 含义 |
|---|---|---|
| `paths` | `game_dir`, `screenshot_dir`, `log_dir`（找不到的为 `null`） | 核心找到的目录 |
| `session` | `mode`: `"Regular"` \| `"Pve"` \| `"PvpSeason"` | 当前游戏模式（日志里的 `Session mode: X`） |
| `raid_loading` | `map` | 开始匹配/加载，已经知道是哪张图 |
| `raid_started` | `map`, `scav`: bool, `raid_mode`: `"Online"` \| `"Coop"` | 对局开始（日志里的 `GameStarted`） |
| `raid_ended` | | 对局结束 |
| `position` | `x`, `y`, `z`, `yaw`（度，可为 `null`）, `source`: `"screenshot"` \| `"log"` | 一次定位 |

- `map` 是游戏内部的地图名，原样给出，例如 `bigmap`、`Interchange`、`factory4_day`、`Sandbox_high`、`RezervBase`。换成显示用的名字由界面负责。
- `x y z` 是游戏坐标，`y` 是高度。
- `yaw`：绕竖直轴的朝向，单位度，范围 [0, 360)。来自截图文件名里的四元数。日志来源的定位没有朝向，为 `null`。
- `scav`：进局记录里的角色编号是 PMC 编号加一时为 `true`。

## 状态快照

界面启动或重连时可以要一份当前状态：

```json
{
  "paths": { "game_dir": "...", "screenshot_dir": "...", "log_dir": "..." },
  "mode": "PvpSeason",
  "raid": { "map": "bigmap", "started": true, "scav": false, "started_at": "..." },
  "position": { "x": 0, "y": 0, "z": 0, "yaw": 0, "source": "screenshot", "time": "..." },
  "trail": [ { "x": 0, "y": 0, "z": 0, "time": "..." } ]
}
```

没有的部分为 `null`，`trail` 是本局所有定位，按时间排序。

## 数据来源（核心只读这些）

- 截图文件名，形如
  `2026-11-12[20-18]_-232.18, 21.77, 16.87_0.00034, 0.97530, 0.00399, 0.22086_5.20 (0).png`
  依次是：日期和时分、坐标 x y z、四元数 x y z w、一个数字。菜单里的截图没有坐标部分，忽略。
- 游戏日志目录 `Logs/log_<日期>_<版本>/` 里的 `application` 日志。每次启动游戏新建一个目录。
  - `Session mode: Pve`
  - `scene preset path:maps/customs_preset.bundle rcid:bigmap.scenespreset.asset`：开始加载，`rcid` 里点号前面是地图名
  - `TRACE-NetworkGameCreate profileStatus: 'Profileid: <24 位十六进制>, Status: Busy, RaidMode: Online, Ip: ..., Port: ..., Location: Interchange, ...'`
  - `GameStarted:...`
  - `Reason:PacketsQueue, Position:(166.309, -0.593, 153.791), SpeedLimit:...`：对局中偶尔出现的一条位置，没有朝向
  - `Disposing BEClient`：`GameStarted` 之后出现，表示离开对局
  - 角色编号第一次在 `PrepareSelectedProfileLocally ProfileId:<id>` 里出现的是 PMC 的编号

测试用的真实日志（已脱敏）和截图文件名在 `core/tests/fixtures/`。

## 红线

核心只读上面这些文件。不读游戏内存，不抓包，不向游戏进程注入，不发送模拟按键。
