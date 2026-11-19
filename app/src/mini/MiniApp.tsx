// 叠加层里的小地图（DESIGN 7.5、7.8，效果图 v2-mini.png / v2-expand.png / v2-mini-detail.png）。
//
// 外壳按 `?view=mini` 打开这个窗口（`shell/src-tauri/src/overlay.rs`）：置顶、透明、穿透。
// 和主窗口是同一份数据、同一份偏好：事件来自核心，底图、标注、楼层、预设筛选都复用；
// 主窗口改了偏好这里跟着变（见 prefsSync.ts）。
//
// 文字只有三处：下一个目标的距离（还没有目标系统，先不显示）、楼层、预设名。

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { layerName } from "../data/annotations";
import { layerOfPoint } from "../data/floors";
import { useSeason } from "../data/season/store";
import { withSeason } from "../data/season/annotations";
import { effectiveFilters, prefsStore, usePrefs } from "../prefs";
import { useAppState } from "../state";
import { markerRotation } from "../map/crs";
import { filterAnnotations, useAnnotations, useData, useMapResolution } from "../map/useMapData";
import { mmss } from "../util";
import { inTauri, listenOverlay, overlayInvoke, useWindowSize, type OverlayWindowState } from "../overlay/bridge";
import { IconCamera } from "../ui/icons";
import { MiniCard } from "./MiniCard";
import { MiniMap } from "./MiniMap";

/** 外壳发过来的窗口状态；浏览器里没有外壳，得到 null。 */
function useOverlayWindow(): OverlayWindowState | null {
  const [state, setState] = useState<OverlayWindowState | null>(null);
  useEffect(() => {
    let alive = true;
    void overlayInvoke<OverlayWindowState>("overlay_state").then((s) => {
      if (alive && s) setState(s);
    });
    const off = listenOverlay<OverlayWindowState>("otm-overlay", (s) => setState(s));
    return () => {
      alive = false;
      off();
    };
  }, []);
  return state;
}

/** 外壳转过来的热键：预设轮换、详情卡片。窗口那几个（显示、展开、调整）外壳自己做了。 */
function useOverlayHotkeys(on: (action: string) => void) {
  // 回调每次渲染都是新的，用 ref 兜住，事件监听只挂一次
  const latest = useRef(on);
  latest.current = on;
  useEffect(
    () =>
      listenOverlay<{ action: string; pressed: boolean }>("otm-hotkey", (e) => {
        if (e?.pressed) latest.current(e.action);
      }),
    [],
  );
}

