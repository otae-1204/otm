// 界面偏好与预设，存在 localStorage。
//
// 筛选分两级：大类开关 + 每个大类下的子类开关（子类清单取自上游数据）。
// 预设是「一组两级类别开关 + 轨迹」的快照；主窗口左侧的大类开关只做临时调整，
// 不改动预设本身（DESIGN 6.3）。

import { useSyncExternalStore } from "react";
import type { CategoryId } from "./data/annotations";
import { CONTAINER_ICON } from "./data/annotations";

export type SubFilters = Record<string, boolean>;

export interface FilterState {
  /** 大类开关。 */
  categories: Record<CategoryId, boolean>;
  /** 子类开关：键是 `${大类}:${子类 id}`，缺省视为开。 */
  subs: SubFilters;
  /** 轨迹。 */
  trail: boolean;
}

export interface Preset {
  id: string;
  name: string;
  filters: FilterState;
}

export interface Prefs {
  /** 存储格式版本，用来迁移旧数据。 */
  v: number;
  presets: Preset[];
  activePresetId: string;
  /** 主窗口左侧的临时调整，叠在预设之上。 */
  overrides: Partial<Record<CategoryId, boolean>>;
  /** 手动指定的地图（游戏内部名）；null 表示跟着对局走。 */
  manualMap: string | null;
  baseStyle: "svg" | "tile";
  /** 多久算位置过时（秒）。 */
  staleSeconds: number;
  /** 假数据回放倍速。 */
  mockSpeed: number;
}

export const ALL_CATEGORIES: CategoryId[] = [
  "extract",
  "transit",
  "lock",
  "hazard",
  "loot",
  "spawn",
  "switch",
  "gun",
];

/** 做任务：只看路和门，物资与出生点全关。 */
const TASK_ON: CategoryId[] = ["extract", "transit", "lock", "hazard"];

/** 跑刀：撤离点、转移点，物资里只留值钱的几种。 */
const RUN_ON: CategoryId[] = ["extract", "transit", "loot"];

const RUN_LOOT = [
  "safe",
  "bank-safe",
  "weapon-box",
  "pc-block",
  "jacket",
  "duffle-bag",
  "medbag",
  "medcase",
  "medical-supply-crate",
];

export function defaultFilters(on: CategoryId[], subs: SubFilters = {}): FilterState {
  const categories = {} as Record<CategoryId, boolean>;
  for (const c of ALL_CATEGORIES) categories[c] = on.includes(c);
  return { categories, subs, trail: true };
}

/** 跑刀预设里关掉的物资子类：除值钱的几种以外全关。 */
function runLootSubs(): SubFilters {
  const subs: SubFilters = {};
  for (const id of Object.keys(CONTAINER_ICON)) {
    if (!RUN_LOOT.includes(id)) subs[subKey("loot", id)] = false;
  }
  return subs;
}

function defaultPrefs(): Prefs {
  const doTask: Preset = { id: "p-do-task", name: "做任务", filters: defaultFilters(TASK_ON) };
  const runScav: Preset = {
    id: "p-run",
    name: "跑刀",
    filters: defaultFilters(RUN_ON, runLootSubs()),
  };
  return {
    v: VERSION,
    presets: [doTask, runScav],
    activePresetId: doTask.id,
    overrides: {},
    manualMap: null,
    baseStyle: "svg",
    staleSeconds: 60,
    mockSpeed: 1,
  };
}

const KEY = "otm.prefs";
/** 2：做任务/跑刀的默认开关改过，旧数据升级时重置这两个内置预设。 */
const VERSION = 2;

/** 把任意存下来的预设整理成当前格式，认不出的字段丢掉。 */
function normalizePreset(raw: unknown): Preset | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Partial<Preset>;
  if (typeof p.id !== "string" || !p.id) return null;
  const f = (p.filters ?? {}) as Partial<FilterState> & { onlyCurrentTask?: boolean };
  const categories = {} as Record<CategoryId, boolean>;
  for (const c of ALL_CATEGORIES) categories[c] = f.categories?.[c] === true;
  const subs: SubFilters = {};
  for (const [k, v] of Object.entries(f.subs ?? {})) if (typeof v === "boolean") subs[k] = v;
  return {
    id: p.id,
    name: typeof p.name === "string" && p.name ? p.name : "预设",
    filters: { categories, subs, trail: f.trail !== false },
  };
}

