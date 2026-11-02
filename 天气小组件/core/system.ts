// 碰系统的几样东西：现场定位、反查 / 正查地名、联网，以及拼出一套真的 `Deps` 交给 load.ts / everything.ts。
// 都是「拿不到就当没有」：小组件里定位、反查能不能用文档没写，失败有退路（见 load.ts）。

import {
  APP_GEOCODE_TIMEOUT_MS,
  APP_LOCATION_TIMEOUT_MS,
  LIVE_LOCATION_TIMEOUT_MS,
  REVERSE_GEOCODE_TIMEOUT_MS,
  WIDGET_FETCH_TIMEOUT_SECONDS,
} from "./config";
import { fetchCaiyun } from "./caiyun";
import { endpointOf, providerOf, type DataSource } from "./dataSource";
import type { EverythingDeps } from "./everything";
import { FetchError } from "./failure";
import { isValidCoord, type Coord } from "./geo";
import type { Forecast } from "./forecast";
import type { Fetched } from "./load";
import { TIMEOUT_SECONDS, fetchForecast } from "./openmeteo";
import { cityName, pickPlace } from "./place";
import type { FixedPlace } from "./settings";
import { readCache, readDataSource, readDemoUntil, readLocation, writeCache, writeLocation } from "./store";

/**
 * 等不到就当没有（返回 null）。传进来的是「怎么发起」而不是已经发起的 Promise。
 *
 * 没有 setTimeout 的环境里没法计时。`noTimer` 说那时怎么办：
 *   · "skip"（默认）：不问了，连请求都不发，当没有。定位、反查用它——小组件一旦卡住就是一片空白，比少一次定位糟得多；
 *   · "run"：照常发起、老实等。联网用它——它自己带着超时，不问就什么数据都没有。
 */
export function withTimeout<T>(start: () => Promise<T>, ms: number, noTimer: "skip" | "run" = "skip"): Promise<T | null> {
  if (typeof setTimeout !== "function") {
    return noTimer === "run" ? Promise.resolve().then(start) : Promise.resolve(null);
  }
  return new Promise<T | null>((resolve, reject) => {
    const timer = setTimeout(() => resolve(null), ms);
    let pending: Promise<T>;
    try {
      pending = start();
    } catch (error) {
      clearTimeout(timer);
      reject(error);
      return;
    }
    pending.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * 现场定位。天气只要一公里的精度，用最省电的档；`fresh` 为真时不用系统缓存的位置。
 * 设精度和取位置整个包在同一个超时里：任何一步不返回，都不能让小组件卡住。
 */
export async function liveLocation(timeoutMs: number, fresh: boolean): Promise<Coord | null> {
  const info = await withTimeout(async () => {
    try {
      await Location.setAccuracy("kilometer");
    } catch {
      // 设不了精度不碍事，按系统默认的来
    }
    return Location.requestCurrent(fresh ? { forceRequest: true } : undefined);
  }, timeoutMs);
  return info !== null && isValidCoord(info) ? { latitude: info.latitude, longitude: info.longitude } : null;
}

export async function reverseName(coord: Coord, timeoutMs: number): Promise<string | null> {
  const placemarks = await withTimeout(
    () => Location.reverseGeocode({ latitude: coord.latitude, longitude: coord.longitude, locale: "zh-CN" }),
    timeoutMs,
  );
  return placemarks === null ? null : cityName(placemarks[0]);
}

/** 按城市名找地点（App 里选固定城市用）。找不到返回 null；联网出错会抛，由调用方提示 */
export async function findPlace(typed: string): Promise<FixedPlace | null> {
  const text = typed.trim();
  if (text === "") return null;
  const placemarks = await withTimeout(() => Location.geocodeAddress({ address: text, locale: "zh-CN" }), APP_GEOCODE_TIMEOUT_MS);
  return pickPlace(placemarks, text);
}

/** 联网外面这层超时比 `fetch` 自带的多给多少毫秒 */
export const FETCH_GRACE_MS = 2000;

/**
 * 联网取天气（来源是彩云就连详细数据和预警一起，是 Open-Meteo 就只有预报）：
 * 除了 `fetch` 自带的超时，外面再兜一层（多给 `graceMs`）——原生超时万一没掐断，小组件也不会卡成空白。
 * 没有 setTimeout 时只靠 `fetch` 自带的超时。超时按失败处理（抛错），由 load.ts 退回缓存。
 * `now` 是手机的时钟（UTC 毫秒），彩云那边用它定「现在」；`previous` 用来累计今天的最高最低。
 */
export async function fetchWeatherWithin(
  source: DataSource,
  coord: Coord,
  previous: Forecast | null,
  timeoutSeconds: number,
  now: number,
  graceMs: number = FETCH_GRACE_MS,
): Promise<Fetched> {
  const endpoint = endpointOf(source);
  const start = async (): Promise<Fetched> => {
    if (endpoint === null) {
      return { forecast: await fetchForecast(coord.latitude, coord.longitude, timeoutSeconds), extras: null, alerts: null };
    }
    const { forecast, extras, alerts } = await fetchCaiyun(endpoint, coord, timeoutSeconds, now, previous);
    return { forecast, extras, alerts };
  };
  const fetched = await withTimeout(start, timeoutSeconds * 1000 + graceMs, "run");
  if (fetched === null) throw new FetchError("network", "超时");
  return fetched;
}

/**
 * 真的依赖。`env` 只决定各处愿意等多久；`fresh` 是 App 里「立即刷新」要的新鲜定位。
 * 数据来源在这里读一次：同一次取数里「缓存认哪个来源」和「向哪个来源要」必须是同一个。
 */
export function systemDeps(env: "widget" | "app", fresh: boolean = false): EverythingDeps {
  const widget = env === "widget";
  const source = readDataSource();
  return {
    now: () => Date.now(),
    readCache,
    writeCache,
    readLocation,
    writeLocation,
    provider: () => providerOf(source),
    demoUntil: readDemoUntil,
    liveLocation: () => liveLocation(widget ? LIVE_LOCATION_TIMEOUT_MS : APP_LOCATION_TIMEOUT_MS, fresh),
    fetchWeather: (coord, previous) =>
      fetchWeatherWithin(source, coord, previous, widget ? WIDGET_FETCH_TIMEOUT_SECONDS : TIMEOUT_SECONDS, Date.now()),
    reverseName: (coord) => reverseName(coord, widget ? REVERSE_GEOCODE_TIMEOUT_MS : APP_GEOCODE_TIMEOUT_MS),
  };
}
