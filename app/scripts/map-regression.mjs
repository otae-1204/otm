#!/usr/bin/env node
// 地图回归：底图样式、楼层、预设、手动换图、回放推进时来回切，
// 确认界面不塌（没有 pageerror、#root 不空），每次切完地图上都有底图和标注。
//
// 用法：
//   npm run build
//   npx vite preview --port 4179 --strictPort
//   node scripts/map-regression.mjs
//   node scripts/map-regression.mjs --url http://localhost:5173/   # 也可以打 dev server
//
// 依赖 playwright-core：在 app/ 里 npm i -D playwright-core 就能直接找到；
// 不想装进项目的话用 PW_MODULE=/path/to/playwright-core 指过去。
// 浏览器用 ~/.cache/ms-playwright 下的 chrome-headless-shell（PLAYWRIGHT_BROWSERS_PATH 可改）。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

function loadPlaywright() {
  const tries = [process.env.PW_MODULE, "playwright-core"].filter(
    (p) => typeof p === "string" && p.length > 0,
  );
  for (const p of tries) {
    try {
      return require(p);
    } catch (e) {
      if (e.code !== "MODULE_NOT_FOUND") throw e;
    }
  }
  console.error("缺 playwright-core：在 app/ 里 npm i -D playwright-core，或设 PW_MODULE=/path/to/playwright-core");
  process.exit(2);
}

function findChrome() {
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(os.homedir(), ".cache", "ms-playwright");
  if (!fs.existsSync(cache)) return null;
  const dirs = fs
    .readdirSync(cache)
    .filter((d) => d.startsWith("chromium_headless_shell-"))
    .sort()
    .reverse();
  for (const d of dirs) {
    const base = path.join(cache, d);
    for (const sub of fs.readdirSync(base)) {
      const bin = path.join(base, sub, "chrome-headless-shell");
      if (fs.existsSync(bin)) return bin;
    }
  }
  return null;
}

const args = process.argv.slice(2);
const urlArg = args.indexOf("--url");
const URL_ = urlArg >= 0 ? args[urlArg + 1] : "http://localhost:4179/";

const { chromium } = loadPlaywright();
const exe = findChrome();
if (!exe) {
  console.error("找不到 chrome-headless-shell：npx playwright install chromium-headless-shell");
  process.exit(2);
}

