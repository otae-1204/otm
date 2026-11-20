// 主界面。

import { useEffect, useMemo, useRef, useState } from "react";
import { layerName } from "./data/annotations";
import { layerOfPoint } from "./data/floors";
import type { MapMeta } from "./data/mapsMeta";
import { mapChoices, mapName } from "./data/mapsMeta";
import { effectiveFilters, prefsStore, usePrefs } from "./prefs";
import { store, useAppState } from "./state";
import { trailShowsOn } from "./map/follow";
import { filterAnnotations, useAnnotations, useData, useMapResolution } from "./map/useMapData";
import { MapView } from "./map/MapView";
import { ErrorBoundary } from "./ui/ErrorBoundary";
import { FilterPanel, PresetChips } from "./ui/FilterPanel";
import { SettingsSheet } from "./ui/SettingsSheet";
import { StatusBar } from "./ui/StatusBar";
import { IconRestart, IconSettings } from "./ui/icons";
import { mockHandle } from "./events/mock";
import { SeasonSheet } from "./ui/SeasonSheet";
import { useOverlayHost } from "./overlay/host";
import { withSeason } from "./data/season/annotations";
import { countStore, todayFor, useCounts, useSeason } from "./data/season/store";

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
  // 叠加层的开关、大小、热键跟着偏好走（窗口在外壳那边）
  useOverlayHost();
  const state = useAppState();
  const prefs = usePrefs();
  const data = useData();
  const { gameMap, playerMap, meta, upstream } = useMapResolution(state, prefs, data);
  const baseSet = useAnnotations(data, upstream);
  // 赛季文件并进当前这张图的标注（没有赛季包时原样返回）
  const season = useSeason();
  const seasonSet = useMemo(() => withSeason(baseSet, season.pack, meta), [baseSet, season.pack, meta]);
  const set = seasonSet;
  const counts = useCounts();
  const today = todayFor(season.pack, state.mode, counts);

  const [doc, setDoc] = useState<{ type: string; index: number } | null>(null);
  const [settings, setSettings] = useState(false);
  const [manualLayer, setManualLayer] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // 看别的图时不画自己，也不按定位算楼层
  const onPlayerMap = trailShowsOn(playerMap, gameMap);
  const viewPosition = onPlayerMap ? state.position : null;
  const viewTrail = onPlayerMap ? state.trail : [];

  // 换图：不知道玩家在哪张图时（日志没读到），手里这份轨迹属于上一张图，
  // 换了图就丢掉，不能画到新图上。对局中换图只是看看，轨迹留着。
  const pickMap = (g: string | null) => {
    if (!playerMap) {
      const s = store.get();
      if (s.trail.length > 0 || s.position) store.set({ ...s, trail: [], position: null });
    }
    prefsStore.update((p) => ({ ...p, manualMap: g }));
  };

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

  // 换图后回到自动楼层，赛季详情也收起（它说的是上一张图）
  useEffect(() => {
    setManualLayer(null);
    lastAuto.current = -1;
    setDoc(null);
  }, [meta?.key]);

  // 换了赛季包，详情里的点位就对不上了，收起
  useEffect(() => {
    setDoc(null);
  }, [season.pack]);

  // 点开的点：抽屉只讲这一个点，包里找不到（换了包）就不显示
  const seasonDoc = useMemo(() => {
    const pack = season.pack;
    if (!pack || !doc) return null;
    const p = pack.maps.find((m) => m.key === meta?.key)?.points[doc.index];
    const t = p ? pack.types.find((x) => x.id === p.type) : undefined;
    return p && t ? { point: p, type: t } : null;
  }, [season.pack, doc, meta]);

  const layer = manualLayer ?? autoLayer;
  const floors = useMemo(() => floorEntries(meta), [meta]);
  // 楼层条选了「全部」：所有楼层的标注都画，底图仍然是地面层
  const allFloors = prefs.floorAll;

  // 标注与外框
  const visible = useMemo(
    () => filterAnnotations(set, prefs, meta, allFloors ? "all" : layer),
    [set, prefs, meta, layer, allFloors],
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

  // 状态栏的文件计数点开详情：本图离自己最近的那一个；本图不刷就换到第一张刷的图
  const openSeason = () => {
    const pack = season.pack;
    if (!pack) return;
    const here = pack.maps.find((m) => m.key === meta?.key);
    const pts = here?.points ?? [];
    if (pts.length > 0) {
      const pos = onPlayerMap ? state.position : null;
      let best = 0;
      if (pos) {
        let bd = Infinity;
        pts.forEach((p, i) => {
          const d = Math.hypot(p.x - pos.x, p.z - pos.z);
          if (d < bd) {
            bd = d;
            best = i;
          }
        });
      }
      setDoc({ type: pts[best].type, index: best });
      return;
    }
    const first = pack.maps.find((m) => m.points.length > 0);
    if (!first) return;
    if (first.key !== meta?.key) pickMapByKey(first.key);
    setDoc({ type: first.points[0].type, index: 0 });
  };

  // 详情里的「刷新地图」按配置 key 切换，换成界面认的游戏内部名
  const pickMapByKey = (key: string) => {
    const c = choices.find((x) => x.normalizedName === key);
    if (c) pickMap(c.gameMap);
  };

  return (
    <div className="app">
      <ErrorBoundary>
        <MapView
          meta={meta}
          style={style}
          zh={data.zh}
          layer={allFloors ? "all" : layer}
          visible={visible}
          clusterIcon={prefs.clusterIcon}
          tileBrightness={prefs.tileBrightness}
          position={viewPosition}
          trail={viewTrail}
          trailOn={trailOn}
          stale={stale}
          ageSeconds={ageSeconds}
          onSeason={(a) => setDoc(a?.season ?? null)}
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
        <div className="floors" data-anno={visible.length} data-all={allFloors ? "1" : "0"}>
          <button
            className={`fl all${allFloors ? " on" : ""}`}
            onClick={() => prefsStore.update((p) => ({ ...p, floorAll: true }))}
          >
            全部
          </button>
          <i className="flsep" />
          {floors.map((f) => (
            <button
              key={f.index}
              className={`fl${!allFloors && f.index === layer ? " on" : ""}${f.index === autoLayer ? " auto" : ""}`}
              onClick={() => {
                // 点某一层就退出「全部」，回到原来的自动/手动逻辑
                prefsStore.update((p) => ({ ...p, floorAll: false }));
                setManualLayer(f.index === autoLayer ? null : f.index);
              }}
            >
              {f.label}
            </button>
          ))}
        </div>
      ) : null}
      <StatusBar
        state={state}
        season={today}
        meta={meta}
        gameMap={gameMap}
        mapLabel={mapName(upstream, data.zh, gameMap)}
        choices={choices}
        layer={layer}
        staleSeconds={prefs.staleSeconds}
        ageSeconds={ageSeconds}
        manualMap={prefs.manualMap}
        onPickMap={pickMap}
        onOpenSeason={openSeason}
      />
      {seasonDoc ? (
        <SeasonSheet
          pack={season.pack!}
          type={seasonDoc.type}
          point={seasonDoc.point}
          pos={onPlayerMap ? state.position : null}
          today={today}
          onBump={(d) => today && countStore.bump(state.mode, d, today.limit)}
          onClose={() => setDoc(null)}
        />
      ) : null}
      {settings ? <SettingsSheet set={set} data={data} mock={mockHandle.current !== null} onClose={() => setSettings(false)} /> : null}
    </div>
  );
}
