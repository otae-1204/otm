// 把赛季包的刷新点摊成地图上的标注。
//
// 赛季包里的点位自带楼层（maps.json 里那一层的名字，null 是地面），
// 不像上游的标注那样只有高度，所以这里直接算出层号挂在标注上，
// 按层过滤时不用再算高度和区域。

import type { Annotation, AnnotationSet } from "../annotations";
// 带 .ts 后缀：单元测试用 node 直接跑这些文件，node 不认没后缀的相对导入
import { GROUND } from "../floors.ts";
import type { MapMeta } from "../mapsMeta";
import type { SeasonPack } from "./types";

/** 赛季包里的层名 → maps.json 的层号；对不上（换了版本）当地面。 */
export function layerIndexOf(meta: MapMeta | null, floor: string | null): number {
  if (!floor || !meta?.layers) return GROUND;
  const i = meta.layers.findIndex((l) => l.name === floor);
  return i < 0 ? GROUND : i;
}

/** 当前这张图的赛季刷新点，摊成标注。没有赛季包、这张图不刷就是空的。 */
export function seasonItems(pack: SeasonPack | null, meta: MapMeta | null): Annotation[] {
  if (!pack || !meta) return [];
  const map = pack.maps.find((m) => m.key === meta.key);
  if (!map) return [];
  const types = new Map(pack.types.map((t) => [t.id, t]));
  const out: Annotation[] = [];
  map.points.forEach((p, i) => {
    out.push({
      key: `se-${map.key}-${i}`,
      category: "season",
      sub: p.type,
      name: types.get(p.type)?.name ?? p.type,
      x: p.x,
      z: p.z,
      // 赛季点位的楼层是给的，不是按高度算的，y 不用
      y: 0,
      layer: layerIndexOf(meta, p.floor),
      // 图标用物品图：地图上是文件形状的徽章，物品图留给详情标题和悬停卡片
      icon: types.get(p.type) ? `doc_${types.get(p.type)!.item}` : "season",
      item: types.get(p.type)?.item ?? undefined,
      color: types.get(p.type)?.color,
      note: p.desc,
      season: { type: p.type, index: i },
    });
  });
  return out;
}

/** 并进当前这张图的标注集：点位 + 子类清单（本图会刷的几种文件）。 */
export function withSeason(set: AnnotationSet, pack: SeasonPack | null, meta: MapMeta | null): AnnotationSet {
  if (!pack || !meta) return set;
  const map = pack.maps.find((m) => m.key === meta.key);
  if (!map) return set;
  const count = new Map<string, number>();
  for (const p of map.points) count.set(p.type, (count.get(p.type) ?? 0) + 1);
  const subs = pack.types
    .filter((t) => count.has(t.id))
    .map((t) => ({
      id: t.id,
      name: t.name,
      count: count.get(t.id) ?? 0,
      icon: `doc_${t.item}`,
      item: t.item,
      color: t.color,
    }));
  return { items: [...set.items, ...seasonItems(pack, meta)], subs: { ...set.subs, season: subs } };
}
