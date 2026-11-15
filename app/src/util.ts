// 小工具：时间、距离、格式。

import type { GamePoint } from "./data/annotations";

/** ISO 时间 → 本地 HH:MM。 */
export function clock(iso: string | null | undefined): string {
  if (!iso) return "--:--";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "--:--";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** 对局时长 mm:ss / h:mm:ss。 */
export function duration(fromIso: string | null | undefined, toMs: number): string {
  if (!fromIso) return "0:00";
  const t = Date.parse(fromIso);
  if (Number.isNaN(t)) return "0:00";
  const s = Math.max(0, Math.floor((toMs - t) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
  return `${m}:${String(ss).padStart(2, "0")}`;
}

/** 秒数 → m:ss。 */
export function mmss(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** 游戏坐标之间的水平距离（米）。 */
export function distance(a: GamePoint, b: GamePoint): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

/** 距离显示：不到 1 km 用米。 */
export function meters(d: number): string {
  if (d >= 1000) return `${(d / 1000).toFixed(1)}km`;
  return `${Math.round(d)}m`;
}

export function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v));
}
