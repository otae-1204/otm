// 赛季文件详情（v2-d-doc.png）：右侧抽屉。
//
// 结构：文件（物品图 + 种类名）→ 刷新地图 → 今日 → 本图刷新点 → 署名。
// 列表里选中的那一条展开成照片 + 描述 + 楼层 + 距离。

import { useEffect, useState } from "react";
import { layerName } from "../data/annotations";
import type { Position, SessionMode } from "../types";
import type { SeasonPack, SeasonPoint } from "../data/season/types";
import { mapsOfType, photoUrl } from "../data/season/types";
import { iconUrl } from "../map/icons";

/** 外部链接。Tauri 里优先走壳的命令，浏览器里就是开新标签页。 */
export function openExternal(url: string) {
  const tauri = (window as unknown as { __TAURI__?: { core?: { invoke?: (c: string, a: unknown) => Promise<unknown> } } })
    .__TAURI__;
  if (tauri?.core?.invoke) {
    tauri.core
      .invoke("plugin:opener|open_url", { url })
      .catch(() => window.open(url, "_blank", "noopener"));
    return;
  }
  window.open(url, "_blank", "noopener");
}

/**
 * 楼层标签：点位画在哪一层（floor）和网站上原来写的楼层是两回事。
 * 楼层对不上、按规则放到地面层的点，这里仍显示它原来在哪层。
 */
function floorText(p: SeasonPoint): string {
  if (p.floor) return layerName(p.floor);
  return p.floorLabel ?? "地面";
}

function distance(pos: Position | null, p: SeasonPoint): number | null {
  if (!pos) return null;
  return Math.round(Math.hypot(p.x - pos.x, p.z - pos.z));
}

export interface SeasonSheetProps {
  pack: SeasonPack;
  /** 当前看着的地图，用来高亮「刷新地图」里的那一个。 */
  mapKey: string | null;
  type: string;
  /** 点开的那一个点在本图刷新点里的序号。 */
  index: number;
  /** 玩家位置；不在本图时为 null（那就不显示距离）。 */
  pos: Position | null;
  mode: SessionMode | null;
  today: { count: number; limit: number } | null;
  /** 地图 key → 切到那张图。 */
  onPickMap: (key: string) => void;
  onBump: (delta: number) => void;
  onClose: () => void;
}

export function SeasonSheet(props: SeasonSheetProps) {
  const { pack, mapKey, type, index, pos, today, onPickMap, onBump, onClose } = props;
  const t = pack.types.find((x) => x.id === type);
  const map = pack.maps.find((m) => m.key === mapKey) ?? null;
  const here = (map?.points ?? []).map((p, i) => ({ p, i })).filter((x) => x.p.type === type);
  const [sel, setSel] = useState(index);

  // 换图、换种类就回到点开的那一条
  useEffect(() => setSel(index), [index, mapKey, type]);

  if (!t) return null;
  const maps = mapsOfType(pack, type);
  const cur = here.find((x) => x.i === sel) ?? here[0] ?? null;
  const curPhoto = cur?.p.images[0] ? photoUrl(pack, cur.p.images[0]) : null;

  return (
    <>
      <div className="dim" onClick={onClose} />
      <div className="drawer">
        <div className="dh">
          <button className="dback" onClick={onClose} title="返回">
            <svg viewBox="0 0 24 24" width="20" height="20">
              <path d="M15 5 L8 12 L15 19" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <img className="ditem" src={iconUrl(`doc_${t.item}`)} alt="" />
          <div>
            <div className="dtt">{t.name}</div>
            <div className="dst">赛季文件</div>
          </div>
        </div>

        <div className="drow">
          <span className="dkey">刷新地图</span>
          <span className="dms">
            {maps.map((m) => (
              <button
                key={m.key}
                className={`mc${m.key === mapKey ? " on" : ""}`}
                onClick={() => {
                  if (m.key !== mapKey) onPickMap(m.key);
                }}
              >
                {m.name}
              </button>
            ))}
          </span>
        </div>

        {today ? (
          <div className="drow">
            <span className="dkey">今日</span>
            <span className="dtoday">
              <b>{today.count}</b> / {today.limit}
            </span>
            <span className="cnt2">
              <button onClick={() => onBump(-1)} disabled={today.count <= 0} title="减一">
                −
              </button>
              <button onClick={() => onBump(1)} disabled={today.count >= today.limit} title="加一">
                ＋
              </button>
            </span>
          </div>
        ) : null}

        <div className="dsec">
          <span>本图刷新点</span>
          <span className="n">{here.length}</span>
        </div>

        <div className="dplist">
          {here.map((x) => {
            const d = distance(pos, x.p);
            const on = cur?.i === x.i;
            const ph = x.p.images[0];
            return (
              <button key={x.i} className={`dp${on ? " on" : ""}`} onClick={() => setSel(x.i)}>
                {on ? (
                  <span className="phb">
                    {curPhoto ? <img src={curPhoto} alt="" loading="lazy" referrerPolicy="no-referrer" /> : null}
                  </span>
                ) : (
                  <span className="phb small">
                    {ph ? <img src={photoUrl(pack, ph)} alt="" loading="lazy" referrerPolicy="no-referrer" /> : null}
                  </span>
                )}
                <span className="dpd">{x.p.desc}</span>
                <span className="dpf">
                  <span className="fc">{floorText(x.p)}</span>
                  {d !== null ? <span className="dpm">{d}m</span> : null}
                </span>
              </button>
            );
          })}
          {here.length === 0 ? <div className="dempty">这张图不刷</div> : null}
        </div>

        <div className="src">
          <a
            href={pack.source.url}
            onClick={(e) => {
              e.preventDefault();
              openExternal(pack.source.url);
            }}
          >
            位置与照片：{pack.source.name}
          </a>
        </div>
      </div>
    </>
  );
}
