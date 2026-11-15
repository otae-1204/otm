// 把上游 json.tarkov.dev 的地图数据摊平成界面要画的标注。
// 子类清单（容器类型、出生点阵营、撤离点阵营、危险区类型）全部取自上游数据，不写死。

import type { Translations, UpstreamMap, UpstreamMaps } from "./loader";
import type { MapLayer, MapMeta } from "./mapsMeta";

export type CategoryId =
  | "extract"
  | "transit"
  | "lock"
  | "hazard"
  | "loot"
  | "spawn"
  | "switch"
  | "gun";

export interface GamePoint {
  x: number;
  y: number;
  z: number;
}

export interface Annotation {
  /** 稳定 id，用于 React key。 */
  key: string;
  category: CategoryId;
  /** 子类 id：物资是容器 id，出生点是阵营，撤离点是阵营，危险区是类型。 */
  sub: string;
  name: string;
  x: number;
  y: number;
  z: number;
  /** 撤离点/转移点/危险区/开关的外框，游戏坐标。 */
  outline?: GamePoint[];
  /** 外框的上下沿，用来判断它属于哪一层。 */
  top?: number;
  bottom?: number;
  icon: string;
  /** 卡片上额外显示的一行。 */
  note?: string;
}

export const CATEGORY_ORDER: CategoryId[] = [
  "extract",
  "transit",
  "lock",
  "hazard",
  "loot",
  "spawn",
  "switch",
  "gun",
];

/** 各大类的颜色（DESIGN 7.1 与 mockup2.html 的 --c-* 变量）。合并圆和子类 chip 用它。 */
export const CATEGORY_COLOR: Record<CategoryId, string> = {
  extract: "#3ddc84",
  transit: "#ff5d5d",
  lock: "#f5a524",
  hazard: "#f5a524",
  loot: "#9d8cff",
  spawn: "#7d8794",
  switch: "#7d8794",
  gun: "#7d8794",
};

export const CATEGORY_NAMES: Record<CategoryId, string> = {
  extract: "撤离点",
  transit: "转移点",
  lock: "上锁的门",
  hazard: "危险区",
  loot: "物资",
  spawn: "出生点",
  switch: "开关",
  gun: "固定武器",
};

/** 上游 lootContainers 的 normalizedName → 图标（app/public/icons/container_*.png）。 */
export const CONTAINER_ICON: Record<string, string> = {
  safe: "safe",
  "bank-safe": "safe",
  drawer: "drawer",
  "pc-block": "pc-block",
  "cash-register": "cash-register",
  "bank-cash-register": "cash-register",
  jacket: "jacket",
  toolbox: "toolbox",
  "dead-scav": "dead-scav",
  "scav-body": "dead-scav",
  "pmc-body": "dead-scav",
  "civilian-body": "dead-scav",
  "lab-technician-body": "dead-scav",
  medbag: "medbag",
  medcase: "medcase",
  "duffle-bag": "duffle-bag",
  "wooden-crate": "wooden-crate",
  "weapon-box": "weapon-box",
  "grenade-box": "grenade-box",
  "ground-cache": "ground-cache",
  "buried-barrel-cache": "buried-barrel-cache",
  "wooden-ammo-box": "wooden-ammo-box",
  "plastic-suitcase": "plastic-suitcase",
  "shturmans-stash": "buried-barrel-cache",
  "technical-supply-crate": "crate",
  "ration-supply-crate": "crate",
  "medical-supply-crate": "crate",
};

