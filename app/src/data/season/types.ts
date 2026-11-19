// 赛季包的格式（DESIGN 6.7.1）。
//
// 赛季限定内容全在这份 JSON 里：赛季名、有哪几种文件、每种文件对应哪个上游物品、
// 每张图的刷新点、每日上限、出处和署名。程序里不写死任何赛季内容，
// 换一个赛季就是换一份赛季包；没有赛季包时相关界面整体不出现。
//
// 生成脚本：design/prototypes/season_pack.py（从 eftarkov_points.json 生成）。

import type { SessionMode } from "../../types";

export const PACK_FORMAT = "otm-season-pack";
/** 程序读得懂的最高版本。 */
export const PACK_VERSION = 1;

/** 一种文件。id 是程序里的名字（子类开关的键），item 是上游物品 id（物品图按它取）。 */
export interface SeasonType {
  id: string;
  name: string;
  /** 上游物品 id：详情页标题和悬停卡片里的物品图按它取。 */
  item: string;
  /** 地图上的徽章和筛选里的子类标签用这个颜色，8 种各不相同。 */
  color: string;
}

/**
 * 包里没写颜色时按种类在 types 里的顺序取一个（换进来的包未必带颜色）。
 * 顺序与生成脚本里的 TYPE_COLORS 一致。
 */
export const TYPE_COLORS = [
  "#7fd8ff",
  "#4a54ff",
  "#ff5ec4",
  "#2fd0d4",
  "#e6ecf5",
  "#ff9ef0",
  "#cfe3ff",
  "#b07bff",
];

/**
 * 一个刷新点。x/z 是游戏坐标；floor 是 maps.json 里那一层的名字，
 * null 表示地面（不在任何一层，底图本身就是它）。
 */
export interface SeasonPoint {
  type: string;
  x: number;
  z: number;
  /** maps.json 里那一层的名字；null 表示画在地面层。 */
  floor: string | null;
  /**
   * 网站原来写的楼层（"2F"、"B1"）。楼层对不上、点位被放到地面层时，
   * 详情里仍要显示它原来在哪一层，这里存的就是那句话。
   */
  floorLabel?: string;
  desc: string;
  /** 网站上的照片路径，相对 source.photos；也可以直接写完整地址。 */
  images: string[];
}

export interface SeasonMap {
  /** maps.json 里的 key（工厂的夜图、实验室的暗图都会落到同一个 key）。 */
  key: string;
  name: string;
  points: SeasonPoint[];
}

export interface SeasonPack {
  season: { name: string };
  /** 每日拾取上限，按档案分开；缺的按 0（不显示）。 */
  limits: Partial<Record<SessionMode, number>>;
  source: { name: string; url: string; photos?: string };
  types: SeasonType[];
  maps: SeasonMap[];
}

export interface ParseOk {
  pack: SeasonPack;
  /** 读的时候丢掉了什么，给人看的。 */
  warnings: string[];
}
export interface ParseFail {
  error: string;
}

const MODES: SessionMode[] = ["Regular", "Pve", "PvpSeason"];

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v : null;
}

/** #rgb / #rrggbb，别的都不认（填错了退回默认色，不连累整份包）。 */
function hex(v: unknown): string | null {
  return typeof v === "string" && /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(v.trim()) ? v.trim().toLowerCase() : null;
}

/**
 * 读一份赛季包。结构不对就整份不用（返回 error），单个点位不对就丢掉那一个。
 * 这里的判断要松一点：用户换进来的包未必是我们生成的，多几个字段不算错。
 */
export function parsePack(raw: unknown): ParseOk | ParseFail {
  if (!isObj(raw)) return { error: "不是 JSON 对象" };
  if (raw.format !== PACK_FORMAT) return { error: "不是赛季包" };
  if (typeof raw.version !== "number" || raw.version > PACK_VERSION) {
    return { error: "赛季包版本太新" };
  }

  const warnings: string[] = [];

  const types: SeasonType[] = [];
  for (const t of Array.isArray(raw.types) ? raw.types : []) {
    if (!isObj(t)) continue;
    const id = str(t.id);
    const name = str(t.name);
    const item = str(t.item);
    if (!id || !name || !item) continue;
    if (types.some((x) => x.id === id)) continue;
    const color = hex(t.color) ?? TYPE_COLORS[types.length % TYPE_COLORS.length];
    types.push({ id, name, item, color });
  }
  if (types.length === 0) return { error: "没有文件种类" };
  const typeIds = new Set(types.map((t) => t.id));

  const sourceRaw = isObj(raw.source) ? raw.source : {};
  const sourceName = str(sourceRaw.name);
  const sourceUrl = str(sourceRaw.url);
  if (!sourceName || !sourceUrl) return { error: "缺出处和署名" };

  const limits: Partial<Record<SessionMode, number>> = {};
  const limRaw = isObj(raw.limits) ? raw.limits : {};
  for (const m of MODES) {
    const v = limRaw[m];
    if (typeof v === "number" && Number.isFinite(v) && v > 0) limits[m] = Math.round(v);
  }

  const maps: SeasonMap[] = [];
  let dropped = 0;
  for (const m of Array.isArray(raw.maps) ? raw.maps : []) {
    if (!isObj(m)) continue;
    const key = str(m.key);
    if (!key) continue;
    const points: SeasonPoint[] = [];
    for (const p of Array.isArray(m.points) ? m.points : []) {
      if (!isObj(p)) continue;
      const type = str(p.type);
      const x = p.x;
      const z = p.z;
      if (!type || !typeIds.has(type) || typeof x !== "number" || typeof z !== "number") {
        dropped++;
        continue;
      }
      if (!Number.isFinite(x) || !Number.isFinite(z)) {
        dropped++;
        continue;
      }
      const floorLabel = str(p.floorLabel);
      points.push({
        type,
        x,
        z,
        floor: str(p.floor),
        ...(floorLabel ? { floorLabel } : {}),
        desc: str(p.desc) ?? "",
        images: (Array.isArray(p.images) ? p.images : []).filter((s): s is string => typeof s === "string"),
      });
    }
    if (points.length === 0) continue;
    maps.push({ key, name: str(m.name) ?? key, points });
  }
  if (maps.length === 0) return { error: "没有刷新点" };
  if (dropped > 0) warnings.push(`丢掉 ${dropped} 个不认识的刷新点`);

  const seasonName = isObj(raw.season) ? (str(raw.season.name) ?? "赛季") : "赛季";
  return {
    pack: {
      season: { name: seasonName },
      limits,
      source: { name: sourceName, url: sourceUrl, photos: str(sourceRaw.photos) ?? undefined },
      types,
      maps,
    },
    warnings,
  };
}

/** 一张图的刷新点里出现过几种文件，按 pack.types 的顺序。 */
export function typesOnMap(pack: SeasonPack, mapKey: string | null): SeasonType[] {
  const map = pack.maps.find((m) => m.key === mapKey);
  if (!map) return [];
  const used = new Set(map.points.map((p) => p.type));
  return pack.types.filter((t) => used.has(t.id));
}

/** 一种文件在哪些图刷新，按 pack.maps 的顺序。 */
export function mapsOfType(pack: SeasonPack, typeId: string): SeasonMap[] {
  return pack.maps.filter((m) => m.points.some((p) => p.type === typeId));
}

/** 照片的完整地址。 */
export function photoUrl(pack: SeasonPack, path: string): string {
  if (/^https?:\/\//.test(path)) return path;
  const base = pack.source.photos ?? pack.source.url;
  return base.replace(/\/+$/, "") + (path.startsWith("/") ? path : `/${path}`);
}
