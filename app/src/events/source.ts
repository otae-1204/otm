// 事件来源。界面只认这个接口，具体是 Tauri 还是假数据由 main.tsx 选。

import type { OTMEvent, StateSnapshot } from "../types";

export type SourceKind = "tauri" | "mock";

export interface EventSource {
  kind: SourceKind;
  /** 开始推送事件；返回停止函数。 */
  start(onEvent: (ev: OTMEvent) => void): () => void;
}

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI__" in window;
}

/** Tauri：监听 otm-event，启动时 invoke("get_state") 取快照。 */
export function tauriSource(onSnapshot: (s: StateSnapshot) => void): EventSource {
  return {
    kind: "tauri",
    start(onEvent) {
      let unlisten: (() => void) | null = null;
      let stopped = false;

      (async () => {
        const { invoke } = await import("@tauri-apps/api/core");
        const { listen } = await import("@tauri-apps/api/event");
        try {
          const snap = await invoke<StateSnapshot | null>("get_state");
          if (snap && !stopped) onSnapshot(snap);
        } catch (e) {
          console.warn("get_state 失败", e);
        }
        const un = await listen<OTMEvent>("otm-event", (e) => {
          if (e.payload && typeof e.payload === "object") onEvent(e.payload);
        });
        if (stopped) un();
        else unlisten = un;
      })().catch((e) => console.warn("Tauri 事件监听失败", e));

      return () => {
        stopped = true;
        unlisten?.();
      };
    },
  };
}
