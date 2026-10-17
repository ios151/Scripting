// 现在走的是蜂窝还是 WiFi。
//
// 为什么要管：建会话要靠 mDNS 找配对服务（`core/bonjour.ts`），而**蜂窝接口上
// 没有本地链路**，公告发不到、也收不到，于是一路退到端口扫描，多半还是连不上。
// 2026-10-16 蜂窝实测确认过：公告端口在隧道对端直接被 RST，配对服务没绑在那条回环上。
//
// 解法不是「必须连 WiFi」：临时开一下飞行模式就行——蜂窝接口被撤掉，mDNS 回到本地，
// 会话建起来之后关掉飞行模式，蜂窝照常用，已经建好的会话不受影响。
//
// 判断只看系统给的默认路径（`Device.getNetworkState`），不发任何探测请求。

import { describeError } from "../core/debug";

export type LinkKind = "wifi" | "cellular" | "wired" | "offline" | "unknown";

export function classifyLink(state: Device.NetworkState | null | undefined): LinkKind {
  if (!state) return "unknown";
  if (state.status === "unsatisfied") return "offline";
  const interfaces = Array.isArray(state.interfaces) ? state.interfaces : [];
  // WiFi 优先：两个接口都在时默认路径走的是 WiFi，mDNS 也就找得到
  if (interfaces.includes("wifi")) return "wifi";
  if (interfaces.includes("wiredEthernet")) return "wired";
  if (interfaces.includes("cellular")) return "cellular";
  return state.status === "satisfied" ? "unknown" : "offline";
}

export const LINK_LABEL: Record<LinkKind, string> = {
  wifi: "Wi‑Fi",
  cellular: "蜂窝数据",
  wired: "有线",
  offline: "没有网络",
  unknown: "未知",
};

/** 蜂窝下建会话前要先做的事。文案按动作顺序写，照着做一遍就行。 */
export const CELLULAR_HINT =
  "现在走的是蜂窝数据。配对服务靠 mDNS 公告自己，而蜂窝接口上没有本地链路，找不到它。\n" +
  "① 控制中心开一次飞行模式，等几秒\n" +
  "② 关掉飞行模式\n" +
  "③ 回来重新连接\n" +
  "连上之后蜂窝照常用，这一步只在建连接那一刻需要。";

/** 飞行模式开着（或别的原因彻底没网）时该说的话。隧道依附网络接口，一起断。 */
export const OFFLINE_HINT = "现在没有网络。飞行模式开着的话，隧道会跟着一起断——关掉它，网络和隧道一起恢复，再重试。";

/** 这种链路下建会话大概率要先折腾一下，值得提前提醒。 */
export function needsAttention(link: LinkKind): boolean {
  return link === "cellular" || link === "offline";
}

export function linkHint(link: LinkKind): string {
  if (link === "cellular") return CELLULAR_HINT;
  if (link === "offline") return OFFLINE_HINT;
  return "";
}

/** 读一次当前链路。拿不到就当「未知」，不拦着用户继续试。 */
export async function readLink(): Promise<LinkKind> {
  try {
    return classifyLink(await Device.getNetworkState());
  } catch {
    return "unknown";
  }
}

/**
 * 连接失败时按当前链路补一句该怎么办。
 *
 * 放在建会话那一处统一加，各页面就都带上了。链路本身没问题（WiFi、有线）时原样抛回，
 * 免得把「开发者模式没开」这种事也推给网络。
 */
export async function withLinkHint(error: unknown): Promise<Error> {
  const failure = error instanceof Error ? error : new Error(describeError(error));
  const link = await readLink();
  const hint = linkHint(link);
  // 诊断文案里可能已经讲过飞行模式了，别再贴一遍
  if (!hint || failure.message.includes("飞行模式")) return failure;
  return new Error(`${failure.message}\n\n${hint}`);
}

/**
 * 订阅链路变化。回调会先收到一次当前状态，之后只在变化时来。
 * 返回取消订阅的函数，直接交给 useEffect 当清理。
 */
export function watchLink(onChange: (link: LinkKind) => void): () => void {
  const listener = (state: Device.NetworkState) => onChange(classifyLink(state));
  Device.addNetworkChangeListener(listener);
  return () => Device.removeNetworkChangeListener(listener);
}
