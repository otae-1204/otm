// 自己的位置、轨迹、撤离点/危险区的外框。

import L from "leaflet";
import type { Annotation, GamePoint } from "../data/annotations";
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

/**
 * 危险区的范围（DESIGN 7.1）：红色斜纹填充 + 虚线边框，中间放危险区图标。
 * 斜纹用 SVG pattern 画，图案跟着地图一起缩放。
 */
const HAZARD_COLOR = "#ff5d5d";
const PATTERN_ID = "otm-hazard-stripes";

/**
 * 图案要放进画多边形的那个 svg。叠底层（底图 SVG）也是 overlay-pane 里的一个 svg，
 * 按选择器取第一个可能取到它，图案就引用不到，所以这里由调用方传进正确的 svg。
 */
function ensurePattern(svg: SVGSVGElement) {
  if (svg.querySelector(`#${PATTERN_ID}`)) return;
  const ns = "http://www.w3.org/2000/svg";
  const defs = document.createElementNS(ns, "defs");
  const pattern = document.createElementNS(ns, "pattern");
  pattern.setAttribute("id", PATTERN_ID);
  pattern.setAttribute("width", "14");
  pattern.setAttribute("height", "14");
  pattern.setAttribute("patternUnits", "userSpaceOnUse");
  pattern.setAttribute("patternTransform", "rotate(45)");
  const bg = document.createElementNS(ns, "rect");
  bg.setAttribute("width", "14");
  bg.setAttribute("height", "14");
  bg.setAttribute("fill", "rgba(255,93,93,.08)");
  const line = document.createElementNS(ns, "line");
  line.setAttribute("x1", "0");
  line.setAttribute("y1", "0");
  line.setAttribute("x2", "0");
  line.setAttribute("y2", "14");
  line.setAttribute("stroke", HAZARD_COLOR);
  line.setAttribute("stroke-opacity", ".45");
  line.setAttribute("stroke-width", "5");
  pattern.append(bg, line);
  defs.appendChild(pattern);
  svg.insertBefore(defs, svg.firstChild);
}

export function createOutlineLayer(map: L.Map): OutlineLayer {
  const group = L.layerGroup().addTo(map);
  return {
    render(items) {
      group.clearLayers();
      const hazards = items.filter(
        (a): a is Annotation & { outline: GamePoint[] } =>
          a.category === "hazard" && !!a.outline && a.outline.length >= 3,
      );
      if (hazards.length === 0) return;
      const polys: L.Polygon[] = [];
      for (const a of hazards) {
        polys.push(L.polygon(
          a.outline.map((p) => [p.z, p.x] as [number, number]),
          {
            color: HAZARD_COLOR,
            weight: 1.5,
            opacity: 0.8,
            fillColor: `url(#${PATTERN_ID})`,
            fillOpacity: 1,
            dashArray: "5 4",
            interactive: false,
          },
        ).addTo(group));
      }
      // 图案放进多边形自己所在的 svg，否则引用不到
      const el = polys[0]?.getElement() as SVGPathElement | null | undefined;
      const svg = el?.ownerSVGElement;
      if (svg) ensurePattern(svg);
    },
    clear() {
      group.clearLayers();
    },
  };
}
