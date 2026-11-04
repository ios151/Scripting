// 存下来的天气缓存与上一次的定位。App、小组件是两个运行环境，共用的就是这两份，
// 所以读出来一律先验一遍：旧版本写的、被改坏的，都不能让脚本崩，坏了就当没有。

import { parseStoredAlerts, type AlertItem } from "./alerts";
import type { Provider } from "./dataSource";
import { parseExtras, type Extras } from "./extras";
import { FAILURE_REASONS, type FailureRecord } from "./failure";
import { parseForecast, type Forecast } from "./forecast";
import { isValidCoord, type Coord } from "./geo";

/**
 * 同一次请求里带回来的预警。`items` 不是 null：读懂了（可能是空的，就是现在没有预警）；
 * 是 null：没读到（接口没给预警字段、或者读不懂），原因在 `failure` 里。
 */
export type AlertSnapshot = { items: AlertItem[] | null; failure: FailureRecord | null };

export type Cache = {
  version: 1;
  /** 取到这份预报的时刻（UTC 毫秒） */
  fetchedAt: number;
  /** 这份预报是在哪个位置查的 */
  anchor: Coord;
  /** 这份数据是谁给的：换了来源，别的来源的缓存不认 */
  provider: Provider;
  forecast: Forecast;
  /** 详细数据，只有彩云来源有 */
  extras: Extras | null;
  /** 预警，只有彩云来源有 */
  alerts: AlertSnapshot | null;
  /** 这个位置的地名（城市级），反查不到是 null，界面退回显示「当前位置」 */
  place: string | null;
  /**
   * 反查时系统给的区县名：null 是反查过、系统没给；没有这一项是旧版本写的、或者地名不是反查来的（固定城市 / 小组件参数自带的）——
   * 地名要写到区县时得补查一次
   */
  district?: string | null;
  /** 地名是在哪个位置反查的（城市级挪出 5 公里才重查，写到区县时 2 公里）；没有地名就是 null */
  placeAnchor: Coord | null;
};

/** 最近一次拿到的定位。小组件里现场定位不成时，退回它 */
export type StoredLocation = { coord: Coord; at: number };

function pickCoord(value: unknown): Coord | null {
  return isValidCoord(value) ? { latitude: value.latitude, longitude: value.longitude } : null;
}

function parseAlertSnapshot(raw: unknown): AlertSnapshot | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const items = parseStoredAlerts(record.items);

  let failure: FailureRecord | null = null;
  const rawFailure = record.failure;
  if (typeof rawFailure === "object" && rawFailure !== null) {
    const { at, reason, message } = rawFailure as Record<string, unknown>;
    const known = FAILURE_REASONS.find((value) => value === reason);
    if (typeof at === "number" && Number.isFinite(at) && known !== undefined && typeof message === "string") {
      failure = { at, reason: known, message: message.slice(0, 120) };
    }
  }
  return items === null && failure === null ? null : { items, failure };
}

/** 区县名：字符串是反查到的；null 是反查过、系统没给；别的（没这一项、被改坏）当「没查过」 */
function parseDistrict(raw: unknown): string | null | undefined {
  if (raw === null) return null;
  return typeof raw === "string" && raw.trim() !== "" ? raw.trim() : undefined;
}

export function parseCache(raw: unknown): Cache | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  if (record.version !== 1) return null;
  const { fetchedAt } = record;
  if (typeof fetchedAt !== "number" || !Number.isFinite(fetchedAt)) return null;
  const anchor = pickCoord(record.anchor);
  const forecast = parseForecast(record.forecast);
  if (anchor === null || forecast === null) return null;

  // 老版本的缓存没有 provider：那时只有 Open-Meteo
  const provider = record.provider === undefined ? "openmeteo" : record.provider === "caiyun" || record.provider === "openmeteo" ? record.provider : null;
  if (provider === null) return null;

  const place = typeof record.place === "string" && record.place !== "" ? record.place : null;
  const placeAnchor = place === null ? null : pickCoord(record.placeAnchor);
  // 有名字却没有「在哪反查的」，名字就说不准是哪儿的，不要（区县名跟着一起作废）
  const district = placeAnchor === null ? undefined : parseDistrict(record.district);
  return {
    version: 1,
    fetchedAt,
    anchor,
    provider,
    forecast,
    extras: parseExtras(record.extras),
    alerts: parseAlertSnapshot(record.alerts),
    place: placeAnchor === null ? null : place,
    ...(district === undefined ? {} : { district }),
    placeAnchor,
  };
}

export function parseStoredLocation(raw: unknown): StoredLocation | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const coord = pickCoord(record.coord);
  const { at } = record;
  if (coord === null || typeof at !== "number" || !Number.isFinite(at)) return null;
  return { coord, at };
}
