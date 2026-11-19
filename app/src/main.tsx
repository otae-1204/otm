import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { CSS } from "./ui/styles";

const styleEl = document.createElement("style");
styleEl.textContent = CSS;
document.head.appendChild(styleEl);
import { App } from "./App";
import { MiniApp } from "./mini/MiniApp";
import { isMiniView } from "./overlay/bridge";
import { ErrorBoundary } from "./ui/ErrorBoundary";
import { dataStore } from "./data/loader";
import { mockHandle, mockSource } from "./events/mock";
import { isTauri, tauriSource, type EventSource } from "./events/source";
import { followRaid } from "./map/follow";
import { fromSnapshot, store } from "./state";
import { startPrefsSync } from "./prefsSync";
import type { StateSnapshot } from "./types";
import { prefsStore } from "./prefs";

// 同一个前端：主窗口是地图界面，叠加层那个窗口是 ?view=mini 的小地图。
// 叠加层窗口是透明的，页面底色得让开（见 styles.ts 里的 body.mini-window）。
const mini = isMiniView();
if (mini) document.body.classList.add("mini-window");

dataStore.start();
startPrefsSync();

/**
 * 新的一局来了，地图就得跟着它走（DESIGN 7.7）：手选只是看看，不能一直盖住自动切换。
 * 界面启动时如果已经在一局里，也一样归队。
 */
function followRaidIfNeeded() {
  prefsStore.update(followRaid);
}

function applySnapshot(snap: StateSnapshot) {
  if (snap.raid) followRaidIfNeeded();
  store.reset(fromSnapshot(snap));
}

// 事件来源：Tauri 里用 Tauri，浏览器里用假数据
const source: EventSource = isTauri()
  ? tauriSource(applySnapshot)
  : mockSource(
      applySnapshot,
      // 拿到回放句柄后立刻套上偏好里的倍速
      (h) => {
        mockHandle.current = h;
        h.setSpeed(prefsStore.get().mockSpeed);
      },
    );

source.start((ev) => {
  // 先切回跟着对局走，再记事件：同一帧里地图就对上了，不会先闪一下手选的那张。
  if (ev.type === "raid_loading" || ev.type === "raid_started") followRaidIfNeeded();
  store.apply(ev);
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary className="full">{mini ? <MiniApp /> : <App />}</ErrorBoundary>
  </StrictMode>,
);
