// 叠加层和外壳之间的那层。
//
// 外壳（`shell/src-tauri/src/overlay.rs`）管窗口：置顶、透明、穿透、位置大小、全局热键。
// 界面这边只认三样东西：调它的命令、它发过来的窗口状态、它转过来的热键。
// 浏览器里（回归脚本、开发）没有外壳，这些调用都变成空操作，界面照常画。

import { useEffect, useState } from "react";
import { isTauri } from "../events/source";

export const inTauri = isTauri();

type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
type Listen = (name: string, cb: (e: { payload: unknown }) => void) => Promise<() => void>;

interface TauriGlobal {
  core?: { invoke?: Invoke };
  event?: { listen?: Listen };
  window?: { getCurrentWindow?: () => { label?: string } };
}

function global(): TauriGlobal | undefined {
  return (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__;
}

/** 调外壳的命令。浏览器里、或者外壳报错，都返回 null（界面不该为此崩掉）。 */
export async function overlayInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
  const invoke = global()?.core?.invoke;
  if (!invoke) return null;
  try {
    return (await invoke(cmd, args)) as T;
  } catch (e) {
    console.warn("叠加层命令失败", cmd, e);
    // 实机上没有控制台，这条路只有写进外壳的日志才看得见（别把日志命令自己写回日志，会转圈）
    if (cmd !== "overlay_log") logToShell(`命令 ${cmd} 失败：${String(e)}`);
    return null;
  }
}

/** 把一句话写进外壳的日志（`%LOCALAPPDATA%\dev.otae.otm\otm.log`）。浏览器里什么都不做。 */
export function logToShell(message: string) {
  const invoke = global()?.core?.invoke;
  if (!invoke) return;
  void invoke("overlay_log", { message: message.slice(0, 1000) }).catch(() => {});
}

/** 听外壳发过来的一个事件；返回取消函数。浏览器里什么都不做。 */
export function listenOverlay<T>(name: string, on: (payload: T) => void): () => void {
  const listen = global()?.event?.listen;
  if (!listen) return () => {};
  let unlisten: (() => void) | null = null;
  let stopped = false;
  listen(name, (e) => on(e.payload as T))
    .then((un) => {
      if (stopped) un();
      else unlisten = un;
    })
    .catch((e) => console.warn("叠加层事件监听失败", name, e));
  return () => {
    stopped = true;
    unlisten?.();
  };
}

/** 把一件事说给另一个窗口（偏好变了、热键结果）。 */
export function broadcast(name: string, payload: unknown) {
  const emit = (window as unknown as { __TAURI__?: { event?: { emit?: (n: string, p: unknown) => Promise<unknown> } } })
    .__TAURI__?.event?.emit;
  if (!emit) return;
  void emit(name, payload).catch(() => {});
}

/** 外壳发过来的窗口状态。 */
export interface OverlayWindowState {
  visible: boolean;
  /** 按住展开的大地图。 */
  expanded: boolean;
  /** 调整模式：不穿透、带细边框、可以拖动改大小。 */
  adjust: boolean;
  /** 没展开、没开详情卡片时的边长。 */
  w: number;
  h: number;
  /** Windows 那边真实的可见性（`IsWindowVisible`），排错时和 visible 对照着看。 */
  screen_visible?: boolean;
  /** 窗口样式的一行摘要，只进日志。 */
  dump?: string;
}

/** 外壳给这个窗口起的名字（`main`、`mini`）；浏览器里没有。 */
export function windowLabel(): string | null {
  try {
    return global()?.window?.getCurrentWindow?.()?.label ?? null;
  } catch {
    return null;
  }
}

/**
 * 当前在不在叠加层那个窗口里。认窗口 label，不认 URL。
 *
 * 外壳给 mini 窗口加载的就是 `index.html`，跟主窗口同一个页面；`?view=mini` 只留给
 * 没有外壳的地方（浏览器里跑回归脚本、开发时直接打开）。
 * （原先靠查询串区分窗口，实机上 mini 窗口一块空白，怀疑 `index.html?view=mini` 在
 * WebView2 下没加载起来，所以改成认 label，URL 不再带任何查询串。）
 */
export function isMiniView(): boolean {
  if (typeof window === "undefined") return false;
  // 外壳建 mini 窗口时注入的（`overlay.rs` 的 initialization_script），最靠得住
  if ((window as unknown as { __OTM_VIEW?: string }).__OTM_VIEW === "mini") return true;
  if (windowLabel() === "mini") return true;
  return new URLSearchParams(window.location.search).get("view") === "mini";
}

/** 窗口现在的像素尺寸；展开、拖大小、开详情卡片都会变。 */
export function useWindowSize(): { w: number; h: number } {
  const [size, setSize] = useState({ w: window.innerWidth, h: window.innerHeight });
  useEffect(() => {
    const onResize = () => setSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", onResize);
    onResize();
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return size;
}
