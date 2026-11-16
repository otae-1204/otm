// 主界面。

import { useEffect, useMemo, useRef, useState } from "react";
import { layerName, layerOfPoint } from "./data/annotations";
import type { MapMeta } from "./data/mapsMeta";
import { canonicalGameMap, mapChoices, mapName } from "./data/mapsMeta";
import { effectiveFilters, prefsStore, usePrefs } from "./prefs";
import { useAppState } from "./state";
import { filterAnnotations, useAnnotations, useData, useMapResolution } from "./map/useMapData";
import { MapView } from "./map/MapView";
import { ErrorBoundary } from "./ui/ErrorBoundary";
import { FilterPanel, PresetChips } from "./ui/FilterPanel";
import { SettingsSheet } from "./ui/SettingsSheet";
import { StatusBar } from "./ui/StatusBar";
import { IconRestart, IconSettings } from "./ui/icons";
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

  // 换图后回到自动楼层
  useEffect(() => {
    setManualLayer(null);
    lastAuto.current = -1;
  }, [meta?.key]);

  const layer = manualLayer ?? autoLayer;
  const floors = useMemo(() => floorEntries(meta), [meta]);

  // 标注与外框
  const visible = useMemo(
    () => filterAnnotations(set, prefs, meta, layer),
    [set, prefs, meta, layer],
  );

  // 自己与轨迹
  const trailOn = effectiveFilters(prefs).trail;
  const ageSeconds = viewPosition ? Math.max(0, (now - Date.parse(viewPosition.time)) / 1000) : null;
  const stale = !!viewPosition && ageSeconds !== null && ageSeconds >= prefs.staleSeconds;

  const hasSvg = !!meta?.svgPath;
  const hasTile = !!meta?.tilePath;
  const style: "svg" | "tile" = hasSvg && hasTile ? prefs.baseStyle : hasSvg ? "svg" : "tile";
  const choices = useMemo(
    () => mapChoices(data.maps, data.mapsMeta ?? [], data.zh),
    [data.maps, data.mapsMeta, data.zh],
  );

  return (
    <div className="app">
      <ErrorBoundary>
        <MapView
          meta={meta}
          style={style}
          zh={data.zh}
          layer={layer}
          visible={visible}
          clusterIcon={prefs.clusterIcon}
          position={viewPosition}
          trail={viewTrail}
          trailOn={trailOn}
          stale={stale}
          ageSeconds={ageSeconds}
        />
      </ErrorBoundary>
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
      {settings ? <SettingsSheet set={set} data={data} mock={mockHandle.current !== null} onClose={() => setSettings(false)} /> : null}
    </div>
  );
}
