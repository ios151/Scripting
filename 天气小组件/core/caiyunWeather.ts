// 彩云天气的返回 → 这边自己的数据：
//   · `Forecast`：和 Open-Meteo 同一个样子，当前气温、逐小时那一行、背景天空色都靠它（这样两个来源走同一套整理和界面）；
//   · `Extras`：体感、湿度、风、空气质量、紫外线、生活指数、未来几天，以及彩云那两句话；
//   · 预警：同一次请求里带回来的（`alert=true`）。
//
// 纯函数。照 https://colorfulclouds.apifox.cn 上 realtime / minutely / hourly / daily / alert 的数据结构读。
// 拿内置接口实测过一份返回，有几处和文档对不上，这里都兜住了：
//   · 昼夜：晚上九点也会返回「晴（白天）」，所以昼夜按经纬度自己算（core/sun.ts），不看 skycon 里的 DAY / NIGHT；
//   · 日出日落：每天的数据里没有（文档说有 `astro`），同样自己算；
//   · 今天的最高最低：只算「剩下的时间」（晚上九点就是 14° / 13°，而现在就是 14°），所以把这一天里已经取到过的最高最低累计起来，
//     并且至少包含现在的气温；
//   · 逐小时的时间不在整点（21:22、22:22……），按小时归整，和 Open-Meteo 的整点对齐；
//   · 已经过去的时段在白天 / 夜晚那几组数据里写成 0，这里只用全天的那一组，不碰它们。
// 凡是读不出来的单项就当没有（null），不拿默认值冒充；只有「没法定位当前天气」才整份当作读不懂。

import { alertFieldMissing, parseAlertResponse } from "./alerts";
import type { AlertSnapshot } from "./cache";
import { codeForSkycon } from "./condition";
import { aqiName, emptyExtras, type DayForecast, type Extras } from "./extras";
import { failureMessage } from "./failure";
import type { Forecast } from "./forecast";
import type { Coord } from "./geo";
import { roundAway } from "./snapshot";
import { isDaylight, sunTimes } from "./sun";

/** 预警：读懂了（可能是空的）就是 items；根本没有 alert 字段是 `missing`，有字段但读不懂是 `format`，都记在 failure 里 */
export type Adapted = { forecast: Forecast; extras: Extras; alerts: AlertSnapshot };

export type AdaptContext = {
  coord: Coord;
  /** 取数据的时刻（UTC 毫秒），用手机的时钟，不用接口的 */
  now: number;
  /** 上一次缓存里的预报，用来累计今天的最高最低；没有就是 null */
  previous: Forecast | null;
};

/** 下雨 / 下雪的最小降水强度（mm/h）：彩云的降水强度表里小于 0.031 算没有 */
const RAIN_THRESHOLD = 0.031;

/** 最多留几天的预报 */
const MAX_DAYS = 6;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function pad(value: number): string {
  return value < 10 ? "0" + value : String(value);
}

const INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(Z|[+-]\d{2}:?\d{2})?$/;

/** 接口里的时刻（`2026-11-02T21:22+08:00`）→ UTC 毫秒；读不懂或日期不存在返回 null。没带时区的按 `fallbackOffset` 算 */
function parseInstant(text: unknown, fallbackOffset: number): number | null {
  if (typeof text !== "string") return null;
  const match = INSTANT.exec(text);
  if (match === null) return null;
  const [year, month, day, hour, minute] = match.slice(1, 6).map(Number);
  const second = match[6] === undefined ? 0 : Number(match[6]);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return null;
  let offset = fallbackOffset;
  const zone = match[7];
  if (zone === "Z") offset = 0;
  else if (zone !== undefined) {
    const digits = zone.replace(":", "");
    offset = (digits[0] === "-" ? -1 : 1) * (Number(digits.slice(1, 3)) * 3600 + Number(digits.slice(3, 5)) * 60);
  }
  const wall = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (wall.getUTCFullYear() !== year || wall.getUTCMonth() !== month - 1 || wall.getUTCDate() !== day) return null;
  return wall.getTime() - offset * 1000;
}

/** UTC 毫秒 → 当地时间 `yyyy-MM-dd'T'HH:mm`（和 Open-Meteo 的写法一样） */
export function formatLocal(epoch: number, offsetSeconds: number): string {
  const wall = new Date(epoch + offsetSeconds * 1000);
  return (
    wall.getUTCFullYear() + "-" + pad(wall.getUTCMonth() + 1) + "-" + pad(wall.getUTCDate()) +
    "T" + pad(wall.getUTCHours()) + ":" + pad(wall.getUTCMinutes())
  );
}

