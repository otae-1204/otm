// 图标：design/mockups/icons 里的 png（已复制到 app/public/icons/）。
// 标注用 divIcon 直接放图片，缩放时大小不变。

import L from "leaflet";
import type { Annotation } from "../data/annotations";
import { itemIcon } from "../data/season/icons";
import { markerRotation } from "./crs";
import type { MapMeta } from "../data/mapsMeta";

const ICON_DIR = "icons/";

export function iconUrl(name: string) {
  return `${ICON_DIR}${name}.png`;
}

/**
 * 赛季文件在地图上：物品图 + 2px 的种类色边框，暗底圆角（v3-doc-badges2.png）。
 * 物品图里面的空边在 CSS 里裁掉（图放大到框的 132%），文件才撑得满。
 * 没有物品图（换了赛季、换了物品 id）退回文件形状的徽章。
 */
const DOC_PATH = "M6.6 2.4h6.9l3.9 3.9v15.3H6.6z";
const DOC_FOLD = "M13.5 2.4v3.9h3.9";

function imgBadge(color: string, size: number, src: string, key?: string, attrs = ""): string {
  const r = Math.round(size * 0.29);
  return (
    `<span class="otm-doc otm-doc-img" data-k="${key ?? ""}"${attrs} style="--c:${color};width:${size}px;height:${size}px;` +
    `border-radius:${r}px;border-width:2px">` +
    `<img src="${src}" alt="" draggable="false"/></span>`
  );
}

function docBadge(color: string, size: number, key?: string, attrs = ""): string {
  const r = Math.round(size * 0.3);
  const bw = Math.max(1.5, Math.round(size * 0.085));
  return (
    `<span class="otm-doc" data-k="${key ?? ""}"${attrs} style="--c:${color};width:${size}px;height:${size}px;` +
    `border-radius:${r}px;border-width:${bw}px">` +
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" ` +
    `stroke-linecap="round" stroke-linejoin="round"><path d="${DOC_PATH}"/><path d="${DOC_FOLD}"/></svg></span>`
  );
}

/**
 * 右上角的小楼层标签：只有「全部」楼层时才带（单个标注，合并标注不带）。
 * 图标上带 data-l 和 otm-l<层号>，回归脚本靠它们区分地面和楼层。
 */
function floorTagHtml(a: Annotation): string {
  if (!a.floorTag) return "";
  const l = a.floorIndex ?? -1;
  return `<span class="ft" data-l="${l}">${a.floorTag.replace(/[&<>]/g, "")}</span>`;
}

/** 标注图标：尺寸随缩放变化，由上层决定；密集时由上层合并。 */
export function annotationIcon(a: Annotation, size = 26): L.DivIcon {
  const tag = floorTagHtml(a);
  // 「全部」楼层时标出层号，方便区分是谁家的标签
  const layerCls = a.floorIndex === undefined ? "" : ` otm-l${a.floorIndex}`;
  const dataL = a.floorIndex === undefined ? "" : ` data-l="${a.floorIndex}"`;
  if (a.season) {
    // 整张图时 28px（比撤离点、上锁的门大一号），放大时跟着其它单个标注一起长
    const s = Math.round(Math.max(28, size * 1.15));
    const src = itemIcon(a.item);
    const badge = src
      ? imgBadge(a.color ?? "#4da3ff", s, src, a.key, dataL)
      : docBadge(a.color ?? "#4da3ff", s, a.key, dataL);
    return L.divIcon({
      className: `otm-anno otm-doc-anno${layerCls}`,
      html: badge + tag,
      iconSize: [s, s],
      iconAnchor: [s / 2, s / 2],
    });
  }
  return L.divIcon({
    className: `otm-anno${layerCls}`,
    html:
      `<img src="${iconUrl(a.icon)}" width="${size}" height="${size}" alt="" draggable="false"${dataL}/>` + tag,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

/**
 * 合并标注（v2-cluster.png）：一个图标 + 右上角的数量角标，
 * 图标后面两层错开的淡轮廓表示这里叠着好几个。颜色都取大类色。
 */
export function clusterIcon(opts: {
  icon: string;
  count: number;
  color: string;
  /** 图标图片的边长，和单个标注同一套缩放规则。 */
  size: number;
}): L.DivIcon {
  const s = opts.size;
  const pad = Math.max(2, Math.round(s * 0.14));
  const frame = s + pad * 2;
  const radius = Math.round(frame * 0.28);
  const off = Math.max(3, Math.round(s * 0.22));
  const bw = Math.max(1.5, Math.round(s * 0.07));
  const bh = Math.max(16, Math.round(s * 0.72));
  const fs = Math.max(11, Math.round(s * 0.48));
  const w = frame + off * 2;
  const h = frame + off;
  const box = (left: number, top: number, cls: string) =>
    `<span class="st ${cls}" style="left:${left}px;top:${top}px;width:${frame}px;height:${frame}px;border-radius:${radius}px;border-width:${bw}px"></span>`;
  const html = `<div class="otm-stack" style="--c:${opts.color};width:${w}px;height:${h}px">${box(
    off * 2,
    0,
    "st2",
  )}${box(off, Math.round(off / 2), "st1")}${box(0, off, "st0")}<img src="${iconUrl(
    opts.icon,
  )}" width="${s}" height="${s}" style="left:${pad}px;top:${off + pad}px" alt="" draggable="false"/><b class="cnt" style="font-size:${fs}px;height:${bh}px;line-height:${bh}px;min-width:${bh}px;padding:0 ${Math.round(
    bh * 0.24,
  )}px;left:${Math.round(frame - bh * 0.5)}px;top:${Math.round(off - bh * 0.5)}px">${opts.count}</b></div>`;
  return L.divIcon({
    className: "otm-cluster",
    html,
    iconSize: [w, h],
    // 锚点对着最前面那层框的中心，也就是这一堆真正的位置
    iconAnchor: [frame / 2, off + frame / 2],
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
