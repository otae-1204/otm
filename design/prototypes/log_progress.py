"""从游戏日志提取出的事件里还原每个模式的任务进度。原型，不是产品代码。

输入是一份事件清单，每行一条（由日志提取脚本生成）：
  D|日志目录名
  S|时间|模式            application 日志里的 "Session mode: X"
  P|时间|角色编号|RaidMode|地图
  Q|时间|类型|任务编号|模板   push-notifications 日志里的任务通知
任务通知的类型：10 = 接取，11 = 失败，12 = 完成（已对照真实日志确认）。
任务通知本身不带角色编号，按同一次启动里最近的 "Session mode" 归到对应模式。
2024 年 5 月之前的日志没有 "Session mode" 这一行，那时只有普通 PVP，按 Regular 算。

周目识别：一个已经完成的任务又被接取，说明进度被重置过（删档或转生），从这里开启新周目。

用法: python3 log_progress.py <事件清单> <上游数据目录> <输出 json>
"""
import collections
import json
import sys
from pathlib import Path

events, data, out = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])
tasks = json.loads((data / "regular_tasks.json").read_text())["data"]["tasks"]

pre = {k: [r["task"] for r in t["taskRequirements"] if "complete" in r["status"]] for k, t in tasks.items()}


def ancestors(q, seen=None):
    seen = set() if seen is None else seen
    for p in pre.get(q, []):
        if p not in seen:
            seen.add(p)
            ancestors(p, seen)
    return seen


# 先按模式把事件分开
seqs = collections.defaultdict(list)
mode = "Regular"
for line in events.read_text(encoding="utf-8", errors="replace").splitlines():
    p = line.split("|")
    if p[0] == "D":
        mode = "Regular"
    elif p[0] == "S":
        mode = p[2]
    elif p[0] == "Q" and p[2] in ("10", "11", "12") and p[3] in tasks:
        seqs[mode].append((p[1], p[2], p[3]))


def hours(a, b):
    from datetime import datetime
    f = "%Y-%m-%d %H:%M:%S"
    return abs((datetime.strptime(b, f) - datetime.strptime(a, f)).total_seconds()) / 3600


res = {}
for m, seq in seqs.items():
    # 一边回放一边找重置：48 小时内有 3 个已完成的任务又被接取，才算一次重置
    # （删档、重置角色、转生）。零星的重接不算。发现重置后清空状态，从第一个重接的时刻重新回放。
    apply = lambda st, kind, q: st.__setitem__(q, {"10": "active", "11": "failed", "12": "done"}[kind])
    st, resets, recent, i = {}, [], [], 0
    while i < len(seq):
        ts, kind, q = seq[i]
        if kind == "10" and st.get(q) == "done":
            recent = [(t, j) for t, j in recent if hours(t, ts) <= 48] + [(ts, i)]
            if len(recent) >= 3:
                resets.append(recent[0][0])
                st, i, recent = {}, recent[0][1], []
                continue
        apply(st, kind, q)
        i += 1
    start = resets[-1] if resets else seq[0][0]
    logged_done = {q for q, v in st.items() if v == "done"}
    # 日志里"完成"的通知经常缺失。接到了后面的任务，说明它的前置一定已经完成。
    inferred = set()
    for q in st:
        inferred |= ancestors(q)
    done = logged_done | inferred
    active = {q for q, v in st.items() if v == "active"} - done
    failed = {q for q, v in st.items() if v == "failed"} - done
    res[m] = {"done": sorted(done), "active": sorted(active), "failed": sorted(failed), "cycles": len(resets) + 1,
              "cycle_start": start, "last_event": seq[-1][0]}
    print(f"{m}: 第 {len(resets) + 1} 周目，从 {start} 起；日志记录完成 {len(logged_done)}，按前置推断补上 {len(done - logged_done)}，"
          f"共完成 {len(done)}；进行中 {len(active)}；失败 {len(failed)}；最后一条记录 {seq[-1][0]}")
    print("   重置时刻:", resets)
out.write_text(json.dumps(res, ensure_ascii=False))
