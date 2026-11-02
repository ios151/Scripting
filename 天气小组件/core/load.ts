// 取一次天气：先定位置，再决定用缓存还是重查，查不到就退回缓存。
//
// 对应 RoamControl 的 WeatherViewModel（`updateAnchor` / `refreshIfNeeded` / `resolveNameIfNeeded`），
// 区别只在：那边是常驻的对象，这边每次出图都是一次性的，所以状态全放在缓存里。
// 所有碰系统的东西（定位、联网、读写存储、反查地名、取当前时间）都从 `Deps` 进来，自测里换成假的就能把每条分支跑一遍。
//
// 位置按这个顺序取：小组件参数 → 固定城市 → 现场定位 → 上次存下的定位 → 都没有。
// 失败的处理照 RoamControl：整个保持原样，旧缓存与旧地名一起留着，地名始终对得上缓存所在的位置。
//
// 数据可以来自两个来源（彩云、Open-Meteo），一次请求带回预报、详细数据和预警（后两样只有彩云有），三样一起存进缓存。
// 缓存记着是哪个来源写的：换了来源，别的来源写的缓存不认。

import type { AlertSnapshot, Cache, StoredLocation } from "./cache";
import type { Provider } from "./dataSource";
import type { Extras } from "./extras";
import { describeFailure, type Failure } from "./failure";
import type { Forecast } from "./forecast";
import type { Coord } from "./geo";
import { isFresh, nameStillApplies, sameArea } from "./refresh";
import type { ParameterPlace, Settings } from "./settings";

/** 位置从哪来：param 小组件参数，fixed 固定城市，live 现场定位，stored 上次存下的定位 */
export type Source = "param" | "fixed" | "live" | "stored";

/** 一次请求带回来的东西：预报、详细数据（只有彩云有）、预警（只有彩云有） */
export type Fetched = { forecast: Forecast; extras: Extras | null; alerts: AlertSnapshot | null };

export type Deps = {
  /** 当前时间（UTC 毫秒） */
  now(): number;
  readCache(): Cache | null;
  writeCache(cache: Cache): void;
  readLocation(): StoredLocation | null;
  writeLocation(location: StoredLocation): void;
  /** 现场定位；拿不到（没权限、超时、小组件里不让）返回 null */
  liveLocation(): Promise<Coord | null>;
  /** 现在用哪个来源：缓存只认这个来源写的 */
  provider(): Provider;
  /** 取天气。`previous` 是缓存里的预报（同一个来源写的），彩云那边靠它累计今天的最高最低 */
  fetchWeather(coord: Coord, previous: Forecast | null): Promise<Fetched>;
  /** 反查城市名；反查不到返回 null */
  reverseName(coord: Coord): Promise<string | null>;
};

export type Input = {
  settings: Settings;
  parameter: ParameterPlace | null;
  /** 不管缓存新不新都重查（App 里的「立即刷新」） */
  force: boolean;
};

export type Loaded =
  | {
      kind: "ok";
      forecast: Forecast;
      /** 详细数据；Open-Meteo 来源没有 */
      extras: Extras | null;
      /** 预警；Open-Meteo 来源没有 */
      alerts: AlertSnapshot | null;
      /** 这份数据是谁给的 */
      provider: Provider;
      /** 缓存里这份预报是什么时候取的 */
      fetchedAt: number;
      /** 地名；null 就显示「当前位置」 */
      place: string | null;
      source: Source;
      /** 这次想刷新、没成功，显示的是之前的数据 */
      refreshFailed: boolean;
      /** 没成功的原因（刷新成功就是 null）。App 页上说给用户听 */
      failure: Failure | null;
    }
  | { kind: "noData"; source: Source; place: string | null; failure: Failure | null }
  | { kind: "noLocation" };

/** 这次要看的位置：坐标、从哪来、有没有现成的名字（固定城市和小组件参数自带名字） */
export type Anchor = { coord: Coord; source: Source; name: string | null };

/** 出什么错都当「没有」：定位、联网、反查都可能失败，失败了有退路 */
async function attempt<T>(run: () => Promise<T>): Promise<T | null> {
  try {
    return await run();
  } catch {
    return null;
  }
}

/** 取天气：失败不往外抛，把原因带出来（同步抛的、异步抛的都算） */
async function tryFetch(run: () => Promise<Fetched>): Promise<{ fetched: Fetched | null; failure: Failure | null }> {
  try {
    return { fetched: await run(), failure: null };
  } catch (error) {
    return { fetched: null, failure: describeFailure(error) };
  }
}

