// 存在脚本自己的 Storage 里（默认私有域）。App、小组件是两个运行环境，共用的就是这几份，
// 读出来一律先过 parse（见 cache.ts / settings.ts / dataSource.ts），读不了、读坏了都当没有，不让脚本崩。

import { parseCache, parseStoredLocation, type Cache, type StoredLocation } from "./cache";
import { defaultSource, parseSource, type DataSource } from "./dataSource";
import { defaultSettings, parseSettings, type Settings } from "./settings";

const CACHE_KEY = "weather.cache.v1";
const LOCATION_KEY = "weather.location.v1";
const SETTINGS_KEY = "weather.settings.v1";
const SOURCE_KEY = "weather.source.v1";
const DEMO_KEY = "weather.alert-demo.v1";
/** 只做过预警、还没有「数据来源」之前的版本留下的键，不再用了，清缓存时顺手删掉 */
const LEGACY_KEYS = ["weather.alerts.v1", "weather.alert-source.v1"];

export function readCache(): Cache | null {
  try {
    return parseCache(Storage.get<unknown>(CACHE_KEY));
  } catch {
    return null;
  }
}

export function writeCache(cache: Cache): void {
  Storage.set(CACHE_KEY, cache);
}

export function readLocation(): StoredLocation | null {
  try {
    return parseStoredLocation(Storage.get<unknown>(LOCATION_KEY));
  } catch {
    return null;
  }
}

export function writeLocation(location: StoredLocation): void {
  Storage.set(LOCATION_KEY, location);
}

export function loadSettings(): Settings {
  try {
    return parseSettings(Storage.get<unknown>(SETTINGS_KEY));
  } catch {
    return defaultSettings();
  }
}

export function saveSettings(settings: Settings): void {
  Storage.set(SETTINGS_KEY, settings);
}

/**
 * 天气数据从哪里取（内置 / 自己的 / Open-Meteo），自己的服务地址和 token 也在里面。只存在本机的 Storage 里，不上传；
 * 读出来每一项再验一遍。没存过、读不出来都是默认的「内置」。
 */
export function readDataSource(): DataSource {
  try {
    return parseSource(Storage.get<unknown>(SOURCE_KEY));
  } catch {
    return defaultSource();
  }
}

/** 换了来源：旧的缓存作废，从头来（不然上一个来源留下的数据会当成新来源的显示出来） */
export function writeDataSource(source: DataSource): void {
  Storage.set(SOURCE_KEY, source);
  Storage.remove(CACHE_KEY);
}

/** 「预览预警样式」开到什么时候；没开、读不出来都是 0 */
export function readDemoUntil(): number {
  try {
    const stored = Storage.get<unknown>(DEMO_KEY);
    return typeof stored === "number" && Number.isFinite(stored) ? stored : 0;
  } catch {
    return 0;
  }
}

export function writeDemoUntil(until: number): void {
  Storage.set(DEMO_KEY, until);
}

export function clearDemo(): void {
  Storage.remove(DEMO_KEY);
}

/** 清掉天气缓存与上次的定位（位置设置和数据来源不动），顺手删掉老版本留下的键 */
export function clearData(): void {
  Storage.remove(CACHE_KEY);
  Storage.remove(LOCATION_KEY);
  for (const key of LEGACY_KEYS) Storage.remove(key);
}