/** 上游容器名没翻译时用的中文名，键是 normalizedName。 */
const CONTAINER_ZH: Record<string, string> = {
  safe: "保险箱",
  "bank-safe": "银行保险箱",
  drawer: "抽屉柜",
  "pc-block": "电脑主机",
  "cash-register": "收银机",
  "bank-cash-register": "银行收银机",
  jacket: "夹克",
  toolbox: "工具箱",
  "dead-scav": "Scav 尸体",
  "scav-body": "Scav 尸体",
  "pmc-body": "PMC 尸体",
  "civilian-body": "平民尸体",
  "lab-technician-body": "实验室技工尸体",
  medbag: "医疗包",
  medcase: "医疗箱",
  "duffle-bag": "运动包",
  "wooden-crate": "木箱",
  "weapon-box": "武器箱",
  "grenade-box": "手雷箱",
  "ground-cache": "地面藏匿点",
  "buried-barrel-cache": "埋藏的桶",
  "wooden-ammo-box": "木弹药箱",
  "plastic-suitcase": "行李箱",
  "shturmans-stash": "Shturman 藏匿点",
  "technical-supply-crate": "技术物资箱",
  "ration-supply-crate": "食品物资箱",
  "medical-supply-crate": "医疗物资箱",
};

/** 出生点阵营 → 图标。上游 sides 里实际出现的是 pmc / scav / all / none。 */
const SPAWN_ICON: Record<string, string> = {
  pmc: "spawn_pmc",
  scav: "spawn_scav",
  all: "spawn_af",
  none: "spawn_af",
  boss: "spawn_boss",
  sniper: "spawn_sniper_scav",
  rogue: "spawn_rogue",
  cultist: "spawn_cultist-priest",
  bloodhound: "spawn_bloodhound",
  blackDiv: "spawn_black-div",
};

export const SPAWN_NAMES: Record<string, string> = {
  pmc: "PMC 出生点",
  scav: "Scav 出生点",
  all: "出生点",
  none: "出生点",
  boss: "Boss 出生点",
  sniper: "狙击 Scav 出生点",
  rogue: "Rogue 出生点",
  cultist: "邪教祭司出生点",
  bloodhound: "血猎犬出生点",
  blackDiv: "黑师出生点",
};

/** 上游的 sides 值 → 子类。只认阵营，别的值一律算"不确定"。 */
function spawnSub(sides?: string[]): string {
  const s = sides ?? [];
  for (const k of ["boss", "pmc", "scav", "sniper", "rogue", "cultist", "bloodhound", "blackDiv"]) {
    if (s.includes(k)) return k;
  }
  if (s.includes("all")) return "all";
  return "none";
}

export function extractFactionName(sub: string) {
  return sub === "pmc" ? "PMC 撤离点" : sub === "scav" ? "Scav 撤离点" : "共用撤离点";
}

export function extractIcon(sub: string) {
  return `extract_${sub === "pmc" || sub === "scav" ? sub : "shared"}`;
}

export interface SubItem {
  id: string;
  name: string;
  count: number;
  icon?: string;
}

export interface AnnotationSet {
  items: Annotation[];
  /** 子类清单，按出现顺序。 */
  subs: Partial<Record<CategoryId, SubItem[]>>;
}

