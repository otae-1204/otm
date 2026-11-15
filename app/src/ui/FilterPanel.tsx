// 左侧：预设 chips + 大类开关 + 轨迹。
// 子类开关在设置的「预设」页里（DESIGN 6.3：主窗口左侧只有大类开关）。
//
// 行按 mockup2.html 的 .frow：图标 + 名称 + 数量，没有开关；
// 关掉的大类整行变淡，点整行切换。

import { useState } from "react";
import type { AnnotationSet, CategoryId } from "../data/annotations";
import { CATEGORY_NAMES, CATEGORY_ORDER } from "../data/annotations";
import {
  activePreset,
  defaultFilters,
  effectiveFilters,
  newPresetId,
  prefsStore,
  usePrefs,
  type FilterState,
} from "../prefs";
import { iconUrl } from "../map/icons";

/** 大类在左侧列表里的图标。 */
const CATEGORY_ICON: Record<CategoryId, string> = {
  extract: "extract_shared",
  transit: "extract_transit",
  lock: "lock",
  hazard: "hazard",
  loot: "container_safe",
  spawn: "spawn_pmc",
  switch: "switch",
  gun: "stationarygun",
};

export function PresetChips() {
  const prefs = usePrefs();
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const add = () => {
    const p = activePreset(prefs);
    const id = newPresetId();
    const filters: FilterState = p
      ? { ...p.filters, categories: { ...p.filters.categories }, subs: { ...p.filters.subs } }
      : defaultFilters(["extract", "transit", "lock", "hazard"]);
    prefsStore.update((old) => ({
      ...old,
      presets: [...old.presets, { id, name: `预设 ${old.presets.length + 1}`, filters }],
      activePresetId: id,
      overrides: {},
    }));
    setRenaming(id);
    setDraft(`预设 ${prefs.presets.length + 1}`);
  };

  const commit = () => {
    if (!renaming) return;
    const name = draft.trim();
    if (name) {
      prefsStore.update((old) => ({
        ...old,
        presets: old.presets.map((x) => (x.id === renaming ? { ...x, name } : x)),
      }));
    }
    setRenaming(null);
  };

  return (
    <div className="presets">
      {prefs.presets.map((p) => (
        <button
          key={p.id}
          className={`chip${p.id === prefs.activePresetId ? " on" : ""}`}
          onClick={() => prefsStore.update((old) => ({ ...old, activePresetId: p.id, overrides: {} }))}
          onDoubleClick={() => {
            setRenaming(p.id);
            setDraft(p.name);
          }}
          title="双击改名"
        >
          {renaming === p.id ? (
            <input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => {
                if (e.key === "Enter") commit();
                if (e.key === "Escape") setRenaming(null);
              }}
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            p.name
          )}
        </button>
      ))}
      <button className="chip add" onClick={add} title="新建预设">
        +
      </button>
    </div>
  );
}

function Switch({ on }: { on: boolean }) {
  return <span className={`sw${on ? "" : " off"}`} />;
}

export function FilterPanel({ set }: { set: AnnotationSet }) {
  const prefs = usePrefs();
  const f = effectiveFilters(prefs);

  const toggleCategory = (c: CategoryId) => {
    // 主窗口的大类开关是临时调整，只改 overrides，不动预设本身
    const next = !f.categories[c];
    prefsStore.update((old) => ({ ...old, overrides: { ...old.overrides, [c]: next } }));
  };

  const toggleTrail = () => {
    prefsStore.update((old) => ({
      ...old,
      presets: old.presets.map((p) =>
        p.id === old.activePresetId ? { ...p, filters: { ...p.filters, trail: !p.filters.trail } } : p,
      ),
    }));
  };

  const countOf = (c: CategoryId) => set.items.filter((a) => a.category === c).length;

  return (
    <div className="filters">
      {CATEGORY_ORDER.map((c) => {
        const on = f.categories[c];
        return (
          <button
            key={c}
            className={`frow${on ? "" : " off"}`}
            onClick={() => toggleCategory(c)}
            title={CATEGORY_NAMES[c]}
          >
            <img src={iconUrl(CATEGORY_ICON[c])} alt="" />
            <span>{CATEGORY_NAMES[c]}</span>
            <span className="n">{countOf(c)}</span>
          </button>
        );
      })}
      <div className="sep" />
      <button className="frow" onClick={toggleTrail}>
        <span>轨迹</span>
        <Switch on={f.trail} />
      </button>
    </div>
  );
}
