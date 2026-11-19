// 设置里的两页：叠加层（开关和外观）、热键（DESIGN 7.4 的「叠加层」「热键」页）。
//
// 风险提示只有叠加层页底部那一行（AGENTS.md：必要提示只写一行）。

import { useEffect, useState } from "react";
import {
  HOTKEY_ACTIONS,
  OVERLAY_OPACITY,
  OVERLAY_RANGE,
  OVERLAY_SIZE,
  prefsStore,
  usePrefs,
  type Hotkeys,
} from "../prefs";
import { applyHotkeys, useHotkeyResults } from "../overlay/host";

/** 一页两栏里的开关行。 */
function SwitchRow({ label, on, onChange }: { label: string; on: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="row">
      {label}
      <span className="r">
        <button className={`sw${on ? "" : " off"}`} onClick={() => onChange(!on)} aria-label={label} />
      </span>
    </div>
  );
}

function SliderRow({
  label,
  value,
  min,
  max,
  step,
  text,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  text: string;
  onChange: (v: number) => void;
}) {
  return (
    <div className="row">
      {label}
      <span className="r">
        <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
        <span className="val">{text}</span>
      </span>
    </div>
  );
}

function SegRow<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { id: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="row">
      {label}
      <span className="r">
        <div className="seg">
          {options.map((o) => (
            <span key={o.id} className={value === o.id ? "on" : ""} onClick={() => onChange(o.id)}>
              {o.label}
            </span>
          ))}
        </div>
      </span>
    </div>
  );
}

/** 叠加层页：启用、大小、不透明度、视野、形状、朝向、对局外隐藏。 */
export function OverlayPanel() {
  const prefs = usePrefs();
  const results = useHotkeyResults();
  const ov = prefs.overlay;
  const patch = (p: Partial<typeof ov>) =>
    prefsStore.update((old) => ({ ...old, overlay: { ...old.overlay, ...p } }));

  return (
    <>
      <SwitchRow label="启用" on={ov.enabled} onChange={(v) => patch({ enabled: v })} />
      <SliderRow
        label="大小"
        value={ov.size}
        min={OVERLAY_SIZE.min}
        max={OVERLAY_SIZE.max}
        step={20}
        text={String(ov.size)}
        onChange={(v) => patch({ size: v })}
      />
      <SliderRow
        label="不透明度"
        value={ov.opacity}
        min={OVERLAY_OPACITY.min}
        max={OVERLAY_OPACITY.max}
        step={0.02}
        text={`${Math.round(ov.opacity * 100)}%`}
        onChange={(v) => patch({ opacity: v })}
      />
      <SliderRow
        label="视野范围"
        value={ov.rangeMeters}
        min={OVERLAY_RANGE.min}
        max={OVERLAY_RANGE.max}
        step={10}
        text={`${ov.rangeMeters}m`}
        onChange={(v) => patch({ rangeMeters: v })}
      />
      <SegRow
        label="形状"
        value={ov.shape}
        options={[
          { id: "square", label: "方" },
          { id: "circle", label: "圆" },
        ]}
        onChange={(v) => patch({ shape: v })}
      />
      <SegRow
        label="朝向"
        value={ov.heading}
        options={[
          { id: "follow", label: "跟随" },
          { id: "north", label: "朝北" },
        ]}
        onChange={(v) => patch({ heading: v })}
      />
      <SwitchRow label="对局外隐藏" on={ov.hideOutside} onChange={(v) => patch({ hideOutside: v })} />
      <HotkeyHint results={results} />
      <div className="note">置顶窗口，不读取游戏。官方未表态，可能有风险。</div>
    </>
  );
}

/** 热键被占用时在页面底部说一声（那一行自己已经标红了）。 */
function HotkeyHint({ results }: { results: ReturnType<typeof useHotkeyResults> }) {
  const bad = HOTKEY_ACTIONS.filter((a) => results[a.id]?.ok === false);
  if (bad.length === 0) return null;
  return (
    <div className="note bad">
      {bad.map((a) => a.label).join("、")} 被占用，换一个键。
    </div>
  );
}

/** 热键页：一行一个动作，点一下按键位，按新的键就换掉、立刻重新注册。 */
export function HotkeyPanel() {
  const prefs = usePrefs();
  const results = useHotkeyResults();
  const hotkeys = prefs.overlay.hotkeys;
  const [editing, setEditing] = useState<keyof Hotkeys | null>(null);

  useEffect(() => {
    if (!editing) return;
    // 等着按下一个键；Esc 放弃
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.code === "Escape") {
        setEditing(null);
        return;
      }
      const accelerator = acceleratorOf(e);
      if (!accelerator) return; // 只按了修饰键，等真正的那一个
      const id = editing;
      const next = { ...prefsStore.get().overlay.hotkeys, [id]: accelerator };
      prefsStore.update((p) => ({ ...p, overlay: { ...p.overlay, hotkeys: next } }));
      setEditing(null);
      void applyHotkeys(next);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [editing]);

  return (
    <>
      <div className="h">叠加层</div>
      {HOTKEY_ACTIONS.map((a) => {
        const r = results[a.id];
        const bad = r && !r.ok;
        return (
          <div className="row" key={a.id}>
            {a.label}
            {a.hold ? <span className="hold">按住</span> : null}
            <span className="r">
              <button
                className={`key${editing === a.id ? " on" : ""}${bad ? " bad" : ""}`}
                title={bad ? `注册不了：${r?.error ?? ""}` : "点一下换键"}
                onClick={() => setEditing(editing === a.id ? null : a.id)}
              >
                {editing === a.id ? "按键" : hotkeys[a.id] || "＋"}
              </button>
            </span>
          </div>
        );
      })}
    </>
  );
}

const MODIFIERS = new Set([
  "ShiftLeft",
  "ShiftRight",
  "ControlLeft",
  "ControlRight",
  "AltLeft",
  "AltRight",
  "MetaLeft",
  "MetaRight",
]);

/** 按下的键 → 外壳认的写法（`Ctrl+Shift+KeyA`、`F6`、`CapsLock`）。 */
function acceleratorOf(e: KeyboardEvent): string | null {
  if (MODIFIERS.has(e.code)) return null;
  const parts: string[] = [];
  if (e.ctrlKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  if (e.metaKey) parts.push("Super");
  const key = e.code || e.key;
  if (!key) return null;
  parts.push(key);
  return parts.join("+");
}
