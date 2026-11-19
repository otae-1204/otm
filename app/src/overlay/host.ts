// 主窗口这一侧：把偏好里的叠加层开关、大小、热键交给外壳，并把注册结果收回来。
//
// 外壳不认识偏好，也不认识 localStorage：开不开、多大、哪个键，都由界面说了算。
// 热键注册不上（被别的程序占了）就记在这里，设置里的那一行标红——不弹窗（DESIGN 7.8）。

import { useEffect, useSyncExternalStore } from "react";
import { HOTKEY_ACTIONS, prefsStore, usePrefs, type Hotkeys } from "../prefs";
import { inTauri, listenOverlay, overlayInvoke, type OverlayWindowState } from "./bridge";

/** 一条热键的注册结果。 */
export interface HotkeyResult {
  action: string;
  accelerator: string;
  ok: boolean;
  error: string | null;
}

let results: Record<string, HotkeyResult> = {};
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

export function useHotkeyResults(): Record<string, HotkeyResult> {
  return useSyncExternalStore(subscribe, () => results);
}

/** 把一组键位交给外壳重新注册；返回每一行的结果。 */
export async function applyHotkeys(hotkeys: Hotkeys | null): Promise<Record<string, HotkeyResult>> {
  const bindings = hotkeys
    ? HOTKEY_ACTIONS.map((a) => ({ action: a.id, accelerator: (hotkeys[a.id] ?? "").trim() })).filter((b) => b.accelerator)
    : [];
  const out = await overlayInvoke<HotkeyResult[]>("overlay_set_hotkeys", { bindings });
  if (!out) return results;
  results = Object.fromEntries(out.map((r) => [r.action, { ...r, error: r.error ?? null }]));
  listeners.forEach((l) => l());
  return results;
}

/** 主窗口挂一次：开关、大小、热键都跟着偏好走，改完立刻生效。 */
export function useOverlayHost() {
  const prefs = usePrefs();
  const ov = prefs.overlay;
  // 热键的值拼成一个字符串当依赖：改哪个键都会重新注册
  const hotkeyKey = HOTKEY_ACTIONS.map((a) => `${a.id}=${ov.hotkeys[a.id]}`).join("|");

  // 开关：关掉时外壳把窗口、热键一起收掉
  useEffect(() => {
    if (inTauri) void overlayInvoke("overlay_set_enabled", { enabled: ov.enabled });
  }, [ov.enabled]);

  // 热键：开着才注册
  useEffect(() => {
    if (!inTauri) return;
    void applyHotkeys(ov.enabled ? ov.hotkeys : null);
  }, [ov.enabled, hotkeyKey]);

  // 大小：设置里改了就把窗口改成这个边长
  useEffect(() => {
    if (inTauri && ov.enabled) void overlayInvoke("overlay_set_size", { size: ov.size });
  }, [ov.enabled, ov.size]);

  // 调整模式里拖出来的大小写回偏好（两个窗口的偏好会同步过去）
  useEffect(() => {
    if (!inTauri) return;
    return listenOverlay<OverlayWindowState>("otm-overlay", (s) => {
      if (s.adjust || !s.w) return;
      const size = Math.round(s.w);
      if (Math.abs(size - prefsStore.get().overlay.size) < 1) return;
      prefsStore.update((p) => ({ ...p, overlay: { ...p.overlay, size } }));
    });
  }, []);
}
