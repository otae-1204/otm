#!/usr/bin/env node
// 叠加层小地图的回归检查（DESIGN 7.5 小地图、7.8 状态，效果图 v2-mini / v2-expand / v2-mini-detail）。
//
// 用法：
//   npm run build
//   npx vite preview --port 4179 --strictPort
//   PW_MODULE=/path/to/playwright-core node scripts/mini-regression.mjs
//
// 外壳用 `?view=mini` 打开叠加层那个窗口，这里照同样的尺寸（420×420 是默认边长）在
// 浏览器里打开它，用自己造的假事件（截胡 mock-events.jsonl）一个一个状态过：
// 能渲染、地图跟着朝向转、自己在正中间、楼层和预设名对、进图还没截图时是相机、
// 位置过时变黄带计时、对局外先画后收（空框、上一局那张图）、详情卡片、按住展开的大地图、圆形；
// 最后开两个页面，确认主窗口改预设小地图跟着变。
//
// 浏览器里验不了的：窗口透明、鼠标穿透、置顶、不在任务栏、不抢焦点、全局热键——
// 这些只有 Windows 实机才说得清，见 shell/src-tauri/src/overlay.rs。
//
// 截图写到 screenshots/，文件名以 30 开头（前面的是主窗口和赛季的）。

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
const BASE = (urlArg >= 0 ? args[urlArg + 1] : "http://localhost:4179/").replace(/\/$/, "");

const { chromium } = loadPlaywright();
const exe = findChrome();
if (!exe) {
  console.error("找不到 chrome-headless-shell：npx playwright install chromium-headless-shell");
  process.exit(2);
}

