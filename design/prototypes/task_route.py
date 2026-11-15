"""任务树与任务路线推荐的原型。

只用于设计阶段验证思路，不是产品代码。
数据来自上游的静态文件 https://json.tarkov.dev/regular/{tasks,tasks_zh,traders,traders_zh,maps_zh}
用法: python3 task_route.py [数据目录] [输出 js 路径] [进度 json] [模式]
不给进度时用模拟的进度；给了就用 log_progress.py 从游戏日志还原出来的真实进度。
"""
import collections
import functools
import json
import sys
from pathlib import Path

DATA = Path(sys.argv[1] if len(sys.argv) > 1 else Path(__file__).parent / "data")
OUT = Path(sys.argv[2]) if len(sys.argv) > 2 else None


def load(name):
    return json.loads((DATA / f"regular_{name}.json").read_text())["data"]


tasks = load("tasks")["tasks"]
zh = load("tasks_zh")
traders = load("traders")
traders_zh = load("traders_zh")
maps_zh = load("maps_zh")


def tname(tid):
    return zh.get(tasks[tid]["name"], tid)


def trader_key(tid):
    return traders[tasks[tid]["trader"]]["normalizedName"]


def trader_name(key):
    for v in traders.values():
        if v["normalizedName"] == key:
            return traders_zh.get(v["name"], key)
    return key


def map_name(mid):
    return maps_zh.get(f"{mid} Name", mid)


# ---------- 图 ----------
# 前置：要求前置任务"完成"或"已接取"的都算一条边；只要求"失败"的是互斥分支，不算。
pre = {
    k: [r["task"] for r in t["taskRequirements"] if {"complete", "active"} & set(r["status"])]
    for k, t in tasks.items()
}
children = collections.defaultdict(list)
for k, ps in pre.items():
    for p in ps:
        children[p].append(k)


def trader_level_req(tid):
    """这个任务要求的商人等级（取发布任务的那个商人）。"""
    t = tasks[tid]
    for r in t["traderRequirements"]:
        if r["requirementType"] == "level" and r["trader"] == t["trader"]:
            return r["value"]
    return 1


def task_maps(tid):
    """任务目标涉及的地图集合；空集合表示任意地图或不在局内。"""
    t = tasks[tid]
    ms = set()
    for o in t["objectives"]:
        if o.get("optional"):
            continue
        ms.update(o.get("maps") or [])
    if not ms and t.get("map"):
        ms.add(t["map"])
    return ms


@functools.lru_cache(None)
def ancestors(tid):
    out = set()
    for p in pre[tid]:
        out.add(p)
        out |= ancestors(p)
    return frozenset(out)


@functools.lru_cache(None)
def descendants(tid):
    out = set()
    for c in children[tid]:
        out.add(c)
        out |= descendants(c)
    return frozenset(out)


# ---------- 模拟进度 ----------
def simulate_progress():
    """造一份像样的进度：低等级、低商人等级的任务按前置顺序做完，其中一部分正在做。"""
    done = set()
    order = sorted(tasks, key=lambda k: (len(ancestors(k)), tasks[k]["minPlayerLevel"], k))
    for k in order:
        t = tasks[k]
        if t["minPlayerLevel"] <= 12 and trader_level_req(k) <= 2 and not t.get("otherRequirements"):
            if all(p in done for p in pre[k]) and len(ancestors(k)) <= 3:
                done.add(k)
    doable = [k for k in order if k not in done and all(p in done for p in pre[k])
              and tasks[k]["minPlayerLevel"] <= 15 and trader_level_req(k) <= 2 and not tasks[k].get("otherRequirements")]
    active = set(doable[::3][:8])
    return done, active


def infer_levels(done, active):
    """从已接取/已完成的任务反推等级下限：能接到的任务说明等级够了。"""
    seen = done | active
    player = max((tasks[k]["minPlayerLevel"] for k in seen), default=1)
    tl = collections.defaultdict(lambda: 1)
    for k in seen:
        for r in tasks[k]["traderRequirements"]:
            if r["requirementType"] == "level":
                key = traders[r["trader"]]["normalizedName"]
                tl[key] = max(tl[key], r["value"])
    return player, dict(tl)


# ---------- 推荐 ----------
def goal_closure(goal_ids):
    need = set(goal_ids)
    for g in goal_ids:
        need |= ancestors(g)
    return need


def plan(goal_ids, done, active, max_raids=8, per_raid=5):
    """贪心：每一局去"能推进最多后续任务"的那张图。

    权重 = 1 + 这个任务在目标范围内挡住的后续任务数。
    一个任务的目标分布在多张图时，权重按图平分。
    """
    need = goal_closure(goal_ids) - done
    done = set(done)
    raids = []
    for _ in range(max_raids):
        doable = [k for k in need if all(p in done for p in pre[k])]
        if not doable:
            break
        weight = {k: 1 + len(descendants(k) & need) for k in doable}
        by_map = collections.defaultdict(list)
        anywhere = []
        for k in doable:
            ms = task_maps(k)
            if not ms:
                anywhere.append(k)
            for m in ms:
                by_map[m].append((weight[k] / len(ms), k))
        if not by_map:
            picked, mid = sorted(anywhere, key=lambda k: -weight[k])[:per_raid], None
        else:
            mid = max(by_map, key=lambda m: sum(w for w, _ in sorted(by_map[m], reverse=True)[:per_raid]))
            picked = [k for _, k in sorted(by_map[mid], reverse=True)[:per_raid]]
        ride = sorted(anywhere, key=lambda k: -weight[k])[:2] if mid else []
        raids.append({"map": mid, "tasks": picked, "ride": ride, "weight": {k: weight[k] for k in picked + ride}})
        for k in picked + ride:
            done.add(k)
            need.discard(k)
    return raids, len(need)


