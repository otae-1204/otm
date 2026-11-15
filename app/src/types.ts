// 核心与界面之间的约定见 core/EVENTS.md，字段名与那里一字不差。

export type SessionMode = "Regular" | "Pve" | "PvpSeason";
export type RaidMode = "Online" | "Coop";
export type PositionSource = "screenshot" | "log";

export interface PathsEvent {
  type: "paths";
  time: string;
  game_dir: string | null;
  screenshot_dir: string | null;
  log_dir: string | null;
}

export interface SessionEvent {
  type: "session";
  time: string;
  mode: SessionMode;
}

export interface RaidLoadingEvent {
  type: "raid_loading";
  time: string;
  map: string;
}

export interface RaidStartedEvent {
  type: "raid_started";
  time: string;
  map: string;
  scav: boolean;
  raid_mode: RaidMode;
}

export interface RaidEndedEvent {
  type: "raid_ended";
  time: string;
}

export interface PositionEvent {
  type: "position";
  time: string;
  x: number;
  y: number;
  z: number;
  yaw: number | null;
  source: PositionSource;
}

export type OTMEvent =
  | PathsEvent
  | SessionEvent
  | RaidLoadingEvent
  | RaidStartedEvent
  | RaidEndedEvent
  | PositionEvent;

export interface Paths {
  game_dir: string | null;
  screenshot_dir: string | null;
  log_dir: string | null;
}

export interface Position {
  x: number;
  y: number;
  z: number;
  yaw: number | null;
  source: PositionSource;
  time: string;
}

export interface TrailPoint {
  x: number;
  y: number;
  z: number;
  time: string;
}

export interface Raid {
  map: string;
  started: boolean;
  scav: boolean;
  started_at: string;
}

/** 启动时 invoke("get_state") 拿到的快照。 */
export interface StateSnapshot {
  paths: Paths | null;
  mode: SessionMode | null;
  raid: Raid | null;
  position: Position | null;
  trail: TrailPoint[];
}