export function MiniApp() {
  const prefs = usePrefs();
  const state = useAppState();
  const data = useData();
  const season = useSeason();
  const size = useWindowSize();
  const win = useOverlayWindow();
  const ov = prefs.overlay;

  // 展开的大地图比小地图宽，用窗口形状认（外壳展开时把它改成 1320×825）
  const expanded = size.w > size.h + 40;

  // 叠加层只认玩家所在的那张图：主窗口手选地图只是浏览，不该把叠加层带走
  const { meta, upstream } = useMapResolution(state, { ...prefs, manualMap: null }, data);
  const baseSet = useAnnotations(data, upstream);
  const set = useMemo(() => withSeason(baseSet, season.pack, meta), [baseSet, season.pack, meta]);

  const inRaid = !!state.raid?.started;
  const pos = state.position;
  const [now, setNow] = useState(() => Date.now());
  // ?card=1 直接带着卡片打开：回归脚本要看卡片，没有外壳按不了那个热键
  const [detailOpen, setDetailOpen] = useState(
    () => new URLSearchParams(window.location.search).get("card") === "1",
  );

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // 楼层自动切：按自己的高度算，和主窗口同一条规则
  const layer = useMemo(() => (pos && meta?.layers?.length ? layerOfPoint(meta.layers, pos) : -1), [meta, pos]);
  const visible = useMemo(() => filterAnnotations(set, prefs, meta, layer), [set, prefs, meta, layer]);
  const trailOn = effectiveFilters(prefs).trail;

  const ageSeconds = pos ? Math.max(0, (now - Date.parse(pos.time)) / 1000) : null;
  const stale = !!pos && ageSeconds !== null && ageSeconds >= prefs.staleSeconds;
  /** 进图后还没按过截图：不转，中间一个相机（DESIGN 7.8）。 */
  const waitingShot = inRaid && !pos;
  /** 对局外：设置里开着「对局外隐藏」就什么都不画（窗口本身是透明的）。 */
  const hidden = !inRaid && ov.hideOutside;

  const rot = useMemo(() => {
    if (!meta || ov.heading === "north" || waitingShot || pos?.yaw == null) return 0;
    return markerRotation(meta, pos.yaw);
  }, [meta, ov.heading, waitingShot, pos?.yaw]);

  // 详情卡片：没有目标系统，就是离自己最近的那一个标注
  const nearest = useMemo(() => {
    if (!pos) return null;
    let best: (typeof visible)[number] | null = null;
    let bestD = Infinity;
    for (const a of visible) {
      const d = Math.hypot(a.x - pos.x, a.z - pos.z);
      if (d < bestD) {
        bestD = d;
        best = a;
      }
    }
    return best ? { a: best, d: bestD } : null;
  }, [visible, pos]);

  // 换图时收起卡片（挂载那一下不算换图）
  const lastMap = useRef<string | null>(meta?.key ?? null);
  useEffect(() => {
    const key = meta?.key ?? null;
    if (lastMap.current !== null && lastMap.current !== key) setDetailOpen(false);
    lastMap.current = key;
  }, [meta?.key]);
  useEffect(() => {
    if (win?.adjust) setDetailOpen(false);
  }, [win?.adjust]);

  // 卡片会占窗口下面一块，让外壳把窗口长出来。高度是量出来的：有照片和没照片差一大截
  const cardRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!inTauri) return;
    if (!detailOpen || !nearest) {
      void overlayInvoke("overlay_set_detail", { open: false, height: null });
      return;
    }
    if (expanded) {
      // 展开时窗口是整张大地图，卡片先不画；外壳只记着「开着」，松开后还留位置
      void overlayInvoke("overlay_set_detail", { open: true, height: null });
      return;
    }
    const el = cardRef.current;
    if (!el) return;
    const report = () => {
      const h = Math.ceil(el.getBoundingClientRect().height);
      if (h > 0) void overlayInvoke("overlay_set_detail", { open: true, height: h });
    };
    report();
    // 最近的那个标注换了，卡片高度可能跟着变
    const ro = new ResizeObserver(report);
    ro.observe(el);
    return () => ro.disconnect();
  }, [expanded, detailOpen, nearest]);

  const cyclePreset = () => {
    const p = prefsStore.get();
    if (p.presets.length < 2) return;
    const i = Math.max(0, p.presets.findIndex((x) => x.id === p.activePresetId));
    const next = p.presets[(i + 1) % p.presets.length];
    prefsStore.update((old) => ({ ...old, activePresetId: next.id, overrides: {}, subOverrides: {} }));
  };

  useOverlayHotkeys((action) => {
    if (action === "preset") cyclePreset();
    else if (action === "detail") setDetailOpen((v) => !v);
  });

  const preset = prefs.presets.find((x) => x.id === prefs.activePresetId) ?? prefs.presets[0] ?? null;
  const floor = meta ? (layer >= 0 && meta.layers?.[layer] ? layerName(meta.layers[layer].name) : "地面") : null;

  if (hidden || !meta) return null;

  return (
    <div className={`mini-root${expanded ? " big" : ""}`}>
      <div
        className={`mini${expanded ? " big" : ""}${!expanded && ov.shape === "circle" ? " circle" : ""}${
          win?.adjust ? " adjust" : ""
        }`}
        style={{ "--mini-opacity": ov.opacity } as CSSProperties}
      >
        <MiniMap
          meta={meta}
          style={prefs.baseStyle}
          zh={data.zh}
          layer={layer}
          visible={visible}
          clusterIcon={prefs.clusterIcon}
          tileBrightness={prefs.tileBrightness}
          pos={pos}
          trail={inRaid ? state.trail : []}
          trailOn={trailOn}
          stale={stale}
          rot={rot}
          range={ov.rangeMeters}
          w={size.w}
          h={size.h}
          expanded={expanded}
        />
        {/* 三处文字：左上下一个目标的距离（还没有目标系统）、左下楼层、右下预设名 */}
        {floor ? <div className="mini-tag bl">{floor}</div> : null}
        {preset ? <div className="mini-tag br">{preset.name}</div> : null}
        {waitingShot ? (
          <div className="mini-center">
            <IconCamera size={expanded ? 56 : 40} />
          </div>
        ) : null}
        {stale && ageSeconds !== null ? (
          <div className="mini-stale">
            <IconCamera size={16} />
            {mmss(ageSeconds)}
          </div>
        ) : null}
        {/* 调整模式：整块可以拖着走，边框由 .adjust 画 */}
        {win?.adjust ? <div className="mini-drag" data-tauri-drag-region /> : null}
      </div>
      {/* 展开时窗口是整张大地图，卡片先收起来，松开以后还在 */}
      {!expanded && detailOpen && nearest ? (
        <div ref={cardRef}>
          <MiniCard item={nearest} meta={meta} pack={season.pack} layer={layer} />
        </div>
      ) : null}
    </div>
  );
}
