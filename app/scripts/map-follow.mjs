#!/usr/bin/env node
// 自动切图与轨迹归属的端到端检查（DESIGN 7.7 与「轨迹跟着它所属的地图走」）。
//
//   npx vite --port 5173 --strictPort          （或 build 后 npx vite preview --port 4179）
//   PW_MODULE=/path/to/playwright-core node scripts/map-follow.mjs --url http://localhost:5173/
//
// 两个场景，各自造一份假事件喂给界面：
//
// 1. 手选了别的图，日志里出现新的一局 → 地图切到那一局的那张图（手选让位）。
// 2. 没收到对局事件（日志还没读到）时换图 → 上一张图的轨迹不能画到新图上，
//    也不留在手里；换过去之后新来的定位照常画。
//
// 依赖 playwright-core 与 chrome-headless-shell，查找方式和 map-regression.mjs 一样。

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

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? "  " + detail : ""}`);
}

const T0 = Date.parse("2026-11-19T12:00:00.000+01:00");
const at = (ms) => new Date(T0 + ms).toISOString();

/** 造一份假事件：`[{ms, ev}]`，按毫秒排。 */
function jsonl(events) {
  return events.map(({ ms, ev }) => JSON.stringify({ ...ev, time: at(ms) })).join("\n");
}

/** 打开一张干净的页面：预置偏好 + 自己那份假事件。 */
async function open(browser, { prefs, events }) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e.stack || e).split("\n")[0]));
  await page.addInitScript((p) => {
    localStorage.setItem("otm.prefs", JSON.stringify(p));
  }, prefs);
  await page.route("**/mock-events.jsonl", (route) =>
    route.fulfill({ status: 200, contentType: "application/jsonl", body: jsonl(events) }),
  );
  await page.goto(URL_, { waitUntil: "domcontentloaded", timeout: 60000 });
  // 等上游数据到位（标注画出来），地图名才有得看
  await page.waitForFunction(
    () => document.querySelectorAll(".map .otm-anno, .map .otm-cluster").length > 0,
    null,
    { timeout: 120000 },
  );
  return { page, errors };
}

const prefsOf = (page) => page.evaluate(() => JSON.parse(localStorage.getItem("otm.prefs") || "{}"));
const mapLabel = (page) => page.locator(".status .mapbtn").first().innerText();
const meCount = (page) => page.locator(".map .otm-me").count();
const trailCount = (page) => page.locator('.map .leaflet-overlay-pane path[stroke="#e6ebf2"]').count();

async function pickMap(page, label) {
  await page.locator(".status .mapbtn").first().click();
  await page.locator(".maplist span", { hasText: new RegExp(`^${label}$`) }).first().click();
}

const basePrefs = {
  v: 3,
  presets: [],
  activePresetId: "",
  overrides: {},
  manualMap: null,
  baseStyle: "svg",
  tileBrightness: 1.4,
  staleSeconds: 60,
  mockSpeed: 1,
  clusterIcon: "count",
};

const browser = await chromium.launch({ executablePath: exe, args: ["--no-sandbox"] });
let failed = false;

try {
  // ——— 场景 1：新的一局盖过手选的地图 ———
  {
    const events = [
      {
        ms: 0,
        ev: { type: "paths", game_dir: "X:/EFT", screenshot_dir: "X:/EFT/Screenshots", log_dir: "X:/EFT/Logs/x" },
      },
      { ms: 100, ev: { type: "position", x: 0, y: 0, z: 0, yaw: 0, source: "screenshot" } },
      // 中途在游戏里进了另一张图
      { ms: 800, ev: { type: "raid_loading", map: "Interchange" } },
      { ms: 900, ev: { type: "raid_started", map: "Interchange", scav: false, raid_mode: "Online" } },
    ];
    const { page, errors } = await open(browser, {
      prefs: { ...basePrefs, manualMap: "factory4_day" },
      events,
    });
    await page.waitForFunction(
      () => document.querySelector(".status .mapbtn")?.textContent?.includes("工厂"),
      null,
      { timeout: 30000 },
    );
    const before = await mapLabel(page);
    record("手选的图先在显示", before.includes("工厂"), before);

    await page.waitForFunction(
      () => document.querySelector(".status .mapbtn")?.textContent?.includes("立交桥"),
      null,
      { timeout: 30000 },
    );
    const after = await mapLabel(page);
    const prefs = await prefsOf(page);
    record("新的一局自动切到那一张图", after.includes("立交桥"), `${before} → ${after}`);
    record("手选的地图让位（回到跟着对局走）", prefs.manualMap === null, `manualMap=${JSON.stringify(prefs.manualMap)}`);
    record("场景 1 没有 pageerror", errors.length === 0, errors.slice(0, 2).join(" || "));
    await page.close();
  }

  // ——— 场景 2：没有对局事件时，旧轨迹不能跟到新图上 ———
  {
    const events = [
      { ms: 0, ev: { type: "paths", game_dir: "X:/EFT", screenshot_dir: "X:/EFT/Screenshots", log_dir: null } },
      // 四张截图同一个时刻：回放在地图画出来之前就放完了，换图时手里不会再有半路来的定位
      { ms: 100, ev: { type: "position", x: 0, y: 0, z: 0, yaw: 0, source: "screenshot" } },
      { ms: 100, ev: { type: "position", x: 10, y: 0, z: 10, yaw: 0, source: "screenshot" } },
      { ms: 100, ev: { type: "position", x: 20, y: 0, z: 20, yaw: 0, source: "screenshot" } },
      { ms: 100, ev: { type: "position", x: 30, y: 0, z: 30, yaw: 0, source: "screenshot" } },
    ];
    const { page, errors } = await open(browser, {
      prefs: { ...basePrefs, manualMap: "bigmap" },
      events,
    });
    await page.waitForFunction(
      () => document.querySelectorAll('.map .leaflet-overlay-pane path[stroke="#e6ebf2"]').length > 0,
      null,
      { timeout: 30000 },
    );
    record("海关上先画出轨迹与箭头", (await trailCount(page)) > 0 && (await meCount(page)) > 0, "");

    // 换到森林：日志没读到，手里这份轨迹属于海关，不能跟过来
    await pickMap(page, "森林");
    await page.waitForTimeout(500);
    record("换图后旧轨迹不画在新图上", (await trailCount(page)) === 0, `轨迹 ${await trailCount(page)} 段`);
    record("换图后箭头也不画", (await meCount(page)) === 0, `箭头 ${await meCount(page)} 个`);

    // 换回海关：记录是清掉了，不是藏起来
    await pickMap(page, "海关");
    await page.waitForTimeout(500);
    record("换回来也不会再冒出上一份轨迹", (await trailCount(page)) === 0, `轨迹 ${await trailCount(page)} 段`);

    // 重新放一遍假数据：新来的定位照常画（证明没有把箭头整个废掉）
    await page.locator('.tools button[title="重放假数据"]').click();
    await page.waitForFunction(
      () => document.querySelectorAll('.map .leaflet-overlay-pane path[stroke="#e6ebf2"]').length > 0,
      null,
      { timeout: 30000 },
    );
    record("新来的定位照常画", (await trailCount(page)) > 0 && (await meCount(page)) > 0, "");
    record("场景 2 没有 pageerror", errors.length === 0, errors.slice(0, 2).join(" || "));
    await page.close();
  }
} catch (e) {
  failed = true;
  record("脚本执行", false, String(e).split("\n")[0]);
} finally {
  await browser.close();
}

const bad = results.filter((r) => !r.ok);
console.log(`\n共 ${results.length} 项检查，失败 ${bad.length}`);
process.exit(failed || bad.length > 0 ? 1 : 0);
