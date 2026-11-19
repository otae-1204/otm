"""把 eftarkov_import.py 导入的点位整理成 otm 的赛季包。

赛季包是程序读的一份独立 JSON：赛季名、文件种类（含上游物品 id）、每张图的刷新点
（坐标、楼层、描述、照片）、每日上限、出处和署名。程序里不写死任何赛季内容，
换一份赛季包就是换一个赛季。

用法: python3 season_pack.py <eftarkov_points.json> <maps.json> <输出 json>

- <eftarkov_points.json>：eftarkov_import.py 的输出（design/prototypes/out/）。
- <maps.json>：tarkov.dev 的静态地图配置，即
  https://raw.githubusercontent.com/the-hideout/tarkov-dev/main/src/data/maps.json
  （app 里 MAPS_JSON_URL 用的就是它），只要其中的楼层划分。
  上游地图 id → 配置 key 的换算用仓库里已有的 design/prototypes/data/regular_maps.json。

楼层的对应关系按 app/src/data/floors.ts 的规则：
  网站的 floor_key 是「几楼」的说法，-1 是地下，1 是一楼（也就是底图本身，不是配置里的一层）。
  先按名字把配置的每一层读成 -1、2、3、4…（Underground/Tunnels/Bunkers/Garage/Technical 都算地下），
  再把 floor_key 对到同号的那一层；对不上的放地面层，并在这里逐条列出来。
  配置里给了区域框（bounds）的层，还要再核一次点位是不是落在框里——落不进去说明它不在这层。
"""

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
POINTS, CONFIG, OUT = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])
REGULAR_MAPS = ROOT / "design/prototypes/data/regular_maps.json"

# 赛季包格式版本。字段有不兼容的改动时加一，程序据此判断还读不读得懂。
FORMAT = "otm-season-pack"
VERSION = 1

# 文件种类：网站的中文名 → 赛季包里的 id。id 是程序里用的稳定名字（子类开关的键）。
# floor_key 是 1 的时候：一楼就是底图本身，不算配置里的一层。
GROUND_1F = "一楼就是底图，归地面"

TYPE_IDS = {
    "PMC 个人档案": "pmc",
    "财务文件": "finance",
    "项目文件": "project",
    "蓝图与技术文档": "blueprint",
    "测试文档": "test",
    "员工文档": "staff",
    "医疗文件": "medical",
    "技术文档": "technical",
}

# 每种文件在地图上和筛选里用的颜色。避开撤离点的绿、危险区的红/橙黄，
# 同一张图会一起刷的两种必须拉开（见 scripts/season.test.mjs 的对照检查）。
TYPE_COLORS = {
    "pmc": "#7fd8ff",
    "finance": "#4a54ff",
    "project": "#ff5ec4",
    "blueprint": "#2fd0d4",
    "test": "#e6ecf5",
    "staff": "#ff9ef0",
    "medical": "#cfe3ff",
    "technical": "#b07bff",
}

def floor_label(floor_key):
    """网站写的楼层 → 详情里显示的层名（2F、B1）。一楼就是底图，不写。"""
    try:
        n = int(str(floor_key).strip())
    except (TypeError, ValueError):
        return None
    if n == 1:
        return None
    return f"B{-n}" if n < 0 else f"{n}F"


# 判定"位置在这层区域里"时允许的误差（米）。
TOL_M = 5.0

# 每日拾取上限，按档案（日志里的模式名）分开。
LIMITS = {"Regular": 25, "Pve": 15, "PvpSeason": 40}

# 楼层层名 → 层号。和 app/src/data/annotations.ts 的 LAYER_NAMES 对得上。
FLOOR_NAMES = {
    "1st Floor": 1, "First Floor": 1,
    "2nd Floor": 2, "Second Floor": 2, "Second Level": 2,
    "3rd Floor": 3, "Third Floor": 3,
    "4th Floor": 4, "Fourth Floor": 4,
    "5th Floor": 5, "Fifth Floor": 5,
    "Underground": -1, "Basement": -1, "Tunnels": -1,
    "Garage": -1, "Bunkers": -1, "Technical": -1,
}


def layer_no(name):
    return FLOOR_NAMES.get(name)


def in_bounds(extents, x, z):
    """点位是不是落在这层给的区域框里。这层没给框就当作不知道，放行。

    每个框是 [[x0, z0], [x1, z1], 名字]，两个角点，谁大谁小不一定。
    换算出来的坐标自己也有几米误差（撤离点平均对到 3 到 6 米），
    所以差不到 TOL_M 米的算在框里，免得把本来就对的点推到地面。
    """
    boxes = [bd for e in extents or [] for bd in (e.get("bounds") or [])]
    if not boxes:
        return True
    for box in boxes:
        (x0, z0), (x1, z1) = box[0], box[1]
        dx = max(min(x0, x1) - x, 0.0, x - max(x0, x1))
        dz = max(min(z0, z1) - z, 0.0, z - max(z0, z1))
        if dx * dx + dz * dz <= TOL_M * TOL_M:
            return True
    return False


