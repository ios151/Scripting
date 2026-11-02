// 天气现象：Open-Meteo 给的 WMO 天气代码 → 中文描述 + SF Symbols 图标（界面里多色渲染）。
//
// 逐项照 RoamControl 的 WeatherCondition.swift 移植，自测里拿它和 Swift 源码里读出来的表对过（28 个代码）。
// 昼夜只影响晴 / 晴间多云 / 多云 / 小阵雨 / 阵雨这几种：白天用太阳，夜里用月亮。
// `sky` 是这边多加的，只管背景用哪一套天空色，Swift 那边没有。

export type Sky = "clear" | "partly" | "overcast" | "fog" | "rain" | "snow" | "storm" | "unknown";

export type Condition = {
  readonly text: string;
  readonly symbol: string;
  readonly sky: Sky;
};

type Row = readonly [text: string, day: string, night: string, sky: Sky];

const TABLE: Readonly<Record<number, Row>> = {
  0: ["晴", "sun.max.fill", "moon.stars.fill", "clear"],
  1: ["晴间多云", "cloud.sun.fill", "cloud.moon.fill", "partly"],
  2: ["多云", "cloud.sun.fill", "cloud.moon.fill", "partly"],
  3: ["阴", "cloud.fill", "cloud.fill", "overcast"],
  45: ["雾", "cloud.fog.fill", "cloud.fog.fill", "fog"],
  48: ["冻雾", "cloud.fog.fill", "cloud.fog.fill", "fog"],
  51: ["小毛毛雨", "cloud.drizzle.fill", "cloud.drizzle.fill", "rain"],
  53: ["毛毛雨", "cloud.drizzle.fill", "cloud.drizzle.fill", "rain"],
  55: ["大毛毛雨", "cloud.drizzle.fill", "cloud.drizzle.fill", "rain"],
  56: ["冻毛毛雨", "cloud.sleet.fill", "cloud.sleet.fill", "rain"],
  57: ["强冻毛毛雨", "cloud.sleet.fill", "cloud.sleet.fill", "rain"],
  61: ["小雨", "cloud.drizzle.fill", "cloud.drizzle.fill", "rain"],
  63: ["中雨", "cloud.rain.fill", "cloud.rain.fill", "rain"],
  65: ["大雨", "cloud.heavyrain.fill", "cloud.heavyrain.fill", "rain"],
  66: ["冻雨", "cloud.sleet.fill", "cloud.sleet.fill", "rain"],
  67: ["强冻雨", "cloud.sleet.fill", "cloud.sleet.fill", "rain"],
  71: ["小雪", "cloud.snow.fill", "cloud.snow.fill", "snow"],
  73: ["中雪", "cloud.snow.fill", "cloud.snow.fill", "snow"],
  75: ["大雪", "cloud.snow.fill", "cloud.snow.fill", "snow"],
  77: ["米雪", "cloud.snow.fill", "cloud.snow.fill", "snow"],
  80: ["小阵雨", "cloud.sun.rain.fill", "cloud.moon.rain.fill", "rain"],
  81: ["阵雨", "cloud.sun.rain.fill", "cloud.moon.rain.fill", "rain"],
  82: ["强阵雨", "cloud.heavyrain.fill", "cloud.heavyrain.fill", "rain"],
  85: ["小阵雪", "cloud.snow.fill", "cloud.snow.fill", "snow"],
  86: ["大阵雪", "cloud.snow.fill", "cloud.snow.fill", "snow"],
  95: ["雷暴", "cloud.bolt.rain.fill", "cloud.bolt.rain.fill", "storm"],
  96: ["雷暴伴小冰雹", "cloud.bolt.rain.fill", "cloud.bolt.rain.fill", "storm"],
  99: ["雷暴伴大冰雹", "cloud.bolt.rain.fill", "cloud.bolt.rain.fill", "storm"],
};

/**
 * 彩云的天气现象（skycon）里 WMO 没有的几种（霾、暴雨、暴雪、浮尘、沙尘、大风……），用 1000 以上的代码接在后面。
 * 其余的借 WMO 里意思一样的代码（见 SKYCON）。这些行不在 RoamControl 的 Swift 表里，所以和 Swift 对拍时不算（见 knownCodes）。
 */