# ---------- 布局（给效果图用） ----------
LANES = ["prapor", "therapist", "skier", "peacekeeper", "mechanic", "ragman", "jaeger"]


def level_rank(tid):
    lv = tasks[tid]["minPlayerLevel"]
    return 0 if lv < 6 else 1 if lv < 12 else 2 if lv < 21 else 3 if lv < 36 else 4


@functools.lru_cache(None)
def column(tid):
    same = [p for p in pre[tid]]
    return max([level_rank(tid), trader_level_req(tid) - 1] + [column(p) + 1 for p in same])


def layout(done, active, goal_need, grid_rows=4):
    """每个商人一条泳道。有前后关系的任务按链条排；独立任务在下面排成紧凑的格子。
    目标涉及的商人排在前面。"""
    nodes, lane_rows = [], {}
    lanes = sorted(LANES, key=lambda l: -sum(1 for k in goal_need if trader_key(k) == l))
    y0 = 0
    for lane in lanes:
        ids = [k for k in tasks if trader_key(k) == lane]
        chain = sorted((k for k in ids if pre[k] or children[k]), key=lambda k: (column(k), tname(k)))
        single = sorted((k for k in ids if not pre[k] and not children[k]),
                        key=lambda k: (k not in done, tasks[k]["minPlayerLevel"], tname(k)))
        used = collections.defaultdict(set)
        place = {}
        for k in chain:
            c = column(k)
            want = [place[p][1] for p in pre[k] if p in place]
            r = want[0] if want and want[0] not in used[c] else 0
            while r in used[c]:
                r += 1
            used[c].add(r)
            place[k] = (c, r)
        base = 1 + max((r for _, r in place.values()), default=-1)
        for i, k in enumerate(single):
            place[k] = (i // grid_rows, base + i % grid_rows)
        rows = 1 + max(r for _, r in place.values())
        lane_rows[lane] = (y0, rows)
        for k in ids:
            state = "done" if k in done else "active" if k in active else \
                "open" if all(p in done for p in pre[k]) else "locked"
            nodes.append({"id": k, "name": tname(k), "lane": lane, "col": place[k][0], "row": y0 + place[k][1],
                          "state": state, "goal": k in goal_need})
        y0 += rows
    idx = {n["id"] for n in nodes}
    edges = [[p, k] for k in idx for p in pre[k] if p in idx]
    return nodes, edges, lane_rows


if __name__ == "__main__":
    if len(sys.argv) > 4:
        # 真实进度：log_progress.py 的输出，取指定模式
        prog = json.loads(Path(sys.argv[3]).read_text())[sys.argv[4]]
        done, active = set(prog["done"]) & set(tasks), set(prog["active"]) & set(tasks)
    else:
        done, active = simulate_progress()
    player, tl = infer_levels(done, active)
    kappa = [k for k, t in tasks.items() if t["kappaRequired"]]
    collector = next(k for k in kappa if tasks[k]["normalizedName"] == "collector")
    need = goal_closure(kappa)

    print(f"任务总数 {len(tasks)}，有前置任务的 {sum(1 for v in pre.values() if v)}")
    print(f"进度：已完成 {len(done)}，进行中 {len(active)}")
    print(f"反推等级下限：角色 ≥ {player}，商人 {tl}")
    print(f"目标 Kappa：涉及 {len(need)} 个任务，还差 {len(need - done)} 个")
    raids, left = plan(kappa, done, active)
    for i, r in enumerate(raids, 1):
        print(f"第 {i} 局  {map_name(r['map']) if r['map'] else '不限地图'}")
        for k in r["tasks"]:
            print(f"    {tname(k)}（{trader_name(trader_key(k))}，解锁后续 {r['weight'][k] - 1}）")
        for k in r["ride"]:
            print(f"    顺带：{tname(k)}（{trader_name(trader_key(k))}）")
    print(f"之后还剩 {left} 个")

    if OUT:
        nodes, edges, lanes = layout(done, active, need)
        payload = {
            "nodes": nodes, "edges": edges,
            "lanes": [{"key": k, "name": trader_name(k), "y": v[0], "rows": v[1]} for k, v in lanes.items()],
            "raids": [{"map": map_name(r["map"]) if r["map"] else "不限地图",
                       "tasks": [tname(k) for k in r["tasks"]], "ride": [tname(k) for k in r["ride"]]} for r in raids],
            "stats": {"need": len(need), "left": len(need - done), "done": len(done), "active": len(active), "total": len(tasks)},
        }
        OUT.write_text("window.TT = " + json.dumps(payload, ensure_ascii=False) + ";\n")
        print("写出", OUT)
