// Leaflet 的 CRS：把游戏坐标当成 latLng(z, x)，再按 maps.json 的 transform 和
// coordinateRotation 投影。逻辑移植自 tarkov.dev（MIT），见 geo.ts 的文件头。

import L from "leaflet";
import { applyRotation, mapTransform, type MapTransform } from "../geo";
import type { MapMeta } from "../data/mapsMeta";

export function crsFor(meta: MapMeta): L.CRS {
  const t = mapTransform(meta.transform, meta.coordinateRotation);
  const crs = L.Util.extend({}, L.CRS.Simple, {
    transformation: new L.Transformation(t.scaleX, t.marginX, t.scaleY, t.marginY),
    projection: L.Util.extend({}, L.Projection.LonLat, {
      project: (latLng: L.LatLng) => {
        const [lat, lng] = applyRotation(latLng.lat, latLng.lng, t.rotation);
        return new L.Point(lng, lat);
      },
      unproject: (point: L.Point) => {
        const [lat, lng] = applyRotation(point.y, point.x, -t.rotation);
        return new L.LatLng(lat, lng);
      },
    }),
  });
  return crs as L.CRS;
}

export function transformOf(meta: MapMeta): MapTransform {
  return mapTransform(meta.transform, meta.coordinateRotation);
}

/** 上游的 getScaledBounds：把 maxBounds 放大一点，留出拖动余地。 */
export function scaledBounds(bounds: number[][], scaleFactor: number): L.LatLngBoundsExpression {
  const cx = (bounds[0][0] + bounds[1][0]) / 2;
  const cy = (bounds[0][1] + bounds[1][1]) / 2;
  const w = (bounds[1][0] - bounds[0][0]) * scaleFactor;
  const h = (bounds[1][1] - bounds[0][1]) * scaleFactor;
  return [
    [cy - h / 2, cx - w / 2],
    [cy + h / 2, cx + w / 2],
  ];
}

export function latLngBoundsOf(bounds: number[][]): L.LatLngBoundsExpression {
  return [
    [bounds[0][1], bounds[0][0]],
    [bounds[1][1], bounds[1][0]],
  ];
}

/** 箭头朝向：上游把玩家旋转角加上 coordinateRotation（90/270 时再加 180）。 */
export function markerRotation(meta: MapMeta, yaw: number | null): number {
  let add = meta.coordinateRotation ?? 0;
  if (add === 90 || add === 270) add += 180;
  return (yaw ?? 0) + add;
}