export function buildAnnotations(
  map: UpstreamMap | null,
  upstream: UpstreamMaps | null,
  zh: Translations | null,
): AnnotationSet {
  const items: Annotation[] = [];
  if (!map) return { items, subs: {} };

  const tr = (key: string | undefined | null, fallback: string) => {
    if (!key) return fallback;
    return zh?.[key] ?? fallback;
  };

  for (const e of map.extracts ?? []) {
    const faction = e.faction === "scav" ? "scav" : e.faction === "pmc" ? "pmc" : "shared";
    items.push({
      key: `ex-${e.id}`,
      category: "extract",
      sub: faction,
      name: tr(e.name, e.name),
      x: e.position.x,
      y: e.position.y,
      z: e.position.z,
      outline: e.outline,
      top: e.top,
      bottom: e.bottom,
      icon: extractIcon(faction),
      note: e.switch ? "需要开关" : e.transferItem ? "需要上交物品" : undefined,
    });
  }

  for (const t of map.transits ?? []) {
    items.push({
      key: `tr-${t.id}`,
      category: "transit",
      sub: "",
      name: tr(t.description, t.description),
      x: t.position.x,
      y: t.position.y,
      z: t.position.z,
      outline: t.outline,
      top: t.top,
      bottom: t.bottom,
      icon: "extract_transit",
    });
  }

  for (const l of map.locks ?? []) {
    items.push({
      key: `lk-${l.id}`,
      category: "lock",
      sub: l.lockType ?? "",
      name: l.lockType === "trunk" ? "上锁的容器" : "上锁的门",
      x: l.position.x,
      y: l.position.y,
      z: l.position.z,
      icon: "lock",
      note: l.needsPower ? "需要通电" : undefined,
    });
  }

  for (const h of map.hazards ?? []) {
    const type = h.hazardType ?? "";
    items.push({
      key: `hz-${h.id ?? `${h.position.x}-${h.position.z}`}`,
      category: "hazard",
      sub: type,
      name: tr(h.name, type === "mortar" ? "炮击区" : "危险区"),
      x: h.position.x,
      y: h.position.y,
      z: h.position.z,
      outline: h.outline,
      top: h.top,
      bottom: h.bottom,
      icon: type === "mortar" ? "hazard_mortar" : "hazard",
    });
  }

  for (const [i, c] of (map.lootContainers ?? []).entries()) {
    const meta = upstream?.lootContainers?.[c.lootContainer];
    const norm = meta?.normalizedName ?? c.lootContainer;
    const icon = CONTAINER_ICON[norm] ?? "crate";
    items.push({
      key: `lt-${i}-${c.lootContainer}`,
      category: "loot",
      // 子类按容器类型（normalizedName）分，同一个类型的多个 id 合成一个开关
      sub: norm,
      name: containerName(c.lootContainer, upstream, zh),
      x: c.position.x,
      y: c.position.y,
      z: c.position.z,
      icon: `container_${icon}`,
    });
  }

  for (const [i, s] of (map.spawns ?? []).entries()) {
    const sub = spawnSub(s.sides);
    items.push({
      key: `sp-${i}-${sub}`,
      category: "spawn",
      sub,
      name: SPAWN_NAMES[sub] ?? "出生点",
      x: s.position.x,
      y: s.position.y,
      z: s.position.z,
      icon: SPAWN_ICON[sub] ?? "spawn_af",
    });
  }

  for (const [i, s] of (map.switches ?? []).entries()) {
    items.push({
      key: `sw-${s.id ?? i}`,
      category: "switch",
      sub: "",
      name: s.name ? tr(s.name, s.name) : "开关",
      x: s.position.x,
      y: s.position.y,
      z: s.position.z,
      outline: s.outline,
      top: s.top,
      bottom: s.bottom,
      icon: "switch",
    });
  }

  for (const [i, g] of (map.stationaryWeapons ?? []).entries()) {
    const meta = g.stationaryWeapon ? upstream?.stationaryWeapons?.[g.stationaryWeapon] : undefined;
    items.push({
      key: `gn-${g.id ?? i}`,
      category: "gun",
      sub: "",
      name: meta ? (zh?.[meta.name] ?? meta.normalizedName) : "固定武器",
      x: g.position.x,
      y: g.position.y,
      z: g.position.z,
      icon: "stationarygun",
    });
  }

  // 子类清单：物资按容器类型，出生点按阵营，撤离点按阵营，危险区按类型
  const subs: AnnotationSet["subs"] = {};
  const push = (cat: CategoryId, id: string, name: string, icon?: string) => {
    const list = (subs[cat] ??= []);
    const found = list.find((s) => s.id === id);
    if (found) found.count++;
    else list.push({ id, name, count: 1, icon });
  };
  for (const a of items) {
    if (a.category === "loot") push("loot", a.sub, a.name, a.icon);
    else if (a.category === "spawn") push("spawn", a.sub, a.name, a.icon);
    else if (a.category === "extract") push("extract", a.sub, extractFactionName(a.sub), a.icon);
    else if (a.category === "hazard") push("hazard", a.sub, a.name, a.icon);
  }
  return { items, subs };
}

