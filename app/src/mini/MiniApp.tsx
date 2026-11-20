// 叠加层里的小地图（DESIGN 7.5、7.8，效果图 v2-mini.png / v2-expand.png / v2-mini-detail.png）。
//
// 外壳按 `?view=mini` 打开这个窗口（`shell/src-tauri/src/overlay.rs`）：置顶、透明、穿透。
// 和主窗口是同一份数据、同一份偏好：事件来自核心，底图、标注、楼层、预设筛选都复用；
// 主窗口改了偏好这里跟着变（见 prefsSync.ts）。
//
// 文字只有三处：下一个目标的距离（还没有目标系统，先不显示）、楼层、预设名。

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { layerName } from "../data/annotations";
import { layerOfPoint } from "../data/floors";
import { useSeason } from "../data/season/store";
import { withSeason } from "../data/season/annotations";
import { effectiveFilters, prefsStore, usePrefs } from "../prefs";
import { useAppState } from "../state";
import { markerRotation } from "../map/crs";
import { filterAnnotations, useAnnotations, useData, useMapResolution } from "../map/useMapData";
import { mmss } from "../util";
import { inTauri, listenOverlay, logToShell, overlayInvoke, useWindowSize, type OverlayWindowState } from "../overlay/bridge";
import { IconCamera } from "../ui/icons";
import { MiniCard } from "./MiniCard";
import { MiniMap } from "./MiniMap";

/** 空框这件事只往日志里写一次（它会一直重画）。 */
let emptyLogged = false;

/**
 * 小地图真正能看见的那一块（`.mini` 的矩形）。
 *
 * 不能用窗口尺寸代替：开着详情卡片时外壳把窗口长高了，`.mini` 还是那个正方形，
 * 拿窗口高度去算中心，地图就会整体往下偏半个卡片高，自己的箭头也就离开了中心。
 */
