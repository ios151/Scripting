// 底部「一句话 + 日落 + 空气」那一行用到的两样东西：下一次日出 / 日落，和那句话。纯函数。
//
// 那句话有三种写法（脚本页「显示样式」里选）：
//   · 彩云的一句话：「今日多云，气温适宜」（接口的 forecast_keypoint）；
//   · 明天比今天冷了还是暖了：「明日平均降温 9°C」，用每天最高最低的中间值算（今天的最高最低是取到过的累计，见 caiyunWeather.ts）；
//   · 自动：未来两小时有雨 / 雪就先说雨，否则明天气温变化够大（≥ 3°）就说变化，再不然用彩云的一句话。

import type { HeadlineMode } from "./display";
import { daysApart, type DayForecast } from "./extras";
import type { Forecast } from "./forecast";
import { localParts, parseLocalTime, roundAway } from "./snapshot";

/** 底部那一项：「日落 17:02」。label 是日出还是日落，time 是当地钟点 */
export type SunView = { label: "日出" | "日落"; time: string };

/** 自动挑一句话时，明天比今天的平均气温差多少度才算「变化够大」，值得说 */
export const NOTABLE_CHANGE = 3;

function twoDigits(value: number): string {
  return value < 10 ? "0" + value : String(value);
}

/**
 * 接下来最近的一次日出或日落（以取数那一刻的当地时间为准）：白天写日落，晚上写明早的日出。
 * 一个都没有（极昼、极夜、数据缺）返回 null。
 */
export function nextSunEvent(forecast: Forecast): SunView | null {
  const offset = forecast.utc_offset_seconds;
  const now = parseLocalTime(forecast.current.time, offset);
  if (now === null) return null;
  const upcoming: Array<{ date: number; label: SunView["label"] }> = [];
  const collect = (texts: readonly (string | null)[], label: SunView["label"]): void => {
    for (const text of texts) {
      const date = parseLocalTime(text, offset);
      if (date !== null && date > now) upcoming.push({ date, label });
    }
  };
  collect(forecast.daily.sunrise, "日出");
  collect(forecast.daily.sunset, "日落");
  if (upcoming.length === 0) return null;
  const first = upcoming.reduce((best, event) => (event.date < best.date ? event : best));
  const { hour, minute } = localParts(first.date, offset);
  return { label: first.label, time: twoDigits(hour) + ":" + twoDigits(minute) };
}

/**
 * 明天比今天的平均气温高多少度（负数是冷了）。每天的平均气温取最高最低的中间值。
 * 第一项是今天、第二项不是明天（中间缺了一天）、或者缺数据，返回 null。
 */
export function temperatureChange(days: readonly DayForecast[]): number | null {
  if (days.length < 2) return null;
  const [today, tomorrow] = days;
  if (daysApart(today.date, tomorrow.date) !== 1) return null;
  return (tomorrow.high + tomorrow.low) / 2 - (today.high + today.low) / 2;
}

/**
 * 「明日平均降温 9°C」。变化不到 1° 时：`always` 为真写「明日气温和今天差不多」，否则不写（返回 null）。
 * 气温差为 null（没有明天的数据）返回 null。
 */
export function changeText(delta: number | null, always: boolean): string | null {
  if (delta === null) return null;
  const degrees = roundAway(Math.abs(delta));
  if (degrees < 1) return always ? "明日气温和今天差不多" : null;
  return "明日平均" + (delta < 0 ? "降温" : "升温") + " " + degrees + "°C";
}

/** 这句话写什么。读不到的就是 null（那一行里这部分留空，日落和空气照常画） */
export function headlineText(
  mode: HeadlineMode,
  parts: { rainNote: string | null; keypoint: string | null; delta: number | null },
): string | null {
  if (mode === "keypoint") return parts.keypoint;
  if (mode === "change") return changeText(parts.delta, true);
  // 自动：有雨先说雨；明天气温变化够大就说变化；再不然彩云的一句话
  if (parts.rainNote !== null) return parts.rainNote;
  const notable = parts.delta !== null && roundAway(Math.abs(parts.delta)) >= NOTABLE_CHANGE ? changeText(parts.delta, false) : null;
  return notable ?? parts.keypoint;
}
