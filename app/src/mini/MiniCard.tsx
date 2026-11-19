// 叠加层里的详情卡片（DESIGN 7.3.2，效果图 v2-mini-detail.png）。
//
// 热键按一下弹出、再按一下收起。还没有目标系统，所以显示离自己最近的那一个标注；
// 落到赛季文件点上时用赛季包里的照片和位置描述（和右侧详情同一份数据）。

import type { Annotation } from "../data/annotations";
import { CATEGORY_NAMES, layerName } from "../data/annotations";
import type { MapMeta } from "../data/mapsMeta";
import { photoUrl, type SeasonPack } from "../data/season/types";
import { itemIcon } from "../data/season/icons";
import { iconUrl } from "../map/icons";
import { meters } from "../util";

export interface MiniCardProps {
  item: { a: Annotation; d: number };
  meta: MapMeta;
  pack: SeasonPack | null;
  /** 当前楼层，非赛季点用它。 */
  layer: number;
}

export function MiniCard({ item, meta, pack, layer }: MiniCardProps) {
  const { a, d } = item;
  // 赛季文件的点位自带照片和网站写的楼层
  const point =
    a.season && pack ? (pack.maps.find((m) => m.key === meta.key)?.points[a.season.index] ?? null) : null;
  const photo = point?.images[0] ? photoUrl(pack!, point.images[0]) : null;
  const type = a.season ? (pack?.types.find((t) => t.id === a.sub) ?? null) : null;
  const floor = point
    ? point.floor
      ? layerName(point.floor)
      : (point.floorLabel ?? "地面")
    : layer >= 0 && meta.layers?.[layer]
      ? layerName(meta.layers[layer].name)
      : "地面";

  return (
    <div className="minicard">
      {/* 没有照片就不留那块地方：卡片高度跟着内容走（外壳按这里量出来的高度开窗口） */}
      {photo ? (
        <div className="mcp">
          <img src={photo} alt="" loading="lazy" referrerPolicy="no-referrer" />
        </div>
      ) : null}
      <div className="mcb">
        <div className="mct">
          {/* 赛季点用包里的物品图（打包进来的），别的用 public 里的图标 */}
          <img src={a.season ? (itemIcon(type?.item) ?? iconUrl(a.icon)) : iconUrl(a.icon)} alt="" />
          <span>{a.name}</span>
          <b>{meters(d)}</b>
        </div>
        {a.note ? <div className="mcd">{a.note}</div> : null}
        <div className="mcf">
          <span className="fc">{floor}</span>
          {/* 类别名和标注名一样时不重复写一遍 */}
          {!point && CATEGORY_NAMES[a.category] !== a.name ? (
            <span className="mcn">{CATEGORY_NAMES[a.category]}</span>
          ) : null}
        </div>
      </div>
    </div>
  );
}
