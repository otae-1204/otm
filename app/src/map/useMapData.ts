// 把事件来源、上游数据、地图实例接到一起的胶水层。

import { useEffect, useMemo, useRef, useState } from "react";
import type { Annotation, AnnotationSet } from "../data/annotations";
import { buildAnnotations, layerOfPoint } from "../data/annotations";
import { dataStore, type DataBundle, type Translations, type UpstreamMap } from "../data/loader";
import { findMapMeta, upstreamMapOf, type MapMeta } from "../data/mapsMeta";
import type { ClusterHover } from "./annotationsLayer";
import { createMapController, type MapController } from "./leafletMap";
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

export interface MapHandle {
  /**
   * 地图控制器。换图、换底图都在它内部处理，这个对象本身不会变；
   * 当前的地图实例和图层要从它上面取（controller.map / annotations …），
   * 不要存下来——换图后旧的就被销毁了。
   */
  controller: MapController | null;
  /** 地图实例的序号，换图后变化，用来触发重画。 */
  version: number;
}

const NO_MAP: MapHandle = { controller: null, version: 0 };

export interface LeafletOptions {
  container: HTMLDivElement | null;
  meta: MapMeta | null;
  style: "svg" | "tile";
  /** 中文翻译，用来给地名取中文名。 */
  zh: Translations | null;
  onPick: (a: Annotation | null) => void;
  /** 鼠标停在合并标注上时，把这一堆的构成交给界面。 */
  onHover: (h: ClusterHover | null) => void;
}

/**
 * 在容器里建一张 Leaflet 地图。控制器只跟容器绑定，换图时由它自己重建实例；
 * 换底图样式只换底图图层，实例和视野都留着。
 */
export function useLeaflet(opts: LeafletOptions): MapHandle {
  const { container, meta, style, zh } = opts;
  const [handle, setHandle] = useState<MapHandle>(NO_MAP);
  const pickRef = useRef(opts.onPick);
  pickRef.current = opts.onPick;
  const hoverRef = useRef(opts.onHover);
  hoverRef.current = opts.onHover;
  const metaRef = useRef<MapMeta | null>(meta);
  metaRef.current = meta;
  const styleRef = useRef(style);
  styleRef.current = style;
  const zhRef = useRef<Translations | null>(zh);
  zhRef.current = zh;
  // 数据刷新会换掉 meta 的对象，但同一张图不用重建
  const metaKey = meta?.key ?? null;

  useEffect(() => {
    if (!container) return;
    const controller = createMapController(container, {
      onPick: (a) => pickRef.current(a),
      onHover: (h) => hoverRef.current(h),
    });
    setHandle({ controller, version: controller.mapVersion() });
    return () => {
      controller.destroy();
      setHandle(NO_MAP);
    };
  }, [container]);

  // 换图：重建地图实例，版本号跟着变
  useEffect(() => {
    const controller = handle.controller;
    if (!controller) return;
    controller.setMap(metaRef.current, styleRef.current, zhRef.current);
    setHandle((h) => (h.controller === controller ? { controller, version: controller.mapVersion() } : h));
  }, [handle.controller, metaKey]);

  // 换底图样式：只换底图图层
  useEffect(() => {
    handle.controller?.setBaseStyle(styleRef.current);
  }, [handle.controller, style]);

  // 翻译晚到的时候补画地名，不重建地图（重建会丢视野）
  useEffect(() => {
    handle.controller?.setLabels(zh);
  }, [handle.controller, handle.version, zh]);

  return handle;
}
