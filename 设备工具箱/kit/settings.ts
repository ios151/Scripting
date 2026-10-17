// 连接设置：隧道从哪来、对端地址是什么。
//
// 存在本脚本自己的 Storage 里。Storage 默认按脚本隔离，别的脚本改不到这儿。

export type TunnelSource = "builtIn" | "proxyApp";

export interface ConnectionSettings {
  /** builtIn：用 Scripting 自己的 VPN 提供回环；proxyApp：回环由代理工具提供。 */
  source: TunnelSource;
  /** 隧道对端，回环约定地址。 */
  host: string;
}

const KEY = "devicekit_connection_v1";
export const DEFAULT_HOST = "10.7.0.1";

/** 去掉首尾空白，不是合法 IPv4 就退回默认值——清空或多打一个空格不该让整条链路失败。 */
export function normalizeHost(text: string): string {
  const host = text.trim();
  const parts = host.split(".");
  const valid = parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
  return valid ? host : DEFAULT_HOST;
}

/** 不管从哪儿读出来的，都洗成一份合法设置。 */
export function normalizeSettings(stored: Partial<ConnectionSettings> | null | undefined): ConnectionSettings {
  return {
    source: stored?.source === "proxyApp" ? "proxyApp" : "builtIn",
    host: normalizeHost(stored?.host ?? DEFAULT_HOST),
  };
}

export function loadConnectionSettings(): ConnectionSettings {
  return normalizeSettings(Storage.get<Partial<ConnectionSettings>>(KEY));
}

export function saveConnectionSettings(settings: ConnectionSettings): void {
  Storage.set(KEY, { source: settings.source, host: normalizeHost(settings.host) });
}
