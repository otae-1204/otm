"""从 逃离塔科夫中文Wiki (https://www.eftarkov.com) 的地图页导入点位，并换算成游戏坐标。

数据经站长同意后使用，需署名"逃离塔科夫中文Wiki"。
只用于设计阶段验证思路，不是产品代码。

该网站的点位用的是它自己地图图片上的像素坐标。换算办法：两边都有撤离点，
用撤离点把"网站像素坐标 -> 游戏坐标"的变换拟合出来，再套到其他点位上。

用法: python3 eftarkov_import.py <网站地图页目录> <上游数据目录> <输出 json>

网站地图页是 https://www.eftarkov.com/map/<地图 id>，存成 <地图 id>.html 放进第一个目录。
"""
import collections
import json
import math
import re
import sys
from pathlib import Path

PAGES, DATA, OUT = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])
TOL = 18.0  # 米：撤离点标注位置允许的误差


def site_config(path):
    s = path.read_text(encoding="utf-8", errors="replace")
    m = re.search(r'\{"mapId":"', s)
    cfg, _ = json.JSONDecoder().raw_decode(s[m.start():])
    return cfg


def rms(pts):
    """点集的均方根半径，用来估两边的尺度。"""
    c = sum(pts) / len(pts)
    return math.sqrt(sum(abs(p - c) ** 2 for p in pts) / len(pts))


def match_pairs(P, game_pts, k, t):
    """一对一配对：都在误差内的候选按距离从小到大认领，两边各只用一次。

    必须一对一：多对一的最近点匹配会让退化解（把所有点缩到某一个撤离点上）
    也报出很高的"对上数"，2026-11-19 就是这么把海关的 30 个点全算成了一处。
    """
    cand = []
    for i, p in enumerate(P):
        q = k * p + t
        for a, g in enumerate(game_pts):
            d = abs(q - g)
            if d <= TOL:
                cand.append((d, i, a))
    cand.sort()
    used_p, used_g, pairs = set(), set(), []
    for d, i, a in cand:
        if i in used_p or a in used_g:
            continue
        used_p.add(i)
        used_g.add(a)
        pairs.append((i, a, d))
    return pairs


def fit(site_pts, game_pts):
    """不知道谁对应谁，枚举两对点假设一个相似变换，取一对一配对里对上最多的。

    同一张图的撤离点分布形状两边是一样的，所以先把尺度估出来（两边 RMS 半径之比），
    只在这个尺度附近找：退化的解尺度会差出几十倍，一上来就被筛掉了。
    """
    k0 = rms(game_pts) / rms(site_pts)
    best = (0, None)
    for refl in (False, True):
        P = [p.conjugate() if refl else p for p in site_pts]
        for i in range(len(P)):
            for j in range(i + 1, len(P)):
                dp = P[i] - P[j]
                if abs(dp) < 1:
                    continue
                for a in range(len(game_pts)):
                    for b in range(a + 1, len(game_pts)):
                        k = (game_pts[a] - game_pts[b]) / dp
                        if not 0.7 * k0 < abs(k) < 1.4 * k0:
                            continue
                        t = game_pts[a] - k * P[i]
                        n = len(match_pairs(P, game_pts, k, t))
                        if n > best[0]:
                            best = (n, (refl, k, t))
    return best


def refine(site_pts, game_pts, model):
    """用配上的点做最小二乘，把相似变换修得更准；配对和拟合交替两三遍。"""
    refl, k, t = model
    P = [p.conjugate() if refl else p for p in site_pts]
    pairs = []
    for _ in range(3):
        pairs = match_pairs(P, game_pts, k, t)
        if len(pairs) < 3:
            break
        mp = sum(P[i] for i, _, _ in pairs) / len(pairs)
        mg = sum(game_pts[a] for _, a, _ in pairs) / len(pairs)
        num = sum((game_pts[a] - mg) * (P[i] - mp).conjugate() for i, a, _ in pairs)
        den = sum(abs(P[i] - mp) ** 2 for i, _, _ in pairs)
        k = num / den
        t = mg - k * mp
    pairs = match_pairs(P, game_pts, k, t)
    err = [abs(k * P[i] + t - game_pts[a]) for i, a, _ in pairs]
    return (refl, k, t), len(pairs), sum(err) / len(err), max(err)



def main():
    up = json.loads((DATA / "regular_maps.json").read_text())["data"]["maps"]
    mzh = json.loads((DATA / "regular_maps_zh.json").read_text())["data"]
    out = {"source": "逃离塔科夫中文Wiki", "url": "https://www.eftarkov.com", "maps": {}}
    for page in sorted(PAGES.glob("*.html")):
        mid = page.stem
        cfg = site_config(page)
        name = mzh.get(f"{mid} Name", mid)
        marks = cfg["markers"]
        cats = collections.Counter(m.get("category_path") or m["category"] for m in marks)
        docs = [m for m in marks if (m.get("category_path") or "").startswith("通行证文件")]
        tasks = [m for m in marks if (m.get("category_path") or "").startswith("任务相关")]
        site_ex = [complex(float(m["x"]), float(m["y"])) for m in marks
                   if (m.get("category_path") or "").startswith("撤离点") and m["marker_type"] == "point"]
        game_ex = []
        if mid in up:
            for e in (up[mid].get("extracts") or []) + (up[mid].get("transits") or []):
                p = e.get("position")
                if p:
                    game_ex.append(complex(p["x"], p["z"]))
        model, info = None, "上游没有这张图或撤离点太少"
        if len(site_ex) >= 3 and len(game_ex) >= 3:
            n, m0 = fit(site_ex, game_ex)
            if m0 and n >= 3:
                model, n2, mean, worst = refine(site_ex, game_ex, m0)
                info = f"对上 {n2}/{len(site_ex)} 个撤离点，平均误差 {mean:.1f} 米，最大 {worst:.1f} 米"
                # 对上一半以上、平均偏差 10 米以内才用：偏差大的点会让整张图的点位全都飘
                if n2 < max(3, len(site_ex) // 2) or mean > 10:
                    model = None
                    info += "（对上的太少或偏差太大，不采用）"
        print(f"{name}: 标注 {len(marks)}，赛季文件 {len(docs)}，任务相关 {len(tasks)} | {info}")

        def conv(m):
            if not model:
                return None
            refl, k, t = model
            p = complex(float(m["x"]), float(m["y"]))
            q = k * (p.conjugate() if refl else p) + t
            return {"x": round(q.real, 1), "z": round(q.imag, 1)}

        def point(m):
            return {"type": m["category"], "title": m["title"], "desc": m["description"], "floor": m["floor_key"],
                    "site": {"x": float(m["x"]), "y": float(m["y"])}, "game": conv(m),
                    "task": m.get("task_id"), "item": m.get("item_id"), "images": m.get("image_urls") or []}

        out["maps"][mid] = {"name": name, "fit": info, "documents": [point(m) for m in docs],
                            "tasks": [point(m) for m in tasks], "categories": dict(cats)}
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, ensure_ascii=False, indent=1))
    nd = sum(len(v["documents"]) for v in out["maps"].values())
    nt = sum(len(v["tasks"]) for v in out["maps"].values())
    ok = sum(1 for v in out["maps"].values() if any(p["game"] for p in v["documents"] + v["tasks"]))
    print(f"合计：赛季文件点位 {nd}，任务相关点位 {nt}；{ok}/{len(out['maps'])} 张图换算成功。写出 {OUT}")


main()