/** 某个时刻所在的当地整点（UTC 毫秒） */
function floorToHour(epoch: number, offsetSeconds: number): number {
  const wall = epoch + offsetSeconds * 1000;
  return epoch - (((wall % 3_600_000) + 3_600_000) % 3_600_000);
}

/** 逐小时的某一组：每项都有 `datetime`，读不出时间的项丢掉，按时刻建索引 */
function hourlySeries(value: unknown, offset: number): Map<number, Record<string, unknown>> {
  const out = new Map<number, Record<string, unknown>>();
  if (!Array.isArray(value)) return out;
  for (const item of value) {
    if (!isRecord(item)) continue;
    const epoch = parseInstant(item.datetime, offset);
    if (epoch !== null) out.set(epoch, item);
  }
  return out;
}

/** 按天的某一组：每项都有 `date`（`2026-11-02T00:00+08:00`），取前面的日期当键 */
function dailySeries(value: unknown): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  if (!Array.isArray(value)) return out;
  for (const item of value) {
    if (!isRecord(item) || typeof item.date !== "string") continue;
    const date = item.date.slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(date)) out.set(date, item);
  }
  return out;
}

function addDays(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  const moved = new Date(Date.UTC(year, month - 1, day + days));
  return moved.getUTCFullYear() + "-" + pad(moved.getUTCMonth() + 1) + "-" + pad(moved.getUTCDate());
}

function percent(value: unknown): number | null {
  const number = finite(value);
  if (number === null || number < 0) return null;
  return Math.min(100, roundAway(number));
}

/** 全天都是 0 的（max、min、avg 同时为 0）是占位，不是真的 0 度 */
function isPlaceholder(entry: Record<string, unknown>): boolean {
  return entry.max === 0 && entry.min === 0 && (entry.avg === 0 || entry.avg === undefined);
}

