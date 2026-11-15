"""从 逃离塔科夫中文Wiki (https://www.eftarkov.com) 的地图页导入点位，并换算成游戏坐标。

数据经站长同意后使用，需署名"逃离塔科夫中文Wiki"。
只用于设计阶段验证思路，不是产品代码。

该网站的点位用的是它自己地图图片上的像素坐标。换算办法：两边都有撤离点，
用撤离点把"网站像素坐标 -> 游戏坐标"的变换拟合出来，再套到其他点位上。

用法: python3 eftarkov_import.py <网站地图页目录> <上游数据目录> <输出 json>
"""
import collections
import json
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


def fit(site_pts, game_pts):
    """不知道谁对应谁，枚举两对点假设一个相似变换，取内点最多的。"""
    best = (0, None)
    for refl in (False, True):
        P = [p.conjugate() if refl else p for p in site_pts]
        for i in range(len(P)):
            for j in range(len(P)):
                if i == j or abs(P[i] - P[j]) < 30:
                    continue
                for a in range(len(game_pts)):
                    for b in range(len(game_pts)):
                        if a == b:
                            continue
                        k = (game_pts[a] - game_pts[b]) / (P[i] - P[j])
                        if not 0.02 < abs(k) < 5:
                            continue
                        t = game_pts[a] - k * P[i]
                        n = 0
                        for p in P:
                            q = k * p + t
                            if min(abs(q - g) for g in game_pts) < TOL:
                                n += 1
                        if n > best[0]:
                            best = (n, (refl, k, t))
    return best


def refine(site_pts, game_pts, model):
    """用内点做一次最小二乘，把相似变换修得更准。"""
    refl, k, t = model
    pairs = []
    for p in site_pts:
        pp = p.conjugate() if refl else p
        q = k * pp + t
        g = min(game_pts, key=lambda g: abs(q - g))
        if abs(q - g) < TOL:
            pairs.append((pp, g))
    n = len(pairs)
    mp = sum(p for p, _ in pairs) / n
    mg = sum(g for _, g in pairs) / n
    num = sum((g - mg) * (p - mp).conjugate() for p, g in pairs)
    den = sum(abs(p - mp) ** 2 for p, _ in pairs)
    k2 = num / den
    t2 = mg - k2 * mp
    err = [abs(k2 * p + t2 - g) for p, g in pairs]
    return (refl, k2, t2), n, sum(err) / n, max(err)


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
                if n2 < max(3, len(site_ex) // 2):
                    model = None
                    info += "（对上的太少，不采用）"
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
