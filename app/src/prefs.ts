// 界面偏好与预设，存在 localStorage。
//
// 筛选分两级：大类开关 + 每个大类下的子类开关（子类清单取自上游数据）。
// 预设是「一组两级类别开关 + 仅当前任务/轨迹」的快照；主窗口左侧的大类开关
// 只做临时调整，不改动预设本身（DESIGN 6.3）。

import { useSyncExternalStore } from "react";
import type { CategoryId } from "./data/annotations";

export type SubFilters = Record<string, boolean>;

export interface FilterState {
  /** 大类开关。 */
  categories: Record<CategoryId, boolean>;
  /** 子类开关：键是 `${大类}:${子类 id}`，缺省视为开。 */
  subs: SubFilters;
  /** 仅当前任务（第一版没有任务数据，开关先留着）。 */
  onlyCurrentTask: boolean;
  /** 轨迹。 */
  trail: boolean;
}

export interface Preset {
  id: string;
  name: string;
  filters: FilterState;
}

export interface Prefs {
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

const DEFAULT_ON: CategoryId[] = [
  "extract",
  "transit",
  "lock",
  "hazard",
  "loot",
  "switch",
  "gun",
];

export function defaultFilters(on: CategoryId[] = DEFAULT_ON): FilterState {
  const categories = {} as Record<CategoryId, boolean>;
  for (const c of ALL_CATEGORIES) categories[c] = on.includes(c);
  return { categories, subs: {}, onlyCurrentTask: false, trail: true };
}

function preset(id: string, name: string, on: CategoryId[], trail = true): Preset {
  const filters = defaultFilters(on);
  filters.trail = trail;
  return { id, name, filters };
}

function defaultPrefs(): Prefs {
  const doTask = preset("p-do-task", "做任务", [
    "extract",
    "transit",
    "lock",
    "hazard",
    "loot",
    "switch",
    "gun",
  ]);
  const runScav = preset("p-run", "跑刀", ["extract", "transit"], true);
  return {
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

function load(): Prefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaultPrefs();
    const p = JSON.parse(raw) as Partial<Prefs>;
    const d = defaultPrefs();
    const merged: Prefs = {
      ...d,
      ...p,
      overrides: p.overrides ?? {},
      presets: (p.presets ?? d.presets).map((x) => {
        const base = defaultFilters();
        return {
          ...x,
          filters: {
            ...base,
            ...x.filters,
            categories: { ...base.categories, ...x.filters?.categories },
            subs: { ...(x.filters?.subs ?? {}) },
          },
        };
      }),
    };
    if (!merged.presets.some((x) => x.id === merged.activePresetId)) {
      merged.activePresetId = merged.presets[0]?.id ?? "";
    }
    return merged;
  } catch {
    return defaultPrefs();
  }
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
  const base = activePreset(p)?.filters ?? defaultFilters();
  const categories = { ...base.categories };
  for (const c of ALL_CATEGORIES) {
    const o = p.overrides[c];
    if (o !== undefined) categories[c] = o;
  }
  return { ...base, categories };
}

export function updateActivePresetFilters(fn: (f: FilterState) => FilterState) {
  prefsStore.update((p) => ({
    ...p,
    presets: p.presets.map((x) =>
      x.id === p.activePresetId ? { ...x, filters: fn(x.filters) } : x,
    ),
  }));
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
