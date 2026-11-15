// Leaflet 地图：底图（矢量 SVG / 栅格瓦片）、楼层图层、地名标注。
//
// 坐标换算见 geo.ts（移植自 tarkov.dev，MIT）。楼层图层的取舍照搬上游：
// 图层同时有 svgLayer 和 tilePath 时，跟随底图样式；只有一种就用那一种。
//
// 底图用 L.svgOverlay 挂上去：Leaflet 按 bounds 给它算位置和尺寸，
// 所以拖动、缩放都跟着地图走（上游也是这么做的）。

import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { MapMeta } from "../data/mapsMeta";
import { crsFor, latLngBoundsOf, scaledBounds } from "./crs";
import { mapLabels } from "../data/annotations";

export type BaseStyle = "svg" | "tile";

export interface MapController {
  /** 当前 Leaflet 实例；没有地图时为 null。 */
  map: L.Map | null;
  /** 每次换图 +1。 */
  mapVersion(): number;
  /** 换图（重建整个地图实例）。 */
  setMap(meta: MapMeta | null, style: BaseStyle): void;
  /** 当前楼层；-1 表示不按楼层过滤。 */
  setLayer(index: number): void;
  /** 把视野放到整张图上。 */
  fit(): void;
  /** 把视野放到某个游戏坐标附近。 */
  focus(x: number, z: number, zoom?: number): void;
  /** 当前缩放级别。 */
  zoom(): number;
  onChange(fn: () => void): void;
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
  color: #7c8797; font-size: 12px; font-weight: 500; white-space: nowrap;
  text-shadow: 0 1px 3px #0b0d10, 0 0 6px #0b0d10; pointer-events: none;
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
  svg: SVGSVGElement | null;
  groups: Map<string, SVGGElement>;
  baseTile: L.TileLayer | null;
  levelTiles: Map<number, L.TileLayer>;
  labels: L.LayerGroup | null;
}

const emptyRuntime = (): Runtime => ({
  svg: null,
  groups: new Map(),
  baseTile: null,
  levelTiles: new Map(),
  labels: null,
});

export function createMapController(container: HTMLElement, onChange: () => void): MapController {
  injectCss();
  let map: L.Map | null = null;
  let version = 0;
  let meta: MapMeta | null = null;
  let layerIndex = -1;
  let rt: Runtime = emptyRuntime();
  let token = 0;
  let listeners: (() => void)[] = [onChange];

  const emit = () => listeners.forEach((l) => l());

  function teardown() {
    token++;
    if (map) {
      map.remove();
      map = null;
    }
    rt = emptyRuntime();
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
    emit();
  }

  function addLabels(m: MapMeta, target: L.Map) {
    const group = L.layerGroup();
    for (const lb of mapLabels(m)) {
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
    if (myToken !== token) return;
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
    if (myToken !== token) {
      overlay.remove();
      return;
    }
    // 底图要压在标注、外框、轨迹下面
    overlay.bringToBack();
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

  function build(m: MapMeta | null, wantStyle: BaseStyle) {
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
    const myToken = token;

    const bounds = latLngBoundsOf(m.bounds);
    const useSvg = !!m.svgPath && (wantStyle === "svg" || !m.tilePath);

    if (!useSvg && m.tilePath) {
      rt.baseTile = L.tileLayer(m.tilePath, {
        tileSize: m.tileSize ?? 256,
        minZoom: m.minZoom ?? 0,
        maxZoom: m.maxZoom ?? 6,
        maxNativeZoom: m.maxZoom ?? 6,
        bounds,
        className: "otm-base-tile",
      }).addTo(target);
    }

    if (useSvg && m.svgPath) {
      loadSvg(m, target, myToken).catch((e) => {
        console.warn("矢量底图加载失败", e);
        if (myToken !== token || !m.tilePath) return;
        rt.baseTile = L.tileLayer(m.tilePath, {
          tileSize: m.tileSize ?? 256,
          minZoom: m.minZoom ?? 0,
          maxZoom: m.maxZoom ?? 6,
          maxNativeZoom: m.maxZoom ?? 6,
          bounds,
          className: "otm-base-tile",
        }).addTo(target);
        applyLayer();
      });
    }

    addLabels(m, target);
    target.fitBounds(bounds, { padding: [0, 0] });
    applyLayer();
    target.on("zoomend", emit);
  }

  const controller: MapController = {
    get map() {
      return map;
    },
    mapVersion() {
      return version;
    },
    setMap(m, s) {
      build(m, s);
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
    onChange(fn) {
      listeners.push(fn);
    },
    destroy() {
      teardown();
      listeners = [];
    },
  };
  return controller;
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);
}
