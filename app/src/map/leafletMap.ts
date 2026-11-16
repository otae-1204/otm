// Leaflet 地图：底图（矢量 SVG / 栅格瓦片）、楼层图层、地名标注。
//
// 坐标换算见 geo.ts（移植自 tarkov.dev，MIT）。楼层图层的取舍照搬上游：
// 图层同时有 svgLayer 和 tilePath 时，跟随底图样式；只有一种就用那一种。
//
// 底图用 L.svgOverlay 挂上去：Leaflet 按 bounds 给它算位置和尺寸，
// 所以拖动、缩放都跟着地图走（上游也是这么做的）。
//
// 地图实例和挂在它上面的图层（标注、外框、自己、地名）由这里一起持有：
// 换图时整组重建，换底图样式时只换底图，实例、视野和其它图层都留着。
// 外面只认这个 controller，不缓存 L.Map，就不会拿到已经销毁的那一版。

import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { Translations } from "../data/loader";
import type { MapMeta } from "../data/mapsMeta";
import { crsFor, latLngBoundsOf, scaledBounds } from "./crs";
import { mapLabels, type Annotation } from "../data/annotations";
import { createAnnotationLayer, type AnnotationLayer, type ClusterHover } from "./annotationsLayer";
import { createOutlineLayer, createPlayerLayer, type OutlineLayer, type PlayerLayer } from "./playerLayer";

export type BaseStyle = "svg" | "tile";

export interface MapHooks {
  /** 点了标注；点空白处给 null。 */
  onPick: (a: Annotation | null) => void;
  /** 鼠标停在合并标注上时，把这一堆的构成交给界面。 */
  onHover: (h: ClusterHover | null) => void;
}

export interface MapController {
  /** 当前 Leaflet 实例；没有地图时为 null。 */
  readonly map: L.Map | null;
  /** 挂在当前地图上的标注层；换图后是新的对象。 */
  readonly annotations: AnnotationLayer | null;
  readonly outlines: OutlineLayer | null;
  readonly player: PlayerLayer | null;
  /** 每次换图 +1。 */
  mapVersion(): number;
  /** 换图（重建整个地图实例）。 */
  setMap(meta: MapMeta | null, style: BaseStyle, zh: Translations | null): void;
  /** 换底图样式：只换底图图层，地图实例、视野和其它图层都不动。 */
  setBaseStyle(style: BaseStyle): void;
  /** 当前楼层；-1 表示不按楼层过滤。 */
  setLayer(index: number): void;
  /** 把视野放到整张图上。 */
  fit(): void;
  /** 把视野放到某个游戏坐标附近。 */
  focus(x: number, z: number, zoom?: number): void;
  /** 当前缩放级别。 */
  zoom(): number;
  /** 整张图刚好铺满窗口时的缩放级别，标注密度按它算相对级数。 */
  fitZoom(): number;
  /** 换一份中文翻译后重画地名。 */
  setLabels(zh: Translations | null): void;
  destroy(): void;
}

