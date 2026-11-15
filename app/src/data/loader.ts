// 上游数据的加载：地图配置、标注、中文翻译。
// 每个数据源都是「先用缓存，后台取新」，取到后写回缓存。
//
// 上游 /regular/maps 有 9MB，直接塞进 localStorage 会超配额，所以只留界面用得到的字段
// （缓存里存的就是压缩后的形状，读缓存和读网络走同一套类型）。

import { cacheAge, readCache, writeCache } from "./cache";
import { MAPS_JSON_URL, parseMapsMeta, type MapGroup } from "./mapsMeta";

export interface UpstreamMaps {
  /** 每张图一个对象，键是地图 id。 */
  maps: Record<string, UpstreamMap>;
  lootContainers: Record<string, UpstreamContainerMeta>;
  stationaryWeapons: Record<string, UpstreamWeaponMeta>;
}

export interface UpstreamMap {
  id: string;
  /** 翻译键，中文名在 maps_zh 里用 `${id} Name` 取。 */
  name: string;
  /** 游戏内部地图名，例如 bigmap。 */
  nameId: string;
  /** 上游给这张图起的名字，和 maps.json 的 key 对得上（工厂的夜图靠 altMaps）。 */
  normalizedName: string;
  extracts?: UpstreamExtract[];
  transits?: UpstreamTransit[];
  locks?: UpstreamLock[];
  hazards?: UpstreamHazard[];
  lootContainers?: UpstreamLoot[];
  switches?: UpstreamSwitch[];
  stationaryWeapons?: UpstreamStationary[];
  spawns?: UpstreamSpawn[];
}

export interface UpstreamSpawn {
  position: { x: number; y: number; z: number };
  sides?: string[];
  categories?: string[];
  zoneName?: string;
}

export interface UpstreamExtract {
  id: string;
  name: string;
  faction: "pmc" | "scav" | "shared" | string;
  switch?: boolean;
  transferItem?: { item: string; count: number } | null;
  position: { x: number; y: number; z: number };
  outline?: { x: number; y: number; z: number }[];
  top?: number;
  bottom?: number;
}

export interface UpstreamTransit {
  id: string;
  description: string;
  map: string;
  position: { x: number; y: number; z: number };
  outline?: { x: number; y: number; z: number }[];
  top?: number;
  bottom?: number;
}

export interface UpstreamLock {
  id: string;
  lockType: string;
  key: string;
  needsPower?: boolean;
  position: { x: number; y: number; z: number };
}

export interface UpstreamHazard {
  id?: string;
  hazardType?: string;
  name?: string;
  position: { x: number; y: number; z: number };
  outline?: { x: number; y: number; z: number }[];
  top?: number;
  bottom?: number;
}

export interface UpstreamLoot {
  lootContainer: string;
  position: { x: number; y: number; z: number };
}

export interface UpstreamContainerMeta {
  id: string;
  name: string;
  normalizedName: string;
}

export interface UpstreamWeaponMeta {
  id: string;
  name: string;
  normalizedName: string;
}

export interface UpstreamSwitch {
  id?: string;
  name?: string;
  switchType?: string;
  position: { x: number; y: number; z: number };
  outline?: { x: number; y: number; z: number }[];
  top?: number;
  bottom?: number;
}

export interface UpstreamStationary {
  id?: string;
  stationaryWeapon?: string;
  position: { x: number; y: number; z: number };
}

export type Translations = Record<string, string>;

export interface DataStatus {
  key: string;
  ok: boolean;
  /** 当前用的是缓存的时间戳（毫秒）。 */
  cachedAt: number | null;
  error: string | null;
}

export interface DataBundle {
  mapsMeta: MapGroup[] | null;
  maps: UpstreamMaps | null;
  zh: Translations | null;
  status: Record<string, DataStatus>;
  loading: boolean;
}

export const DATA_KEYS = {
  mapsMeta: "mapsMeta",
  maps: "maps",
  mapsZh: "mapsZh",
} as const;

const URLS = {
  mapsMeta: MAPS_JSON_URL,
  maps: "https://json.tarkov.dev/regular/maps",
  mapsZh: "https://json.tarkov.dev/regular/maps_zh",
};

type Listener = (b: DataBundle) => void;

let bundle: DataBundle = {
  mapsMeta: null,
  maps: null,
  zh: null,
  status: {},
  loading: false,
};
const listeners = new Set<Listener>();
let started = false;

