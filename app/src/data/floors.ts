// 楼层归属：一个标注（或者自己）算在哪一层。
//
// 规则照搬上游 tarkov.dev 的 markerIsOnLayer：高度落在某个 extent 的 [h0, h1) 里，
// 并且（如果这个 extent 给了 bounds）平面位置落在其中一块 bounds 里，才算这一层。
// 同一张图上不同建筑的二楼高度不一样（海关宿舍楼和别处就不一样），
// 所以只看高度不看 bounds 会串层。
//
// 哪一层都不属于的算地面（GROUND = -1）：底图本身就是地面，地面不是 maps.json 里的一层。
//
// 这里全是纯函数，不碰 Leaflet，可以直接跑单元测试（见 scripts/floors.test.mjs）。

import type { MapLayer, MapMeta } from "./mapsMeta";

export interface GamePoint {
  x: number;
  y: number;
  z: number;
}

/** 地面：不属于任何一层。 */
export const GROUND = -1;

/** 带上下沿的东西（撤离点、危险区、开关的标注）。 */
export interface LayerPoint extends GamePoint {
  top?: number;
  bottom?: number;
}

/**
 * 点（或一段高度）属于哪一层，返回层索引；不属于任何一层返回 GROUND。
 * top/bottom 缺省时用 position.y。
 */
export function layerOfPoint(
  layers: MapLayer[] | undefined,
  p: GamePoint,
  top?: number,
  bottom?: number,
): number {
  if (!layers || layers.length === 0) return GROUND;
  const t = top ?? p.y;
  const b = bottom ?? p.y;
  for (let i = 0; i < layers.length; i++) {
    for (const ext of layers[i].extents ?? []) {
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
  return GROUND;
}

/** 标注属于哪一层：有 top/bottom 的用它，没有的用 position.y。 */
export function annotationLayer(meta: MapMeta | null, a: LayerPoint): number {
  return layerOfPoint(meta?.layers, a, a.top, a.bottom);
}

/** 这个点是不是就在这一层上。选中哪一层就只显示哪一层，别的层一个都不出现。 */
export function onLayer(
  meta: MapMeta | null,
  layer: number,
  p: GamePoint,
  top?: number,
  bottom?: number,
): boolean {
  return layerOfPoint(meta?.layers, p, top, bottom) === layer;
}
