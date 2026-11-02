// 天气查询：Open-Meteo（https://open-meteo.com）的公开预报接口。
//
// 不要密钥；免费版只限非商用（个人、开源、没有广告和订阅都算），数据按 CC BY 4.0 提供，
// 所以中号、大号小组件的底部和 App 页里都有署名。不走中转：每台手机各用各的 IP，不会撞到限额。
// 查询参数与 RoamControl 的 OpenMeteoClient.url 完全一致（自测里和 Swift 源码里读出来的对过）。

import { parseForecast, type Forecast } from "./forecast";
import { roundAway } from "./snapshot";

export const ENDPOINT = "https://api.open-meteo.com/v1/forecast";

/** 请求超时（秒）。和 RoamControl 一致 */
export const TIMEOUT_SECONDS = 12;

/** 查询参数，顺序也和 Swift 那边一样 */
const QUERY: readonly (readonly [string, string])[] = [
  ["current", "temperature_2m,weather_code,is_day"],
  ["hourly", "temperature_2m,weather_code,precipitation_probability,is_day"],
  ["daily", "temperature_2m_max,temperature_2m_min,sunrise,sunset"],
  // auto：按查询地点所在的时区给时间，「现在」「15时」才是当地的钟点
  ["timezone", "auto"],
  ["forecast_days", "2"],
];

/** 坐标取整到小数点后两位（约 1 公里）再发出去：天气用不着更精确，也少漏一点真实位置 */
export function roundedForRequest(value: number): number {
  return roundAway(value * 100) / 100;
}

export function buildURL(latitude: number, longitude: number): string {
  const parts = [
    "latitude=" + roundedForRequest(latitude).toFixed(2),
    "longitude=" + roundedForRequest(longitude).toFixed(2),
    ...QUERY.map(([name, value]) => name + "=" + value),
  ];
  return ENDPOINT + "?" + parts.join("&");
}

export class ForecastError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ForecastError";
  }
}

/** 取预报。非 200、解不开都当失败（抛错），由调用方决定退回缓存 */
export async function fetchForecast(
  latitude: number,
  longitude: number,
  timeoutSeconds: number = TIMEOUT_SECONDS,
): Promise<Forecast> {
  const response = await fetch(buildURL(latitude, longitude), { timeout: timeoutSeconds });
  if (response.status !== 200) throw new ForecastError("天气服务返回 " + response.status);
  const forecast = parseForecast(await response.json());
  if (forecast === null) throw new ForecastError("天气数据解不开");
  return forecast;
}
