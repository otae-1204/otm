// 两个窗口的偏好同步：主窗口改了小地图要跟着变（预设、筛选、底图、亮度、叠加层外观都是）。
//
// 两个窗口是同一个前端，偏好本来就在同一个 localStorage 里；但各自内存里那一份不会自己变，
// 所以这里在改完之后说一声。Tauri 里走自己的事件（跨 webview 的 storage 事件不保证送到），
// 浏览器里退回 storage 事件（两个标签页也能对上）。

import { isTauri } from "./events/source";
import { broadcast, listenOverlay } from "./overlay/bridge";
import { PREFS_KEY, prefsFromJson, prefsStore } from "./prefs";

const EVENT = "otm-prefs";

export function startPrefsSync() {
  if (typeof window === "undefined") return;
  // 正在应用别的窗口写来的那一份；这期间不再往外说，免得两边来回踢
  let applying = false;
  let last = JSON.stringify(prefsStore.get());

  const adopt = (text: string | null) => {
    if (!text) return;
    applying = true;
    try {
      const next = prefsFromJson(text);
      last = JSON.stringify(next);
      prefsStore.set(next);
    } finally {
      applying = false;
    }
  };

  if (isTauri()) {
    listenOverlay<string>(EVENT, (text) => {
      if (typeof text === "string") adopt(text);
    });
  }

  prefsStore.subscribe(() => {
    const json = JSON.stringify(prefsStore.get());
    if (applying || json === last) return;
    last = json;
    broadcast(EVENT, json);
  });

  window.addEventListener("storage", (e) => {
    if (e.key !== PREFS_KEY) return;
    adopt(e.newValue);
  });
}
