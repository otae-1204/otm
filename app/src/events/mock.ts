// 浏览器里的假数据：读 public/mock-events.jsonl（每行一个事件），
// 按事件里 time 的间隔回放，可以加速。

import type { OTMEvent, StateSnapshot } from "../types";
import type { EventSource } from "./source";

export const MOCK_URL = "mock-events.jsonl";

/** 当前正在跑的假数据回放，界面上的「重放」按钮用它。 */
export const mockHandle: { current: MockHandle | null } = { current: null };

export function parseJsonl(text: string): OTMEvent[] {
  const out: OTMEvent[] = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    try {
      out.push(JSON.parse(t) as OTMEvent);
    } catch {
      console.warn("跳过一行坏数据", t.slice(0, 80));
    }
  }
  return out;
}

/** 事件时间差（毫秒），坏时间按 0 处理。 */
function gapMs(prev: string | null, cur: string): number {
  if (!prev) return 0;
  const a = Date.parse(prev);
  const b = Date.parse(cur);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.max(0, b - a);
}

export interface MockHandle {
  /** 当前倍速。 */
  setSpeed(s: number): void;
  /** 从头再放一遍。 */
  restart(): void;
  /** 跳到第 n 个事件之前。 */
  seek(index: number): void;
  index(): number;
  total(): number;
}

export function mockSource(
  onSnapshot: (s: StateSnapshot) => void,
  onHandle?: (h: MockHandle) => void,
): EventSource {
  let speed = 1;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let events: OTMEvent[] = [];
  let i = 0;
  let stopped = false;
  let onEvent: (ev: OTMEvent) => void = () => {};

  const clear = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  const step = () => {
    if (stopped || i >= events.length) return;
    const ev = events[i];
    const prev = i > 0 ? events[i - 1].time : null;
    const wait = gapMs(prev, ev.time) / Math.max(0.05, speed);
    timer = setTimeout(() => {
      if (stopped) return;
      i++;
      // 假数据写死的是过去的日期，回放时把时间换成此刻，计时器和"位置过时"才说得通
      onEvent({ ...ev, time: new Date().toISOString() });
      step();
    }, wait);
  };

  const handle: MockHandle = {
    setSpeed(s) {
      const wasRunning = timer !== null;
      speed = s;
      if (wasRunning) {
        clear();
        step();
      }
    },
    restart() {
      clear();
      i = 0;
      onSnapshot({ paths: null, mode: null, raid: null, position: null, trail: [] });
      step();
    },
    seek(n) {
      clear();
      i = Math.max(0, Math.min(events.length, n));
      onSnapshot({ paths: null, mode: null, raid: null, position: null, trail: [] });
      step();
    },
    index: () => i,
    total: () => events.length,
  };

  return {
    kind: "mock",
    start(handler) {
      onEvent = handler;
      stopped = false;
      fetch(MOCK_URL)
        .then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.text();
        })
        .then((text) => {
          events = parseJsonl(text);
          i = 0;
          if (onHandle) onHandle(handle);
          else mockHandle.current = handle;
          step();
        })
        .catch((e) => console.warn("假数据读不到", e));
      return () => {
        stopped = true;
        clear();
      };
    },
  };
}
