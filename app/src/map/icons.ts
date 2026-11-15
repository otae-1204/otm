// 图标：design/mockups/icons 里的 png（已复制到 app/public/icons/）。
// 标注用 divIcon 直接放图片，缩放时大小不变。

import L from "leaflet";
import type { Annotation } from "../data/annotations";
import { markerRotation } from "./crs";
import type { MapMeta } from "../data/mapsMeta";

const ICON_DIR = "icons/";

export function iconUrl(name: string) {
  return `${ICON_DIR}${name}.png`;
}

/** 标注图标：默认 26px，密集时由上层合并。 */
export function annotationIcon(a: Annotation, size = 26): L.DivIcon {
  return L.divIcon({
    className: "otm-anno",
    html: `<img src="${iconUrl(a.icon)}" width="${size}" height="${size}" alt="" draggable="false"/>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

export function clusterIcon(count: number): L.DivIcon {
  return L.divIcon({
    className: "otm-cluster",
    html: `<div>${count}</div>`,
    iconSize: [30, 30],
    iconAnchor: [15, 15],
  });
}

export type PlayerLook = "normal" | "stale";

/** 自己的位置：带朝向的箭头。过时变黄、去掉视野锥（v2-states.png）。 */
export function playerIcon(meta: MapMeta | null, yaw: number | null, look: PlayerLook): L.DivIcon {
  const rot = meta ? markerRotation(meta, yaw) : (yaw ?? 0);
  const cls = look === "stale" ? "otm-me stale" : "otm-me";
  const cone = look === "normal" && yaw !== null ? `<div class="cone" style="rotate:${rot}deg"></div>` : "";
  const arrow =
    yaw === null
      ? `<div class="dot"></div>`
      : `<div class="arrow" style="rotate:${rot}deg"><svg viewBox="0 0 24 24" width="24" height="24"><path d="M12 2 L20 22 L12 17 L4 22 Z"/></svg></div>`;
  return L.divIcon({
    className: cls,
    html: `${cone}${arrow}`,
    iconSize: [24, 24],
    iconAnchor: [12, 12],
  });
}

export function staleLabelIcon(text: string): L.DivIcon {
  return L.divIcon({
    className: "otm-stale-label",
    html: `<svg viewBox="0 0 24 24" width="16" height="16"><path d="M4 8h3l2-2h6l2 2h3v11H4z" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="13.5" r="3.2" fill="none" stroke="currentColor" stroke-width="1.8"/></svg><b>${text}</b>`,
    iconSize: [0, 0],
    iconAnchor: [-14, 12],
  });
}
