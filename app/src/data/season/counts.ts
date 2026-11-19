// 今日已拾取数的算法：跨天归零、按档案分开、加减夹在 0 到上限之间。
//
// 纯函数，不碰存储也不碰界面，方便直接跑测试（scripts/season.test.mjs）。

import type { SessionMode } from "../../types";

export interface CountState {
  /** 这一份计数属于哪一天。 */
  day: string;
  /** 档案（日志里的模式名）→ 今天捡了几个。 */
  byMode: Record<string, number>;
}

/** 本地日期的 YYYY-MM-DD。 */
export function dayKey(d = new Date()): string {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${dd}`;
}

/** 把存下来的计数整理成今天的：日期不对就是零，坏数字丢掉。 */
export function normalizeCounts(raw: unknown, today: string): CountState {
  if (!raw || typeof raw !== "object") return { day: today, byMode: {} };
  const s = raw as Partial<CountState>;
  if (s.day !== today) return { day: today, byMode: {} };
  const byMode: Record<string, number> = {};
  for (const [k, v] of Object.entries(s.byMode ?? {})) {
    if (typeof v === "number" && Number.isFinite(v) && v > 0) byMode[k] = Math.round(v);
  }
  return { day: today, byMode };
}

/** 加减一次。上限由调用方给（不同档案不一样），结果夹在 0 和上限之间。 */
export function bumpCount(cur: CountState, mode: SessionMode | null, delta: number, limit: number): CountState {
  const key: SessionMode = mode ?? "Regular";
  const next = Math.max(0, Math.min(limit, (cur.byMode[key] ?? 0) + delta));
  if (next === (cur.byMode[key] ?? 0)) return cur;
  return { day: cur.day, byMode: { ...cur.byMode, [key]: next } };
}

/** 某个档案今天捡了几个、上限多少。 */
export function todayFor(
  limits: Partial<Record<SessionMode, number>> | null,
  mode: SessionMode | null,
  c: CountState,
): { count: number; limit: number } | null {
  if (!limits) return null;
  const key: SessionMode = mode ?? "Regular";
  const limit = limits[key];
  if (!limit) return null;
  return { count: c.byMode[key] ?? 0, limit };
}
