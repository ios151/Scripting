// 天气数据：彩云天气（https://www.caiyunapp.com）的综合接口 `/weather`，一次请求带回实况、逐小时、每天、空气质量、
// 生活指数、分钟级降水的那句话，加上 `alert=true` 的预警。内置的接口由 001 提供；用户也可以换成自己的。
//
// 默认用内置的接口（路径写法和彩云官方一样）；用户可以换成自己的：自己的服务地址 + token，
// 也可以是彩云官方的地址 + 自己在彩云平台申请的 token。路径都是这一套：`{地址}/v2.6/{token}/{经度},{纬度}/weather`。
// 彩云文档页的 servers 写的是 `singer.caiyunhub.com/v3`，那是另一套（要在请求头里带 token），这里不用。
//
// 内置接口路径里的 token 是什么文字都行（只要没有斜杠），所以内置的只是个占位词，不是彩云的 token。
// 内置接口的地址只写在这一个文件里，界面和文档里都不写出来。
//
// 为什么用综合接口 `/weather` 而不是分开请求 realtime / hourly / daily：一次请求就是一次调用，次数一样、返回一次到齐。
// `hourlysteps` 取文档里的最小值 24（逐小时那一行最远看十几个小时），`dailysteps` 取 6（今天加后面五天）。
//
// 坐标取整到小数点后两位（约 1 公里）：天气和预警都用不着更准，也少发出去一点真实位置。

import { adaptCaiyun, type Adapted } from "./caiyunWeather";
import { FetchError, classifyFailure } from "./failure";
import type { Forecast } from "./forecast";
import type { Coord } from "./geo";
import { roundedForRequest } from "./openmeteo";

/** 内置的接口（001 提供） */
export const BUILTIN_HOST = "https://colorfulclouds.trigram-masques-8r.workers.dev";

/** 内置接口路径里要有 token 这一段，但它是什么都行，所以放个占位词；不是彩云的 token */
export const BUILTIN_TOKEN = "scripting-weather";

/** 彩云官方的地址。只在「自己的」输入框里当示范，内置的不走它 */
export const OFFICIAL_HOST = "https://api.caiyunapp.com";

/** 往哪里发：服务地址 + 路径里 token 的那一段 */
export type Endpoint = { host: string; token: string };

/** 地址只认 https（token 在路径里，不能明文发）；可以带端口和路径前缀，不许有问号、井号、空格、反斜杠 */
const HOST = /^https:\/\/[A-Za-z0-9][A-Za-z0-9.-]*(:\d{1,5})?(\/[A-Za-z0-9._~%-]+)*$/;

const MAX_TOKEN_LENGTH = 128;

/** 用户粘贴进来的服务地址：去掉首尾空白和结尾的斜杠，多写的 `/v2.6` 也去掉（后面会自己拼）；格式不对返回 null */
export function cleanHost(value: string): string | null {
  const text = value.trim().replace(/\/+$/, "").replace(/\/v2\.6$/, "").replace(/\/+$/, "");
  return HOST.test(text) ? text : null;
}

/**
 * 用户粘贴进来的 token：去掉首尾空白，不合格返回 null。
 * token 只是路径里的一段，什么文字都行，只是不能为空、不能带斜杠、不能有换行这类控制字符，长度也卡一道；
 * 放进地址时再整体转义，所以问号、井号这些也不会拼出奇怪的地址。
 */
export function cleanToken(value: string): string | null {
  const text = value.trim();
  if (text === "" || text.length > MAX_TOKEN_LENGTH || text.includes("/") || /[\u0000-\u001f\u007f]/.test(text)) return null;
  return text;
}

export function buildWeatherURL(endpoint: Endpoint, coord: Coord): string {
  const lng = roundedForRequest(coord.longitude).toFixed(2);
  const lat = roundedForRequest(coord.latitude).toFixed(2);
  // 经度在前、纬度在后（彩云的顺序，和 Open-Meteo 相反）
  return `${endpoint.host}/v2.6/${encodeURIComponent(endpoint.token)}/${lng},${lat}/weather?alert=true&dailysteps=6&hourlysteps=24&lang=zh_CN`;
}

/**
 * 取一次天气。出错抛 `FetchError`（原因分好类了），由调用方决定退回缓存还是提示。
 * `previous` 是缓存里的预报，用来累计今天的最高最低；`now` 是手机的时钟（UTC 毫秒）。
 */
export async function fetchCaiyun(
  endpoint: Endpoint,
  coord: Coord,
  timeoutSeconds: number,
  now: number,
  previous: Forecast | null,
): Promise<Adapted> {
  let response: Response;
  try {
    response = await fetch(buildWeatherURL(endpoint, coord), { timeout: timeoutSeconds });
  } catch {
    throw new FetchError("network");
  }

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // 不是 JSON：下面按状态码归类
  }

  if (response.status !== 200) {
    const errorText = typeof body === "object" && body !== null && typeof (body as { error?: unknown }).error === "string" ? (body as { error: string }).error : "";
    throw new FetchError(classifyFailure(response.status, errorText), `HTTP ${response.status}`);
  }

  const adapted = adaptCaiyun(body, { coord, now, previous });
  if (adapted === null) throw new FetchError("format");
  return adapted;
}
