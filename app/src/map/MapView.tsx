// 地图这一块：Leaflet 实例、标注、外框、自己与轨迹，以及跟着地图走的卡片。
//
// 单独成一个组件，是为了让 App 的其它界面不跟地图绑在一起：
// 地图这边出错时，错误边界只换掉这一块，预设、筛选、楼层、状态栏都还在。

import { useCallback, useEffect, useState, type CSSProperties } from "react";
import type { Annotation } from "../data/annotations";
import { layerOfPoint } from "../data/floors";
import type { Translations } from "../data/loader";
import type { MapMeta } from "../data/mapsMeta";
import type { ClusterIconMode } from "../prefs";
import type { Position, TrailPoint } from "../types";
import { mmss } from "../util";
import type { ClusterHover } from "./annotationsLayer";
import { useLeaflet } from "./useMapData";
import { AnnotationCard } from "../ui/AnnotationCard";
import { ClusterCard } from "../ui/ClusterCard";

export interface MapViewProps {
  meta: MapMeta | null;
  style: "svg" | "tile";
  zh: Translations | null;
  /** 当前楼层；-1 表示不按楼层过滤。 */
  layer: number;
  /** 按筛选和楼层过滤后的标注。 */
  visible: Annotation[];
  clusterIcon: ClusterIconMode;
  /** 实景底图的亮度，1 = 原图。 */
  tileBrightness: number;
  position: Position | null;
  trail: TrailPoint[];
  trailOn: boolean;
  stale: boolean;
  ageSeconds: number | null;
}

export function MapView(props: MapViewProps) {
  const { meta, style, zh, layer, visible, clusterIcon, tileBrightness, position, trail, trailOn, stale, ageSeconds } =
    props;

  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const [picked, setPicked] = useState<{ a: Annotation; x: number; y: number } | null>(null);
  const [hover, setHover] = useState<ClusterHover | null>(null);

  const onPick = useCallback((a: Annotation | null) => {
    setPicked((prev) => (a === null || prev?.a.key === a.key ? null : { a, x: 0, y: 0 }));
  }, []);
  const onHover = useCallback((h: ClusterHover | null) => setHover(h), []);

  const map = useLeaflet({ container, meta, style, zh, onPick, onHover });
  const controller = map.controller;

  // 换图后收起卡片
  useEffect(() => {
    setPicked(null);
    setHover(null);
  }, [meta?.key]);

  // 卡片位置跟着地图走
  useEffect(() => {
    const m = controller?.map;
    if (!m || !picked) return;
    const update = () => {
      const p = m.latLngToContainerPoint([picked.a.z, picked.a.x]);
      setPicked((prev) => (prev ? { ...prev, x: p.x, y: p.y } : prev));
    };
    update();
    m.on("move zoom", update);
    return () => {
      m.off("move zoom", update);
    };
  }, [controller, map.version, picked?.a.key]);

  // 楼层
  useEffect(() => {
    controller?.setLayer(layer);
  }, [controller, map.version, layer, meta?.key]);

  // 标注与外框
  useEffect(() => {
    const m = controller?.map;
    const annotations = controller?.annotations;
    if (!m || !annotations) return;
    const draw = () => {
      setHover(null);
      annotations.render(visible, m.getZoom(), controller?.fitZoom() ?? m.getZoom(), clusterIcon);
    };
    draw();
    controller?.outlines?.render(visible);
    m.on("zoomend", draw);
    m.on("moveend", draw);
    return () => {
      m.off("zoomend", draw);
      m.off("moveend", draw);
    };
  }, [controller, map.version, visible, clusterIcon]);

  // 自己只在自己所在的那一层上画：看别的楼层时连箭头和轨迹一起收起来
  const posOnLayer = position && layerOfPoint(meta?.layers, position) === layer ? position : null;

  // 自己与轨迹
  useEffect(() => {
    controller?.player?.update(
      meta,
      posOnLayer,
      posOnLayer ? trail : [],
      trailOn,
      stale ? "stale" : "normal",
      stale && ageSeconds !== null ? mmss(ageSeconds) : null,
    );
    // ageSeconds 每秒变一次，过时的计时才会跟着跳
  }, [controller, map.version, meta, posOnLayer, trail, trailOn, stale, ageSeconds]);

  return (
    <>
      <div
        className="map"
        ref={setContainer}
        style={
          {
            "--otm-tile-brightness": tileBrightness,
            // 楼层瓦片比底图亮一点，选中的那一层才跳出来
            "--otm-level-brightness": tileBrightness + 0.12,
          } as CSSProperties
        }
      />
      {picked ? (
        <AnnotationCard
          a={picked.a}
          pos={position}
          x={picked.x}
          y={picked.y}
          onClose={() => setPicked(null)}
        />
      ) : null}
      {hover ? <ClusterCard hover={hover} /> : null}
    </>
  );
}