/** 底图压暗：矢量底图按 otm 的配色重新上色，栅格底图整体压暗（DESIGN 6.1）。 */
const BASE_CSS = `
.map { background: #14171c; }
.map .leaflet-overlay-pane svg { max-width: none; max-height: none; }
.map .otm-base-tile { filter: brightness(.42) saturate(.55) contrast(1.08); }
.map .otm-level-tile { filter: brightness(.85) saturate(.75); }

.otm-svg-base .land { fill: #1b2027; }
.otm-svg-base .water { fill: #17303f; }
.otm-svg-base .trees { fill: #1c2a24; }
.otm-svg-base .rock { fill: #242a32; }
.otm-svg-base .wood { fill: #2a2118; }
.otm-svg-base .tarmac { fill: #232a33; }
.otm-svg-base .gravel { fill: #2a2620; }
.otm-svg-base .cement { fill: #232a33; }
.otm-svg-base .building { fill: #2c343f; stroke: #465160; }
.otm-svg-base .floor { fill: #303945; stroke: #4d5868; }
.otm-svg-base .stairs { fill: #46515f; }
.otm-svg-base .locked { fill: #3d3323; stroke: #8a6a2f; }
.otm-svg-base .shadow { filter: none; fill: #2a323c; fill-opacity: .55; stroke: #3b4553; }
.otm-svg-base .task { fill: none; stroke: none; }

/* 下面这些上游是只有描边、没有填充的；不写 fill:none 会按默认的黑色填满 */
.otm-svg-base .road_gravel, .otm-svg-base .road_small { fill: none; stroke: #39414d; stroke-width: 5; }
.otm-svg-base .road_tarmac { fill: none; stroke: #39414d; }
.otm-svg-base .road_medium { fill: none; stroke: #414a57; stroke-width: 8; }
.otm-svg-base .road_large { fill: none; stroke: #4a5462; stroke-width: 12; }
.otm-svg-base .railroad { fill: none; stroke: #3b434f; stroke-width: 3; stroke-dasharray: 6; }
.otm-svg-base .fence { fill: none; stroke: #3a424e; stroke-width: 1; }
.otm-svg-base .powerline { fill: none; stroke: #333b46; stroke-width: 2; stroke-dasharray: 6 6; }
.otm-svg-base .map_border { fill: none; stroke: #2e3641; stroke-width: 2; }
.otm-svg-base .danger { fill: #3a2a1c; fill-opacity: .4; stroke: #7a4a2a; stroke-width: 2; stroke-dasharray: 4 2; }

.otm-svg-base .hidden-layer { display: none; }
/* 选中的楼层：不压暗地面，只把这一层提亮，免得整张图变黑 */
.otm-svg-base .otm-level { filter: brightness(1.75) saturate(1.15); }
.otm-label {
  color: rgba(223,229,236,.34); font-size: 11px; font-weight: 400; letter-spacing: .2px;
  white-space: nowrap; text-shadow: none; pointer-events: none;
}
`;

let cssInjected = false;
function injectCss() {
  if (cssInjected) return;
  cssInjected = true;
  const style = document.createElement("style");
  style.textContent = BASE_CSS;
  document.head.appendChild(style);
}

interface Runtime {
  /** 底图：矢量叠层或栅格瓦片，换样式时整个换掉。 */
  baseSvg: L.SVGOverlay | null;
  baseTile: L.TileLayer | null;
  /** 底图 SVG 里按楼层分好的组。 */
  svg: SVGSVGElement | null;
  groups: Map<string, SVGGElement>;
  levelTiles: Map<number, L.TileLayer>;
  labels: L.LayerGroup | null;
  /** 挂在这张地图上的图层，跟着地图一起建、一起销毁。 */
  annotations: AnnotationLayer | null;
  outlines: OutlineLayer | null;
  player: PlayerLayer | null;
  fitZoom: number;
}

const emptyRuntime = (): Runtime => ({
  baseSvg: null,
  baseTile: null,
  svg: null,
  groups: new Map(),
  levelTiles: new Map(),
  labels: null,
  annotations: null,
  outlines: null,
  player: null,
  fitZoom: 0,
});

