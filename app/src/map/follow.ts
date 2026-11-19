// 地图跟着谁走：自动切图与轨迹归属的那两条规则（DESIGN 7.7 与「轨迹跟着它所属的地图走」）。
//
// 两条规则合起来是同一件事：地图和轨迹都有归属，显示出来的东西必须是当前这张图的。
//
// - 新的一局开始时，显示的地图切到那一张。手选只是看看，不能把它挡住。
// - 轨迹只画在它所属的那张图上：知道玩家在哪张图时就是玩家那张，看别的图时收起来；
//   不知道玩家在哪张图（日志没读到）时，换图等于换了一局，旧轨迹直接丢掉（见 App 的 pickMap）。

import { canonicalGameMap } from "../data/mapsMeta";

/** 带手选地图的那份偏好。 */
export interface ManualMapHolder {
  manualMap: string | null;
}

/**
 * 新的一局开始时把手选的地图让出来，回到「跟着对局走」。
 *
 * 已经跟着对局走时原样返回，免得白写一次 localStorage、白通知一次界面。
 */
export function followRaid<T extends ManualMapHolder>(prefs: T): T {
  return prefs.manualMap === null ? prefs : { ...prefs, manualMap: null };
}

/**
 * 轨迹（以及自己的箭头）该不该画在当前显示的这张图上。
 *
 * @param playerMap 玩家在哪张图；日志还没读到、不知道时为 `null`。
 * @param gameMap   现在显示的那张图。
 */
export function trailShowsOn(playerMap: string | null, gameMap: string | null): boolean {
  if (!playerMap) return true;
  if (!gameMap) return false;
  return canonicalGameMap(playerMap) === canonicalGameMap(gameMap);
}
