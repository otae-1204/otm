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

/** 合并标注里放哪个图标。 */
export type ClusterIconMode = "count" | "value" | "category";

export const CLUSTER_ICON_MODES: { id: ClusterIconMode; label: string }[] = [
  { id: "count", label: "数量最多" },
  { id: "value", label: "价值最高" },
  { id: "category", label: "统一图标" },
];

/** 叠加层的热键。空串表示没绑。 */
export interface Hotkeys {
  /** 显示 / 隐藏小地图。 */
  show: string;
  /** 按住展开大地图，松开收回。 */
  expand: string;
  /** 预设轮换（小地图里按）。 */
  preset: string;
  /** 详情卡片。 */
  detail: string;
  /** 调整模式：关掉鼠标穿透，拖边框改位置大小。 */
  adjust: string;
}

/** 设置里热键那一页的五行，顺序就是那里的顺序。 */
export const HOTKEY_ACTIONS: { id: keyof Hotkeys; label: string; hold: boolean }[] = [
  { id: "show", label: "显示 / 隐藏", hold: false },
  { id: "expand", label: "展开", hold: true },
  { id: "preset", label: "预设轮换", hold: false },
  { id: "detail", label: "详情卡片", hold: false },
  { id: "adjust", label: "调整模式", hold: false },
];

/** 默认键位照 DESIGN 8 节（F6 显示/隐藏、按住 Caps 展开、F5 预设轮换），
 *  详情和调整模式 DESIGN 没定，先用旁边的 F7 / F8。 */
export const DEFAULT_HOTKEYS: Hotkeys = {
  show: "F6",
  expand: "CapsLock",
  preset: "F5",
  detail: "F7",
  adjust: "F8",
};

/** 小地图的形状和朝向。 */
export type OverlayShape = "square" | "circle";
export type OverlayHeading = "follow" | "north";

/** 叠加层（DESIGN 7.4 的「叠加层」页）。 */
export interface OverlayPrefs {
  /** 默认关闭：窗口模式是默认和保底。 */
  enabled: boolean;
  shape: OverlayShape;
  /** 跟随朝向（自己朝上）还是固定朝北。 */
  heading: OverlayHeading;
  /** 对局外把窗口藏起来。 */
  hideOutside: boolean;
  /** 小地图里横着看到多少米（DESIGN 7.4 的「视野范围」）。 */
  rangeMeters: number;
  /** 不透明度。 */
  opacity: number;
  /** 正方形边长；调完记在这里，拖边框改大小也会写回来。 */
  size: number;
  hotkeys: Hotkeys;
}

export const OVERLAY_RANGE = { min: 60, max: 400 } as const;
export const OVERLAY_OPACITY = { min: 0.4, max: 1 } as const;
export const OVERLAY_SIZE = { min: 160, max: 900 } as const;

export const DEFAULT_OVERLAY: OverlayPrefs = {
  enabled: false,
  shape: "square",
  heading: "follow",
  hideOutside: true,
  rangeMeters: 150,
  opacity: 0.92,
  size: 320,
  hotkeys: DEFAULT_HOTKEYS,
};

export interface Prefs {
  /** 存储格式版本，用来迁移旧数据。 */
  v: number;
  presets: Preset[];
  activePresetId: string;
  /** 主窗口左侧的临时调整，叠在预设之上。 */
  overrides: Partial<Record<CategoryId, boolean>>;
  /** 临时调整里的子类开关，键同 subs。 */
  subOverrides: SubFilters;
  /** 手动指定的地图（游戏内部名）；null 表示跟着对局走。 */
  manualMap: string | null;
  baseStyle: "svg" | "tile";
  /** 实景底图的亮度（1 = 原图）。 */
  tileBrightness: number;
  /** 多久算位置过时（秒）。 */
  staleSeconds: number;
  /** 假数据回放倍速。 */
  mockSpeed: number;
  /** 合并标注里放哪个图标。 */
  clusterIcon: ClusterIconMode;
  /** 叠加层：开关、外观、热键。 */
  overlay: OverlayPrefs;
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
  "season",
];

/** 做任务：只看路和门，物资与出生点全关。 */
const TASK_ON: CategoryId[] = ["extract", "transit", "lock", "hazard", "season"];

/** 跑刀：撤离点、转移点，物资里只留值钱的几种。 */
const RUN_ON: CategoryId[] = ["extract", "transit", "loot", "season"];

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
    subOverrides: {},
    manualMap: null,
    baseStyle: "svg",
    tileBrightness: DEFAULT_TILE_BRIGHTNESS,
    staleSeconds: 60,
    mockSpeed: 1,
    clusterIcon: "count",
    overlay: DEFAULT_OVERLAY,
  };
}

/** 实景亮度：1 是原图，再亮就没意义了；太暗看不清地图。 */
export const MIN_TILE_BRIGHTNESS = 0.3;
export const MAX_TILE_BRIGHTNESS = 2;
export const DEFAULT_TILE_BRIGHTNESS = 1.4;

export function clampBrightness(v: number) {
  return Math.min(MAX_TILE_BRIGHTNESS, Math.max(MIN_TILE_BRIGHTNESS, Math.round(v * 100) / 100));
}

