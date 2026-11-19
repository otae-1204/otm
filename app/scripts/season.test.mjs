#!/usr/bin/env node
// 赛季文件的单元测试：node scripts/season.test.mjs
//
// 三块：赛季包的读取与校验（types.ts）、刷新点摊成标注和楼层（season/annotations.ts）、
// 今日计数的跨天归零与上下限（season/counts.ts）。
// 界面上的部分（筛选行、地图图标、详情、状态栏）由 scripts/map-regression.mjs 端到端覆盖。

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parsePack, photoUrl, typesOnMap, mapsOfType, TYPE_COLORS } from "../src/data/season/types.ts";
import { layerIndexOf, seasonItems, withSeason } from "../src/data/season/annotations.ts";
import { bumpCount, dayKey, normalizeCounts, todayFor } from "../src/data/season/counts.ts";
import { GROUND } from "../src/data/floors.ts";

let n = 0;
function ok(name, fn) {
  fn();
  n++;
  console.log(`✓ ${name}`);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const builtin = JSON.parse(fs.readFileSync(path.join(here, "../src/data/season/current.json"), "utf8"));

// —— 赛季包 ——

ok("自带的赛季包读得出来，9 张图 8 种文件", () => {
  const r = parsePack(builtin);
  assert.ok("pack" in r, r.error);
  assert.equal(r.pack.types.length, 8);
  assert.equal(r.pack.maps.length, 9);
  assert.equal(r.warnings.length, 0);
});

ok("自带的赛季包：每个点都有种类、坐标有限、楼层是字符串或 null", () => {
  const { pack } = parsePack(builtin);
  const ids = new Set(pack.types.map((t) => t.id));
  let total = 0;
  for (const m of pack.maps) {
    for (const p of m.points) {
      total++;
      assert.ok(ids.has(p.type), `${m.key} 出现不认识的种类 ${p.type}`);
      assert.ok(Number.isFinite(p.x) && Number.isFinite(p.z), `${m.key} 坐标不是数`);
      assert.ok(p.floor === null || typeof p.floor === "string", `${m.key} 楼层不是字符串`);
    }
  }
  assert.equal(total, 280);
});

// 颜色：RGB → 色相（度）和相对亮度。用来量"两种颜色看着是不是一回事"。
function hue(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) return null;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

function lum(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function hueGap(a, b) {
  const d = Math.abs(hue(a) - hue(b)) % 360;
  return d > 180 ? 360 - d : d;
}

/** 两种颜色分不分得开：色相差够大，或者明暗差够大。 */
function apart(a, b) {
  if (hue(a) === null || hue(b) === null) return true;
  return hueGap(a, b) >= 50 || Math.abs(lum(a) - lum(b)) >= 0.2;
}

ok("自带的赛季包：上限按档案是 PVE 15 / PVP 25 / 赛季 40", () => {
  const { pack } = parsePack(builtin);
  assert.deepEqual(pack.limits, { Regular: 25, Pve: 15, PvpSeason: 40 });
});

ok("每种文件各有一个颜色，8 个互不相同，也不用大类的绿/红/橙黄", () => {
  const { pack } = parsePack(builtin);
  const colors = pack.types.map((t) => t.color);
  assert.equal(colors.length, 8);
  assert.equal(new Set(colors).size, 8, "有重复的颜色");
  for (const c of colors) assert.match(c, /^#[0-9a-f]{6}$/);
  // 撤离点绿、危险区红/橙黄、上锁的门橙黄：色相和明暗都贴近才算撞色
  for (const [name, c] of [["撤离点", "#3ddc84"], ["转移点", "#ff5d5d"], ["锁/危险区", "#f5a524"]]) {
    for (const t of pack.types) {
      const near = hue(t.color) !== null && hueGap(t.color, c) < 20 && Math.abs(lum(t.color) - lum(c)) < 0.12;
      assert.ok(!near, `${t.name} 的 ${t.color} 和${name}的 ${c} 撞色`);
    }
  }
});

ok("同一张图会一起刷的两种，颜色分得开", () => {
  const { pack } = parsePack(builtin);
  const byId = new Map(pack.types.map((t) => [t.id, t]));
  for (const m of pack.maps) {
    const ids = [...new Set(m.points.map((p) => p.type))];
    assert.equal(ids.length, 2, `${m.key} 期望两种文件`);
    const [a, b] = ids.map((id) => byId.get(id));
    assert.ok(apart(a.color, b.color), `${m.key}：${a.name} ${a.color} 与 ${b.name} ${b.color} 太像`);
  }
});

ok("颜色写坏了、或者包里没写，退回默认色系", () => {
  const broken = { ...builtin, types: builtin.types.map((t) => ({ ...t, color: "bluish" })) };
  const r1 = parsePack(broken);
  assert.ok("pack" in r1, r1.error);
  assert.equal(r1.pack.types[0].color, TYPE_COLORS[0]);
  const stripped = { ...builtin, types: builtin.types.map(({ color, ...t }) => t) };
  const r2 = parsePack(stripped);
  assert.deepEqual(r2.pack.types.map((t) => t.color), TYPE_COLORS);
});

ok("自带的赛季包：署名是逃离塔科夫中文Wiki", () => {
  const { pack } = parsePack(builtin);
  assert.equal(pack.source.name, "逃离塔科夫中文Wiki");
  assert.equal(pack.source.url, "https://www.eftarkov.com");
});

ok("不是赛季包 / 版本太新 / 缺署名 → 整份不用", () => {
  assert.ok("error" in parsePack({ ...builtin, format: "other" }));
  assert.ok("error" in parsePack({ ...builtin, version: 2 }));
  assert.ok("error" in parsePack({ ...builtin, source: undefined }));
  assert.ok("error" in parsePack("nope"));
  assert.ok("error" in parsePack({ ...builtin, types: [], maps: [] }));
});

ok("单个坏点位丢掉，不连累整份", () => {
  const bad = {
    ...builtin,
    maps: [
      {
        key: "customs",
        name: "海关",
        points: [
          { type: "finance", x: 1, z: 2, floor: null, desc: "好点", images: [] },
          { type: "unknown", x: 1, z: 2, floor: null, desc: "种类不认识", images: [] },
          { type: "finance", x: "3", z: 2, floor: null, desc: "坐标不是数", images: [] },
          { type: "finance", x: 1, z: 2, floor: null, desc: "少照片", images: [1, "a"] },
        ],
      },
    ],
  };
  const r = parsePack(bad);
  assert.ok("pack" in r, r.error);
  assert.equal(r.pack.maps[0].points.length, 2);
  assert.deepEqual(r.pack.maps[0].points[1].images, ["a"]);
  assert.match(r.warnings[0], /丢掉 2 个/);
});

ok("照片地址按出处的站点拼", () => {
  const { pack } = parsePack(builtin);
  assert.equal(photoUrl(pack, "/uploads/a.webp"), "https://www.eftarkov.com/uploads/a.webp");
  assert.equal(photoUrl(pack, "https://cdn/x.webp"), "https://cdn/x.webp");
});

ok("本图会刷哪几种文件 / 一种文件在哪些图刷", () => {
  const { pack } = parsePack(builtin);
  assert.deepEqual(
    typesOnMap(pack, "customs").map((t) => t.name),
    ["财务文件", "项目文件"],
  );
  assert.deepEqual(
    mapsOfType(pack, "finance").map((m) => m.name),
    ["海关", "立交桥", "塔科夫街区"],
  );
  assert.deepEqual(typesOnMap(pack, "no-such-map"), []);
});

// —— 楼层与标注 ——

const meta = {
  key: "customs",
  layers: [{ name: "2nd Floor", extents: [] }, { name: "3rd Floor", extents: [] }],
};

ok("楼层名对到层号，对不上或没有楼层就是地面", () => {
  assert.equal(layerIndexOf(meta, "2nd Floor"), 0);
  assert.equal(layerIndexOf(meta, "3rd Floor"), 1);
  assert.equal(layerIndexOf(meta, null), GROUND);
  assert.equal(layerIndexOf(meta, "4th Floor"), GROUND);
  assert.equal(layerIndexOf(null, "2nd Floor"), GROUND);
});

ok("摊成标注：层号按包里的楼层定，不再按高度算", () => {
  const { pack } = parsePack(builtin);
  const items = seasonItems(pack, meta);
  const map = pack.maps.find((m) => m.key === "customs");
  assert.equal(items.length, map.points.length);
  const cnt = { 0: 0, 1: 0, "-1": 0 };
  for (const a of items) {
    assert.equal(a.category, "season");
    // 地图上画的是文件徽章（按种类上色），物品图放在 icon 里给详情和悬停卡片用
    assert.match(a.icon, /^doc_/);
    assert.ok(a.season && typeof a.season.index === "number");
    cnt[a.layer]++;
  }
  // 海关 30 个点：地面 14、2F 12、3F 4
  assert.deepEqual(cnt, { 0: 12, 1: 4, "-1": 14 });
  assert.equal(items.length, 30);
});

ok("楼层对不上、画在地面层的点：仍记着网站写的楼层", () => {
  const { pack } = parsePack(builtin);
  const demoted = [];
  for (const m of pack.maps) {
    for (const p of m.points) {
      if (p.floorLabel) {
        // 只在这种情况下写：点位画在地面层，但网站说它在楼上
        assert.equal(p.floor, null, `${m.key} 有楼层的点不该带 floorLabel`);
        demoted.push([m.key, p.floorLabel]);
      }
    }
  }
  assert.equal(demoted.length, 27);
  const labels = new Set(demoted.map((d) => d[1]));
  assert.deepEqual([...labels].sort(), ["2F", "3F"]);
  // 灯塔没有 2F/3F 这一层，12 个点全在这里；海关 3 个（锅炉房二楼、17 号仓库）
  const per = {};
  for (const [k] of demoted) per[k] = (per[k] ?? 0) + 1;
  assert.deepEqual(per, { customs: 3, lighthouse: 12, "streets-of-tarkov": 12 });
});

ok("并进标注集：子类清单是本图会刷的几种，带数量", () => {
  const { pack } = parsePack(builtin);
  const base = { items: [], subs: {} };
  const set = withSeason(base, pack, meta);
  assert.equal(set.items.length, 30);
  assert.deepEqual(
    set.subs.season.map((s) => [s.id, s.count]),
    [
      ["finance", 15],
      ["project", 15],
    ],
  );
});

ok("子类清单带颜色；地图图标换成物品图（地图上的徽章按种类上色，物品图留给详情和悬停）", () => {
  const { pack } = parsePack(builtin);
  const set = withSeason({ items: [], subs: {} }, pack, meta);
  const byId = new Map(pack.types.map((t) => [t.id, t]));
  for (const s of set.subs.season) {
    assert.equal(s.color, byId.get(s.id).color);
    assert.equal(s.icon, `doc_${byId.get(s.id).item}`);
  }
  for (const a of set.items) {
    assert.equal(a.color, byId.get(a.season.type).color);
    assert.equal(a.icon, `doc_${byId.get(a.season.type).item}`);
  }
});

ok("没有赛季包 / 这张图不刷 → 原样返回", () => {
  const base = { items: [], subs: {} };
  assert.equal(withSeason(base, null, meta), base);
  const { pack } = parsePack(builtin);
  assert.equal(withSeason(base, pack, { key: "labyrinth", layers: [] }), base);
});

// —— 今日计数 ——

ok("日期键是本地的 YYYY-MM-DD", () => {
  assert.equal(dayKey(new Date(2026, 0, 5, 23, 59)), "2026-01-05");
});

ok("跨天归零：不是今天的计数当零", () => {
  const raw = { day: "2026-01-04", byMode: { Regular: 7 } };
  assert.deepEqual(normalizeCounts(raw, "2026-01-05"), { day: "2026-01-05", byMode: {} });
  assert.deepEqual(normalizeCounts(raw, "2026-01-04"), { day: "2026-01-04", byMode: { Regular: 7 } });
});

ok("坏掉的计数丢掉，不认识的档案保留", () => {
  const raw = { day: "2026-01-05", byMode: { Regular: -3, Pve: "x", PvpSeason: 4.6, weird: 2 } };
  assert.deepEqual(normalizeCounts(raw, "2026-01-05").byMode, { PvpSeason: 5, weird: 2 });
});

ok("加减夹在 0 和上限之间", () => {
  const c = { day: "2026-01-05", byMode: {} };
  const a = bumpCount(c, "Regular", 1, 25);
  assert.equal(a.byMode.Regular, 1);
  const b = bumpCount({ day: a.day, byMode: { Regular: 25 } }, "Regular", 1, 25);
  assert.equal(b.byMode.Regular, 25);
  const d = bumpCount({ day: a.day, byMode: {} }, "Regular", -1, 25);
  assert.equal(d.byMode.Regular ?? 0, 0);
  assert.equal(bumpCount(c, null, 2, 25).byMode.Regular, 2, "没有档案按 Regular 记");
});

ok("每个档案各算各的", () => {
  let c = { day: "2026-01-05", byMode: {} };
  c = bumpCount(c, "Pve", 3, 15);
  c = bumpCount(c, "PvpSeason", 1, 40);
  assert.deepEqual(c.byMode, { Pve: 3, PvpSeason: 1 });
  assert.deepEqual(todayFor({ Pve: 15, PvpSeason: 40 }, "Pve", c), { count: 3, limit: 15 });
  assert.deepEqual(todayFor({ Pve: 15, PvpSeason: 40 }, "PvpSeason", c), { count: 1, limit: 40 });
});

ok("没有赛季包 / 这个档案没上限 → 不显示", () => {
  const c = { day: "2026-01-05", byMode: {} };
  assert.equal(todayFor(null, "Regular", c), null);
  assert.equal(todayFor({ Pve: 15 }, "Regular", c), null);
});

console.log(`\n${n} 项全过`);
