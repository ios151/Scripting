// Open-Meteo 预报接口的返回，只取天气卡用得到的字段，字段名照接口原样（snake_case）。
//
// 照 RoamControl 的 OpenMeteoResponse（Swift Decodable）的严格程度来：
//   · 必需的键缺了、类型对不上，整份当作解不开（返回 null）；
//   · 数组里的值可以是 null（预报尽头常有），所以逐项按「数字或 null」收；
//   · 数字一律按 Double 收，接口把 `3` 写成 `3.0` 不碍事（JS 里本来就是同一个数）。
// 解完会另造一份只含这些字段的对象，缓存存的就是这份，读缓存时走同一个函数再验一遍。

export type Forecast = {
  /** 查询地点相对 UTC 的偏移（秒）。接口返回的时间都是当地时间、不带时区，要靠它还原 */
  utc_offset_seconds: number;
  current: { time: string; temperature_2m: number; weather_code: number; is_day: number };
  hourly: {
    time: string[];
    temperature_2m: (number | null)[];
    weather_code: (number | null)[];
    precipitation_probability: (number | null)[];
    is_day: (number | null)[];
  };
  daily: {
    temperature_2m_max: (number | null)[];
    temperature_2m_min: (number | null)[];
    sunrise: (string | null)[];
    sunset: (string | null)[];
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function numberOrNull(value: unknown): number | null | undefined {
  if (value === null) return null;
  return isNumber(value) ? value : undefined;
}

function stringOrNull(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === "string" ? value : undefined;
}

/** 整个数组每一项都过得了 `pick` 才算数，否则返回 null */
function collect<T>(value: unknown, pick: (item: unknown) => T | undefined): T[] | null {
  if (!Array.isArray(value)) return null;
  const out: T[] = [];
  for (const item of value) {
    const picked = pick(item);
    if (picked === undefined) return null;
    out.push(picked);
  }
  return out;
}

export function parseForecast(raw: unknown): Forecast | null {
  if (!isRecord(raw)) return null;
  const { utc_offset_seconds: offset, current, hourly, daily } = raw;
  if (typeof offset !== "number" || !Number.isInteger(offset)) return null;
  if (!isRecord(current) || !isRecord(hourly) || !isRecord(daily)) return null;

  const { time, temperature_2m, weather_code, is_day } = current;
  if (typeof time !== "string" || !isNumber(temperature_2m) || !isNumber(weather_code) || !isNumber(is_day)) return null;

  const hourlyTime = collect(hourly.time, (item) => (typeof item === "string" ? item : undefined));
  const hourlyTemperature = collect(hourly.temperature_2m, numberOrNull);
  const hourlyCode = collect(hourly.weather_code, numberOrNull);
  const hourlyRain = collect(hourly.precipitation_probability, numberOrNull);
  const hourlyIsDay = collect(hourly.is_day, numberOrNull);
  if (hourlyTime === null || hourlyTemperature === null || hourlyCode === null || hourlyRain === null || hourlyIsDay === null) {
    return null;
  }

  const dailyMax = collect(daily.temperature_2m_max, numberOrNull);
  const dailyMin = collect(daily.temperature_2m_min, numberOrNull);
  const sunrise = collect(daily.sunrise, stringOrNull);
  const sunset = collect(daily.sunset, stringOrNull);
  if (dailyMax === null || dailyMin === null || sunrise === null || sunset === null) return null;

  return {
    utc_offset_seconds: offset,
    current: { time, temperature_2m, weather_code, is_day },
    hourly: {
      time: hourlyTime,
      temperature_2m: hourlyTemperature,
      weather_code: hourlyCode,
      precipitation_probability: hourlyRain,
      is_day: hourlyIsDay,
    },
    daily: { temperature_2m_max: dailyMax, temperature_2m_min: dailyMin, sunrise, sunset },
  };
}
