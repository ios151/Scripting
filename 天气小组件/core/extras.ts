// 天气之外的详细数据：体感、湿度、风、气压、能见度、空气质量、紫外线、生活指数、未来几天，以及彩云那两句话
// （「今日多云，气温适宜」「未来2小时无降水」）。只有彩云来源才有；备用的 Open-Meteo 没有这些，界面上就不画。
//
// 这里放数据的样子、读存下来的缓存时的校验，以及几个纯粹的换算（风速 → 风力等级、风向 → 文字、空气质量分级）。
// 要说的话（「东南风 3 级」「空气 优 50」）在 present.ts 里拼，界面不碰原始数字。

export type DayForecast = {
  /** 当地日期 `yyyy-MM-dd` */
  date: string;
  high: number;
  low: number;
  /** 天气代码（见 condition.ts）；接口没给或不认识是 null */
  code: number | null;
  /** 全天降水概率（%）；接口没给是 null */
  rainChance: number | null;
  /** 全天的平均风：风速（km/h）和风向（度）；接口没给是 null */
  wind: { kmh: number; direction: number } | null;
  /** 全天的平均相对湿度（%，整数） */
  humidity: number | null;
  /** 全天的平均国标空气质量指数 */
  aqi: number | null;
  /** 紫外线的文字（「强」）；接口没给是 null */
  uv: string | null;
};

/** 污染物浓度：PM2.5、PM10、臭氧、二氧化氮、二氧化硫（μg/m³），一氧化碳（mg/m³）。读不出来的那项是 null */
export type Pollutants = {
  pm25: number | null;
  pm10: number | null;
  o3: number | null;
  no2: number | null;
  so2: number | null;
  co: number | null;
};

export type Life = {
  dressing: string | null;
  carWashing: string | null;
  comfort: string | null;
  coldRisk: string | null;
};

export type Extras = {
  /** 体感温度（整数） */
  apparent: number | null;
  /** 相对湿度（%，整数） */
  humidity: number | null;
  /** 风速（km/h）和风向（度，风从哪边来，北为 0 顺时针） */
  wind: { kmh: number; direction: number } | null;
  /** 气压（hPa，整数） */
  pressure: number | null;
  /** 能见度（km） */
  visibility: number | null;
  /** 总云量（%，整数） */
  cloud: number | null;
  /** 露点（℃，整数） */
  dewpoint: number | null;
  /** 国标空气质量指数和文字（「优」「良」……） */
  aqi: { value: number; text: string } | null;
  /** 各项污染物浓度；一项都读不出来就是 null */
  pollutants: Pollutants | null;
  /** 紫外线：强度指数（可能读不出）和文字 */
  uv: { index: number | null; text: string } | null;
  /** 一句话概括：「今日多云，气温适宜」 */
  keypoint: string | null;
  /** 未来 24 小时的概括：「未来24小时多云，气温适中」 */
  dayOutlook: string | null;
  /** 未来两小时的降水说明，有没有降水都有：「未来2小时无降水」（App 页「概况」里写） */
  rainOutlook: string | null;
  /** 同一句话，但只有真的会下雨 / 下雪的时候才有（没有降水就是 null，不写「无降水」）：卡片底部用 */
  rainNote: string | null;
  life: Life | null;
  /** 今天起的几天预报，第一项是今天 */
  days: DayForecast[];
};