def resolve_floor(cfg_map, floor_key, x, z):
    """网站的 floor_key → 配置里的层名。返回 (层名 or None, 说明)。

    层名 None 表示地面（底层底图），说明是给人看的理由，用来汇报。
    """
    layers = cfg_map.get("layers") or []
    try:
        n = int(str(floor_key).strip())
    except (TypeError, ValueError):
        return None, f"楼层 {floor_key!r} 看不懂，放地面"
    if n <= -1:
        want, what = -1, "地下"
    elif n == 1:
        # 一楼就是底图本身。配置里真有一层叫一楼时才算一层，否则归地面。
        want, what = 1, "一楼"
    else:
        want, what = n, f"{n} 楼"

    same = [(i, l) for i, l in enumerate(layers) if layer_no(l.get("name")) == want]
    if not same:
        if want == 1:
            return None, GROUND_1F
        return None, f"这张图没有{what}这一层，放地面"
    for _, l in same:
        if in_bounds(l.get("extents"), x, z):
            return l["name"], ""
    return None, f"位置不在{what}的区域里，放地面"


def config_lookup(cfg):
    """配置的 key 和 altMaps 都指到同一个地图对象。"""
    out = {}
    for g in cfg:
        for m in g.get("maps", []):
            if m.get("projection") != "interactive":
                continue
            out[m["key"]] = m
            for alt in m.get("altMaps") or []:
                out[alt] = m
    return out


def main():
    pts = json.loads(POINTS.read_text(encoding="utf-8"))["maps"]
    cfg = config_lookup(json.loads(CONFIG.read_text(encoding="utf-8")))
    up = json.loads(REGULAR_MAPS.read_text(encoding="utf-8"))["data"]["maps"]

    types = {}          # id → {id, name, item}
    maps = []
    report = []
    skipped = []        # 没进包的点位（没有物品 id、没换算坐标、图对不上）
    mismatched = []     # 楼层对不上的点位

    for mid, src in pts.items():
        name = src["name"]
        if not any(p.get("game") for p in src.get("documents") or []):
            skipped.append(f"{name}：没有换算成功的点位（网站上没有这张图的撤离点），整张图不放")
            continue
        norm = (up.get(mid) or {}).get("normalizedName")
        cfg_map = cfg.get(norm) if norm else None
        if not cfg_map:
            skipped.append(f"{name}：上游配置里找不到对应的地图（{norm}），整张图不放")
            continue

        out_points = []
        floor_count = {}
        first_floor = 0
        for p in src.get("documents") or []:
            if not p.get("item"):
                skipped.append(f"{name}：{p.get('desc') or p.get('title')}（没有物品 id）")
                continue
            tid = TYPE_IDS.get(p["type"])
            if not tid:
                skipped.append(f"{name}：{p['type']}（认不出的文件种类）")
                continue
            game = p.get("game")
            if not game:
                skipped.append(f"{name}：{p.get('desc') or p.get('title')}（没换算坐标）")
                continue
            floor, why = resolve_floor(cfg_map, p.get("floor"), game["x"], game["z"])
            types.setdefault(
                tid, {"id": tid, "name": p["type"], "item": p["item"], "color": TYPE_COLORS[tid]}
            )
            if types[tid]["item"] != p["item"]:
                print(f"！{p['type']} 有两个物品 id：{types[tid]['item']} / {p['item']}，按先出现的算")
            if floor is None and why == GROUND_1F:
                first_floor += 1
            elif floor is None and why:
                mismatched.append((name, p["type"], p.get("floor"), why, p.get("desc")))
            label = floor or "地面"
            floor_count[label] = floor_count.get(label, 0) + 1
            point = {
                "type": tid,
                "x": game["x"],
                "z": game["z"],
                "floor": floor,
                "desc": p.get("desc") or "",
                "images": p.get("images") or [],
            }
            # 放到地面层的点：详情里仍要显示网站写的楼层（DESIGN 6.7.1）
            if floor is None:
                label = floor_label(p.get("floor"))
                if label:
                    point["floorLabel"] = label
            out_points.append(point)

        if not out_points:
            skipped.append(f"{name}：没有可用的点位")
            continue
        maps.append({"key": cfg_map["key"], "name": name, "points": out_points})
        order = ["地面"] + [l["name"] for l in (cfg_map.get("layers") or [])]
        tally = []
        for k in order:
            if k not in floor_count:
                continue
            tally.append(f"{k} {floor_count[k]}" + (f"（其中一楼 {first_floor}）" if k == "地面" and first_floor else ""))
        report.append(f"{name}（{cfg_map['key']}）：{len(out_points)} 点 → " + "、".join(tally))

    pack = {
        "format": FORMAT,
        "version": VERSION,
        "season": {"name": "当前赛季"},
        "limits": LIMITS,
        "source": {
            "name": "逃离塔科夫中文Wiki",
            "url": "https://www.eftarkov.com",
            "photos": "https://www.eftarkov.com",
        },
        "types": sorted(types.values(), key=lambda t: list(TYPE_IDS.values()).index(t["id"])),
        "maps": maps,
    }

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(pack, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")

    print("每张图的点位与楼层：")
    for line in report:
        print("  " + line)
    total = sum(len(m["points"]) for m in maps)
    print(f"共 {len(types)} 种文件、{len(maps)} 张图、{total} 个刷新点；写出 {OUT}（{OUT.stat().st_size // 1024} KB）")
    if mismatched:
        print(f"\n楼层没对上、按 floors.ts 的规则放到地面的 {len(mismatched)} 个点：")
        for name, typ, floor, why, desc in mismatched:
            print(f"  {name} {typ} 楼层 {floor!r}：{why} —— {desc}")
    else:
        print("\n除了「一楼就是底图」的，楼层全部对上")
    if skipped:
        print(f"\n没进包的点位/地图 {len(skipped)} 条：")
        for s in skipped:
            print("  " + s)


main()
