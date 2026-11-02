// 把接口的数据整理成界面要的样子：当前气温与天气、今日最高最低、降水概率，
// 以及逐小时那一行（现在在最前，后面按时间排，日出日落夹在整点之间）。
//
// 逐段照 RoamControl 的 `OpenMeteoClient.snapshot(from:fetchedAt:)` 移植，是纯函数：给定响应与时间，结果是确定的。
// 自测里拿 weather_fixture.json 和它的 Python 移植（weather_port.py）对拍过，见 _selftest/weather-widget.test.ts。
//
// 和 Swift 版唯一的区别是格数可选：中号和小号取 5 格（和 Swift 一样），大号取 10 格（两排）。
// 5 格时行为与 Swift 完全一致（往后看 8 个整点）；格数更多时往后看的整点也跟着多，不然日落会被夹在缺了整点的位置。

import { SUNRISE, SUNSET, conditionFor, type Condition } from "./condition";
import type { Forecast } from "./forecast";

/** 逐小时那一行最多几格（现在 + 后面几格）。和 RoamControl 的 slotCount 一致 */
export const SLOT_COUNT = 5;

export type SlotKind = "now" | "hour" | "sunrise" | "sunset";

export type Slot = {
  readonly kind: SlotKind;
  /** 这一格对应的时刻（UTC 毫秒） */
  readonly date: number;
  /** 气温（整数）。日出日落那一格没有 */
  readonly temperature: number | null;
  readonly condition: Condition;
  /** 这一格上面的时间文字：「现在」「15时」「17:55」 */
  readonly label: string;
  /** 下面那行字（「日落」）。整点的格子下面显示气温，没有这一项 */
  readonly caption: string | null;
};

export type Snapshot = {
  /** 取到这份数据的时刻（UTC 毫秒） */
  readonly fetchedAt: number;
  readonly temperature: number;
  readonly condition: Condition;
  /** 现在是白天吗（给背景选天空色用） */
  readonly isDay: boolean;
  readonly high: number;
  readonly low: number;
  /** 当前所在小时的降水概率（%）；接口没给就是 null */
  readonly rainChance: number | null;
  /** 逐小时那一行：现在在最前，后面按时间排，日出日落夹在整点之间 */
  readonly slots: readonly Slot[];
};

/**
 * 四舍五入，平局远离零（Swift `Double.rounded()` 的默认规则）：18.5 → 19，-0.5 → -1，-3.5 → -4。
 * JS 的 `Math.round` 平局往正无穷走（-3.5 → -3），不能直接用。末尾 `+ 0` 把 -0 抹成 0。
 */
export function roundAway(value: number): number {
  const rounded = value >= 0 ? Math.floor(value + 0.5) : -Math.floor(-value + 0.5);
  return rounded + 0;
}

const LOCAL_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

/**
 * 解接口给的当地时间 `yyyy-MM-dd'T'HH:mm`（不带时区），用查询地点的偏移还原成 UTC 毫秒。
 * 格式不对、日期不存在（2 月 30 日）、钟点越界都返回 null。
 */
export function parseLocalTime(text: string | null | undefined, utcOffsetSeconds: number): number | null {
  if (typeof text !== "string") return null;
  const match = LOCAL_TIME.exec(text);
  if (match === null) return null;
  const [year, month, day, hour, minute] = match.slice(1).map(Number);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null;
  const wall = new Date(Date.UTC(year, month - 1, day, hour, minute));
  // Date.UTC 会把 2 月 30 日滚成 3 月 2 日；滚了就说明日期不存在
  if (wall.getUTCFullYear() !== year || wall.getUTCMonth() !== month - 1 || wall.getUTCDate() !== day) return null;
  return wall.getTime() - utcOffsetSeconds * 1000;
}

/** 某个时刻在查询地点的「当地钟点」 */
export function localParts(epoch: number, utcOffsetSeconds: number): { hour: number; minute: number } {
  const wall = new Date(epoch + utcOffsetSeconds * 1000);
  return { hour: wall.getUTCHours(), minute: wall.getUTCMinutes() };
}

