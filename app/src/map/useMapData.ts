// 把事件来源、上游数据、地图实例接到一起的胶水层。

import { useEffect, useMemo, useRef, useState } from "react";
import type L from "leaflet";
import type { Annotation, AnnotationSet } from "../data/annotations";
import { buildAnnotations, layerOfPoint } from "../data/annotations";
import { dataStore, type DataBundle, type UpstreamMap } from "../data/loader";
import { findMapMeta, upstreamMapOf, type MapMeta } from "../data/mapsMeta";
import { createAnnotationLayer, type AnnotationLayer } from "./annotationsLayer";
import { createMapController, type MapController } from "./leafletMap";
import { createOutlineLayer, createPlayerLayer, type OutlineLayer, type PlayerLayer } from "./playerLayer";
import { effectiveFilters, subVisible, type Prefs } from "../prefs";
import type { AppState } from "../state";

export function useData(): DataBundle {
  const [b, setB] = useState<DataBundle>(dataStore.get());
  useEffect(() => dataStore.subscribe(setB), []);
  return b;
}

export interface MapResolution {
  /** 正在显示的这张图的游戏内部名（手动选图时是手选的那张）。 */
  gameMap: string | null;
  /** 玩家所在那张图的游戏内部名；看别的图时和 gameMap 不同。 */
  playerMap: string | null;
  /** maps.json 里的那张配置。 */
  meta: MapMeta | null;
  /** 上游的标注数据。 */
  upstream: UpstreamMap | null;
}

/** 当前该显示哪张图：手动选图优先，否则跟对局走。 */
export function useMapResolution(state: AppState, prefs: Prefs, data: DataBundle): MapResolution {
  return useMemo(() => {
    const playerMap = state.raid?.map ?? state.lastMap;
    const gameMap = prefs.manualMap ?? playerMap;
    const upstream = upstreamMapOf(data.maps, gameMap);
    // 上游的 normalizedName 才是 maps.json 的 key（夜工厂等靠 altMaps 落到同一张配置）
    const key = upstream?.normalizedName ?? gameMap;
    const meta = findMapMeta(data.mapsMeta ?? [], key);
    return { gameMap, playerMap, meta, upstream };
  }, [prefs.manualMap, state.raid?.map, state.lastMap, data.maps, data.mapsMeta]);
}

/** 标注集合：上游数据摊平的结果。 */
export function useAnnotations(data: DataBundle, map: UpstreamMap | null): AnnotationSet {
  return useMemo(() => buildAnnotations(map, data.maps, data.zh), [map, data.maps, data.zh]);
}

/**
 * 按筛选和楼层过滤后的标注。
 * 属于别的楼层的标注藏起来；不属于任何楼层的（地面上的东西）一直显示。
 */
export function filterAnnotations(
  set: AnnotationSet,
  prefs: Prefs,
  meta: MapMeta | null,
  layer: number,
): Annotation[] {
  const f = effectiveFilters(prefs);
  const layers = meta?.layers;
  const out: Annotation[] = [];
  for (const a of set.items) {
    if (!subVisible(f, a.category, a.sub)) continue;
    if (layers && layers.length > 0 && layer >= 0) {
      const l = layerOfPoint(layers, a, a.top, a.bottom);
      if (l !== -1 && l !== layer) continue;
    }
    out.push(a);
  }
  return out;
}

export interface MapLayers {
  controller: MapController | null;
  /** 这一版地图实例；换图后是新的对象，旧的可能已经被销毁。 */
  map: L.Map | null;
  annotations: AnnotationLayer | null;
  outlines: OutlineLayer | null;
  player: PlayerLayer | null;
  /** 地图实例的序号，换图后变化。 */
  version: number;
}

const NO_LAYERS: MapLayers = {
  controller: null,
  map: null,
  annotations: null,
  outlines: null,
  player: null,
  version: 0,
};

export interface LeafletOptions {
  container: HTMLDivElement | null;
  meta: MapMeta | null;
  style: "svg" | "tile";
  onPick: (a: Annotation | null) => void;
}

/**
 * 在容器里建一张 Leaflet 地图。换图或换底图样式时整个重建 Leaflet 实例，
 * 标注层、外框层、自己位置层都挂在新实例上。
 */
export function useLeaflet(opts: LeafletOptions): MapLayers {
  const { container, meta, style } = opts;
  const [layers, setLayers] = useState<MapLayers>(NO_LAYERS);
  const pickRef = useRef(opts.onPick);
  pickRef.current = opts.onPick;
  const metaRef = useRef<MapMeta | null>(meta);
  metaRef.current = meta;
  // 数据刷新会换掉 meta 的对象，但同一张图不用重建
  const metaKey = meta?.key ?? null;

  useEffect(() => {
    if (!container) return;
    const controller = createMapController(container, () => {});
    controller.setMap(metaRef.current, style);
    const map = controller.map;
    if (!map) {
      setLayers({ ...NO_LAYERS, controller, version: controller.mapVersion() });
      return () => {
        controller.destroy();
        setLayers(NO_LAYERS);
      };
    }
    // 点空白处收起卡片
    map.on("click", () => pickRef.current(null));
    const annotations = createAnnotationLayer(map, (a) => pickRef.current(a));
    const outlines = createOutlineLayer(map);
    const player = createPlayerLayer(map);
    setLayers({ controller, map, annotations, outlines, player, version: controller.mapVersion() });
    return () => {
      controller.destroy();
      setLayers(NO_LAYERS);
    };
  }, [container, metaKey, style]);

  return layers;
}
