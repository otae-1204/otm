// 主界面。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { layerName, layerOfPoint } from "./data/annotations";
import type { MapMeta } from "./data/mapsMeta";
import type { Annotation } from "./data/annotations";
import { canonicalGameMap, mapChoices, mapName } from "./data/mapsMeta";
import { effectiveFilters, prefsStore, usePrefs } from "./prefs";
import { useAppState } from "./state";
import {
  filterAnnotations,
  useAnnotations,
  useData,
  useLeaflet,
  useMapResolution,
} from "./map/useMapData";
import { AnnotationCard } from "./ui/AnnotationCard";
import { ClusterCard } from "./ui/ClusterCard";
import type { ClusterHover } from "./map/annotationsLayer";
import { FilterPanel, PresetChips } from "./ui/FilterPanel";
import { SettingsSheet } from "./ui/SettingsSheet";
import { StatusBar } from "./ui/StatusBar";
import { IconRestart, IconSettings } from "./ui/icons";
import { mmss } from "./util";
import { mockHandle } from "./events/mock";

/**
 * 楼层条：从上到下高层到低层。地面不是 maps.json 里的一层（底图本身就是地面），
 * 所以补一个「地面」项，索引 -1。
 */
function floorEntries(meta: MapMeta | null): { index: number; label: string }[] {
  if (!meta?.layers || meta.layers.length === 0) return [];
  const rows = meta.layers.map((l, i) => {
    const hs = (l.extents ?? []).map((e) => e.height[0]);
    return { index: i, label: layerName(l.name), h: hs.length ? Math.min(...hs) : 0 };
  });
  rows.push({ index: -1, label: "地面", h: 0 });
  return rows.sort((a, b) => b.h - a.h).map(({ index, label }) => ({ index, label }));
}