export function emptyExtras(): Extras {
  return {
    apparent: null,
    humidity: null,
    wind: null,
    pressure: null,
    visibility: null,
    cloud: null,
    dewpoint: null,
    aqi: null,
    pollutants: null,
    uv: null,
    keypoint: null,
    dayOutlook: null,
    rainOutlook: null,
    rainNote: null,
    life: null,
    days: [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function textOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** 风速和风向都是有限的数才算一阵风 */
function parseWind(raw: unknown): { kmh: number; direction: number } | null {
  if (!isRecord(raw)) return null;
  const kmh = numberOrNull(raw.kmh);
  const direction = numberOrNull(raw.direction);
  return kmh === null || direction === null ? null : { kmh, direction };
}

/** 污染物：每一项单独验；六项都读不出来就当没有这一块 */
function parsePollutants(raw: unknown): Pollutants | null {
  if (!isRecord(raw)) return null;
  const got: Pollutants = {
    pm25: numberOrNull(raw.pm25),
    pm10: numberOrNull(raw.pm10),
    o3: numberOrNull(raw.o3),
    no2: numberOrNull(raw.no2),
    so2: numberOrNull(raw.so2),
    co: numberOrNull(raw.co),
  };
  return Object.values(got).every((value) => value === null) ? null : got;
}

/** 缓存里存的 extras 读回来：每一项都重新验一遍，坏的那项当没有，不让脚本崩 */
export function parseExtras(raw: unknown): Extras | null {
  if (!isRecord(raw)) return null;
  const wind = parseWind(raw.wind);
  const aqi = isRecord(raw.aqi) && numberOrNull(raw.aqi.value) !== null && typeof raw.aqi.text === "string"
    ? { value: raw.aqi.value as number, text: raw.aqi.text }
    : null;
  const uv = isRecord(raw.uv) && typeof raw.uv.text === "string" ? { index: numberOrNull(raw.uv.index), text: raw.uv.text } : null;
  const pollutants = parsePollutants(raw.pollutants);
  const life = isRecord(raw.life)
    ? {
        dressing: textOrNull(raw.life.dressing),
        carWashing: textOrNull(raw.life.carWashing),
        comfort: textOrNull(raw.life.comfort),
        coldRisk: textOrNull(raw.life.coldRisk),
      }
    : null;

  const days: DayForecast[] = [];
  if (Array.isArray(raw.days)) {
    for (const entry of raw.days) {
      if (!isRecord(entry) || typeof entry.date !== "string" || !DATE.test(entry.date)) continue;
      const high = numberOrNull(entry.high);
      const low = numberOrNull(entry.low);
      if (high === null || low === null) continue;
      days.push({
        date: entry.date,
        high,
        low,
        code: numberOrNull(entry.code),
        rainChance: numberOrNull(entry.rainChance),
        wind: parseWind(entry.wind),
        humidity: numberOrNull(entry.humidity),
        aqi: numberOrNull(entry.aqi),
        uv: textOrNull(entry.uv),
      });
    }
  }

  return {
    apparent: numberOrNull(raw.apparent),
    humidity: numberOrNull(raw.humidity),
    wind,
    pressure: numberOrNull(raw.pressure),
    visibility: numberOrNull(raw.visibility),
    cloud: numberOrNull(raw.cloud),
    dewpoint: numberOrNull(raw.dewpoint),
    aqi,
    pollutants,
    uv,
    keypoint: textOrNull(raw.keypoint),
    dayOutlook: textOrNull(raw.dayOutlook),
    rainOutlook: textOrNull(raw.rainOutlook),
    rainNote: textOrNull(raw.rainNote),
    life,
    days,
  };
}

// ---------------------------------------------------------------- 换算

/** 「2026-11-04」距「2026-11-02」几天：后一个日期晚就是正数。按日历算，跨月、跨年都对 */
export function daysApart(from: string, to: string): number {
  const [fromYear, fromMonth, fromDay] = from.split("-").map(Number);
  const [toYear, toMonth, toDay] = to.split("-").map(Number);
  return Math.round((Date.UTC(toYear, toMonth - 1, toDay) - Date.UTC(fromYear, fromMonth - 1, fromDay)) / 86_400_000);
}

/** 风力等级各级的下限（m/s），第 i 项是 i+1 级的下限：国内天气预报说的「几级风」 */
const WIND_LEVEL_FLOORS = [0.3, 1.6, 3.4, 5.5, 8.0, 10.8, 13.9, 17.2, 20.8, 24.5, 28.5, 32.7];

/** 风速（km/h）→ 风力等级（0 ~ 12） */
export function windLevel(kmh: number): number {
  const metersPerSecond = kmh / 3.6;
  let level = 0;
  for (let index = 0; index < WIND_LEVEL_FLOORS.length; index++) {
    if (metersPerSecond >= WIND_LEVEL_FLOORS[index]) level = index + 1;
  }
  return level;
}

const DIRECTIONS = ["北", "东北", "东", "东南", "南", "西南", "西", "西北"];

/** 风向（度）→ 「东南」。风从哪边来就叫哪风（东南风 = 从东南吹来） */
export function windDirectionName(degrees: number): string {
  const normalized = ((degrees % 360) + 360) % 360;
  return DIRECTIONS[Math.round(normalized / 45) % 8];
}

/** 国标空气质量分级：0 优、1 良、2 轻度污染、3 中度污染、4 重度污染、5 严重污染 */
export function aqiBand(value: number): 0 | 1 | 2 | 3 | 4 | 5 {
  if (value <= 50) return 0;
  if (value <= 100) return 1;
  if (value <= 150) return 2;
  if (value <= 200) return 3;
  if (value <= 300) return 4;
  return 5;
}

const AQI_NAMES = ["优", "良", "轻度污染", "中度污染", "重度污染", "严重污染"];
const AQI_SHORT_NAMES = ["优", "良", "轻度", "中度", "重度", "严重"];

/** 接口没给文字时，按国标分级补一个 */
export function aqiName(value: number): string {
  return AQI_NAMES[aqiBand(value)];
}

/** 卡片底部那一行地方窄（四项平分一行），用两个字的短名：「轻度 120」，不用「轻度污染 120」 */
export function aqiShortName(value: number): string {
  return AQI_SHORT_NAMES[aqiBand(value)];
}