/** 定位置：小组件参数 → 固定城市 → 现场定位 → 上次存下的定位 → 都没有（null） */
export async function resolveAnchor(deps: Deps, input: Input): Promise<Anchor | null> {
  const { parameter, settings } = input;
  if (parameter !== null) {
    const coord = { latitude: parameter.latitude, longitude: parameter.longitude };
    return { coord, source: "param", name: parameter.name };
  }
  if (settings.mode === "fixed" && settings.fixed !== null) {
    const coord = { latitude: settings.fixed.latitude, longitude: settings.fixed.longitude };
    return { coord, source: "fixed", name: settings.fixed.name };
  }
  const live = await attempt(() => deps.liveLocation());
  if (live !== null) {
    deps.writeLocation({ coord: live, at: deps.now() });
    return { coord: live, source: "live", name: null };
  }
  const stored = deps.readLocation();
  return stored === null ? null : { coord: stored.coord, source: "stored", name: null };
}

export async function loadWeather(deps: Deps, input: Input): Promise<Loaded> {
  const anchor = await resolveAnchor(deps, input);
  return anchor === null ? { kind: "noLocation" } : loadWeatherAt(deps, input, anchor);
}

/** 位置已经定好之后取天气。拆出来是为了自测里可以绕开定位这一步 */
export async function loadWeatherAt(deps: Deps, input: Input, anchor: Anchor): Promise<Loaded> {
  const now = deps.now();
  const provider = deps.provider();
  const stored = deps.readCache();
  // 换了来源：别的来源写的缓存不认（数据的样子、有没有详细数据都不一样）。地名和来源无关，照用 `stored` 的
  const cache = stored !== null && stored.provider === provider ? stored : null;

  if (!input.force && cache !== null && isFresh(cache, anchor.coord, now)) {
    // 天气还新，不重查；但上次没反查到地名的话，趁这次补一下
    let place = anchor.name ?? cache.place;
    if (place === null) {
      place = await attempt(() => deps.reverseName(cache.anchor));
      if (place !== null) deps.writeCache({ ...cache, place, placeAnchor: cache.anchor });
    }
    return {
      kind: "ok",
      forecast: cache.forecast,
      extras: cache.extras,
      alerts: cache.alerts,
      provider,
      fetchedAt: cache.fetchedAt,
      place,
      source: anchor.source,
      refreshFailed: false,
      failure: null,
    };
  }

  // 要重查。地名和天气互不依赖，一起查；天气没查成的话地名也作废（见下）。天气没查成要记下原因，App 页上说给用户听
  const needName = anchor.name === null && !nameStillApplies(stored?.placeAnchor ?? null, stored?.place ?? null, anchor.coord);
  // 上一次的预报只在同一个地方才交过去：它用来累计「今天」的最高最低，别的城市的最高气温不能算进这里
  const previous = cache !== null && sameArea(cache.anchor, anchor.coord) ? cache.forecast : null;
  const [attempted, resolved] = await Promise.all([
    tryFetch(() => deps.fetchWeather(anchor.coord, previous)),
    needName ? attempt(() => deps.reverseName(anchor.coord)) : Promise.resolve(null),
  ]);
  const { fetched, failure } = attempted;

  if (fetched === null) {
    // 失败就整个保持原样：旧缓存与旧地名一起留着
    if (cache === null) return { kind: "noData", source: anchor.source, place: anchor.name, failure };
    return {
      kind: "ok",
      forecast: cache.forecast,
      extras: cache.extras,
      alerts: cache.alerts,
      provider,
      fetchedAt: cache.fetchedAt,
      place: cache.place,
      source: anchor.source,
      refreshFailed: true,
      failure,
    };
  }

  let place: string | null;
  let placeAnchor: Coord | null;
  if (anchor.name !== null) {
    place = anchor.name;
    placeAnchor = anchor.coord;
  } else if (needName) {
    // 位置挪远了，旧地名不再适用：反查到新的之前先退回「当前位置」，免得旧城市名配着新位置的天气
    place = resolved;
    placeAnchor = resolved === null ? null : anchor.coord;
  } else {
    place = stored?.place ?? null;
    placeAnchor = stored?.placeAnchor ?? null;
  }

  deps.writeCache({
    version: 1,
    fetchedAt: now,
    anchor: anchor.coord,
    provider,
    forecast: fetched.forecast,
    extras: fetched.extras,
    alerts: fetched.alerts,
    place,
    placeAnchor,
  });
  return {
    kind: "ok",
    forecast: fetched.forecast,
    extras: fetched.extras,
    alerts: fetched.alerts,
    provider,
    fetchedAt: now,
    place,
    source: anchor.source,
    refreshFailed: false,
    failure: null,
  };
}