export function createMapController(container: HTMLElement, hooks: MapHooks): MapController {
  injectCss();
  let map: L.Map | null = null;
  let version = 0;
  let meta: MapMeta | null = null;
  let layerIndex = -1;
  /** 当前底图用的样式；换图后清空，下次一定重新挂。 */
  let baseStyle: BaseStyle | null = null;
  let rt: Runtime = emptyRuntime();
  /** 底图的版本号：换底图或销毁地图后，之前发出去的 SVG 请求作废。 */
  let baseToken = 0;

  function teardown() {
    baseToken++;
    if (map) {
      map.remove();
      map = null;
    }
    rt = emptyRuntime();
    baseStyle = null;
  }

  /** 按楼层切换图层：矢量换组，栅格换瓦片。 */
  function applyLayer() {
    if (!map || !meta) return;
    const cur = layerIndex >= 0 ? meta.layers?.[layerIndex] : undefined;

    if (rt.baseTile) {
      const path = cur?.tilePath;
      if (path) {
        let tl = rt.levelTiles.get(layerIndex);
        if (!tl) {
          tl = L.tileLayer(path, {
            tileSize: meta.tileSize ?? 256,
            minZoom: meta.minZoom ?? 0,
            maxZoom: meta.maxZoom ?? 6,
            maxNativeZoom: meta.maxZoom ?? 6,
            bounds: latLngBoundsOf(meta.bounds),
            className: "otm-level-tile",
          });
          rt.levelTiles.set(layerIndex, tl);
        }
        if (!map.hasLayer(tl)) tl.addTo(map);
      }
      for (const [i, l] of rt.levelTiles) {
        if ((!path || i !== layerIndex) && map.hasLayer(l)) map.removeLayer(l);
      }
    }

    if (rt.svg) {
      const ground = meta.svgLayer;
      const curGroup = cur?.svgLayer;
      for (const [id, g] of rt.groups) {
        const isGround = id === ground;
        const isLevel = !!curGroup && id === curGroup;
        g.classList.toggle("hidden-layer", !isGround && !isLevel);
        g.classList.toggle("otm-level", isLevel && !isGround);
      }
    }
  }

  function addLabels(m: MapMeta, target: L.Map, zh: Translations | null) {
    if (rt.labels) {
      rt.labels.remove();
      rt.labels = null;
    }
    const group = L.layerGroup();
    for (const lb of mapLabels(m, zh)) {
      const icon = L.divIcon({
        className: "otm-label",
        html: `<div>${escapeHtml(lb.text)}</div>`,
        iconSize: [0, 0],
      });
      L.marker([lb.z, lb.x], { icon, interactive: false, keyboard: false }).addTo(group);
    }
    group.addTo(target);
    rt.labels = group;
  }

  async function loadSvg(m: MapMeta, target: L.Map, myToken: number) {
    const res = await fetch(m.svgPath!);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (myToken !== baseToken) return;
    const doc = new DOMParser().parseFromString(text, "image/svg+xml");
    const root = doc.documentElement;
    if (!root || root.nodeName !== "svg") throw new Error("SVG 解析失败");
    const svg = document.importNode(root, true) as unknown as SVGSVGElement;
    svg.removeAttribute("width");
    svg.removeAttribute("height");
    // 上游的 viewBox 铺满 bounds，宽高比和 bounds 略有出入，直接拉伸最省事
    svg.setAttribute("preserveAspectRatio", "none");
    // 上游内嵌的浅色样式不要，配色由 BASE_CSS 决定
    for (const st of Array.from(svg.querySelectorAll("style"))) st.remove();
    // 陆地的轮廓是自交的，非零填充会把整块矩形填满；奇偶填充才是对的
    for (const p of Array.from(svg.querySelectorAll("path"))) p.setAttribute("fill-rule", "evenodd");
    svg.classList.add("otm-svg-base");

    const overlay = L.svgOverlay(svg, latLngBoundsOf(m.svgBounds ?? m.bounds), {
      interactive: false,
      className: "otm-svg-base",
    }).addTo(target);
    if (myToken !== baseToken) {
      overlay.remove();
      return;
    }
    // 底图要压在标注、外框、轨迹下面
    overlay.bringToBack();
    rt.baseSvg = overlay;
    rt.svg = overlay.getElement() as SVGSVGElement;
    rt.groups = new Map();
    for (const child of Array.from(svg.children)) {
      if (child.nodeName === "g" && child.id) {
        rt.groups.set(child.id, child as SVGGElement);
        child.classList.add("hidden-layer");
      }
    }
    applyLayer();
  }

  /** 这张图该用矢量还是栅格底图：有 SVG 且（选了矢量或没有瓦片）时用 SVG。 */
  function useSvgBase(m: MapMeta, style: BaseStyle) {
    return !!m.svgPath && (style === "svg" || !m.tilePath);
  }

  function addBaseTile(m: MapMeta, target: L.Map) {
    return L.tileLayer(m.tilePath!, {
      tileSize: m.tileSize ?? 256,
      minZoom: m.minZoom ?? 0,
      maxZoom: m.maxZoom ?? 6,
      maxNativeZoom: m.maxZoom ?? 6,
      bounds: latLngBoundsOf(m.bounds),
      className: "otm-base-tile",
    }).addTo(target);
  }

  /** 换底图：撤掉旧的，按样式挂上新的。地图实例、视野和其它图层都不动。 */
  function applyBase(style: BaseStyle) {
    if (!map || !meta) return;
    const target = map;
    const m = meta;
    const myToken = ++baseToken;
    baseStyle = style;

    if (rt.baseSvg) {
      rt.baseSvg.remove();
      rt.baseSvg = null;
    }
    if (rt.baseTile) {
      rt.baseTile.remove();
      rt.baseTile = null;
    }
    rt.svg = null;
    rt.groups = new Map();

    if (useSvgBase(m, style)) {
      loadSvg(m, target, myToken).catch((e) => {
        console.warn("矢量底图加载失败", e);
        if (myToken !== baseToken || !m.tilePath) return;
        // 退到瓦片；样式记成没实现，再点一次矢量会重试
        baseStyle = null;
        rt.baseTile = addBaseTile(m, target);
        applyLayer();
      });
    } else if (m.tilePath) {
      rt.baseTile = addBaseTile(m, target);
    }
    applyLayer();
  }

  function build(m: MapMeta | null, wantStyle: BaseStyle, zh: Translations | null) {
    teardown();
    meta = m;
    container.innerHTML = "";
    if (!m) return;

    const target = L.map(container, {
      crs: crsFor(m),
      minZoom: m.minZoom ?? 0,
      maxZoom: m.maxZoom ?? 6,
      zoomSnap: 0.1,
      zoomDelta: 0.5,
      wheelPxPerZoomLevel: 90,
      attributionControl: false,
      zoomControl: false,
      maxBounds: scaledBounds(m.bounds, 1.3),
      maxBoundsViscosity: 0.6,
      preferCanvas: false,
    });
    map = target;
    version++;

    // 图层跟这张地图一起建，也跟它一起销毁
    rt.annotations = createAnnotationLayer(target, hooks.onPick, hooks.onHover);
    rt.outlines = createOutlineLayer(target);
    rt.player = createPlayerLayer(target);
    target.on("click", () => hooks.onPick(null));

    applyBase(wantStyle);
    addLabels(m, target, zh);
    target.fitBounds(latLngBoundsOf(m.bounds), { padding: [0, 0] });
    rt.fitZoom = target.getZoom();
    applyLayer();
  }

  const controller: MapController = {
    get map() {
      return map;
    },
    get annotations() {
      return rt.annotations;
    },
    get outlines() {
      return rt.outlines;
    },
    get player() {
      return rt.player;
    },
    mapVersion() {
      return version;
    },
    setMap(m, s, zh) {
      build(m, s, zh);
    },
    setBaseStyle(style) {
      // 已经是这份样式就不用重来（换图后 baseStyle 会清空）
      if (style === baseStyle) return;
      applyBase(style);
    },
    fitZoom() {
      return rt.fitZoom;
    },
    setLabels(zh) {
      if (map && meta) addLabels(meta, map, zh);
    },
    setLayer(index) {
      // 换图时楼层可能还是同一个值，但图层要重新应用，所以这里不跳过
      layerIndex = index;
      applyLayer();
    },
    fit() {
      if (map && meta) map.fitBounds(latLngBoundsOf(meta.bounds), { padding: [0, 0] });
    },
    focus(x, z, zoom) {
      if (!map) return;
      map.setView([z, x], zoom ?? map.getZoom(), { animate: true });
    },
    zoom() {
      return map ? map.getZoom() : 0;
    },
    destroy() {
      teardown();
    },
  };
  return controller;
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);
}
