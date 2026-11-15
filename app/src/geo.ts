// 游戏坐标 → 地图坐标的换算。
//
// 移植自 tarkov.dev 的地图页面（MIT 协议）：
// https://github.com/the-hideout/tarkov-dev/blob/main/src/pages/map/index.jsx
// 原文件里的 getCRS / applyRotation / pos / getBounds 被改写成不依赖 Leaflet 的纯函数，
// 供 Leaflet 的 CRS 和标注楼层判定共用。
//
// 要点：
// - 一个游戏点 (x, y, z) 在 Leaflet 的 CRS.Simple 里是 latLng(lat = z, lng = x)，y 只用来判楼层。
// - CRS 的 transformation 取 maps.json 的 transform：[scaleX, marginX, scaleY, marginY]，
//   其中 scaleY = transform[2] * -1。
// - projection 先按 coordinateRotation 旋转再投影。

export type LatLngTuple = [number, number];

export interface GamePoint {
  x: number;
  y: number;
  z: number;
}

/** 与上游 applyRotation 一致：绕原点旋转，返回 latLng(lat, lng)。 */
export function applyRotation(lat: number, lng: number, rotation: number): LatLngTuple {
  if (!lat && !lng) return [0, 0];
  if (!rotation) return [lat, lng];
  const rad = (rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const rotatedLng = lng * cos - lat * sin;
  const rotatedLat = lng * sin + lat * cos;
  return [rotatedLat, rotatedLng];
}

/** 与上游 pos() 一致。 */
export function gamePos(p: GamePoint): LatLngTuple {
  return [p.z, p.x];
}

/** 与上游 getBounds 一致：bounds 是 [[x1, z1], [x2, z2]]。 */
export function boundsLatLng(bounds: number[][]): [LatLngTuple, LatLngTuple] {
  return [
    [bounds[0][1], bounds[0][0]],
    [bounds[1][1], bounds[1][0]],
  ];
}

export interface MapTransform {
  scaleX: number;
  scaleY: number;
  marginX: number;
  marginY: number;
  rotation: number;
}

export function mapTransform(transform?: number[] | null, rotation?: number | null): MapTransform {
  return {
    scaleX: transform ? transform[0] : 1,
    scaleY: transform ? transform[2] * -1 : 1,
    marginX: transform ? transform[1] : 0,
    marginY: transform ? transform[3] : 0,
    rotation: rotation ?? 0,
  };
}

/** 游戏坐标 → 投影后的平面坐标（Leaflet 的 CRS 内部用的就是这一步）。 */
export function projectGame(p: GamePoint, t: MapTransform): LatLngTuple {
  return applyRotation(p.z, p.x, t.rotation);
}

/** 平面坐标 → 图层像素坐标（和 Leaflet transformation.transform 一致）。 */
export function transformPoint(pt: LatLngTuple, t: MapTransform): [number, number] {
  return [t.scaleX * pt[1] + t.marginX, t.scaleY * pt[0] + t.marginY];
}

/** 游戏坐标 → 图层像素坐标，等价于 map.project(latLng, 0)。 */
export function gameToPixel(p: GamePoint, t: MapTransform): [number, number] {
  return transformPoint(projectGame(p, t), t);
}

/** 图层像素坐标 → 游戏坐标（gameToPixel 的反函数，用来核对 SVG 里的路径）。 */
export function pixelToGame(px: number, py: number, t: MapTransform): [number, number] {
  const lng = (px - t.marginX) / t.scaleX;
  const lat = (py - t.marginY) / t.scaleY;
  const [rlng, rlat] = applyRotation(lat, lng, -t.rotation);
  // applyRotation 返回 [lat, lng]，而游戏坐标是 (x = lng, z = lat)
  return [rlng, rlat];
}

/** 平面坐标 → 反向旋转后的 latLng（仅用于调试/对照）。 */
export function unrotate(lat: number, lng: number, rotation: number): LatLngTuple {
  return applyRotation(lat, lng, -rotation);
}
