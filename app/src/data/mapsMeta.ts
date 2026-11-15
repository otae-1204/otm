// tarkov.dev 的静态地图配置（矢量/栅格底图、transform、楼层、区域名）。
// 上游文件：https://raw.githubusercontent.com/the-hideout/tarkov-dev/main/src/data/maps.json

import type { Translations, UpstreamMap, UpstreamMaps } from "./loader";

export const MAPS_JSON_URL =
  "https://raw.githubusercontent.com/the-hideout/tarkov-dev/main/src/data/maps.json";

export interface MapExtent {
  height: [number, number];
  bounds?: [number, number, string][][];
}

export interface MapLayer {
  name: string;
  svgLayer?: string;
  tilePath?: string;
  show?: boolean;
  extents?: MapExtent[];
}

export interface MapLabel {
  /** [x, z] 或 [x, z, y]。 */
  position: number[];
  text: string;
  rotation?: string | number;
  size?: number;
  top?: number;
  bottom?: number;
}

export interface MapMeta {
  key: string;
  /** 同一张图的其它 key（工厂的夜图、实验室的暗图等）。 */
  altMaps?: string[];
  projection?: string;
  tileSize?: number;
  minZoom?: number;
  maxZoom?: number;
  transform?: number[];
  coordinateRotation?: number;
  bounds: number[][];
  svgBounds?: number[][];
  author?: string;
  authorLink?: string;
  svgPath?: string;
  svgLayer?: string;
  tilePath?: string;
  heightRange?: [number, number];
  layers?: MapLayer[];
  labels?: MapLabel[];
}

export interface MapGroup {
  normalizedName: string;
  primaryPath?: string;
  maps: MapMeta[];
}

export function parseMapsMeta(json: unknown): MapGroup[] {
  if (!Array.isArray(json)) throw new Error("maps.json 格式不对");
  return json as MapGroup[];
}

/**
 * 上游没有单独配置的游戏地图，用哪张图的配置。
 * 只有中心区的教学图是这样：上游给它 normalizedName = ground-zero-tutorial，
 * 但 maps.json 里既没有这个 key，ground-zero 的 altMaps 里也没有它。
 */
const CONFIG_ALIASES: Record<string, string> = {
  "ground-zero-tutorial": "ground-zero",
};

/** 按上游的 normalizedName（或 altMaps 里的名字）找配置。 */
export function findMapMeta(groups: MapGroup[], key: string | null): MapMeta | null {
  if (!key) return null;
  const wanted = CONFIG_ALIASES[key] ?? key;
  for (const g of groups) {
    for (const m of g.maps) {
      if (m.projection !== "interactive") continue;
      if (m.key === wanted || (m.altMaps ?? []).includes(wanted)) return m;
    }
  }
  return null;
}

/**
 * 日志里 `scene preset path:maps/xxx_preset.bundle rcid:<名字>.scenespreset.asset`
 * 的名字不一定等于地点名：立交桥的预设叫 Shopping_Mall，地点叫 Interchange。
 * 加载阶段的 raid_loading 用的是预设名，开始后 raid_started 用的是地点名。
 */
const PRESET_ALIASES: Record<string, string> = {
  Shopping_Mall: "Interchange",
};

export function canonicalGameMap(gameMap: string | null): string | null {
  if (!gameMap) return null;
  return PRESET_ALIASES[gameMap] ?? gameMap;
}

/** 游戏内部地图名 → 上游地图对象。上游的 nameId 就是游戏内部名。 */
export function upstreamMapOf(maps: UpstreamMaps | null, gameMap: string | null): UpstreamMap | null {
  const name = canonicalGameMap(gameMap);
  if (!maps || !name) return null;
  for (const m of Object.values(maps.maps)) {
    if (m.nameId === name) return m;
  }
  return null;
}

/** 地图的中文名：maps_zh 里按 `${id} Name` 取。 */
export function mapName(upstream: UpstreamMap | null, zh: Translations | null, gameMap: string | null) {
  if (upstream) {
    const t = zh?.[`${upstream.id} Name`];
    if (t) return t;
  }
  return (gameMap && GAME_MAP_NAMES[canonicalGameMap(gameMap) ?? ""]) || upstream?.normalizedName || gameMap || "";
}

/** 状态栏地图列表里的一项。 */
export interface MapChoice {
  gameMap: string;
  normalizedName: string;
  label: string;
}

/** 列表顺序：先按这里的顺序，没列到的排在后面。 */
const ORDER = [
  "customs",
  "woods",
  "factory",
  "night-factory",
  "interchange",
  "shoreline",
  "reserve",
  "lighthouse",
  "streets-of-tarkov",
  "ground-zero",
  "ground-zero-21",
  "ground-zero-tutorial",
  "the-lab",
  "the-lab-dark",
  "infected-lab",
  "the-labyrinth",
  "terminal",
  "icebreaker",
  "infected-factory",
];

/** 能画的地图（有配置的）列表，给状态栏的手动选图用。 */
export function mapChoices(
  maps: UpstreamMaps | null,
  groups: MapGroup[],
  zh: Translations | null,
): MapChoice[] {
  if (!maps) return [];
  const out: MapChoice[] = [];
  for (const m of Object.values(maps.maps)) {
    const meta = findMapMeta(groups, m.normalizedName);
    if (!meta) continue;
    out.push({ gameMap: m.nameId, normalizedName: m.normalizedName, label: mapName(m, zh, m.nameId) });
  }
  const rank = (g: string) => {
    const i = ORDER.indexOf(g);
    return i < 0 ? ORDER.length : i;
  };
  return out.sort(
    (a, b) => rank(a.normalizedName) - rank(b.normalizedName) || a.label.localeCompare(b.label, "zh"),
  );
}

/** 游戏内部地图名的中文名。上游数据没到之前用它兜底。 */
export const GAME_MAP_NAMES: Record<string, string> = {
  bigmap: "海关",
  Woods: "森林",
  Shoreline: "海岸线",
  Interchange: "立交桥",
  RezervBase: "储备站",
  Lighthouse: "灯塔",
  laboratory: "实验室",
  laboratory_dark: "实验室 (Dark)",
  laboratory_event: "实验室疫区",
  TarkovStreets: "街区",
  factory4_day: "工厂",
  factory4_night: "夜间工厂",
  factory_event: "工厂疫区",
  Sandbox: "中心区",
  Sandbox_high: "中心区 21+",
  Sandbox_start: "中心区 教程",
  Labyrinth: "迷宫",
  Terminal: "码头",
  Icebreaker: "破冰船",
};
