// 小地图里的那张 Leaflet 地图。
//
// 和主窗口共用同一套底图、标注、楼层、自己与轨迹（`map/` 里那些），区别只有：
// - 地图跟着朝向转（DESIGN 7.5 默认跟随、自己朝上）：转动的是外面那一层，
//   所以自己的箭头在屏幕上是永远朝上的，朝北时整张图不转。
// - 视野固定：窗口短边看到「视野范围」那么多米，展开时改成整张图。
// - 不响应鼠标：叠加层默认穿透，地图自己不需要拖动和缩放。
//
// 转动的容器要比窗口大一圈，转起来四个角才不露底：取 1.5 倍，45° 时仍有余量。

import type L from "leaflet";
import { useCallback, useEffect, useState, type CSSProperties } from "react";
import type { Annotation } from "../data/annotations";
import type { Translations } from "../data/loader";
import type { MapMeta } from "../data/mapsMeta";
import type { ClusterIconMode } from "../prefs";
import type { Position, TrailPoint } from "../types";
import { latLngBoundsOf } from "../map/crs";
import { useLeaflet } from "../map/useMapData";

export interface MiniMapProps {
  meta: MapMeta | null;
  style: "svg" | "tile";
  zh: Translations | null;
  layer: number;
  visible: Annotation[];
  clusterIcon: ClusterIconMode;
  tileBrightness: number;
  pos: Position | null;
  trail: TrailPoint[];
  trailOn: boolean;
  stale: boolean;
  /** 整张图要转多少度（顺时针）；0 是不转。 */
  rot: number;
  /** 横着看到多少米。 */
  range: number;
  /** 窗口宽高。 */
  w: number;
  h: number;
  expanded: boolean;
}

/** 当前缩放下，一「米」有多少像素。 */
function pixelsPerMeter(m: L.Map, zoom: number): number {
  const a = m.project([0, 0], zoom);
  const b = m.project([0, 1], zoom);
  return Math.max(1e-6, Math.abs(b.x - a.x));
}

/** 转到 (-180, 180]：CSS 里干净，回归脚本也好对。 */
function normalized(deg: number): number {
  const r = (((deg % 360) + 540) % 360) - 180;
  return r === -180 ? 180 : r;
}

function clampZoom(m: L.Map, z: number): number {
  return Math.min(m.getMaxZoom(), Math.max(m.getMinZoom(), z));
}

/** 让窗口短边正好看到 `meters` 米。 */
function zoomForRange(m: L.Map, px: number, meters: number): number {
  const z0 = m.getZoom();
  const want = px / Math.max(1, meters);
  return clampZoom(m, z0 + Math.log2(want / pixelsPerMeter(m, z0)));
}

export function MiniMap(props: MiniMapProps) {
  const { meta, style, zh, layer, visible, clusterIcon, tileBrightness, pos, trail, trailOn, stale, rot, range, w, h, expanded } =
    props;

  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const onPick = useCallback(() => {}, []);
  const onHover = useCallback(() => {}, []);
  const map = useLeaflet({ container, meta, style, zh, onPick, onHover });
  const controller = map.controller;
  const version = map.version;

  // 转动的那一层：比窗口大一圈，转起来四个角才不露底。
  // 展开的大地图不转，铺满窗口就好（也正好让 fitBounds 按窗口算缩放）。
  const box = expanded ? 0 : Math.max(120, Math.round(Math.max(w, h) * 1.5));
  const boxW = expanded ? w : box;
  const boxH = expanded ? h : box;

  // 穿透窗口里的地图不该自己动：不拖、不滚、不双击
  useEffect(() => {
    const m = controller?.map;
    if (!m) return;
    m.options.maxBoundsViscosity = 0;
    // maxBounds 会把视野中心夹回图幅里，玩家贴着图边时就不在中心了
    m.setMaxBounds([
      [-1e6, -1e6],
      [1e6, 1e6],
    ]);
    m.dragging.disable();
    m.scrollWheelZoom.disable();
    m.doubleClickZoom.disable();
    m.boxZoom.disable();
    m.keyboard.disable();
    m.touchZoom.disable();
  }, [controller, version]);

  // 窗口大小变了（展开、拖大小、开详情卡片）要让 Leaflet 重新量一遍
  useEffect(() => {
    controller?.map?.invalidateSize();
  }, [controller, version, boxW, boxH]);

  // 视野：小地图按米数、自己在中间；展开时整张图铺开（效果图 v2-expand.png）
  useEffect(() => {
    const m = controller?.map;
    if (!m || !meta) return;
    const bounds = latLngBoundsOf(meta.bounds);
    if (expanded || !pos) {
      m.fitBounds(bounds, { animate: false });
      return;
    }
    m.setView([pos.z, pos.x], zoomForRange(m, Math.min(w, h), range), { animate: false });
  }, [controller, version, meta, pos?.x, pos?.z, w, h, range, expanded, boxW, boxH]);

  // 楼层
  useEffect(() => {
    controller?.setLayer(layer);
  }, [controller, version, layer, meta?.key]);

  // 标注与外框。合并密度按整张图铺满算，和主窗口同一套规则
  useEffect(() => {
    const m = controller?.map;
    const annotations = controller?.annotations;
    if (!m || !annotations) return;
    const draw = () => annotations.render(visible, m.getZoom(), controller?.fitZoom() ?? m.getZoom(), clusterIcon);
    draw();
    controller?.outlines?.render(visible);
    m.on("zoomend", draw);
    m.on("moveend", draw);
    return () => {
      m.off("zoomend", draw);
      m.off("moveend", draw);
    };
  }, [controller, version, visible, clusterIcon]);

  // 自己与轨迹。过时的标签画在窗口那一层（跟着地图转会歪）
  useEffect(() => {
    controller?.player?.update(
      meta,
      pos,
      pos ? trail : [],
      trailOn,
      stale ? "stale" : "normal",
      null,
    );
  }, [controller, version, meta, pos, trail, trailOn, stale]);

  return (
    <div
      className="mini-mapbox"
      // data-rot 是干什么用的，回归脚本要知道地图转了多少
      data-rot={expanded ? 0 : normalized(-rot)}
      style={{
        left: expanded ? 0 : (w - box) / 2,
        top: expanded ? 0 : (h - box) / 2,
        width: boxW,
        height: boxH,
        transform: expanded ? undefined : `rotate(${normalized(-rot)}deg)`,
      }}
    >
      <div
        className="map"
        ref={setContainer}
        style={
          {
            "--otm-tile-brightness": tileBrightness,
            "--otm-level-brightness": tileBrightness + 0.12,
          } as CSSProperties
        }
      />
    </div>
  );
}
