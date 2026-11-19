// 赛季文件详情（v2-d-doc.png）：右侧抽屉，只讲点开的这一个点。
//
// 结构：文件（物品图 + 种类名）→ 大照片 → 描述 → 楼层与距离 → 今日 → 署名。
// 换一个点就是换一页，不再在抽屉里列出这张图的其它刷新点；不加遮罩，
// 地图上的别的点直接点就是换到那一个，点空白处（MapView 的 onPick(null)）收起。

import { layerName } from "../data/annotations";
import type { Position } from "../types";
import type { SeasonPack, SeasonPoint, SeasonType } from "../data/season/types";
import { photoUrl } from "../data/season/types";
import { itemIcon } from "../data/season/icons";

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

/** 物品图没有或画不出来时垫在下面的文件形状，用种类的颜色（和地图上的徽章同一个形状）。 */
function FileShape({ color }: { color?: string }) {
  return (
    <svg
      className="dibg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.1"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={color ? { color } : undefined}
      aria-hidden="true"
    >
      <path d="M6.6 2.4h6.9l3.9 3.9v15.3H6.6z" />
      <path d="M13.5 2.4v3.9h3.9" />
    </svg>
  );
}

export interface SeasonSheetProps {
  pack: SeasonPack;
  type: SeasonType;
  /** 点开的那个点。 */
  point: SeasonPoint;
  /** 玩家位置；不在本图时为 null（那就不显示距离）。 */
  pos: Position | null;
  today: { count: number; limit: number } | null;
  onBump: (delta: number) => void;
  onClose: () => void;
}

export function SeasonSheet(props: SeasonSheetProps) {
  const { pack, type, point, pos, today, onBump, onClose } = props;
  const photo = point.images[0] ? photoUrl(pack, point.images[0]) : null;
  const d = distance(pos, point);
  const icon = itemIcon(type.item);

  return (
    <>
      <div className="drawer dpane">
        <div className="dh">
          <button className="dback" onClick={onClose} title="返回">
            <svg viewBox="0 0 24 24" width="20" height="20">
              <path d="M15 5 L8 12 L15 19" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <span className="dibox">
            <FileShape color={type.color} />
            {icon ? (
              <img
                key={type.id}
                className="ditem"
                src={icon}
                width={52}
                height={52}
                alt=""
                onError={(e) => {
                  // 画不出来就把图收起来，露出下面的文件形状，不留一个灰方块
                  e.currentTarget.style.visibility = "hidden";
                }}
              />
            ) : null}
          </span>
          <div>
            <div className="dtt">{type.name}</div>
            <div className="dst">赛季文件</div>
          </div>
        </div>

        <div className="dphoto">
          {photo ? <img src={photo} alt="" referrerPolicy="no-referrer" /> : <FileShape color={type.color} />}
        </div>

        <div className="ddesc">{point.desc}</div>

        <div className="dmeta">
          <span className="fc">{floorText(point)}</span>
          {d !== null ? <span className="dpm">{d}m</span> : null}
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
