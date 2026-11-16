import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { CSS } from "./ui/styles";

const styleEl = document.createElement("style");
styleEl.textContent = CSS;
document.head.appendChild(styleEl);
import { App } from "./App";
import { ErrorBoundary } from "./ui/ErrorBoundary";
import { dataStore } from "./data/loader";
import { mockHandle, mockSource } from "./events/mock";
import { isTauri, tauriSource, type EventSource } from "./events/source";
import { fromSnapshot, store } from "./state";
import { prefsStore } from "./prefs";

dataStore.start();

// 事件来源：Tauri 里用 Tauri，浏览器里用假数据
const source: EventSource = isTauri()
  ? tauriSource((snap) => store.reset(fromSnapshot(snap)))
  : mockSource(
      (snap) => store.reset(fromSnapshot(snap)),
      // 拿到回放句柄后立刻套上偏好里的倍速
      (h) => {
        mockHandle.current = h;
        h.setSpeed(prefsStore.get().mockSpeed);
      },
    );

source.start((ev) => store.apply(ev));

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary className="full">
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