// —— 小工具 ——

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? "  " + detail : ""}`);
}

/** 页面上的地图状态。 */
async function snap(page) {
  return page.evaluate(() => {
    const root = document.getElementById("root");
    const box = document.querySelector(".map");
    const baseSvg = box ? box.querySelector(".leaflet-overlay-pane svg.otm-svg-base") : null;
    const groups = baseSvg ? Array.from(baseSvg.children).filter((n) => n.nodeName === "g") : [];
    const shown = groups.filter((g) => !g.classList.contains("hidden-layer"));
    const rect = baseSvg ? baseSvg.getBoundingClientRect() : null;
    // 瓦片底图的 className 挂在 GridLayer 的容器 div 上，不在每个 img 上。
    // 切换底图时旧容器可能还在 DOM 里挂一下，取最后一个（当前那个），别读成上一份。
    const layers = box ? [...box.querySelectorAll(".leaflet-tile-pane .otm-base-tile")] : [];
    const baseLayer = layers.length ? layers[layers.length - 1] : null;
    const me = box ? box.querySelector(".otm-me") : null;
    return {
      root: root ? root.children.length : 0,
      crash: !!document.querySelector(".crash"),
      status: !!document.querySelector(".status"),
      presets: !!document.querySelector(".presets"),
      svgBase: !!baseSvg,
      svgShown: shown.length,
      svgBox: rect ? `${Math.round(rect.width)}x${Math.round(rect.height)}` : null,
      baseLayer: !!baseLayer,
      baseTiles: baseLayer ? baseLayer.querySelectorAll("img.leaflet-tile").length : 0,
      baseTilesLoaded: baseLayer ? baseLayer.querySelectorAll("img.leaflet-tile-loaded").length : 0,
      annos: box ? box.querySelectorAll(".otm-anno, .otm-cluster").length : 0,
      me: me ? me.style.transform : null,
    };
  });
}

/** 等底图按样式出现：实景等瓦片加载完，矢量等 SVG 里至少有一层露出来。 */
async function waitBase(page, style) {
  if (style === "tile") {
    await page.waitForFunction(
      () =>
        document.querySelectorAll(".map .leaflet-tile-pane .otm-base-tile img.leaflet-tile-loaded").length > 0,
      null,
      { timeout: 20000 },
    );
  } else {
    await page.waitForFunction(
      () => {
        const svg = document.querySelector(".map .leaflet-overlay-pane svg.otm-svg-base");
        if (!svg) return false;
        const groups = Array.from(svg.children).filter((n) => n.nodeName === "g");
        return groups.some((g) => !g.classList.contains("hidden-layer"));
      },
      null,
      { timeout: 20000 },
    );
  }
}

/** 一次截图里看到的东西算不算「界面还好、底图对」。 */
function verdict(s, style) {
  return (
    s.root > 0 &&
    !s.crash &&
    s.status &&
    s.presets &&
    s.annos > 0 &&
    (style === "tile"
      ? s.baseTilesLoaded > 0 && !s.svgBase
      : s.svgBase && s.svgShown > 0 && s.svgBox !== "0x0" && !s.baseLayer)
  );
}

/** 切完等界面稳下来，再检查一遍。 */
async function check(page, name, style, extra = "") {
  // 回放是实时的：检查的这一刻它可能刚好进下一局、地图自己换了一张，底图图层正在重建。
  // 多等一两次再量，别把「正在换」当成「底图没出来」。
  let s = null;
  let ok = false;
  for (let attempt = 0; attempt < 3 && !ok; attempt++) {
    if (attempt > 0) await page.waitForTimeout(1500);
    try {
      if (style) await waitBase(page, style);
    } catch {
      // 底图没出来，交给下面的检查报错
    }
    await page.waitForTimeout(120);
    s = await snap(page);
    ok = verdict(s, style);
  }
  const detail =
    `base=${style === "tile" ? `tile ${s.baseTilesLoaded}/${s.baseTiles}` : `svg ${s.svgShown}组 ${s.svgBox}`}` +
    ` anno=${s.annos} root=${s.root}${s.crash ? " CRASH占位" : ""}${extra ? " " + extra : ""}`;
  record(name, ok, detail);
  return s;
}

/** 上游缺瓦片的地方（地图外沿那一列）要垫上底色并裁到图幅边缘，不能露出页面底色。 */
async function checkGapFill(page) {
  const sel = ".map .leaflet-tile-pane .otm-base-tile img.leaflet-tile";
  let seen = true;
  try {
    await page.waitForFunction(
      (q) => Array.from(document.querySelectorAll(q)).some((t) => t.style.backgroundColor),
      sel,
      { timeout: 15000 },
    );
  } catch {
    seen = false;
  }
  const s = await page.evaluate((q) => {
    const tiles = Array.from(document.querySelectorAll(q));
    const filled = tiles.filter((t) => t.style.backgroundColor);
    return {
      filled: filled.length,
      clipped: filled.filter((t) => !!t.style.clipPath && t.style.clipPath !== "none").length,
      color: filled[0] ? getComputedStyle(filled[0]).backgroundColor : null,
    };
  }, sel);
  record("缺瓦片处垫底色", seen && s.filled > 0 && s.clipped === s.filled, `垫了 ${s.filled} 张、裁边 ${s.clipped} 张 ${s.color ?? ""}`);
}

/** 赛季文件：筛选行、地图图标、详情抽屉、今日计数（6.7.1）。 */
async function checkSeason(page) {
  const row = await page.evaluate(() => {
    const r = [...document.querySelectorAll(".frow")].find((x) => x.textContent.includes("赛季文件"));
    if (!r) return null;
    return {
      n: Number((r.querySelector(".n")?.textContent ?? "0").trim()),
      off: r.className.includes("off"),
      subs: [...document.querySelectorAll(".subs2 .sc")].map((s) => s.textContent.trim()),
    };
  });
  record(
    "筛选里有「赛季文件」一行",
    !!row && row.n > 0 && !row.off && row.subs.length > 0,
    row ? `${row.n} 个、子类 ${row.subs.join(" / ")}` : "没有这一行",
  );

  // 地图徽章＝物品图 + 种类色边框（主审 #344）：同图几种颜色要不同，边框色要等于筛选标签的颜色
  const badges = await page.evaluate(() => {
    const els = [...document.querySelectorAll(".otm-doc")];
    const chips = [...document.querySelectorAll(".subs2 .sc")];
    const hexRgb = (c) => {
      const m = c.trim().match(/^#?([0-9a-f]{6})$/i);
      if (!m) return c.trim();
      const n = parseInt(m[1], 16);
      return `rgb(${n >> 16}, ${(n >> 8) & 255}, ${n & 255})`;
    };
    const varOf = (el) => getComputedStyle(el).getPropertyValue("--c").trim().toLowerCase();
    return {
      count: els.length,
      colors: [...new Set(els.map(varOf))],
      borders: [...new Set(els.map((d) => getComputedStyle(d).borderTopColor))],
      min: Math.min(...els.map((d) => Math.round(d.getBoundingClientRect().height))),
      radius: [...new Set(els.map((d) => getComputedStyle(d).borderRadius))],
      imgs: els.filter((d) => d.querySelector("img")).length,
      imgOk: els.filter((d) => (d.querySelector("img")?.naturalWidth ?? 0) > 0).length,
      chips: [...new Set(chips.map(varOf))],
      chipRgb: [...new Set(chips.map((c) => hexRgb(varOf(c))))],
      chipCount: chips.length,
      chipImgs: chips.filter((c) => (c.querySelector("img.si")?.naturalWidth ?? 0) > 0).length,
      aside: [...document.querySelectorAll(".otm-anno img")].filter((i) => i.src.includes("season.png")).length,
    };
  });
  record(
    "地图徽章按种类上色",
    badges.count > 0 && badges.colors.length >= 2 && badges.aside === 0,
    `${badges.count} 个、颜色 ${badges.colors.join(" ")}`,
  );
  record(
    "徽章里是物品图，图片真的画出来了",
    badges.count > 0 && badges.imgs === badges.count && badges.imgOk === badges.count,
    `${badges.count} 个徽章、带图 ${badges.imgs} 个、图有内容 ${badges.imgOk} 个`,
  );
  record(
    "徽章的边框颜色跟子类标签一致",
    badges.borders.length > 0 && badges.borders.every((b) => badges.chipRgb.includes(b)),
    `边框 ${badges.borders.join(" ")} ／ 标签 ${badges.chipRgb.join(" ")}`,
  );
  record(
    "徽章最小 28px、圆角 8px",
    badges.min >= 28 && badges.radius.every((r) => Math.round(parseFloat(r)) === 8),
    `最小 ${badges.min}px、圆角 ${badges.radius.join(" ")}`,
  );
  record(
    "筛选的赛季子类标签前有 14px 物品图",
    badges.chipCount > 0 && badges.chipImgs === badges.chipCount,
    `${badges.chipCount} 个标签、带图 ${badges.chipImgs} 个`,
  );

  // 点开一个刷新点 → 右侧详情只讲这一个点（主审 #282）：标题、照片、描述、楼层、距离、今日、署名
  const openPoint = async (key) => {
    await page.evaluate((k) => {
      document.querySelector(`[data-k="${k}"]`)?.closest(".leaflet-marker-icon")?.click();
    }, key);
    await page.waitForSelector(".drawer.dpane", { timeout: 8000 });
    await page
      .waitForFunction(
        () => [...document.querySelectorAll(".drawer .dphoto img")].some((i) => i.naturalWidth > 0),
        null,
        { timeout: 8000 },
      )
      .catch(() => {});
  };
  // 距离要有：先等自己的箭头出现（回放里有定位），否则这一页不显示距离
  await page.waitForSelector(".otm-me", { timeout: 30000 }).catch(() => {});
  const readDrawer = () =>
    page.evaluate(() => {
      const d = document.querySelector(".drawer.dpane");
      if (!d) return null;
      const icon = d.querySelector("img.ditem");
      return {
        type: d.querySelector(".dtt")?.textContent?.trim() ?? "",
        desc: d.querySelector(".ddesc")?.textContent?.trim() ?? "",
        floor: d.querySelector(".dmeta .fc")?.textContent?.trim() ?? "",
        dist: d.querySelector(".dmeta .dpm")?.textContent?.trim() ?? "",
        today: d.querySelector(".dtoday")?.textContent?.replace(/\s+/g, " ").trim() ?? null,
        photo: [...d.querySelectorAll(".dphoto img")].some((i) => i.naturalWidth > 0),
        credit: d.querySelector(".src")?.textContent?.trim() ?? "",
        // 列表、刷新地图的标签都不该再有
        list: d.querySelectorAll(".dplist, .dp, .dsec, .mc").length,
        iconLoaded: !!icon && icon.naturalWidth > 0,
        iconSrc: icon?.getAttribute("src") ?? "",
      };
    });

  await openPoint("se-customs-4");
  const one = await readDrawer();
  record(
    "详情只显示点开的这一个点",
    !!one &&
      one.list === 0 &&
      one.desc.includes("锅炉房二楼") &&
      /^\d+m$/.test(one.dist) &&
      one.photo &&
      one.today !== null &&
      one.credit.includes("逃离塔科夫中文Wiki"),
    one ? `${one.type}｜${one.desc.slice(0, 12)}…｜${one.floor}｜${one.dist}｜今日 ${one.today}` : "没有抽屉",
  );
  // 楼层对不上、画在地面层的点：这里仍显示网站写的楼层
  record("楼层对不上的点仍显示原楼层", one?.floor === "2F", one ? `锅炉房二楼 → ${one.floor}` : "没有抽屉");
  // 标题左边的物品图：实机里这里是空的，现在改成打包进程序的资源（assets/），并检查真的画出来了
  const inlined = /^data:image\/png;base64,/.test(one?.iconSrc ?? "");
  record(
    "标题的物品图画出来了",
    !!one && one.iconLoaded && (inlined || /assets\/.*\.png/.test(one.iconSrc)),
    one ? `${inlined ? "打包内联的 data URI" : one.iconSrc.split("/").pop()}、naturalWidth ${one.iconLoaded ? ">0" : "=0"}` : "没有图",
  );

  // 换一个点就是换一页：种类、描述都跟着变
  await openPoint("se-customs-16");
  const two = await readDrawer();
  record(
    "换一个刷新点就换一页",
    !!two && two.type === "项目文件" && two.desc.includes("老加油站撤离点房间里") && !two.desc.includes("锅炉房"),
    two ? `${two.type}｜${two.desc.slice(0, 12)}…` : "没有抽屉",
  );

  // 今日 +1，状态栏跟着变；刷新页面后还在（存在本地，跨天归零另有单元测试）
  const before = await page.evaluate(() => document.querySelector(".status .seas")?.textContent?.replace(/\s+/g, " ").trim() ?? null);
  await page.evaluate(() => document.querySelectorAll(".cnt2 button")[1]?.click());
  await page.waitForTimeout(200);
  const after = await page.evaluate(() => document.querySelector(".status .seas")?.textContent?.replace(/\s+/g, " ").trim() ?? null);
  const num = (t) => Number((t ?? "").match(/(\d+)\s*\//)?.[1] ?? NaN);
  record("今日计数 +1 后状态栏跟着变", num(after) === num(before) + 1, `${before} → ${after}`);

  const mode = await page.evaluate(() => (document.querySelector(".status")?.textContent?.includes("赛季") ? "赛季" : null));
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector(".status .seas", { timeout: 30000 });
  // 计数按档案分开记：等回放到同一个档案再看这个档案的数字
  if (mode) {
    await page
      .waitForFunction(() => document.querySelector(".status")?.textContent?.includes("赛季"), null, { timeout: 30000 })
      .catch(() => {});
  }
  const kept = await page.evaluate(() => document.querySelector(".status .seas")?.textContent?.replace(/\s+/g, " ").trim() ?? null);
  const stored = await page.evaluate(() => localStorage.getItem("otm.season.count"));
  record(
    "刷新页面后今日计数还在",
    num(kept) === num(after),
    `重新打开是 ${kept}${stored ? "（存的 " + stored + "）" : ""}`,
  );

  // 状态栏的计数点开也是详情：把刚才 +1 的还回去
  await page.evaluate(() => document.querySelector(".status .seas")?.click());
  await page.waitForSelector(".drawer", { timeout: 8000 }).catch(() => {});
  await page.evaluate(() => document.querySelectorAll(".cnt2 button")[0]?.click());
  await page.waitForTimeout(150);
  await page.evaluate(() => document.querySelector(".dback")?.click());
}

/** 楼层条的现状：「全部」按钮、分隔线、各层名字、当前筛出来的标注数。 */
async function floorsBar(page) {
  return page.evaluate(() => {
    const el = document.querySelector(".floors");
    if (!el) return null;
    const kids = [...el.children];
    const all = kids.find((k) => k.classList.contains("all"));
    const onFloor = kids.find((k) => k.tagName === "BUTTON" && !k.classList.contains("all") && k.classList.contains("on"));
    return {
      firstAll: !!kids[0]?.classList.contains("all"),
      firstText: kids[0]?.textContent?.trim() ?? "",
      sep: kids[1]?.className ?? "",
      labels: kids.filter((k) => k.tagName === "BUTTON" && !k.classList.contains("all")).map((b) => b.textContent.trim()),
      all: el.dataset.all === "1",
      count: Number(el.dataset.anno ?? -1),
      allOn: !!all?.classList.contains("on"),
      allBg: all ? getComputedStyle(all).backgroundColor : "",
      floorOn: onFloor ? onFloor.textContent.trim() : null,
      floorBg: onFloor ? getComputedStyle(onFloor).backgroundColor : "",
    };
  });
}

/**
 * 楼层条上的「全部」（主审 #341、v3-floors-all.png）：
 * 选它时所有楼层的标注都画出来、不在地面的带楼层标签，底图还是地面层，
 * 选择记进偏好，点某一层就回到单层；小地图不跟着变。
 */
async function checkFloorsAll(page) {
  const b0 = await floorsBar(page);
  record(
    "楼层条最上面是「全部」，下面一条分隔线",
    !!b0 && b0.firstAll && b0.firstText === "全部" && b0.sep.split(/\s+/).includes("flsep") && b0.labels.length >= 2,
    b0 ? `全部 ｜ ${b0.labels.join(" ")}` : "没有楼层条",
  );
  if (!b0) return;

  // 逐层量一遍标注数，加起来跟「全部」比
  const per = {};
  for (const label of b0.labels) {
    await clickFloor(page, label);
    await page.waitForTimeout(120);
    per[label] = (await floorsBar(page)).count;
  }
  const sum = Object.values(per).reduce((a, b) => a + b, 0);
  const perText = Object.entries(per)
    .map(([k, v]) => `${k} ${v}`)
    .join(" + ");

  await page.locator(".floors .fl.all").click();
  await page.waitForTimeout(250);
  const bAll = await floorsBar(page);
  record("选「全部」后标注数等于各层之和", bAll.all && bAll.count === sum, `${bAll.count} = ${perText}`);
  const base = await page.evaluate(() => {
    const svg = document.querySelector(".map svg.otm-svg-base");
    const shown = svg ? [...svg.children].filter((g) => g.nodeName === "g" && !g.classList.contains("hidden-layer")) : [];
    return { shown: shown.length, ids: shown.map((g) => g.id) };
  });
  record("「全部」时底图仍然只画地面层", base.shown === 1 && /ground/i.test(base.ids[0] ?? ""), `${base.ids.join(" ") || "没露出组"}`);

  // 单个标注的楼层标签：楼层的带、地面层不带、合并标注不带
  const tags = await page.evaluate(() => {
    const list = [];
    for (const el of document.querySelectorAll(".map .otm-anno")) {
      const holder = el.querySelector("[data-l]");
      if (!holder) {
        list.push({ l: null, tag: null });
        continue;
      }
      list.push({ l: Number(holder.getAttribute("data-l")), tag: el.querySelector(".ft")?.textContent?.trim() || null });
    }
    return { list, clusterTags: document.querySelectorAll(".map .otm-cluster .ft").length };
  });
  const up = tags.list.filter((t) => t.l !== null && t.l >= 0);
  const ground = tags.list.filter((t) => t.l === -1);
  record(
    "不在地面层的单个标注右上角带楼层标签",
    up.length > 0 && up.every((t) => !!t.tag),
    `${up.length} 个楼层标注、带标签 ${up.filter((t) => t.tag).length} 个（${[...new Set(up.map((t) => t.tag))].join(" ")}）`,
  );
  record("地面层的标注不带标签", ground.length > 0 && ground.every((t) => !t.tag), `${ground.length} 个地面标注`);
  record("标签写的就是楼层条上的名字", up.every((t) => b0.labels.includes(t.tag)), [...new Set(up.map((t) => t.tag))].join(" "));
  record("2F 的标注带「2F」", up.some((t) => t.tag === "2F"), [...new Set(up.map((t) => t.tag))].join(" "));
  record("合并标注本身不带楼层标签", tags.clusterTags === 0, `合并点里的标签 ${tags.clusterTags} 个`);

  // 合并标注的悬停明细：每一行带楼层。地面那一堆本来就没有楼层，所以多试几个，
  // 收集全部行，要求有风的都写着楼层条上的名字、并且确实有带楼层的行
  const seenRows = [];
  let found = 0;
  for (let i = 0; i < 12 && found === 0; i++) {
    const box = await page.evaluate((idx) => {
      const el = document.querySelectorAll(".map .otm-cluster")[idx];
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }, i);
    if (!box) break;
    await page.mouse.move(box.x, box.y);
    await page.waitForTimeout(160);
    const rows = await page.evaluate(() => {
      const card = document.querySelector(".ccluster");
      if (!card) return null;
      return [...card.querySelectorAll(".crow")].map((r) => ({
        name: r.querySelector("span")?.textContent?.trim() ?? "",
        floor: r.querySelector(".ctag")?.textContent?.trim() ?? null,
      }));
    });
    if (!rows) continue;
    seenRows.push(...rows);
    found = rows.filter((r) => r.floor).length;
  }
  const tagged = seenRows.filter((r) => r.floor);
  record(
    "合并标注的悬停明细每行带楼层",
    tagged.length > 0 && tagged.every((r) => r.floor.split("·").every((f) => b0.labels.includes(f))),
    `${seenRows.length} 行，带楼层的 ${tagged.length} 行（${[...new Set(tagged.map((r) => r.floor))].join(" ")}）`,
  );
  await page.mouse.move(8, 8);

  // 点某一层：退出「全部」，回到单层
  await clickFloor(page, "2F");
  await page.waitForTimeout(180);
  const b2 = await floorsBar(page);
  const left = await page.evaluate(() => ({
    tags: document.querySelectorAll(".map .ft").length,
    layerCls: document.querySelectorAll(".map .otm-anno[class*='otm-l']").length,
  }));
  record(
    "点 2F 就回到单层",
    !b2.all && b2.count === per["2F"] && left.tags === 0 && left.layerCls === 0,
    `${b2.count} 个、标签 ${left.tags} 个、存的是 ${await page.evaluate(() => JSON.parse(localStorage.getItem("otm.prefs") || "{}").floorAll)}`,
  );
  record("「全部」和选中的楼层是同一种黄底", !!bAll.allBg && bAll.allBg === b2.floorBg, `${bAll.allBg} / ${b2.floorBg}`);

  // 换局也保持：重新打开页面还是「全部」
  await page.locator(".floors .fl.all").click();
  await page.waitForTimeout(200);
  await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForFunction(() => document.querySelectorAll(".map .otm-anno, .map .otm-cluster").length > 0, null, {
    timeout: 60000,
  });
  const bR = await floorsBar(page);
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("otm.prefs") || "{}").floorAll);
  record(
    "刷新页面后「全部」仍然保持",
    bR.all && bR.allOn && bR.count === bAll.count && stored === true,
    `全部=${bR.all}、${bR.count} 个、存的 ${stored}`,
  );

  // 小地图不跟着「全部」走：只画自己所在那一层，不带楼层标签
  const miniCtx = await browser.newContext({
    storageState: await page.context().storageState(),
    viewport: { width: 420, height: 420 },
  });
  // 小地图那一页用一份最小的假事件：立刻进图、一张二层截图，不等真的回放走到那一步
  let miniHits = 0;
  await miniCtx.route("**/mock-events.jsonl", (route) => {
    miniHits++;
    return route.fulfill({ status: 200, contentType: "application/jsonl", body: MINI_LOG });
  });
  const mini = await miniCtx.newPage();
  const miniErrors = [];
  mini.on("pageerror", (e) => miniErrors.push(String(e).split("\n")[0]));
  await mini.goto(`${URL_}?view=mini`, { waitUntil: "domcontentloaded", timeout: 60000 });
  // 数据是页面起来之后才拉的，主窗口那边同时在拉，等它真画出来
  let m = { tags: 0, layerCls: 0, n: 0, floorText: [] };
  for (let i = 0; i < 60; i++) {
    await mini.waitForTimeout(1000);
    m = await mini.evaluate(() => ({
      tags: document.querySelectorAll(".mini .ft").length,
      layerCls: document.querySelectorAll(".mini .otm-anno[class*='otm-l']").length,
      n: document.querySelectorAll(".mini .otm-anno, .mini .otm-cluster").length,
      floorText: [...document.querySelectorAll(".mini-tag")].map((n) => n.textContent.trim()),
    }));
    if (m.n > 0 && m.floorText.length > 0) break;
  }
  record(
    "小地图不跟随「全部」（还是自己那一层）",
    m.n > 0 &&
      m.tags === 0 &&
      m.layerCls === 0 &&
      m.floorText.some((t) => b0.labels.includes(t)) &&
      !m.floorText.includes("全部"),
    `画了 ${m.n} 个、标签 ${m.tags} 个、带层号 ${m.layerCls} 个、文字 ${m.floorText.join(" / ") || "无"}` +
      (miniErrors.length ? `、报错 ${miniErrors[0]}` : "") +
      `、拦截 ${miniHits} 次`,
  );
  await miniCtx.close();

  // 收起「全部」，后面几项还按单层看
  await clickFloor(page, "地面");
  await page.waitForTimeout(120);
}

async function clickSeg(page, label) {
  await page.locator(".seg span", { hasText: new RegExp(`^${label}$`) }).first().click();
}

async function clickFloor(page, label) {
  await page.locator(".floors .fl", { hasText: new RegExp(`^${label}$`) }).first().click();
}

async function clickPreset(page, label) {
  await page.locator(".presets .chip", { hasText: new RegExp(`^${label}$`) }).first().click();
}

async function pickMap(page, label) {
  await page.locator(".status .mapbtn").click();
  await page.locator(".maplist span", { hasText: new RegExp(`^${label}$`) }).first().click();
}

/** 等自己那个箭头动一下，证明回放的定位在推进。 */
async function waitMeMove(page, from, timeout = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const s = await snap(page);
    if (s.me && s.me !== from) return s.me;
    await page.waitForTimeout(250);
  }
  return null;
}

/** 小地图那一页的假事件：进图、开打、一张二层截图（和 mini-regression 里同一套格式）。 */
const MINI_LOG = (() => {
  const t0 = Date.parse("2026-11-19T12:00:00.000+01:00");
  const at = (ms) => new Date(t0 + ms).toISOString();
  return [
    {
      ms: 0,
      ev: { type: "paths", game_dir: "X:/EFT", screenshot_dir: "X:/EFT/Screenshots", log_dir: "X:/EFT/Logs/x" },
    },
    { ms: 50, ev: { type: "raid_loading", map: "bigmap" } },
    { ms: 100, ev: { type: "raid_started", map: "bigmap", scav: false, raid_mode: "Online" } },
    { ms: 300, ev: { type: "position", x: 199.0, y: 3.2, z: 148.0, yaw: 206.57, source: "screenshot" } },
  ]
    .map(({ ms, ev }) => JSON.stringify({ ...ev, time: at(ms) }))
    .join("\n");
})();

// —— 跑一遍 ——

const browser = await chromium.launch({ executablePath: exe, args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const pageErrors = [];
const consoleErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e.stack || e).split("\n").slice(0, 3).join(" | ")));
page.on("console", (m) => {
  if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200));
});

let failed = false;
let n = 0;
try {
  // 不用 networkidle：数据是页面起来之后才拉的，等标注出来更可靠
  await page.goto(URL_, { waitUntil: "domcontentloaded", timeout: 60000 });
  // 等数据到位：标注画出来、底图挂上
  await page.waitForFunction(
    () => document.querySelectorAll(".map .otm-anno, .map .otm-cluster").length > 0,
    null,
    { timeout: 60000 },
  );
  await check(page, "初始（矢量）", "svg");
  await checkSeason(page);
  await check(page, "看完赛季详情后（矢量）", "svg");
  await checkFloorsAll(page);
  await check(page, "看完「全部」楼层后（矢量）", "svg");

  // 1—6：矢量 / 实景来回切，中间夹着楼层、预设、手动换图
  const trip = async (style) => {
    const label = style === "tile" ? "实景" : "矢量";
    await clickSeg(page, label);
    n++;
    return check(page, `${label} #${n}`, style);
  };

  await trip("tile");
  await checkGapFill(page);
  await trip("svg");

  await trip("tile");
  await clickFloor(page, "2F");
  await check(page, "实景 #2 切到 2F", "tile");
  await trip("svg");
  await clickFloor(page, "地面");
  await check(page, "矢量 #2 切回地面", "svg");

  await trip("tile");
  await clickPreset(page, "跑刀");
  await check(page, "实景 #3 切到跑刀", "tile");
  await trip("svg");
  await clickPreset(page, "做任务");
  await check(page, "矢量 #3 切回做任务", "svg");

  await trip("tile");
  await trip("svg");

  // 手动换一张图，再切底图
  await pickMap(page, "森林");
  await check(page, "换图 森林（矢量）", "svg");
  await trip("tile");
  await trip("svg");
  await pickMap(page, "自动");
  await check(page, "换回 自动（矢量）", "svg");

  // 另一张图 + 楼层 + 底图
  await trip("tile");
  await pickMap(page, "立交桥");
  await check(page, "换图 立交桥（实景）", "tile");
  await trip("svg");
  await clickFloor(page, "2F");
  await check(page, "矢量 #6 切到 2F", "svg");
  await trip("tile");
  await pickMap(page, "自动");
  await check(page, "换回 自动（实景）", "tile");

  // 回放推进定位的过程中切换：重放 → 等箭头出现 → 边切边看它动
  await page.locator('.tools button[title="重放假数据"]').click();
  await page.waitForFunction(() => !!document.querySelector(".map .otm-me"), null, { timeout: 30000 });
  const before = (await snap(page)).me;
  await trip("svg");
  await trip("tile");
  const moved = await waitMeMove(page, before);
  record("回放推进时切换后定位仍在走", moved !== null, moved ? `箭头 ${before} → ${moved}` : "箭头没动");
  await check(page, "回放推进后（实景）", "tile");
} catch (e) {
  failed = true;
  record("脚本执行", false, String(e).split("\n")[0]);
  await page.screenshot({ path: path.join(os.tmpdir(), "otm-map-regression-fail.png") }).catch(() => {});
} finally {
  await browser.close();
}

record("全程没有 pageerror", pageErrors.length === 0, pageErrors.slice(0, 3).join(" || "));
if (consoleErrors.length > 0) {
  console.log(`（console.error ${consoleErrors.length} 条，前 3 条）\n  ` + consoleErrors.slice(0, 3).join("\n  "));
}

const bad = results.filter((r) => !r.ok);
console.log(
  `\n共 ${results.length} 项检查，失败 ${bad.length}；pageerror ${pageErrors.length}；` +
    `底图切换 ${n} 次（${Math.ceil(n / 2)} 个来回）`,
);
process.exit(bad.length === 0 && !failed ? 0 : 1);