export function App() {
  const state = useAppState();
  const prefs = usePrefs();
  const data = useData();
  const { gameMap, playerMap, meta, upstream } = useMapResolution(state, prefs, data);
  const set = useAnnotations(data, upstream);

  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const [picked, setPicked] = useState<{ a: Annotation; x: number; y: number } | null>(null);
  const [hover, setHover] = useState<ClusterHover | null>(null);
  const [settings, setSettings] = useState(false);
  const [manualLayer, setManualLayer] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // 看别的图时不画自己，也不按定位算楼层
  const onPlayerMap = !playerMap || canonicalGameMap(playerMap) === canonicalGameMap(gameMap);
  const viewPosition = onPlayerMap ? state.position : null;
  const viewTrail = onPlayerMap ? state.trail : [];

  const autoLayer = useMemo(() => {
    const p = viewPosition;
    if (!meta?.layers || meta.layers.length === 0 || !p) return -1;
    return layerOfPoint(meta.layers, p);
  }, [meta, viewPosition]);

  // 手动看别的楼层时，只有玩家换到另一层才拉回自动；
  // 从「没位置」到有楼层不算换层，否则开局一瞬间就把手动选择清掉了
  const lastAuto = useRef(autoLayer);
  useEffect(() => {
    const prev = lastAuto.current;
    lastAuto.current = autoLayer;
    if (prev >= 0 && autoLayer >= 0 && prev !== autoLayer) setManualLayer(null);
  }, [autoLayer]);

  // 换图后回到自动楼层，并收起卡片
  useEffect(() => {
    setManualLayer(null);
    setPicked(null);
    lastAuto.current = -1;
  }, [meta?.key]);

  const layer = manualLayer ?? autoLayer;
  const floors = useMemo(() => floorEntries(meta), [meta]);

  const onPick = useCallback((a: Annotation | null) => {
    setPicked((prev) => (a === null || prev?.a.key === a.key ? null : { a, x: 0, y: 0 }));
  }, []);
  const onHover = useCallback((h: ClusterHover | null) => setHover(h), []);

  const layers = useLeaflet({
    container,
    meta,
    style: prefs.baseStyle,
    zh: data.zh,
    onPick,
    onHover,
  });

  // 卡片位置跟着地图走
  useEffect(() => {
    const map = layers.map;
    if (!map || !picked) return;
    const update = () => {
      const p = map.latLngToContainerPoint([picked.a.z, picked.a.x]);
      setPicked((prev) => (prev ? { ...prev, x: p.x, y: p.y } : prev));
    };
    update();
    map.on("move zoom", update);
    return () => {
      map.off("move zoom", update);
    };
  }, [layers.map, layers.version, picked?.a.key]);

  // 楼层
  useEffect(() => {
    layers.controller?.setLayer(layer);
  }, [layers.controller, layers.version, layer, meta?.key]);

  // 标注与外框
  const visible = useMemo(
    () => filterAnnotations(set, prefs, meta, layer),
    [set, prefs, meta, layer],
  );
  useEffect(() => {
    const map = layers.map;
    if (!map || !layers.annotations) return;
    const draw = () => {
      setHover(null);
      layers.annotations?.render(
        visible,
        map.getZoom(),
        layers.controller?.fitZoom() ?? map.getZoom(),
        prefs.clusterIcon,
      );
    };
    draw();
    layers.outlines?.render(visible);
    map.on("zoomend", draw);
    map.on("moveend", draw);
    return () => {
      map.off("zoomend", draw);
      map.off("moveend", draw);
    };
  }, [layers.map, layers.annotations, layers.outlines, layers.version, visible, prefs.clusterIcon]);

  // 自己与轨迹
  const trailOn = effectiveFilters(prefs).trail;
  const ageSeconds = viewPosition ? Math.max(0, (now - Date.parse(viewPosition.time)) / 1000) : null;
  const stale = !!viewPosition && ageSeconds !== null && ageSeconds >= prefs.staleSeconds;
  useEffect(() => {
    if (!layers.player) return;
    layers.player.update(
      meta,
      viewPosition,
      viewTrail,
      trailOn,
      stale ? "stale" : "normal",
      stale && ageSeconds !== null ? mmss(ageSeconds) : null,
    );
    // ageSeconds 每秒变一次，过时的计时才会跟着跳
  }, [layers.player, layers.version, meta, viewPosition, viewTrail, trailOn, stale, ageSeconds]);

  const hasSvg = !!meta?.svgPath;
  const hasTile = !!meta?.tilePath;
  const style: "svg" | "tile" = hasSvg && hasTile ? prefs.baseStyle : hasSvg ? "svg" : "tile";
  const choices = useMemo(
    () => mapChoices(data.maps, data.mapsMeta ?? [], data.zh),
    [data.maps, data.mapsMeta, data.zh],
  );

  return (
    <div className="app">
      <div className="map" ref={setContainer} />
      <PresetChips />
      <FilterPanel set={set} />
      <div className="tools">
        {hasSvg && hasTile ? (
          <div className="seg">
            <span
              className={style === "svg" ? "on" : ""}
              onClick={() => prefsStore.update((p) => ({ ...p, baseStyle: "svg" }))}
            >
              矢量
            </span>
            <span
              className={style === "tile" ? "on" : ""}
              onClick={() => prefsStore.update((p) => ({ ...p, baseStyle: "tile" }))}
            >
              实景
            </span>
          </div>
        ) : null}
        {mockHandle.current ? (
          <button
            className="ib"
            title="重放假数据"
            onClick={() => {
              mockHandle.current?.restart();
              setManualLayer(null);
            }}
          >
            <IconRestart />
          </button>
        ) : null}
        <button className="ib" title="设置" onClick={() => setSettings(true)}>
          <IconSettings />
        </button>
      </div>
      {floors.length > 0 ? (
        <div className="floors">
          {floors.map((f) => (
            <button
              key={f.index}
              className={`fl${f.index === layer ? " on" : ""}${f.index === autoLayer ? " auto" : ""}`}
              onClick={() => setManualLayer(f.index === autoLayer ? null : f.index)}
            >
              {f.label}
            </button>
          ))}
        </div>
      ) : null}
      <StatusBar
        state={state}
        meta={meta}
        gameMap={gameMap}
        mapLabel={mapName(upstream, data.zh, gameMap)}
        choices={choices}
        layer={layer}
        staleSeconds={prefs.staleSeconds}
        ageSeconds={ageSeconds}
        manualMap={prefs.manualMap}
        onPickMap={(g) => prefsStore.update((p) => ({ ...p, manualMap: g }))}
      />
      {picked ? (
        <AnnotationCard
          a={picked.a}
          pos={viewPosition}
          x={picked.x}
          y={picked.y}
          onClose={() => setPicked(null)}
        />
      ) : null}
      {hover ? <ClusterCard hover={hover} /> : null}
      {settings ? <SettingsSheet set={set} data={data} mock={mockHandle.current !== null} onClose={() => setSettings(false)} /> : null}
    </div>
  );
}