function emit() {
  listeners.forEach((l) => l(bundle));
}

function setStatus(key: string, s: Partial<DataStatus>) {
  const prev = bundle.status[key] ?? { key, ok: true, cachedAt: null, error: null };
  bundle.status = { ...bundle.status, [key]: { ...prev, ...s } };
  emit();
}

/** 只留下界面用得上的字段，顺带把 9MB 压到 1.4MB，好放进 localStorage。 */
function compactMaps(data: Record<string, unknown>): UpstreamMaps {
  const maps = (data.maps ?? {}) as Record<string, UpstreamMap>;
  const out: UpstreamMaps["maps"] = {};
  for (const [id, m] of Object.entries(maps)) {
    out[id] = {
      id: m.id ?? id,
      name: m.name,
      nameId: m.nameId,
      normalizedName: m.normalizedName,
      extracts: m.extracts,
      transits: m.transits,
      locks: m.locks,
      hazards: m.hazards,
      lootContainers: m.lootContainers,
      switches: m.switches,
      stationaryWeapons: m.stationaryWeapons,
      spawns: m.spawns,
    };
  }
  const pick = <T extends { id: string; name: string; normalizedName: string }>(
    src: Record<string, T> | undefined,
  ): Record<string, { id: string; name: string; normalizedName: string }> => {
    const dst: Record<string, { id: string; name: string; normalizedName: string }> = {};
    for (const [id, v] of Object.entries(src ?? {})) {
      dst[id] = { id: v.id ?? id, name: v.name, normalizedName: v.normalizedName };
    }
    return dst;
  };
  return {
    maps: out,
    lootContainers: pick(data.lootContainers as Record<string, UpstreamContainerMeta> | undefined),
    stationaryWeapons: pick(data.stationaryWeapons as Record<string, UpstreamWeaponMeta> | undefined),
  };
}

function normalizeMaps(json: unknown): UpstreamMaps {
  const data = (json as { data?: Record<string, unknown> })?.data;
  if (!data) throw new Error("maps 数据缺 data");
  return compactMaps(data);
}

function normalizeZh(json: unknown): Translations {
  const data = (json as { data?: unknown })?.data;
  if (!data || typeof data !== "object") throw new Error("maps_zh 数据缺 data");
  return data as Translations;
}

const NORMALIZERS: Record<string, (json: unknown) => unknown> = {
  mapsMeta: parseMapsMeta,
  maps: normalizeMaps,
  mapsZh: normalizeZh,
};

async function refresh(key: string) {
  try {
    const res = await fetch(URLS[key as keyof typeof URLS], { cache: "no-cache" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const data = NORMALIZERS[key](json);
    writeCache(key, data);
    apply(key, data, null);
    setStatus(key, { ok: true, cachedAt: Date.now(), error: null });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const cached = readCache(key);
    if (cached) {
      apply(key, cached.data, cached.fetchedAt);
      setStatus(key, { ok: false, error: msg, cachedAt: cached.fetchedAt });
    } else {
      setStatus(key, { ok: false, error: msg, cachedAt: null });
    }
  }
}

function apply(key: string, data: unknown, cachedAt: number | null) {
  if (key === "mapsMeta") bundle.mapsMeta = data as MapGroup[];
  else if (key === "maps") bundle.maps = data as UpstreamMaps;
  else if (key === "mapsZh") bundle.zh = data as Translations;
  if (cachedAt !== null) setStatus(key, { cachedAt });
  emit();
}

export const dataStore = {
  get: () => bundle,
  subscribe(l: Listener) {
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  },
  /** 启动时调用一次：先上缓存，再后台更新。 */
  start(force = false) {
    if (started && !force) return;
    started = true;
    bundle = { ...bundle, loading: true };
    for (const key of Object.keys(URLS)) {
      const cached = readCache(key);
      if (cached) apply(key, cached.data, cached.fetchedAt);
      setStatus(key, { cachedAt: cached?.fetchedAt ?? null });
    }
    emit();
    Promise.all(Object.keys(URLS).map((k) => refresh(k))).finally(() => {
      bundle = { ...bundle, loading: false };
      emit();
    });
  },
  age(key: string) {
    return cacheAge(key);
  },
  refreshAll() {
    for (const k of Object.keys(URLS)) refresh(k);
  },
};
