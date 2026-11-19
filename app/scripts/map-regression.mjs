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
    // 瓦片底图的 className 挂在 GridLayer 的容器 div 上，不在每个 img 上
    const baseLayer = box ? box.querySelector(".leaflet-tile-pane .otm-base-tile") : null;
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

/** 切完等界面稳下来，再检查一遍。 */
async function check(page, name, style, extra = "") {
  try {
    if (style) await waitBase(page, style);
  } catch {
    // 底图没出来，交给下面的检查报错
  }
  await page.waitForTimeout(120);
  const s = await snap(page);
  const ok =
    s.root > 0 &&
    !s.crash &&
    s.status &&
    s.presets &&
    s.annos > 0 &&
    (style === "tile"
      ? s.baseTilesLoaded > 0 && !s.svgBase
      : s.svgBase && s.svgShown > 0 && s.svgBox !== "0x0" && !s.baseLayer);
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

  // 地图上是文件形状的徽章，按种类上色：同一张图里几种必须颜色不同，且和子类标签一致
  const badges = await page.evaluate(() => {
    const colors = [...document.querySelectorAll(".otm-doc")].map((d) =>
      getComputedStyle(d).getPropertyValue("--c").trim().toLowerCase(),
    );
    const boxes = [...document.querySelectorAll(".otm-doc")].map((d) => Math.round(d.getBoundingClientRect().height));
    const chips = [...document.querySelectorAll(".subs2 .sc")].map((s) =>
      getComputedStyle(s).getPropertyValue("--c").trim().toLowerCase(),
    );
    const aside = [...document.querySelectorAll(".otm-anno img")].filter((i) => i.src.includes("season.png")).length;
    return { count: colors.length, colors: [...new Set(colors)], min: Math.min(...boxes), chips, aside };
  });
  record(
    "地图上是按种类上色的文件徽章",
    badges.count > 0 && badges.colors.length >= 2 && badges.aside === 0,
    `${badges.count} 个、颜色 ${badges.colors.join(" ")}、最小 ${badges.min}px`,
  );
  record(
    "子类标签的颜色跟地图上的徽章一致",
    badges.chips.length === badges.colors.length && badges.chips.every((c) => badges.colors.includes(c)),
    `标签 ${badges.chips.join(" ")}`,
  );

  // 点一个徽章 → 右侧详情
  await page.evaluate(() => {
    document.querySelector(".otm-doc")?.closest(".leaflet-marker-icon")?.click();
  });
  await page.waitForSelector(".drawer", { timeout: 8000 }).catch(() => {});
  await page
    .waitForFunction(
      () => [...document.querySelectorAll(".drawer .phb img")].some((i) => i.naturalWidth > 0),
      null,
      { timeout: 8000 },
    )
    .catch(() => {});
  const drawer = await page.evaluate(() => {
    const d = document.querySelector(".drawer");
    if (!d) return null;
    return {
      rows: d.querySelectorAll(".dp").length,
      chips: [...d.querySelectorAll(".mc")].length,
      today: d.querySelector(".dtoday")?.textContent?.replace(/\s+/g, " ").trim() ?? null,
      photo: [...d.querySelectorAll(".phb img")].some((i) => i.naturalWidth > 0),
      credit: d.querySelector(".src")?.textContent?.trim() ?? "",
    };
  });
  // 楼层对不上、画在地面层的点：详情里仍显示网站写的楼层
  const floors = await page.evaluate(() =>
    [...document.querySelectorAll(".drawer .dp")].map((d) => ({
      desc: d.querySelector(".dpd")?.textContent ?? "",
      floor: d.querySelector(".fc")?.textContent?.trim() ?? "",
    })),
  );
  const boiler = floors.find((f) => f.desc.includes("锅炉房二楼"));
  record(
    "楼层对不上的点仍显示原楼层",
    !!boiler && boiler.floor === "2F",
    boiler ? `${boiler.desc.slice(0, 12)}… → ${boiler.floor}` : "没找到那条",
  );

  record(
    "点开赛季文件是详情",
    !!drawer && drawer.rows > 0 && drawer.chips > 0 && drawer.today !== null && drawer.credit.includes("逃离塔科夫中文Wiki"),
    drawer ? `刷新点 ${drawer.rows}、地图 ${drawer.chips}、今日 ${drawer.today}、照片${drawer.photo ? "已" : "未"}加载` : "没有抽屉",
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