function load(): Prefs {
  const d = defaultPrefs();
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    return d;
  }
  if (!raw) return d;

  let stored: Partial<Prefs> | null = null;
  try {
    stored = JSON.parse(raw) as Partial<Prefs>;
  } catch {
    return d;
  }
  if (!stored || typeof stored !== "object") return d;

  const oldVersion = typeof stored.v === "number" ? stored.v : 1;
  const list = Array.isArray(stored.presets) ? stored.presets : [];
  let presets = list.map(normalizePreset).filter((x): x is Preset => x !== null);

  if (oldVersion < VERSION) {
    // 升级：内置的两个预设换成新的默认开关，用户自己建的预设原样保留。
    const fresh = new Map(d.presets.map((p) => [p.id, p]));
    presets = presets.map((p) => {
      const f = fresh.get(p.id);
      return f ? { ...p, filters: f.filters } : p;
    });
  }
  if (presets.length === 0) presets = d.presets;

  const activePresetId = presets.some((p) => p.id === stored!.activePresetId)
    ? (stored.activePresetId as string)
    : presets[0].id;

  const result: Prefs = {
    v: VERSION,
    presets,
    activePresetId,
    // 旧版的临时调整是按旧默认点出来的，升级时清掉，免得盖住新默认
    overrides: oldVersion < VERSION ? {} : (stored.overrides ?? {}),
    manualMap: typeof stored.manualMap === "string" ? stored.manualMap : null,
    baseStyle: stored.baseStyle === "tile" ? "tile" : "svg",
    staleSeconds:
      typeof stored.staleSeconds === "number" && stored.staleSeconds >= 5
        ? stored.staleSeconds
        : d.staleSeconds,
    mockSpeed:
      typeof stored.mockSpeed === "number" && stored.mockSpeed >= 1 && stored.mockSpeed <= 20
        ? stored.mockSpeed
        : d.mockSpeed,
  };
  if (oldVersion < VERSION) {
    // 迁移结果马上写回去，免得下次启动又按旧数据算一遍
    try {
      localStorage.setItem(KEY, JSON.stringify(result));
    } catch {
      // 写不进去就只在内存里生效
    }
  }
  return result;
}

type Listener = () => void;
let prefs: Prefs = load();
const listeners = new Set<Listener>();

function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // 存不下就只在内存里生效
  }
}

export const prefsStore = {
  get: () => prefs,
  set(next: Prefs) {
    prefs = next;
    persist();
    listeners.forEach((l) => l());
  },
  update(fn: (p: Prefs) => Prefs) {
    prefsStore.set(fn(prefs));
  },
  subscribe(l: Listener) {
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  },
};

export function usePrefs(): Prefs {
  return useSyncExternalStore(prefsStore.subscribe, prefsStore.get);
}

export function activePreset(p: Prefs): Preset | null {
  return p.presets.find((x) => x.id === p.activePresetId) ?? p.presets[0] ?? null;
}

/** 最终生效的筛选：预设 ∩ 主窗口的临时调整。 */
export function effectiveFilters(p: Prefs): FilterState {
  const base = activePreset(p)?.filters ?? defaultFilters(TASK_ON);
  const categories = { ...base.categories };
  for (const c of ALL_CATEGORIES) {
    const o = p.overrides[c];
    if (o !== undefined) categories[c] = o;
  }
  return { ...base, categories };
}

export function newPresetId() {
  return `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export function subKey(cat: CategoryId, sub: string) {
  return `${cat}:${sub}`;
}

/** 子类是否显示：大类开着，且子类没被关掉。 */
export function subVisible(f: FilterState, cat: CategoryId, sub: string): boolean {
  if (!f.categories[cat]) return false;
  return f.subs[subKey(cat, sub)] !== false;
}
