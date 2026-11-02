// 天气数据从哪里取：内置的接口（默认）、用户自己的彩云接口、或者备用的 Open-Meteo。纯函数；存取在 store.ts。
//
// 默认「内置」：装好就有，天气、详细数据、预警都从 001 提供的彩云接口一次取到，什么都不用填。
// 想换成自己的服务，选「自己的」填地址和 token；想用备用的 Open-Meteo，选「Open-Meteo」——那边只有基础的天气，没有详细数据和预警。

import { BUILTIN_HOST, BUILTIN_TOKEN, cleanHost, cleanToken, type Endpoint } from "./caiyun";

export type SourceMode = "builtin" | "custom" | "openmeteo";

/** 实际取数的是谁：彩云（内置的和自己的都是彩云的接口格式），还是 Open-Meteo */
export type Provider = "caiyun" | "openmeteo";

export type DataSource = {
  mode: SourceMode;
  /** 自己的服务地址和 token。选别的来源时也留着，免得来回切换要重填；没有就是空字符串 */
  host: string;
  token: string;
};

export function defaultSource(): DataSource {
  return { mode: "builtin", host: "", token: "" };
}

const MODES: readonly SourceMode[] = ["builtin", "custom", "openmeteo"];

/**
 * 存下来的设置读回来，每一项都重新验。
 * 没存过、读不懂都当默认的「内置」；说是「自己的」、地址或 token 却不合格，不照着用，也回到「内置」
 * （填过的地址和 token 还留着，界面上看得到、能改）。
 */
export function parseSource(raw: unknown): DataSource {
  if (typeof raw !== "object" || raw === null) return defaultSource();
  const record = raw as Record<string, unknown>;
  const mode = MODES.find((value) => value === record.mode);
  if (mode === undefined) return defaultSource();
  const host = typeof record.host === "string" ? (cleanHost(record.host) ?? "") : "";
  const token = typeof record.token === "string" ? (cleanToken(record.token) ?? "") : "";
  if (mode === "custom" && (host === "" || token === "")) return { mode: "builtin", host, token };
  return { mode, host, token };
}

export function providerOf(source: DataSource): Provider {
  return source.mode === "openmeteo" ? "openmeteo" : "caiyun";
}

/** 这一刻往哪个彩云接口发；用 Open-Meteo 时是 null */
export function endpointOf(source: DataSource): Endpoint | null {
  if (source.mode === "openmeteo") return null;
  if (source.mode === "builtin") return { host: BUILTIN_HOST, token: BUILTIN_TOKEN };
  return source.host !== "" && source.token !== "" ? { host: source.host, token: source.token } : null;
}
