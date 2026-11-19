// 左下角状态栏（DESIGN 7.8）。所有状态只靠这里表达，不弹窗。

import { useEffect, useState } from "react";
import type { MapChoice, MapMeta } from "../data/mapsMeta";
import { layerName } from "../data/annotations";
import type { AppState } from "../state";
import { clock, duration, mmss } from "../util";
import { IconCamera, IconCaret, IconFolder } from "./icons";
import { iconUrl } from "../map/icons";

export interface StatusBarProps {
  state: AppState;
  meta: MapMeta | null;
  gameMap: string | null;
  mapLabel: string;
  choices: MapChoice[];
  layer: number;
  staleSeconds: number;
  /** 距上次定位的秒数；没有定位时为 null。 */
  ageSeconds: number | null;
  manualMap: string | null;
  onPickMap: (gameMap: string | null) => void;
  /** 今日已拾取数 / 上限；没有赛季包或这个档案没上限时为 null。 */
  season: { count: number; limit: number } | null;
  onOpenSeason: () => void;
}

export function StatusBar(props: StatusBarProps) {
  const { state, meta, mapLabel, choices, layer, staleSeconds, ageSeconds, manualMap, onPickMap, season, onOpenSeason } =
    props;
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const raid = state.raid;
  const inRaid = !!raid?.started;
  const noGameDir = state.paths !== null && !state.paths.game_dir;
  const noMap = !meta;
  const waitingShot = inRaid && !state.position;
  const stale = inRaid && !!state.position && ageSeconds !== null && ageSeconds >= staleSeconds;

  const dot = noGameDir ? "red" : noMap ? "yellow" : waitingShot ? "yellow" : inRaid ? "" : "gray";
  const mode = state.mode === "Pve" ? "PVE" : state.mode === "PvpSeason" ? "赛季" : state.mode === "Regular" ? "PVP" : null;
  const floor = inRaid && meta?.layers && layer >= 0 ? layerName(meta.layers[layer].name) : null;

  return (
    <>
      {open ? (
        <div className="maplist">
          <span
            className={manualMap === null ? "on" : ""}
            onClick={() => {
              onPickMap(null);
              setOpen(false);
            }}
          >
            自动
          </span>
          {choices.map((c) => (
            <span
              key={c.gameMap}
              className={manualMap === c.gameMap ? "on" : ""}
              onClick={() => {
                onPickMap(c.gameMap);
                setOpen(false);
              }}
            >
              {c.label}
            </span>
          ))}
        </div>
      ) : null}
      <div className="status">
        <span className={`dot ${dot}`} />
        {noGameDir ? (
          <span className="err">
            <IconFolder />
            选择游戏目录
          </span>
        ) : noMap ? (
          <button className="mapbtn" onClick={() => setOpen((o) => !o)}>
            选择地图
            <IconCaret />
          </button>
        ) : (
          <button className="mapbtn" onClick={() => setOpen((o) => !o)}>
            {mapLabel}
            <IconCaret />
          </button>
        )}
        {floor ? <span>{floor}</span> : null}
        {inRaid && raid ? <span>{duration(raid.started_at, now)}</span> : null}
        {waitingShot ? (
          <span className="warn" title="进图后还没截过图">
            <IconCamera />
          </span>
        ) : null}
        {stale && ageSeconds !== null ? (
          <span className="warn">
            <IconCamera />
            {mmss(ageSeconds)}
          </span>
        ) : null}
        {mode ? <span>{mode}</span> : null}
        {inRaid && state.position ? <b>{clock(state.position.time)}</b> : null}
        {season ? (
          <button className="seas" onClick={onOpenSeason} title="赛季文件">
            <img src={iconUrl("season")} alt="" />
            <b>{season.count}</b>
            <span className="of">/ {season.limit}</span>
          </button>
        ) : null}
      </div>
    </>
  );
}
