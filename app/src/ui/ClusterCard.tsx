// 鼠标停在合并标注上时弹出的小列表：这一堆里每种东西的图标、名称、数量。

import type { ClusterHover } from "../map/annotationsLayer";
import { iconUrl } from "../map/icons";

export function ClusterCard({ hover }: { hover: ClusterHover }) {
  const rows = hover.parts.length;
  const left = Math.min(hover.x + 30, window.innerWidth - 260);
  const top = Math.max(12, Math.min(hover.y - 24, window.innerHeight - rows * 30 - 28));
  return (
    <div className="card ccluster" style={{ left, top }}>
      {hover.parts.map((p) => (
        <div className="crow" key={p.sub || p.name}>
          <img src={iconUrl(p.icon)} alt="" />
          <span>{p.name}</span>
          {p.floors?.length ? <span className="ctag">{p.floors.join("·")}</span> : null}
          <b>{p.count}</b>
        </div>
      ))}
    </div>
  );
}
