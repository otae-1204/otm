// 地图上的标注层：按筛选和楼层过滤，密集时合并成带数字的圆（DESIGN 7.1）。

import L from "leaflet";
import type { Annotation } from "../data/annotations";
import { annotationIcon, clusterIcon } from "./icons";

/** 合并半径（屏幕像素）：两个标注靠得比这近就合成一个圆。 */
const CLUSTER_PX = 24;

export interface AnnotationLayer {
  render(items: Annotation[], zoom: number): void;
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

  function render(items: Annotation[], zoom: number) {
    group.clearLayers();
    shown = items;
    if (items.length === 0) return;

    // 贪心合并：按顺序放进第一个足够近的组，组的中心跟着更新。
    // 比按格子分桶稳，不会出现两个圆心叠在一起。
    const groups: Annotation[][] = [];
    const centers: L.Point[] = [];
    for (const a of items) {
      const p = map.project([a.z, a.x], zoom);
      let hit = -1;
      let bestD = CLUSTER_PX;
      for (let i = 0; i < centers.length; i++) {
        const d = centers[i].distanceTo(p);
        if (d <= bestD) {
          bestD = d;
          hit = i;
        }
      }
      if (hit >= 0) {
        groups[hit].push(a);
        const c = centers[hit];
        centers[hit] = L.point(
          (c.x * (groups[hit].length - 1) + p.x) / groups[hit].length,
          (c.y * (groups[hit].length - 1) + p.y) / groups[hit].length,
        );
      } else {
        groups.push([a]);
        centers.push(p);
      }
    }

    for (const list of groups) {
      if (list.length === 1) {
        const a = list[0];
        const m = L.marker([a.z, a.x], { icon: annotationIcon(a), keyboard: false });
        m.on("click", () => onClick(a));
        m.addTo(group);
      } else {
        let sx = 0;
        let sz = 0;
        for (const a of list) {
          sx += a.x;
          sz += a.z;
        }
        const c = L.marker([sz / list.length, sx / list.length], {
          icon: clusterIcon(list.length),
          keyboard: false,
        });
        c.on("click", () => {
          onClick(null);
          map.setView([sz / list.length, sx / list.length], Math.min(map.getZoom() + 1.5, map.getMaxZoom()), {
            animate: true,
          });
        });
        c.addTo(group);
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