export const PREFS_KEY = "otm.prefs";
const KEY = PREFS_KEY;
/**
 * 存储格式版本：
 * 2：做任务/跑刀的默认开关改过，升级时重置这两个内置预设；
 * 3：加了合并标注的图标选项；
 * 4：加了赛季文件这一大类，内置预设默认打开它。
 * 5：加了叠加层（开关、外观、热键），默认还是关着。
 */
const VERSION = 5;

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

/** 叠加层偏好：认不出的字段退回默认值，版本升级、换进来的数据都走这里。 */
export function normalizeOverlay(raw: unknown): OverlayPrefs {
  const d = DEFAULT_OVERLAY;
  if (!raw || typeof raw !== "object") return d;
  const o = raw as Partial<OverlayPrefs>;
  const h = (o.hotkeys ?? {}) as Partial<Hotkeys>;
  const key = (v: unknown, fallback: string) => (typeof v === "string" ? v : fallback);
  const num = (v: unknown, fallback: number, lo: number, hi: number) =>
    typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
  return {
    enabled: o.enabled === true,
    shape: o.shape === "circle" ? "circle" : "square",
    heading: o.heading === "north" ? "north" : "follow",
    hideOutside: o.hideOutside !== false,
    rangeMeters: Math.round(num(o.rangeMeters, d.rangeMeters, OVERLAY_RANGE.min, OVERLAY_RANGE.max)),
    opacity: Math.round(num(o.opacity, d.opacity, OVERLAY_OPACITY.min, OVERLAY_OPACITY.max) * 100) / 100,
    size: Math.round(num(o.size, d.size, OVERLAY_SIZE.min, OVERLAY_SIZE.max)),
    hotkeys: {
      show: key(h.show, d.hotkeys.show),
      expand: key(h.expand, d.hotkeys.expand),
      preset: key(h.preset, d.hotkeys.preset),
      detail: key(h.detail, d.hotkeys.detail),
      adjust: key(h.adjust, d.hotkeys.adjust),
    },
  };
}

/** 把存下来的一份偏好整理成当前格式。`load` 和两个窗口之间的同步都走这里。 */
function parseStored(raw: string | null): Prefs {
  const d = defaultPrefs();
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

  if (oldVersion < 2) {
    // 升级：内置的两个预设换成新的默认开关，用户自己建的预设原样保留。
    const fresh = new Map(d.presets.map((p) => [p.id, p]));
    presets = presets.map((p) => {
      const f = fresh.get(p.id);
      return f ? { ...p, filters: f.filters } : p;
    });
  }
  if (oldVersion < 4) {
    // 加了赛季文件：只把这一位打开，预设里别的开关维持用户原来的样子
    const fresh = new Map(d.presets.map((p) => [p.id, p]));
    presets = presets.map((p) => {
      const f = fresh.get(p.id);
      if (!f) return p;
      return { ...p, filters: { ...p.filters, categories: { ...p.filters.categories, season: f.filters.categories.season } } };
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
    overrides: oldVersion < 2 ? {} : (stored.overrides ?? {}),
    subOverrides: oldVersion < 2 ? {} : (stored.subOverrides ?? {}),
    manualMap: typeof stored.manualMap === "string" ? stored.manualMap : null,
    baseStyle: stored.baseStyle === "tile" ? "tile" : "svg",
    tileBrightness:
      typeof stored.tileBrightness === "number"
        ? clampBrightness(stored.tileBrightness)
        : d.tileBrightness,
    staleSeconds:
      typeof stored.staleSeconds === "number" && stored.staleSeconds >= 5
        ? stored.staleSeconds
        : d.staleSeconds,
    mockSpeed:
      typeof stored.mockSpeed === "number" && stored.mockSpeed >= 1 && stored.mockSpeed <= 20
        ? stored.mockSpeed
        : d.mockSpeed,
    clusterIcon:
      stored.clusterIcon === "value" || stored.clusterIcon === "category"
        ? stored.clusterIcon
        : d.clusterIcon,
    overlay: normalizeOverlay(stored.overlay),
  };
  return result;
}

/** 存着的那份是哪个版本；读不出来就当最老的。 */
function storedVersion(raw: string): number {
  try {
    const v = (JSON.parse(raw) as { v?: unknown }).v;
    return typeof v === "number" ? v : 1;
  } catch {
    return 1;
  }
}

function load(): Prefs {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    return defaultPrefs();
  }
  const result = parseStored(raw);
  if (raw && storedVersion(raw) < VERSION) {
    // 迁移结果马上写回去，免得下次启动又按旧数据算一遍
    try {
      localStorage.setItem(KEY, JSON.stringify(result));
    } catch {
      // 写不进去就只在内存里生效
    }
  }
  return result;
}

/** 另一个窗口写过来的那份偏好。 */
export function prefsFromJson(text: string): Prefs {
  return parseStored(text);
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
  const subs = { ...base.subs };
  for (const [k, v] of Object.entries(p.subOverrides)) if (v !== undefined) subs[k] = v;
  return { ...base, categories, subs };
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
