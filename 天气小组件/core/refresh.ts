// 刷新规则：什么时候重查天气、什么时候重查地名。照 RoamControl 的 WeatherViewModel 移植。
//
//   · 天气一刻钟里变不了多少，不必每次碰一下都重查：15 分钟内、位置也没挪出 5 公里，就直接用缓存。
//   · 位置挪出 5 公里，天气和地名都要重查；地名不到 5 公里就不重查。
//   · 地名写到区县时，地名挪出 2 公里就重查（区县的边界比城市近得多）。
//   · 位置变化的判断拿的是「上次查询用的锚点」，不是上次的定位：定位在 5 公里以内晃动不算变了。

import { distanceMeters, type Coord } from "./geo";
import type { PlaceLevel } from "./settings";

/** 数据多久算新 */
export const FRESHNESS_MS = 15 * 60 * 1000;

/** 位置挪动超过这么远（米）就重查，也重新反查地名 */
export const MOVE_THRESHOLD_M = 5_000;

export type Cached = { fetchedAt: number; anchor: Coord };

/** 两个位置还算同一个地方吗：相隔不到 5 公里 */
export function sameArea(a: Coord, b: Coord): boolean {
  return distanceMeters(a, b) < MOVE_THRESHOLD_M;
}

/**
 * 缓存还新吗：取到不到 15 分钟、而且就在这个位置附近。
 * 取到的时刻在「未来」（设备时钟被往回拨过）算过期：不然缓存会一直冻到时钟追上那个时刻。
 */
export function isFresh(cache: Cached | null, anchor: Coord, now: number): boolean {
  if (cache === null) return false;
  const age = now - cache.fetchedAt;
  return age >= 0 && age < FRESHNESS_MS && sameArea(anchor, cache.anchor);
}

/** 地名写到区县时，挪出这么远（米）就重新反查：区县的边界比城市近得多 */
export const DISTRICT_NAME_THRESHOLD_M = 2_000;

/** 已有的地名还适用吗：有名字，而且是在离现在不到 5 公里（写到区县时 2 公里）的地方反查的 */
export function nameStillApplies(placeAnchor: Coord | null, place: string | null, anchor: Coord, level: PlaceLevel = "city"): boolean {
  if (place === null || place === "" || placeAnchor === null) return false;
  return level === "district" ? distanceMeters(anchor, placeAnchor) < DISTRICT_NAME_THRESHOLD_M : sameArea(anchor, placeAnchor);
}
