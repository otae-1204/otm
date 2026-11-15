import { useSyncExternalStore } from "react";
import type {
  OTMEvent,
  Paths,
  Position,
  Raid,
  SessionMode,
  StateSnapshot,
  TrailPoint,
} from "./types";

export interface AppState {
  paths: Paths | null;
  mode: SessionMode | null;
  /** 当前对局；raid_loading 时 started 为 false。 */
  raid: Raid | null;
  position: Position | null;
  trail: TrailPoint[];
  /** 上一局（或当前局）打的地图；对局外主窗口显示它（DESIGN 7.7）。 */
  lastMap: string | null;
}

export function emptyState(): AppState {
  return { paths: null, mode: null, raid: null, position: null, trail: [], lastMap: null };
}

export function fromSnapshot(s: StateSnapshot): AppState {
  return {
    paths: s.paths,
    mode: s.mode,
    raid: s.raid,
    position: s.position,
    trail: s.trail ?? [],
    lastMap: s.raid?.map ?? null,
  };
}

/** 轨迹上限，防止长时间对局把内存撑爆。 */
const TRAIL_LIMIT = 5000;

export function reduce(state: AppState, ev: OTMEvent): AppState {
  switch (ev.type) {
    case "paths":
      return {
        ...state,
        paths: {
          game_dir: ev.game_dir,
          screenshot_dir: ev.screenshot_dir,
          log_dir: ev.log_dir,
        },
      };
    case "session":
      return { ...state, mode: ev.mode };
    case "raid_loading":
      return {
        ...state,
        raid: {
          map: ev.map,
          started: false,
          scav: false,
          started_at: ev.time,
        },
        position: null,
        trail: [],
        lastMap: ev.map,
      };
    case "raid_started":
      return {
        ...state,
        raid: {
          map: ev.map,
          started: true,
          scav: ev.scav,
          started_at: ev.time,
        },
        position: null,
        trail: [],
        lastMap: ev.map,
      };
    case "raid_ended":
      return { ...state, raid: null, position: null, trail: [] };
    case "position": {
      const pos: Position = {
        x: ev.x,
        y: ev.y,
        z: ev.z,
        yaw: ev.yaw,
        source: ev.source,
        time: ev.time,
      };
      const trail = [...state.trail, { x: ev.x, y: ev.y, z: ev.z, time: ev.time }];
      return {
        ...state,
        position: pos,
        trail: trail.length > TRAIL_LIMIT ? trail.slice(trail.length - TRAIL_LIMIT) : trail,
      };
    }
    default:
      return state;
  }
}

// —— 一个极小的全局 store，供事件来源和界面共用 ——

type Listener = () => void;

let current: AppState = emptyState();
const listeners = new Set<Listener>();

export const store = {
  get: () => current,
  set(next: AppState) {
    current = next;
    listeners.forEach((l) => l());
  },
  apply(ev: OTMEvent) {
    store.set(reduce(current, ev));
  },
  reset(next: AppState) {
    store.set(next);
  },
  subscribe(l: Listener) {
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  },
};

export function useAppState(): AppState {
  return useSyncExternalStore(store.subscribe, store.get);
}