function describe(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** 风：`{ speed, direction }`（实况是这个样子，每天的 `avg` 也是）。风速是 km/h，不能是负的；风向是度 */
function windOf(value: unknown): { kmh: number; direction: number } | null {
  if (!isRecord(value)) return null;
  const speed = finite(value.speed);
  const direction = finite(value.direction);
  return speed !== null && speed >= 0 && direction !== null ? { kmh: speed, direction } : null;
}

/** 污染物浓度：不能是负的；取到 `decimals` 位小数 */
function concentration(value: unknown, decimals: number): number | null {
  const number = finite(value);
  if (number === null || number < 0) return null;
  const scale = 10 ** decimals;
  return Math.round(number * scale) / scale;
}

/** 湿度、云量：接口给 0~1 的小数（0.25）；万一给的是百分数（25）也认 */
function fractionPercent(value: unknown): number | null {
  const number = finite(value);
  if (number === null || number < 0 || number > 100) return null;
  return roundAway(number <= 1 ? number * 100 : number);
}

/** 气压：接口给 Pa（100723）；万一给的是 hPa（1007）也认 */
function pressureHpa(value: unknown): number | null {
  const number = finite(value);
  if (number === null) return null;
  if (number >= 20_000) return roundAway(number / 100);
  return number >= 300 && number <= 1_200 ? roundAway(number) : null;
}

/** 某一天的平均国标 AQI：`{ date, max: { chn, usa }, min, avg: { chn, usa } }` 里 `avg.chn` */
function averageAqi(entry: Record<string, unknown> | undefined): number | null {
  const average = entry === undefined ? null : entry.avg;
  const value = isRecord(average) ? finite(average.chn) : null;
  return value !== null && value >= 0 ? roundAway(value) : null;
}

export function adaptCaiyun(raw: unknown, context: AdaptContext): Adapted | null {
  if (!isRecord(raw) || raw.status !== "ok" || !isRecord(raw.result)) return null;
  const offset = raw.tzshift;
  if (typeof offset !== "number" || !Number.isInteger(offset)) return null;
  const result = raw.result;
  const realtime = result.realtime;
  if (!isRecord(realtime)) return null;
  const temperature = finite(realtime.temperature);
  if (temperature === null) return null;

  const { coord, now, previous } = context;
  const today = formatLocal(now, offset).slice(0, 10);
  const nowHour = floorToHour(now, offset);
  const dayAt = (epoch: number): boolean => isDaylight(coord.latitude, coord.longitude, epoch, offset);

  // ---- 逐小时：以 skycon 的时间为准，其余各组按同一时刻对上
  const hourly = isRecord(result.hourly) ? result.hourly : {};
  const skycon = hourlySeries(hourly.skycon, offset);
  const temperatures = hourlySeries(hourly.temperature, offset);
  const precipitation = hourlySeries(hourly.precipitation, offset);

  type Hour = { time: string; temperature: number | null; code: number | null; rain: number | null; isDay: number };
  const hours = new Map<number, Hour>();
  for (const [epoch, entry] of skycon) {
    const hour = floorToHour(epoch, offset);
    if (hour < nowHour || hours.has(hour)) continue;
    hours.set(hour, {
      time: formatLocal(hour, offset),
      temperature: finite(temperatures.get(epoch)?.value),
      code: codeForSkycon(entry.value),
      rain: percent(precipitation.get(epoch)?.probability),
      isDay: dayAt(epoch) ? 1 : 0,
    });
  }
  // 逐小时必须从「现在所在的整点」开始，整理逐小时那一行时要靠它找「现在」。接口从下一个整点才开始给的话，用实况补一格
  const currentCode = codeForSkycon(realtime.skycon);
  if (!hours.has(nowHour)) {
    hours.set(nowHour, { time: formatLocal(nowHour, offset), temperature, code: currentCode, rain: null, isDay: dayAt(now) ? 1 : 0 });
  }
  const ordered = [...hours.entries()].sort((a, b) => a[0] - b[0]).map((pair) => pair[1]);

  // ---- 每天
  const daily = isRecord(result.daily) ? result.daily : {};
  const temperatureByDay = dailySeries(daily.temperature);
  const skyByDay = dailySeries(daily.skycon);
  const rainByDay = dailySeries(daily.precipitation);
  const windByDay = dailySeries(daily.wind);
  const humidityByDay = dailySeries(daily.humidity);
  const aqiByDay = dailySeries(isRecord(daily.air_quality) ? daily.air_quality.aqi : undefined);
  const lifeIndex = isRecord(daily.life_index) ? daily.life_index : null;
  const uvByDay = dailySeries(lifeIndex === null ? undefined : lifeIndex.ultraviolet);

  let todayHigh = temperature;
  let todayLow = temperature;
  const todayEntry = temperatureByDay.get(today);
  if (todayEntry !== undefined && !isPlaceholder(todayEntry)) {
    const max = finite(todayEntry.max);
    const min = finite(todayEntry.min);
    if (max !== null) todayHigh = Math.max(todayHigh, max);
    if (min !== null) todayLow = Math.min(todayLow, min);
  }
  // 今天已经取到过的最高最低一起算上：晚上取的数据只剩后半夜，白天的最高早就过去了
  if (previous !== null && previous.utc_offset_seconds === offset && previous.current.time.slice(0, 10) === today) {
    const earlierHigh = previous.daily.temperature_2m_max[0];
    const earlierLow = previous.daily.temperature_2m_min[0];
    if (typeof earlierHigh === "number") todayHigh = Math.max(todayHigh, earlierHigh);
    if (typeof earlierLow === "number") todayLow = Math.min(todayLow, earlierLow);
  }

  // 今天一定有（上面算出来的），后面几天要接口给了像样的最高最低才要
  const highs: number[] = [];
  const lows: number[] = [];
  const days: DayForecast[] = [];
  for (let step = 0; step < MAX_DAYS; step++) {
    const date = addDays(today, step);
    const entry = temperatureByDay.get(date);
    let high = todayHigh;
    let low = todayLow;
    if (step > 0) {
      const max = entry === undefined || isPlaceholder(entry) ? null : finite(entry.max);
      const min = entry === undefined || isPlaceholder(entry) ? null : finite(entry.min);
      if (max === null || min === null) continue;
      high = max;
      low = min;
    }
    highs.push(high);
    lows.push(low);
    days.push({
      date,
      high: roundAway(high),
      low: roundAway(low),
      code: codeForSkycon(skyByDay.get(date)?.value),
      rainChance: percent(rainByDay.get(date)?.probability),
      wind: windOf(windByDay.get(date)?.avg),
      humidity: fractionPercent(humidityByDay.get(date)?.avg),
      aqi: averageAqi(aqiByDay.get(date)),
      uv: describe(uvByDay.get(date)?.desc),
    });
  }

  // 日出日落：今天和明天
  const sunrise: (string | null)[] = [];
  const sunset: (string | null)[] = [];
  for (const date of [today, addDays(today, 1)]) {
    const [year, month, day] = date.split("-").map(Number);
    const sun = sunTimes(coord.latitude, coord.longitude, year, month, day);
    sunrise.push(sun.sunrise === null ? null : formatLocal(sun.sunrise, offset));
    sunset.push(sun.sunset === null ? null : formatLocal(sun.sunset, offset));
  }

  const forecast: Forecast = {
    utc_offset_seconds: offset,
    current: { time: formatLocal(now, offset), temperature_2m: temperature, weather_code: currentCode ?? -1, is_day: dayAt(now) ? 1 : 0 },
    hourly: {
      time: ordered.map((hour) => hour.time),
      temperature_2m: ordered.map((hour) => hour.temperature),
      weather_code: ordered.map((hour) => hour.code),
      precipitation_probability: ordered.map((hour) => hour.rain),
      is_day: ordered.map((hour) => hour.isDay),
    },
    daily: { temperature_2m_max: highs, temperature_2m_min: lows, sunrise, sunset },
  };

  // ---- 详细数据
  const extras = emptyExtras();
  const apparent = finite(realtime.apparent_temperature);
  extras.apparent = apparent === null ? null : roundAway(apparent);
  extras.humidity = fractionPercent(realtime.humidity);
  extras.wind = windOf(realtime.wind);
  extras.pressure = pressureHpa(realtime.pressure);
  const visibility = finite(realtime.visibility);
  extras.visibility = visibility !== null && visibility >= 0 ? Math.round(visibility * 10) / 10 : null;
  extras.cloud = fractionPercent(realtime.cloudrate);
  const dewpoint = finite(realtime.dewpoint);
  extras.dewpoint = dewpoint === null ? null : roundAway(dewpoint);

  if (isRecord(realtime.air_quality) && isRecord(realtime.air_quality.aqi)) {
    const value = finite(realtime.air_quality.aqi.chn);
    if (value !== null && value >= 0) {
      const text = isRecord(realtime.air_quality.description) ? describe(realtime.air_quality.description.chn) : null;
      extras.aqi = { value: roundAway(value), text: text ?? aqiName(value) };
    }
  }
  if (isRecord(realtime.air_quality)) {
    const air = realtime.air_quality;
    const pollutants = {
      pm25: concentration(air.pm25, 0),
      pm10: concentration(air.pm10, 0),
      o3: concentration(air.o3, 0),
      no2: concentration(air.no2, 0),
      so2: concentration(air.so2, 0),
      co: concentration(air.co, 1),
    };
    if (Object.values(pollutants).some((value) => value !== null)) extras.pollutants = pollutants;
  }
  if (isRecord(realtime.life_index) && isRecord(realtime.life_index.ultraviolet)) {
    const text = describe(realtime.life_index.ultraviolet.desc);
    if (text !== null) {
      const index = Number(realtime.life_index.ultraviolet.index);
      extras.uv = { index: Number.isFinite(index) ? index : null, text };
    }
  }

  extras.keypoint = describe(result.forecast_keypoint);
  extras.dayOutlook = describe(hourly.description);
  if (isRecord(result.minutely)) {
    extras.rainOutlook = describe(result.minutely.description);
    // 卡片底部只在真的会下雨 / 下雪时才写（没有降水不写「无降水」）
    if (Array.isArray(result.minutely.precipitation_2h)) {
      const raining = result.minutely.precipitation_2h.some((value) => typeof value === "number" && value >= RAIN_THRESHOLD);
      if (raining) extras.rainNote = extras.rainOutlook;
    }
  }

  if (lifeIndex !== null) {
    const pick = (name: string): string | null => describe(dailySeries(lifeIndex[name]).get(today)?.desc);
    extras.life = { dressing: pick("dressing"), carWashing: pick("carWashing"), comfort: pick("comfort"), coldRisk: pick("coldRisk") };
  }
  extras.days = days;

  // ---- 预警：同一次请求里带回来的
  const items = parseAlertResponse(raw);
  let alerts: AlertSnapshot;
  if (items !== null) {
    alerts = { items, failure: null };
  } else {
    const reason = alertFieldMissing(raw) ? "missing" : "format";
    alerts = { items: null, failure: { at: now, reason, message: failureMessage(reason) } };
  }

  return { forecast, extras, alerts };
}