/** 取数组里第 `index` 个；越界或是 null 都当没有 */
function element<T>(array: readonly (T | null)[], index: number): T | null {
  return index >= 0 && index < array.length ? array[index] : null;
}

function twoDigits(value: number): string {
  return value < 10 ? "0" + value : String(value);
}

export function buildSnapshot(forecast: Forecast, fetchedAt: number, slotCount: number = SLOT_COUNT): Snapshot | null {
  const offset = forecast.utc_offset_seconds;
  const now = parseLocalTime(forecast.current.time, offset);
  const high = element(forecast.daily.temperature_2m_max, 0);
  const low = element(forecast.daily.temperature_2m_min, 0);
  if (now === null || high === null || low === null) return null;

  const isDay = forecast.current.is_day !== 0;
  const current = conditionFor(Math.trunc(forecast.current.weather_code), isDay);
  const temperature = roundAway(forecast.current.temperature_2m);
  const nowSlot: Slot = { kind: "now", date: now, temperature, condition: current, label: "现在", caption: null };

  // 当前所在的整点：最后一个不晚于「现在」的整点。降水概率按它取，和系统天气的「降雨概率」同一个口径
  const hourDates = forecast.hourly.time.map((text) => parseLocalTime(text, offset));
  let currentHour = -1;
  for (let index = hourDates.length - 1; index >= 0; index--) {
    const date = hourDates[index];
    if (date !== null && date <= now) {
      currentHour = index;
      break;
    }
  }
  const rain = currentHour >= 0 ? element(forecast.hourly.precipitation_probability, currentHour) : null;
  const rainChance = rain === null ? null : roundAway(rain);

  const later: Slot[] = [];

  // 之后的整点：够挑出前几格，也够把日落夹进去（5 格时是 8 个，和 Swift 一样）
  if (currentHour >= 0) {
    const lookahead = Math.max(slotCount + 3, 8);
    const end = Math.min(hourDates.length, currentHour + 1 + lookahead);
    for (let index = currentHour + 1; index < end; index++) {
      const date = hourDates[index];
      const hourTemperature = element(forecast.hourly.temperature_2m, index);
      if (date === null || hourTemperature === null) continue;
      // 缺天气代码时用 -1 落到「未知」，别默认成 0（晴）冒充；缺昼夜标记按白天算
      const code = element(forecast.hourly.weather_code, index);
      const hourIsDay = element(forecast.hourly.is_day, index);
      later.push({
        kind: "hour",
        date,
        temperature: roundAway(hourTemperature),
        condition: conditionFor(Math.trunc(code === null ? -1 : code), (hourIsDay === null ? 1 : hourIsDay) !== 0),
        label: localParts(date, offset).hour + "时",
        caption: null,
      });
    }
  }

  // 日出日落：今天、明天里还没到的，按时间夹在整点之间
  const appendSunEvents = (texts: readonly (string | null)[], kind: "sunrise" | "sunset"): void => {
    for (const text of texts) {
      const date = parseLocalTime(text, offset);
      if (date === null || !(date > now)) continue;
      const { hour, minute } = localParts(date, offset);
      later.push({
        kind,
        date,
        temperature: null,
        condition: kind === "sunset" ? SUNSET : SUNRISE,
        label: twoDigits(hour) + ":" + twoDigits(minute),
        caption: kind === "sunset" ? "日落" : "日出",
      });
    }
  };
  appendSunEvents(forecast.daily.sunrise, "sunrise");
  appendSunEvents(forecast.daily.sunset, "sunset");

  // 稳定排序：同一时刻整点在前、日出在日落前（和 Swift / Python 的 sorted 一致）
  const ordered = later.slice().sort((a, b) => a.date - b.date);
  return {
    fetchedAt,
    temperature,
    condition: current,
    isDay,
    high: roundAway(high),
    low: roundAway(low),
    rainChance,
    slots: [nowSlot, ...ordered.slice(0, Math.max(slotCount - 1, 0))],
  };
}