export function containerName(
  id: string,
  upstream: UpstreamMaps | null,
  zh: Translations | null,
) {
  const meta = upstream?.lootContainers?.[id];
  if (!meta) return id;
  return zh?.[meta.name] ?? CONTAINER_ZH[meta.normalizedName] ?? meta.normalizedName;
}

/** 标注落在哪一层：先看高度落在哪个 extent，再看区域框。返回 -1 表示不属于任何一层。 */
export function layerOfPoint(
  layers: MapLayer[] | undefined,
  p: GamePoint,
  top?: number,
  bottom?: number,
): number {
  if (!layers || layers.length === 0) return -1;
  const t = top ?? p.y;
  const b = bottom ?? p.y;
  for (let i = 0; i < layers.length; i++) {
    for (const ext of layers[i].extents ?? []) {
      // 与上游 markerIsOnLayer 一致：整体落在高度范围内，再看是否落在某个区域框里
      if (!(t >= ext.height[0] && b < ext.height[1])) continue;
      if (!ext.bounds || ext.bounds.length === 0) return i;
      for (const bd of ext.bounds) {
        const x0 = Math.min(bd[0][0], bd[1][0]);
        const x1 = Math.max(bd[0][0], bd[1][0]);
        const z0 = Math.min(bd[0][1], bd[1][1]);
        const z1 = Math.max(bd[0][1], bd[1][1]);
        if (p.x >= x0 && p.x <= x1 && p.z >= z0 && p.z <= z1) return i;
      }
    }
  }
  return -1;
}

/** 楼层显示名。 */
export const LAYER_NAMES: Record<string, string> = {
  "2nd Floor": "2F",
  "3rd Floor": "3F",
  "4th Floor": "4F",
  "5th Floor": "5F",
  "First Floor": "1F",
  "Second Floor": "2F",
  "Third Floor": "3F",
  "Fourth Floor": "4F",
  "Fifth Floor": "5F",
  "Second Level": "2F",
  Underground: "B1",
  Basement: "B1",
  Tunnels: "B1",
  Garage: "B1",
  Bunkers: "B1",
  Technical: "B1",
  Infirmary: "医务室",
  Helipad: "停机坪",
  "Gym/Canteen": "健身房",
  "Accommodation (lower)": "下层舱",
  "Accommodation (mid)": "中层舱",
  "Accommodation (upper)": "上层舱",
  "Officers' Deck": "军官甲板",
  "Stairs (blocked)": "楼梯",
  Bridge: "舰桥",
  "Bridge Roof": "舰桥顶",
  "Control Room": "控制室",
  "Engine Room": "机舱",
  "Engine Room (upper)": "机舱上层",
  "Fuel Pumps (lower)": "油泵下层",
  "Fuel Pumps": "油泵",
  "Storage/Security": "仓储",
};

export function layerName(name: string) {
  return LAYER_NAMES[name] ?? name;
}

/**
 * 地图上的地名。上游的 labels 只有英文（Old Gas、Dorms 这些），
 * 中文名要按 maps_zh 里的同名键取；没有中文名的就不显示。
 */
export function mapLabels(
  meta: MapMeta | null,
  zh: Translations | null,
): { text: string; x: number; z: number; y: number }[] {
  if (!meta?.labels) return [];
  // 与上游一致：地名默认放在整张图高度范围的中点上
  const mid = meta.heightRange ? (meta.heightRange[0] + meta.heightRange[1]) / 2 : 0;
  const out: { text: string; x: number; z: number; y: number }[] = [];
  for (const l of meta.labels) {
    const text = zh?.[l.text];
    if (!text) continue;
    const y =
      l.position.length > 2
        ? l.position[2]
        : l.top !== undefined && l.bottom !== undefined
          ? (l.top + l.bottom) / 2
          : mid;
    out.push({ text, x: l.position[0], z: l.position[1], y });
  }
  return out;
}
