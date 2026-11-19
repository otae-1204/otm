// 赛季包与今日计数。
//
// 赛季包有两份来源：程序自带的一份（随界面一起构建，见 current.json），
// 和用户在设置里换进来的那份（存在 localStorage）。换进来的那份优先；
// 用户也可以移除，移除后相关界面整体不出现（DESIGN 6.7.1）。
//
// 今日已拾取数按档案分开记：PVE 15、PVP 25、赛季 40 这类上限是每个档案各自一份的，
// 跨天归零。它不受窗口大小、界面偏好影响，所以和偏好分开存。

import { useSyncExternalStore } from "react";
import type { SessionMode } from "../../types";
import { parsePack, type SeasonPack } from "./types";
import { bumpCount, dayKey, normalizeCounts, todayFor as todayForLimits, type CountState } from "./counts";
import builtinJson from "./current.json";

const PACK_KEY = "otm.season.pack";
const COUNT_KEY = "otm.season.count";

export type PackOrigin = "builtin" | "imported" | "none";

export interface SeasonState {
  pack: SeasonPack | null;
  origin: PackOrigin;
  /** 换进来的包有问题时的说明，给人看的一句话。 */
  error: string | null;
}

type Listener = () => void;

function readJson(key: string): unknown {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // 存不下就只在内存里生效
  }
}

// —— 赛季包 ——

/** 自带的赛季包。换赛季就是换 current.json（由 design/prototypes/season_pack.py 生成）。 */
const builtin = parsePack(builtinJson as unknown);

function builtinPack(): SeasonPack | null {
  return "pack" in builtin ? builtin.pack : null;
}

function initialState(): SeasonState {
  const b = builtinPack();
  const stored = readJson(PACK_KEY);
  if (stored && typeof stored === "object") {
    const s = stored as { removed?: unknown; pack?: unknown };
    if (s.removed === true) return { pack: null, origin: "none", error: null };
    if (s.pack !== undefined) {
      const r = parsePack(s.pack);
      // 读得懂就用它；读不懂（格式改过、手工改坏了）退回自带的那份，并留一句话
      if ("pack" in r) return { pack: r.pack, origin: "imported", error: null };
      return { pack: b, origin: b ? "builtin" : "none", error: r.error };
    }
  }
  return { pack: b, origin: b ? "builtin" : "none", error: null };
}

let season: SeasonState = initialState();
const packListeners = new Set<Listener>();

function emitPack() {
  packListeners.forEach((l) => l());
}

export const seasonStore = {
  get: () => season,
  subscribe(l: Listener) {
    packListeners.add(l);
    return () => {
      packListeners.delete(l);
    };
  },
  /** 换一份赛季包：读得懂就换上去，读不懂就报一句，原样不动。 */
  importText(text: string): string | null {
    const fail = (msg: string) => {
      season = { ...season, error: msg };
      emitPack();
      return msg;
    };
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return fail("不是 JSON 文件");
    }
    const r = parsePack(raw);
    if ("error" in r) return fail(r.error);
    writeJson(PACK_KEY, { pack: raw });
    season = { pack: r.pack, origin: "imported", error: null };
    emitPack();
    return null;
  },
  /** 移除赛季包：相关界面整体消失。 */
  remove() {
    writeJson(PACK_KEY, { removed: true });
    season = { pack: null, origin: "none", error: null };
    emitPack();
  },
  /** 回到自带的那份。 */
  restore() {
    writeJson(PACK_KEY, null);
    const b = builtinPack();
    season = { pack: b, origin: b ? "builtin" : "none", error: null };
    emitPack();
  },
};

export function useSeason(): SeasonState {
  return useSyncExternalStore(seasonStore.subscribe, seasonStore.get);
}

// —— 今日已拾取 ——

function readCounts(): CountState {
  const today = dayKey();
  const raw = readJson(COUNT_KEY);
  const c = normalizeCounts(raw, today);
  // 换天了就把旧的清掉，别留在存储里
  if (raw !== null && (raw as Partial<CountState>).day !== today) writeJson(COUNT_KEY, c);
  return c;
}

let counts: CountState = readCounts();
const countListeners = new Set<Listener>();

function emitCounts() {
  countListeners.forEach((l) => l());
}

export const countStore = {
  /** 当前计数。换天了就当零，顺手写回去。 */
  get(): CountState {
    const today = dayKey();
    if (counts.day !== today) {
      counts = { day: today, byMode: {} };
      writeJson(COUNT_KEY, counts);
    }
    return counts;
  },
  subscribe(l: Listener) {
    countListeners.add(l);
    return () => {
      countListeners.delete(l);
    };
  },
  /** 加减今日已拾取数。上限由调用方给（不同档案不一样）。 */
  bump(mode: SessionMode | null, delta: number, limit: number) {
    const next = bumpCount(countStore.get(), mode, delta, limit);
    if (next === counts) return;
    counts = next;
    writeJson(COUNT_KEY, counts);
    emitCounts();
  },
};

export function useCounts(): CountState {
  return useSyncExternalStore(countStore.subscribe, countStore.get);
}

/** 某个档案今天捡了几个、上限多少。没有赛季包、这个档案没设上限时返回 null。 */
export function todayFor(
  pack: SeasonPack | null,
  mode: SessionMode | null,
  c: CountState,
): { count: number; limit: number } | null {
  return todayForLimits(pack ? pack.limits : null, mode, c);
}
