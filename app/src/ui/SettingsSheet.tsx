// 设置面板：预设编辑、定位、数据。

import { useState } from "react";
import type { AnnotationSet, CategoryId } from "../data/annotations";
import { CATEGORY_NAMES, CATEGORY_ORDER } from "../data/annotations";
import type { DataBundle } from "../data/loader";
import { dataStore } from "../data/loader";
import { activePreset, newPresetId, prefsStore, subKey, usePrefs, type FilterState } from "../prefs";
import { mockHandle } from "../events/mock";
import { iconUrl } from "../map/icons";
import { IconCaret } from "./icons";

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

type Tab = "presets" | "locate" | "data";

export function SettingsSheet({
  set,
  data,
  mock,
  onClose,
}: {
  set: AnnotationSet;
  data: DataBundle;
  /** 当前是不是在放假的定位数据（浏览器里没有核心时）。 */
  mock: boolean;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<Tab>("presets");
  return (
    <>
      <div className="dim" onClick={onClose} />
      <div className="sheet">
        <div className="tabs">
          <button className={`tab${tab === "presets" ? " on" : ""}`} onClick={() => setTab("presets")}>
            预设
          </button>
          <button className={`tab${tab === "locate" ? " on" : ""}`} onClick={() => setTab("locate")}>
            定位
          </button>
          <button className={`tab${tab === "data" ? " on" : ""}`} onClick={() => setTab("data")}>
            数据
          </button>
        </div>
        <div className="sbody">
          {tab === "presets" ? <PresetEditor set={set} /> : null}
          {tab === "locate" ? <LocatePanel /> : null}
          {tab === "data" ? <DataPanel data={data} mock={mock} /> : null}
        </div>
      </div>
    </>
  );
}

function PresetEditor({ set }: { set: AnnotationSet }) {
  const prefs = usePrefs();
  const p = activePreset(prefs);
  const [open, setOpen] = useState<CategoryId | null>("loot");
  if (!p) return null;

  const patch = (fn: (f: FilterState) => FilterState) =>
    prefsStore.update((old) => ({
      ...old,
      presets: old.presets.map((x) => (x.id === p.id ? { ...x, filters: fn(x.filters) } : x)),
    }));

  const toggleCat = (c: CategoryId) =>
    patch((f) => ({ ...f, categories: { ...f.categories, [c]: !f.categories[c] } }));

  const toggleSub = (c: CategoryId, id: string) =>
    patch((f) => {
      const k = subKey(c, id);
      return { ...f, subs: { ...f.subs, [k]: f.subs[k] === false } };
    });

  const add = () => {
    const id = newPresetId();
    prefsStore.update((old) => ({
      ...old,
      presets: [...old.presets, { id, name: `预设 ${old.presets.length + 1}`, filters: { ...p.filters, categories: { ...p.filters.categories }, subs: { ...p.filters.subs } } }],
      activePresetId: id,
    }));
  };

  const remove = () => {
    prefsStore.update((old) => {
      const presets = old.presets.filter((x) => x.id !== p.id);
      return {
        ...old,
        presets,
        activePresetId: presets[0]?.id ?? "",
        overrides: {},
      };
    });
  };

  return (
    <div style={{ display: "flex" }}>
      <div className="plist">
        {prefs.presets.map((x) => (
          <button
            key={x.id}
            className={`pi${x.id === p.id ? " on" : ""}`}
            onClick={() => prefsStore.update((old) => ({ ...old, activePresetId: x.id, overrides: {} }))}
          >
            {x.name}
          </button>
        ))}
        <button className="pi" onClick={add} style={{ justifyContent: "center", fontSize: 20 }}>
          +
        </button>
      </div>
      <div style={{ flex: 1 }}>
        <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
          <div className="name">
            <input
              value={p.name}
              onChange={(e) => {
                const name = e.target.value;
                prefsStore.update((old) => ({
                  ...old,
                  presets: old.presets.map((x) => (x.id === p.id ? { ...x, name } : x)),
                }));
              }}
            />
          </div>
        </div>
        <div className="h">类别</div>
        <div className="tree">
          {CATEGORY_ORDER.map((c) => {
            const subs = set.subs[c] ?? [];
            const on = p.filters.categories[c];
            const expanded = open === c;
            return (
              <div key={c} className={`g${on ? "" : " off"}`}>
                <button className="gh" onClick={() => toggleCat(c)}>
                  <img src={iconUrl(CATEGORY_ICON[c])} alt="" />
                  <span>{CATEGORY_NAMES[c]}</span>
                  {subs.length > 0 ? (
                    <span className="cnt">
                      {subs.filter((s) => p.filters.subs[subKey(c, s.id)] !== false).length}/{subs.length}
                    </span>
                  ) : null}
                  <span
                    className="car"
                    role="button"
                    tabIndex={-1}
                    onClick={(e) => {
                      e.stopPropagation();
                      setOpen(expanded ? null : c);
                    }}
                  >
                    <IconCaret />
                  </span>
                  <span className={`sw${on ? "" : " off"}`} style={{ marginLeft: 10 }} />
                </button>
                {expanded && subs.length > 0 ? (
                  <div className="subs2">
                    {subs.map((s) => {
                      const son = p.filters.subs[subKey(c, s.id)] !== false;
                      return (
                        <button key={s.id} className={`sc ${c}${son ? " on" : ""}`} onClick={() => toggleSub(c, s.id)}>
                          {s.icon ? <img src={iconUrl(s.icon)} alt="" /> : null}
                          {s.name}
                        </button>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
        <div className="h">显示</div>
        <button className="row" style={{ width: "100%" }} onClick={() => patch((f) => ({ ...f, trail: !f.trail }))}>
          轨迹
          <span className="r">
            <span className={`sw${p.filters.trail ? "" : " off"}`} />
          </span>
        </button>
        <div style={{ marginTop: 18 }}>
          <button className="del" onClick={remove} disabled={prefs.presets.length <= 1}>
            删除
          </button>
        </div>
      </div>
    </div>
  );
}

function LocatePanel() {
  const prefs = usePrefs();
  return (
    <>
      <div className="h">位置过时</div>
      <div className="row">
        超过多少秒算过时
        <span className="r">
          <input
            type="range"
            min={10}
            max={300}
            step={5}
            value={prefs.staleSeconds}
            onChange={(e) => prefsStore.update((p) => ({ ...p, staleSeconds: Number(e.target.value) }))}
          />
          <span className="val">{prefs.staleSeconds}s</span>
        </span>
      </div>
      <div className="h" style={{ marginTop: 18 }}>
        底图
      </div>
      <div className="row">
        样式
        <span className="r">
          <div className="seg">
            <span
              className={prefs.baseStyle === "svg" ? "on" : ""}
              onClick={() => prefsStore.update((p) => ({ ...p, baseStyle: "svg" }))}
            >
              矢量
            </span>
            <span
              className={prefs.baseStyle === "tile" ? "on" : ""}
              onClick={() => prefsStore.update((p) => ({ ...p, baseStyle: "tile" }))}
            >
              实景
            </span>
          </div>
        </span>
      </div>
    </>
  );
}

function DataPanel({ data, mock }: { data: DataBundle; mock: boolean }) {
  const rows = [
    { key: "mapsMeta", label: "地图配置" },
    { key: "maps", label: "标注数据" },
    { key: "mapsZh", label: "中文翻译" },
  ];
  return (
    <>
      <div className="h">上游数据</div>
      {rows.map((r) => {
        const s = data.status[r.key];
        const age = s?.cachedAt ? Math.round((Date.now() - s.cachedAt) / 60000) : null;
        return (
          <div className="kv" key={r.key}>
            <span>{r.label}</span>
            <b className={s && !s.ok ? "bad" : "good"}>
              {s ? (s.ok ? "已更新" : data.status[r.key]?.cachedAt ? "用缓存" : "失败") : "未加载"}
            </b>
            {age !== null ? <span>{age < 1 ? "刚刚" : `${age} 分钟前`}</span> : null}
            {s?.error ? <span className="bad">{s.error}</span> : null}
          </div>
        );
      })}
      <div style={{ marginTop: 14 }}>
        <button className="chip" onClick={() => dataStore.refreshAll()}>
          重新获取
        </button>
      </div>
      {mock ? <MockSpeed /> : null}
    </>
  );
}

function MockSpeed() {
  const prefs = usePrefs();
  return (
    <>
      <div className="h">假数据</div>
      <div className="kv">
        <span>回放倍速</span>
        <b className="good">{prefs.mockSpeed}×</b>
      </div>
      <input
        type="range"
        min={1}
        max={20}
        step={1}
        value={prefs.mockSpeed}
        onChange={(e) => {
          const v = Number(e.target.value);
          prefsStore.update((p) => ({ ...p, mockSpeed: v }));
          mockHandle.current?.setSpeed(v);
        }}
        style={{ width: "100%" }}
      />
    </>
  );
}
