// 地图上的标注层：按筛选和楼层过滤，密集时合并成带数字的圆（DESIGN 7.1）。
//
// 合并只在同一大类内部做，圆圈用该大类的颜色；合并半径随缩放变化：
// 整张图铺满窗口时半径很大，只剩少量圆圈；放大到能看清建筑时散成单个图标。
// 撤离点、转移点、危险区数量少又重要，任何缩放下都不合并。

import L from "leaflet";
import type { Annotation, CategoryId } from "../data/annotations";
import { CATEGORY_COLOR } from "../data/annotations";
import { annotationIcon, clusterIcon } from "./icons";

/**
 * 每个大类的合并半径（屏幕像素），按「相对整张图铺满窗口的缩放级数」分段：
 * [dz 上限, 半径]。超出最后一段就不合并。
 */
const CLUSTER_PX: Partial<Record<CategoryId, [number, number][]>> = {
  loot: [
    [0.9, 58],
    [1.6, 30],
    [2.2, 14],
  ],
  spawn: [
    [0.9, 62],
    [1.6, 32],
    [2.2, 16],
  ],
  lock: [
    [0.9, 42],
    [1.6, 18],
  ],
  gun: [
    [0.9, 34],
    [1.6, 16],
  ],
};

/**
 * 全图视角下每个大类最多留几个圆。物资在不同图上从几十到几百个不等，
 * 光靠固定半径压不住，所以圆太多时把半径放大重算，直到降到这个数。
 */
const CLUSTER_TARGET: Partial<Record<CategoryId, number>> = {
  loot: 20,
  spawn: 12,
  lock: 12,
  gun: 6,
};

/** 单个图标的尺寸：整张图 16px，放大到建筑级 27px。 */
function iconSize(dz: number): number {
  return Math.round(16 + Math.min(Math.max(dz, 0), 4) * 3.5);
}

function clusterRadius(cat: CategoryId, dz: number): number {
  const steps = CLUSTER_PX[cat];
  if (!steps) return 0;
  for (const [limit, px] of steps) if (dz < limit) return px;
  return 0;
}

export interface AnnotationLayer {
  render(items: Annotation[], zoom: number, fitZoom: number): void;
  clear(): void;
  /** 当前渲染出来的标注（未合并的），用来找卡片。 */
  visible(): Annotation[];
}

export function createAnnotationLayer(
  map: L.Map,
  onClick: (a: Annotation | null) => void,
): AnnotationLayer {
  const group = L.layerGroup().addTo(map);
  let shown: Annotation[] = [];

  /** 贪心合并：按顺序放进第一个足够近的组，组的中心跟着更新。 */
  function cluster(items: Annotation[], radius: number, zoom: number): { list: Annotation[]; at: L.Point }[] {
    const groups: { list: Annotation[]; at: L.Point }[] = [];
    for (const a of items) {
      const p = map.project([a.z, a.x], zoom);
      let hit: { list: Annotation[]; at: L.Point } | null = null;
      let bestD = radius;
      for (const g of groups) {
        const d = g.at.distanceTo(p);
        if (d <= bestD) {
          bestD = d;
          hit = g;
        }
      }
      if (hit) {
        const n = hit.list.length;
        hit.list.push(a);
        hit.at = L.point((hit.at.x * n + p.x) / (n + 1), (hit.at.y * n + p.y) / (n + 1));
      } else {
        groups.push({ list: [a], at: p });
      }
    }
    return groups;
  }

  function render(items: Annotation[], zoom: number, fitZoom: number) {
    group.clearLayers();
    shown = items;
    if (items.length === 0) return;

    // 只画视野里的：放大后物资有几百个，全画出来既慢又没必要
    const view = map.getBounds().pad(0.15);
    const items2 = items.filter((a) => view.contains([a.z, a.x]));
    if (items2.length === 0) return;

    const dz = zoom - fitZoom;
    const size = iconSize(dz);

    // 先按大类分桶，再各自合并：不同大类永远不混在一个圆里
    const byCat = new Map<CategoryId, Annotation[]>();
    for (const a of items2) {
      const list = byCat.get(a.category);
      if (list) list.push(a);
      else byCat.set(a.category, [a]);
    }

    for (const [cat, list] of byCat) {
      const radius = clusterRadius(cat, dz);
      let groups = radius > 0 ? cluster(list, radius, zoom) : list.map((a) => ({ list: [a], at: L.point(0, 0) }));
      const target = CLUSTER_TARGET[cat];
      if (radius > 0 && target) {
        let r = radius;
        for (let i = 0; i < 5 && groups.length > target; i++) {
          r *= 1.35;
          groups = cluster(list, r, zoom);
        }
      }
      for (const g of groups) {
        if (g.list.length === 1) {
          const a = g.list[0];
          const m = L.marker([a.z, a.x], { icon: annotationIcon(a, size), keyboard: false });
          m.on("click", () => onClick(a));
          m.addTo(group);
        } else {
          let sx = 0;
          let sz = 0;
          for (const a of g.list) {
            sx += a.x;
            sz += a.z;
          }
          const lat = sz / g.list.length;
          const lng = sx / g.list.length;
          const c = L.marker([lat, lng], {
            icon: clusterIcon(g.list.length, CATEGORY_COLOR[cat]),
            keyboard: false,
          });
          c.on("click", () => {
            onClick(null);
            map.setView([lat, lng], Math.min(map.getZoom() + 1.5, map.getMaxZoom()), { animate: true });
          });
          c.addTo(group);
        }
      }
    }
  }

  return {
    render,
    clear() {
      group.clearLayers();
      shown = [];
    },
    visible: () => shown,
  };
}
