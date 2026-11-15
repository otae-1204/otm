// 点标注弹出的卡片。

import type { Annotation } from "../data/annotations";
import { CATEGORY_NAMES } from "../data/annotations";
import { iconUrl } from "../map/icons";
import { meters } from "../util";
import type { Position } from "../types";

export function AnnotationCard({
  a,
  pos,
  x,
  y,
  onClose,
}: {
  a: Annotation;
  pos: Position | null;
  x: number;
  y: number;
  onClose: () => void;
}) {
  const d = pos ? Math.hypot(a.x - pos.x, a.z - pos.z) : null;
  return (
    <div className="card" style={{ left: Math.min(x + 18, window.innerWidth - 270), top: Math.max(12, y - 70) }}>
      <button className="close" onClick={onClose}>
        ×
      </button>
      <h4>
        <img src={iconUrl(a.icon)} alt="" />
        {a.name}
      </h4>
      <div className="meta">
        <span className="tagc">{CATEGORY_NAMES[a.category]}</span>
        {d !== null ? <span>{meters(d)}</span> : null}
        <span>
          {Math.round(a.x)}, {Math.round(a.z)}
        </span>
      </div>
      {a.note ? <div className="meta" style={{ marginTop: 6 }}>{a.note}</div> : null}
    </div>
  );
}
