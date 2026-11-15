// 自己的位置、轨迹、撤离点/危险区的外框。

import L from "leaflet";
import type { Annotation } from "../data/annotations";
import type { MapMeta } from "../data/mapsMeta";
import type { Position, TrailPoint } from "../types";
import { playerIcon, staleLabelIcon, type PlayerLook } from "./icons";

export interface PlayerLayer {
  update(
    meta: MapMeta | null,
    pos: Position | null,
    trail: TrailPoint[],
    showTrail: boolean,
    look: PlayerLook,
    staleText: string | null,
  ): void;
  clear(): void;
}

export function createPlayerLayer(map: L.Map): PlayerLayer {
  const trailLayer = L.layerGroup().addTo(map);
  const markerLayer = L.layerGroup().addTo(map);
  let marker: L.Marker | null = null;
  let lastTrailKey = "";
  let lastMarkerKey = "";

  function clear() {
    trailLayer.clearLayers();
    markerLayer.clearLayers();
    marker = null;
    lastTrailKey = "";
    lastMarkerKey = "";
  }

  return {
    update(meta, pos, trail, showTrail, look, staleText) {
      // 轨迹
      const trailKey = showTrail ? `${trail.length}:${trail[0]?.time ?? ""}:${trail.at(-1)?.time ?? ""}` : "off";
      if (trailKey !== lastTrailKey) {
        lastTrailKey = trailKey;
        trailLayer.clearLayers();
        if (showTrail && trail.length > 1) {
          L.polyline(
            trail.map((p) => [p.z, p.x] as [number, number]),
            { color: "#e6ebf2", weight: 2.5, opacity: 0.7, interactive: false },
          ).addTo(trailLayer);
        }
      }

      if (!pos) {
        markerLayer.clearLayers();
        marker = null;
        lastMarkerKey = "";
        return;
      }

      const key = `${pos.x},${pos.z},${pos.yaw},${look},${staleText ?? ""}`;
      if (marker && key === lastMarkerKey) return;
      lastMarkerKey = key;
      markerLayer.clearLayers();
      marker = L.marker([pos.z, pos.x], {
        icon: playerIcon(meta, pos.yaw, look),
        interactive: false,
        keyboard: false,
        zIndexOffset: 1000,
      }).addTo(markerLayer);
      if (staleText) {
        L.marker([pos.z, pos.x], {
          icon: staleLabelIcon(staleText),
          interactive: false,
          keyboard: false,
          zIndexOffset: 1100,
        }).addTo(markerLayer);
      }
    },
    clear,
  };
}

/** 撤离点、危险区、转移点、开关的外框：游戏坐标的多边形。 */
export interface OutlineLayer {
  render(items: Annotation[]): void;
  clear(): void;
}

/** 只画危险区的范围（DESIGN 7.1）：红色斜纹，这里用虚线加半透明填充近似。 */
const OUTLINE_STYLE: Record<string, { color: string; fill: string; weight: number; dash?: string }> = {
  hazard: { color: "#ff5d5d", fill: "#ff5d5d", weight: 1.5, dash: "6 5" },
};

export function createOutlineLayer(map: L.Map): OutlineLayer {
  const group = L.layerGroup().addTo(map);
  return {
    render(items) {
      group.clearLayers();
      for (const a of items) {
        if (!a.outline || a.outline.length < 3) continue;
        const st = OUTLINE_STYLE[a.category];
        if (!st) continue;
        L.polygon(
          a.outline.map((p) => [p.z, p.x] as [number, number]),
          {
            color: st.color,
            weight: st.weight,
            opacity: 0.75,
            fillColor: st.fill,
            fillOpacity: 0.16,
            dashArray: st.dash,
            interactive: false,
          },
        ).addTo(group);
      }
    },
    clear() {
      group.clearLayers();
    },
  };
}