const SHOTS = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "screenshots");
fs.mkdirSync(SHOTS, { recursive: true });

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? "  " + detail : ""}`);
}

// —— 假事件 ——

const T0 = Date.parse("2026-11-19T12:00:00.000+01:00");
const at = (ms) => new Date(T0 + ms).toISOString();
const jsonl = (events) => events.map(({ ms, ev }) => JSON.stringify({ ...ev, time: at(ms) })).join("\n");

const PATHS = {
  type: "paths",
  game_dir: "X:/EFT",
  screenshot_dir: "X:/EFT/Screenshots",
  log_dir: "X:/EFT/Logs/x",
};

/** 海关宿舍 2F：x/z 落在宿舍楼里，y=3.2 是二层，yaw 206.57 对着走廊那头。 */
const ON_2F = { type: "position", x: 199.0, y: 3.2, z: 148.0, yaw: 206.57, source: "screenshot" };

/** 进图、开打、一张截图，然后不再有事件（对局一直在打）。 */
function raidEvents({ shotAt = 300, shot = ON_2F, end } = {}) {
  const list = [
    { ms: 0, ev: PATHS },
    { ms: 50, ev: { type: "raid_loading", map: "bigmap" } },
    { ms: 100, ev: { type: "raid_started", map: "bigmap", scav: false, raid_mode: "Online" } },
  ];
  if (shot) list.push({ ms: shotAt, ev: shot });
  if (typeof end === "number") list.push({ ms: end, ev: { type: "raid_ended" } });
  return list;
}

// —— 偏好 ——

const HOTKEYS = { show: "F6", expand: "CapsLock", preset: "F5", detail: "F7", adjust: "F8" };

function prefsWith(overlay = {}, rest = {}) {
  return {
    v: 5,
    // 空数组 → 用内置的两个预设（做任务、跑刀）
    presets: [],
    activePresetId: "",
    overrides: {},
    subOverrides: {},
    manualMap: null,
    baseStyle: "svg",
    tileBrightness: 1,
    staleSeconds: 60,
    mockSpeed: 1,
    clusterIcon: "count",
    overlay: {
      enabled: true,
      shape: "square",
      heading: "follow",
      hideOutside: true,
      rangeMeters: 150,
      opacity: 0.92,
      size: 420,
      hotkeys: HOTKEYS,
      ...overlay,
    },
    ...rest,
  };
}

// —— 打开页面 ——

/** 叠加层那个窗口的尺寸就是边长；主窗口那个页面才用 1600×900。 */
const MINI = { width: 420, height: 420 };
const EXPAND = { width: 1320, height: 825 };
const MAIN = { width: 1600, height: 900 };

async function open(browser, { prefs, events, viewport = MINI, query = "" }) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 2 });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e.stack || e).split("\n")[0]));
  // 只种一次：同一页 reload 时保留页面里改过的偏好
  await page.addInitScript((p) => {
    if (sessionStorage.getItem("otm.seeded")) return;
    localStorage.setItem("otm.prefs", JSON.stringify(p));
    sessionStorage.setItem("otm.seeded", "1");
  }, prefs);
  await page.route("**/mock-events.jsonl", (route) =>
    route.fulfill({ status: 200, contentType: "application/jsonl", body: jsonl(events) }),
  );
  await page.goto(`${BASE}/?view=mini${query}`, { waitUntil: "domcontentloaded", timeout: 60000 });
  // 截图用：浏览器里没有游戏在后面，铺一层深色底（实机是透明窗口盖在游戏上）
  await page.addStyleTag({
    content: "body.mini-window{background:linear-gradient(160deg,#2d333b,#181c21) !important}",
  });
  return { page, context, errors };
}

/** 等小地图铺开：地图有了、标注画出来了。 */
async function waitMini(page) {
  await page.waitForFunction(
    () =>
      document.querySelector(".mini .map") &&
      document.querySelectorAll(".mini .otm-anno, .mini .otm-cluster").length > 0,
    null,
    { timeout: 60000 },
  );
}

async function snapMini(page) {
  return page.evaluate(() => {
    const rect = (n) => (n ? n.getBoundingClientRect() : null);
    const frame = document.querySelector(".mini");
    const box = document.querySelector(".mini-mapbox");
    const me = document.querySelector(".mini .otm-me");
    const cone = me?.querySelector(".cone");
    const fr = rect(frame);
    const mr = rect(me);
    const card = document.querySelector(".minicard");
    const cr = rect(card);
    const style = frame ? getComputedStyle(frame) : null;
    return {
      viewport: { w: innerWidth, h: innerHeight },
      frame: fr ? { w: Math.round(fr.width), h: Math.round(fr.height), r: style.borderTopLeftRadius } : null,
      rot: box ? Number(box.getAttribute("data-rot")) : null,
      cone: cone ? parseFloat(getComputedStyle(cone).rotate) : null,
      me: mr ? { x: Math.round(mr.left + mr.width / 2), y: Math.round(mr.top + mr.height / 2) } : null,
      stale: !!me?.classList.contains("stale"),
      staleTag: document.querySelector(".mini-stale")?.textContent ?? null,
      camera: !!document.querySelector(".mini-center"),
      tags: [...document.querySelectorAll(".mini-tag")].map((n) => n.textContent),
      annos: document.querySelectorAll(".mini .otm-anno, .mini .otm-cluster").length,
      main: !!document.querySelector(".status") || !!document.querySelector(".presets"),
      big: !!document.querySelector(".mini-root.big"),
      card: cr
        ? {
            top: Math.round(cr.top),
            h: Math.round(cr.height),
            frameBottom: Math.round(fr.bottom),
            title: card.querySelector(".mct")?.textContent ?? "",
            dist: card.querySelector(".mct b")?.textContent ?? "",
            floor: card.querySelector(".fc")?.textContent ?? "",
            img: !!card.querySelector(".mcp img"),
            ph: !!card.querySelector(".mcp"),
          }
        : null,
    };
  });
}

/** 圆形小地图：两个标签的中心要在圆内，不然会被圆角裁掉。 */
async function tagInsideCircle(page) {
  return page.evaluate(() => {
    const f = document.querySelector(".mini")?.getBoundingClientRect();
    if (!f) return false;
    const cx = f.left + f.width / 2;
    const cy = f.top + f.height / 2;
    const radius = Math.min(f.width, f.height) / 2;
    const tags = [...document.querySelectorAll(".mini-tag")];
    return (
      tags.length === 2 &&
      tags.every((n) => {
        const r = n.getBoundingClientRect();
        // 整个标签的四个角都要在圆里，不只是中心
        return [
          [r.left, r.top],
          [r.right, r.top],
          [r.left, r.bottom],
          [r.right, r.bottom],
        ].every(([x, y]) => Math.hypot(x - cx, y - cy) <= radius);
      })
    );
  });
}

/** 地图转角和箭头转角加起来是 360 的整倍数：自己永远朝上。 */
function pointsUp(rot, cone) {
  const sum = (((rot + cone) % 360) + 360) % 360;
  return sum < 0.5 || sum > 359.5;
}

const browser = await chromium.launch({ executablePath: exe, args: ["--no-sandbox"] });
let failed = false;
const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, name) });

try {
  // ——— 1. 对局中、2F：能渲染、跟着朝向转、自己在中间、楼层和预设名 ——
  {
    const { page, context, errors } = await open(browser, {
      prefs: prefsWith({ rangeMeters: 150 }),
      events: raidEvents(),
      viewport: { width: 640, height: 640 },
    });
    await waitMini(page);
    // 等第一帧定位画上去
    await page.waitForFunction(() => document.querySelector(".mini .otm-me"), null, { timeout: 30000 });
    await page.waitForTimeout(300);
    const s = await snapMini(page);

    record("?view=mini 画的是小地图，不是主窗口", !s.main && s.frame !== null, `frame=${JSON.stringify(s.frame)}`);
    record(
      "窗口多宽小地图就多大，圆角 18px",
      s.frame && Math.abs(s.frame.w - 640) <= 1 && Math.abs(s.frame.h - 640) <= 1 && s.frame.r === "18px",
      `frame=${s.frame?.w}x${s.frame?.h} r=${s.frame?.r}`,
    );
    record("底图与标注都在", s.annos > 0, `标注 ${s.annos} 个`);
    const [floorTag, presetTag] = s.tags;
    record("楼层按自己的高度切：2F", floorTag === "2F", `楼层=${floorTag}`);
    record("预设名是当前预设", presetTag === "做任务", `预设=${presetTag}`);
    record("地图跟着朝向转", typeof s.rot === "number" && Math.abs(s.rot) > 1, `地图转了 ${s.rot}°`);
    record("自己还是朝上（地图转角和箭头转角抵消）", pointsUp(s.rot, s.cone ?? 0), `箭头 ${s.cone}°`);
    record(
      "自己在窗口正中间",
      s.me && Math.abs(s.me.x - s.viewport.w / 2) <= 2 && Math.abs(s.me.y - s.viewport.h / 2) <= 2,
      `自己在 ${JSON.stringify(s.me)}，窗口 ${s.viewport.w}x${s.viewport.h}`,
    );
    await shot(page, "30-mini-2f.png");
    record("没有 pageerror", errors.length === 0, errors.join(" | "));

    // 朝北：整张图不转，箭头照旧按朝向转
    await page.evaluate(() => {
      const p = JSON.parse(localStorage.getItem("otm.prefs"));
      p.overlay.heading = "north";
      localStorage.setItem("otm.prefs", JSON.stringify(p));
    });
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitMini(page);
    await page.waitForFunction(() => document.querySelector(".mini .otm-me"), null, { timeout: 30000 });
    await page.waitForTimeout(300);
    const north = await snapMini(page);
    record("设置成朝北时整张图不转", north.rot === 0, `地图转了 ${north.rot}°，箭头 ${north.cone}°`);
    await shot(page, "31-mini-north.png");
    await context.close();
  }

  // ——— 2. 进图了但还没截图：中间一个相机、不转 ———
  {
    const { page, context } = await open(browser, {
      prefs: prefsWith(),
      events: raidEvents({ shot: null }),
    });
    await waitMini(page);
    await page.waitForTimeout(600);
    const s = await snapMini(page);
    record("进图后还没截图：中间一个相机", s.camera && !s.me, `相机=${s.camera} 自己=${!!s.me}`);
    record("还没截图时不转", s.rot === 0, `地图转了 ${s.rot}°`);
    record("这时候楼层和预设名照样有", s.tags.length === 2, s.tags.join(" / "));
    await shot(page, "32-mini-no-shot.png");
    await context.close();
  }

  // ——— 3. 位置过时：箭头变黄、去掉视野锥、旁边一个相机 + 计时 ———
  {
    const { page, context } = await open(browser, {
      prefs: prefsWith({}, { staleSeconds: 5 }),
      events: raidEvents(),
    });
    await waitMini(page);
    await page.waitForFunction(() => document.querySelector(".mini .otm-me"), null, { timeout: 30000 });
    await page.waitForFunction(() => document.querySelector(".mini-stale"), null, { timeout: 30000 });
    const s = await snapMini(page);
    record("位置过时：箭头变黄", s.stale, `stale=${s.stale}`);
    record("位置过时：视野锥去掉", s.cone === null, `视野锥=${s.cone}`);
    record("位置过时：旁边一个相机 + 计时", /^\d{1,2}:\d{2}$/.test((s.staleTag ?? "").trim()), `标签=${s.staleTag}`);
    record("过时的时候地图照样跟着转", Math.abs(s.rot) > 1, `${s.rot}°`);
    await shot(page, "33-mini-stale.png");
    await context.close();
  }

  // ——— 4. 对局外：整块不画（窗口本身就是透明的） ———
  {
    const { page, context } = await open(browser, {
      prefs: prefsWith({}, { mockSpeed: 1 }),
      events: raidEvents({ end: 3000 }),
    });
    await waitMini(page);
    // 刚打开叠加层的 10 秒里，对局外也画；过了这 10 秒才收起来
    await page.waitForFunction(() => !document.querySelector(".mini"), null, { timeout: 25000 });
    await page.waitForTimeout(200);
    const s = await snapMini(page);
    record("对局外（默认设置）过一会儿才什么都不画", s.frame === null && s.tags.length === 0, `frame=${JSON.stringify(s.frame)}`);

    // 关掉「对局外隐藏」：整块留着
    await page.evaluate(() => {
      const p = JSON.parse(localStorage.getItem("otm.prefs"));
      p.overlay.hideOutside = false;
      p.mockSpeed = 1;
      localStorage.setItem("otm.prefs", JSON.stringify(p));
    });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.querySelector(".mini"), null, { timeout: 30000 });
    await page.waitForTimeout(4000); // 等这一局打完
    const out = await snapMini(page);
    record("关掉「对局外隐藏」以后整块还在", out.frame !== null);
    record("对局外画的是上一局那张图", out.annos > 0, `标注 ${out.annos} 个`);
    await shot(page, "34-mini-outside.png");
    await context.close();
  }

  // ——— 4b. 刚打开叠加层、对局外、还没有上一局：灰底空框加相机，10 秒后收起来 ———
  {
    const { page, context } = await open(browser, {
      prefs: prefsWith({ hideOutside: true }, { mockSpeed: 1 }),
      events: [{ ms: 0, ev: PATHS }],
    });
    await page.waitForFunction(() => document.querySelector(".mini"), null, { timeout: 30000 });
    await page.waitForTimeout(500);
    const s = await snapMini(page);
    record("刚打开叠加层，对局外也画出来（空框加相机）", s.frame !== null && s.camera === true, JSON.stringify({ frame: s.frame, camera: s.camera }));
    const noMap = await page.evaluate(() => !document.querySelector(".mini .map"));
    record("没有上一局时只是一个灰底空框", noMap);
    await shot(page, "41-mini-empty.png");
    let gone = true;
    try {
      await page.waitForFunction(() => !document.querySelector(".mini"), null, { timeout: 20000 });
    } catch {
      gone = false;
    }
    record("10 秒后在对局外收起来", gone);
    await context.close();
  }

  // ——— 5. 详情卡片：没有目标系统，显示离自己最近的那个标注 ———
  {
    const { page, context } = await open(browser, {
      prefs: prefsWith({}, { mockSpeed: 4 }),
      events: raidEvents(),
      viewport: { width: 420, height: 740 },
      query: "&card=1",
    });
    await waitMini(page);
    await page.waitForFunction(() => document.querySelector(".minicard"), null, { timeout: 30000 });
    await page.waitForTimeout(400);
    const s = await snapMini(page);
    const c = s.card;
    record("详情卡片在窗口里", c !== null, JSON.stringify(c));
    record("卡片在小地图下面、中间留 12px", c !== null && c.top - c.frameBottom === 12, `间距=${c ? c.top - c.frameBottom : "?"}`);
    record("卡片标题写着标注名和距离", !!c && c.title.length > 0 && /^\d+m$/.test(c.dist), `${c?.title} / ${c?.dist}`);
    record("卡片有楼层标签", !!c && c.floor.length > 0, `楼层=${c?.floor}`);
    record("没有照片就不画照片区（不留空白）", c?.ph === false, `照片区=${c?.ph}`);
    record("没照片时卡片只有标题和楼层那么高", !!c && c.h > 40 && c.h < 120, `高度=${c?.h}`);
    record("卡片整块在窗口里", !!c && c.top + c.h <= 740, `下沿=${c ? c.top + c.h : "?"}/740`);
    await shot(page, "35-mini-card.png");
    await context.close();
  }

  // ——— 5b. 有照片的卡片：赛季文件点，高度跟着照片走 ———
  {
    const { page, context } = await open(browser, {
      prefs: prefsWith({}, { mockSpeed: 4 }),
      // 站在海关「财务文件」那个刷新点上：最近的就是它，卡片有照片
      events: raidEvents({ shot: { type: "position", x: 223.5, y: 3.2, z: 139.8, yaw: 120, source: "screenshot" } }),
      viewport: { width: 420, height: 740 },
      query: "&card=1",
    });
    await waitMini(page);
    await page.waitForFunction(() => document.querySelector(".minicard"), null, { timeout: 30000 });
    await page.waitForTimeout(600);
    const c = (await snapMini(page)).card;
    record("赛季文件点有照片区", c?.ph === true, `照片区=${c?.ph}`);
    record("有照片的卡片比没照片的高一截", !!c && c.h > 200, `高度=${c?.h}`);
    record("照片卡片整块在窗口里", !!c && c.top + c.h <= 740, `下沿=${c ? c.top + c.h : "?"}/740`);
    await shot(page, "40-mini-card-photo.png");
    await context.close();
  }

  // ——— 5c. 展开时卡片先收起，松开（窗口缩回去）以后还在 ———
  {
    const { page, context } = await open(browser, {
      prefs: prefsWith({}, { mockSpeed: 4 }),
      events: raidEvents(),
      viewport: { width: 420, height: 740 },
      query: "&card=1",
    });
    await waitMini(page);
    await page.waitForFunction(() => document.querySelector(".minicard"), null, { timeout: 30000 });
    await page.setViewportSize(EXPAND);
    await page.waitForTimeout(600);
    const big = await snapMini(page);
    record("展开时卡片收起来（大地图不带卡片）", big.card === null);
    await page.setViewportSize({ width: 420, height: 740 });
    await page.waitForTimeout(600);
    const back = await snapMini(page);
    record("松开以后卡片还在", back.card !== null, `高度=${back.card?.h}`);
    await context.close();
  }

  // ——— 6. 按住展开：整张图 ———
  {
    const { page, context } = await open(browser, {
      prefs: prefsWith({}, { mockSpeed: 4 }),
      events: raidEvents(),
      viewport: EXPAND,
      query: "",
    });
    await waitMini(page);
    await page.waitForFunction(() => document.querySelector(".mini .otm-me"), null, { timeout: 30000 });
    await page.waitForTimeout(400);
    const s = await snapMini(page);
    record("展开时铺满窗口", s.big && s.frame?.w === EXPAND.width && s.frame?.h === EXPAND.height, JSON.stringify(s.frame));
    record("展开时也看得见自己", !!s.me, JSON.stringify(s.me));
    record("展开时楼层和预设名还在（字更大）", s.tags.length === 2, s.tags.join(" / "));
    record("展开时整张图朝北、不跟着朝向转", s.rot === 0, `地图转了 ${s.rot}°`);
    await shot(page, "36-mini-expand.png");
    await context.close();
  }

  // ——— 7. 圆形 ———
  {
    const { page, context } = await open(browser, {
      prefs: prefsWith({ shape: "circle" }, { mockSpeed: 4 }),
      events: raidEvents(),
    });
    await waitMini(page);
    await page.waitForTimeout(400);
    const s = await snapMini(page);
    record("形状选圆时是圆的", s.frame?.r === "50%", `圆角=${s.frame?.r}`);
    const inside = await tagInsideCircle(page);
    record("圆形时楼层和预设名没被圆弧裁掉", inside, `标签 ${s.tags.join(" / ")}`);
    await shot(page, "37-mini-circle.png");
    await context.close();
  }

  // ——— 8. 两个窗口的偏好：主窗口换个预设，小地图跟着换 ———
  {
    const context = await browser.newContext({ viewport: MAIN, deviceScaleFactor: 1 });
    const main = await context.newPage();
    await main.addInitScript((p) => {
      if (sessionStorage.getItem("otm.seeded")) return;
      localStorage.setItem("otm.prefs", JSON.stringify(p));
      sessionStorage.setItem("otm.seeded", "1");
    }, prefsWith({}, { mockSpeed: 4 }));
    const mock = (route) =>
      route.fulfill({ status: 200, contentType: "application/jsonl", body: jsonl(raidEvents()) });
    await main.route("**/mock-events.jsonl", mock);
    await main.goto(`${BASE}/`, { waitUntil: "domcontentloaded", timeout: 60000 });
    await main.waitForFunction(() => document.querySelectorAll(".map .otm-anno").length > 0, null, { timeout: 60000 });

    const miniPage = await context.newPage();
    await miniPage.setViewportSize({ width: 420, height: 420 });
    await miniPage.route("**/mock-events.jsonl", mock);
    await miniPage.goto(`${BASE}/?view=mini`, { waitUntil: "domcontentloaded", timeout: 60000 });
    await waitMini(miniPage);
    await miniPage.waitForFunction(() => document.querySelector(".mini .otm-me"), null, { timeout: 30000 });
    await miniPage.waitForTimeout(300);
    const before = (await snapMini(miniPage)).tags[1];

    await main.locator(".presets .chip", { hasText: "跑刀" }).click();
    await miniPage.waitForFunction(() => document.querySelector(".mini-tag.br")?.textContent === "跑刀", null, {
      timeout: 10000,
    });
    const after = (await snapMini(miniPage)).tags[1];
    record("主窗口换预设，小地图跟着换", before === "做任务" && after === "跑刀", `${before} → ${after}`);
    await context.close();
  }
} catch (e) {
  failed = true;
  record("跑起来了", false, String(e?.message || e).split("\n")[0]);
} finally {
  await browser.close();
}

const bad = results.filter((r) => !r.ok);
console.log(`\n${results.length - bad.length}/${results.length} 项通过${bad.length ? `，${bad.length} 项没过` : ""}`);
if (bad.length || failed) process.exitCode = 1;