function useFrameSize(el: HTMLDivElement | null, fallback: { w: number; h: number }) {
  const [box, setBox] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => {
    if (!el) return;
    // clientWidth/Height 是边框里面那一圈：绝对定位的子弹层就是按它算的
    const measure = () => {
      const { clientWidth: w, clientHeight: h } = el;
      if (w < 1 || h < 1) return;
      setBox((b) => (b && Math.abs(b.w - w) < 0.5 && Math.abs(b.h - h) < 0.5 ? b : { w, h }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return box ?? fallback;
}

/** 外壳发过来的窗口状态；浏览器里没有外壳，得到 null。 */
function useOverlayWindow(): OverlayWindowState | null {
  const [state, setState] = useState<OverlayWindowState | null>(null);
  useEffect(() => {
    let alive = true;
    void overlayInvoke<OverlayWindowState>("overlay_state").then((s) => {
      if (!s) return;
      // 外壳以为的样子 vs Windows 那边真实的样子，两个都记下来（日志里排错用）
      if (s.dump) logToShell(`叠加层：外壳说 ${s.dump}`);
      if (alive) setState(s);
    });
    const off = listenOverlay<OverlayWindowState>("otm-overlay", (s) => setState(s));
    return () => {
      alive = false;
      off();
    };
  }, []);
  return state;
}

/**
 * 心跳：每 5 秒把「页面还活着吗」写一行日志。
 *
 * WebView2 会把被判成被遮挡、在后台的窗口暂停重绘和计时器。游戏全屏盖着小地图时，按键外壳
 * 照样收到、窗口也照样显示成功，画面却停在最后一帧——只有这里能分出是不是这一回事。
 * 数值没变就不写，不刷屏。
 */
function useHeartbeat(lastPosAt: { current: number }) {
  useEffect(() => {
    if (!inTauri) return;
    let frames = 0;
    let raf = 0;
    const tick = () => {
      frames += 1;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    let seenFrames = 0;
    let seenVis = document.visibilityState;
    const id = window.setInterval(() => {
      const vis = document.visibilityState;
      if (frames === seenFrames && vis === seenVis) return;
      const ago =
        lastPosAt.current > 0
          ? `${Math.round((Date.now() - lastPosAt.current) / 1000)}s 前`
          : "还没收到";
      logToShell(`叠加层：心跳 帧+${frames - seenFrames} 可见性=${vis} 上次位置 ${ago}`);
      seenFrames = frames;
      seenVis = vis;
    }, 5000);
    return () => {
      cancelAnimationFrame(raf);
      window.clearInterval(id);
    };
  }, [lastPosAt]);
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
  // 回调 ref：空框和真地图是两个元素，换的时候要让量尺寸的那一套跟着换
  const [frameEl, setFrameEl] = useState<HTMLDivElement | null>(null);
  const frameRef = useCallback((n: HTMLDivElement | null) => setFrameEl(n), []);
  const ov = prefs.overlay;

  // 展开的大地图比小地图宽，用窗口形状认（外壳展开时把它改成 1320×825）
  const expanded = size.w > size.h + 40;
  // 地图按 `.mini` 那块来铺：中心、视野、转动都只用它
  const frame = useFrameSize(frameEl, { w: size.w, h: size.w });

  // 叠加层只认玩家所在的那张图：主窗口手选地图只是浏览，不该把叠加层带走
  const { meta, upstream } = useMapResolution(state, { ...prefs, manualMap: null }, data);
  const baseSet = useAnnotations(data, upstream);
  const set = useMemo(() => withSeason(baseSet, season.pack, meta), [baseSet, season.pack, meta]);

  const inRaid = !!state.raid?.started;
  const pos = state.position;
  // 最近一次收到位置的时间：心跳日志要带着它，才看得出地图有没有在更新
  const posAt = useRef(0);
  const posKey = pos ? `${pos.x},${pos.y},${pos.yaw}` : "";
  useEffect(() => {
    if (posKey) posAt.current = Date.now();
  }, [posKey]);
  useHeartbeat(posAt);
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
  /**
   * 对局外怎么显示：设置里开着「对局外隐藏」就什么都不画（窗口本身是透明的），
   * 但刚打开叠加层的这 10 秒、以及调整模式里，一定要让人看见窗口在哪、能拖。
   */
  const [justOpened, setJustOpened] = useState(true);
  useEffect(() => {
    const t = setTimeout(() => setJustOpened(false), 10_000);
    return () => clearTimeout(t);
  }, []);
  const showOutside = !ov.hideOutside || justOpened || !!win?.adjust;
  const hidden = !inRaid && !showOutside;

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
  // 最近一次量到的卡片高度：日志里要带上它，才看得出卡片到底弹没弹
  const cardH = useRef(0);
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
      if (h <= 0) return;
      if (h !== cardH.current) {
        cardH.current = h;
        logToShell(`叠加层：详情卡片画出来了，高 ${h}`);
      }
      void overlayInvoke("overlay_set_detail", { open: true, height: h });
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
    else if (action === "detail") {
      const next = !detailOpen;
      // 实机上按键收到了、窗口也说自己显示成功了，可屏幕上什么都没有；这行能对上界面的视角
      logToShell(
        `热键 detail：卡片${next ? "开" : "关"}，卡片高 ${cardH.current > 0 ? cardH.current : "还没量过"}，对局${inRaid ? "里" : "外"}`,
      );
      setDetailOpen(next);
    }
  });

  const preset = prefs.presets.find((x) => x.id === prefs.activePresetId) ?? prefs.presets[0] ?? null;
  const floor = meta ? (layer >= 0 && meta.layers?.[layer] ? layerName(meta.layers[layer].name) : "地面") : null;

  if (hidden) return null;
  if (!meta) {
    // 对局中还没认出哪张图：等事件，别闪一下空框
    if (inRaid) return null;
    // 对局外又没有上一局：灰底的空框加一个相机，至少看得见窗口在哪、能拖
    if (!emptyLogged) {
      emptyLogged = true;
      logToShell("叠加层：没有上一局，画灰底空框");
    }
    return (
      <div className={`mini-root${expanded ? " big" : ""}`}>
        <div
          ref={frameRef}
          className={`mini empty${expanded ? " big" : ""}${!expanded && ov.shape === "circle" ? " circle" : ""}${
            win?.adjust ? " adjust" : ""
          }`}
          style={{ "--mini-opacity": ov.opacity } as CSSProperties}
        >
          <div className="mini-center">
            <IconCamera size={expanded ? 56 : 40} />
          </div>
          {win?.adjust ? <div className="mini-drag" data-tauri-drag-region /> : null}
        </div>
      </div>
    );
  }

  return (
    <div className={`mini-root${expanded ? " big" : ""}`}>
      <div
        ref={frameRef}
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
          w={frame.w}
          h={frame.h}
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