const EXTENSION: Readonly<Record<number, Row>> = {
  1001: ["轻度霾", "sun.haze.fill", "moon.haze.fill", "fog"],
  1002: ["中度霾", "sun.haze.fill", "moon.haze.fill", "fog"],
  1003: ["重度霾", "smoke.fill", "smoke.fill", "fog"],
  1004: ["暴雨", "cloud.heavyrain.fill", "cloud.heavyrain.fill", "rain"],
  1005: ["暴雪", "wind.snow", "wind.snow", "snow"],
  1006: ["浮尘", "sun.dust.fill", "smoke.fill", "fog"],
  1007: ["沙尘", "sun.dust.fill", "smoke.fill", "fog"],
  1008: ["大风", "wind", "wind", "partly"],
  1009: ["雷阵雨", "cloud.bolt.rain.fill", "cloud.bolt.rain.fill", "storm"],
  1010: ["冰雹", "cloud.hail.fill", "cloud.hail.fill", "storm"],
  1011: ["雨夹雪", "cloud.sleet.fill", "cloud.sleet.fill", "rain"],
};

/** 彩云 skycon → 这里的天气代码。晴和多云的白天 / 夜间两个写法是同一个代码，昼夜由调用方另外算（见 core/sun.ts） */
const SKYCON: Readonly<Record<string, number>> = {
  CLEAR_DAY: 0,
  CLEAR_NIGHT: 0,
  PARTLY_CLOUDY_DAY: 2,
  PARTLY_CLOUDY_NIGHT: 2,
  CLOUDY: 3,
  LIGHT_HAZE: 1001,
  MODERATE_HAZE: 1002,
  HEAVY_HAZE: 1003,
  LIGHT_RAIN: 61,
  MODERATE_RAIN: 63,
  HEAVY_RAIN: 65,
  STORM_RAIN: 1004,
  FOG: 45,
  LIGHT_SNOW: 71,
  MODERATE_SNOW: 73,
  HEAVY_SNOW: 75,
  STORM_SNOW: 1005,
  DUST: 1006,
  SAND: 1007,
  WIND: 1008,
  // 文档里没有、老版本接口里有的几种
  THUNDER_SHOWER: 1009,
  HAIL: 1010,
  SLEET: 1011,
};

/** 不认识的 skycon（或不是字符串）返回 null：调用方当「天气现象缺失」处理，别默认成晴 */
export function codeForSkycon(skycon: unknown): number | null {
  return typeof skycon === "string" && Object.prototype.hasOwnProperty.call(SKYCON, skycon) ? SKYCON[skycon] : null;
}

/** 代码不认识（或缺失）时的样子，别默认成晴冒充 */
export const UNKNOWN: Condition = { text: "未知", symbol: "cloud.fill", sky: "unknown" };

/** 日出 / 日落那一格用的「天气」，只有名字和图标 */
export const SUNRISE: Condition = { text: "日出", symbol: "sunrise.fill", sky: "clear" };
export const SUNSET: Condition = { text: "日落", symbol: "sunset.fill", sky: "clear" };

/** `code` 要先取整（Swift 那边是 `Int(Double)`，向零截断），这里不替调用方做。 */
export function conditionFor(code: number, isDay: boolean): Condition {
  const row = TABLE[code] ?? EXTENSION[code];
  if (row === undefined) return UNKNOWN;
  return { text: row[0], symbol: isDay ? row[1] : row[2], sky: row[3] };
}

/** 自测用：WMO 的全部已知代码（和 Swift 表对拍的就是这 28 个） */
export function knownCodes(): number[] {
  return Object.keys(TABLE).map(Number);
}

/** 自测用：彩云才有的那几个扩展代码 */
export function extensionCodes(): number[] {
  return Object.keys(EXTENSION).map(Number);
}

/** 自测用：skycon 对照表里的全部 skycon */
export function knownSkycons(): string[] {
  return Object.keys(SKYCON);
}
