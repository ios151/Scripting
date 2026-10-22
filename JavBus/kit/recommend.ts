// 推荐：拉取两份列表、判断「新」角标、上传 / 撤销 / 举报推荐。
//
// 服务端有两种，按频道分：归社区服务管的列表（COMMUNITY_CHANNELS，现在只有网友推荐）走 javbus-community；
// 其余（作者精选）照旧是原作者维护的列表 + Apps Script 上传。没填社区地址就全部用原作者的。

import { useEffect, useState } from "scripting";

import {
  buildPayload,
  buildReport,
  channelUsesCommunity,
  cleanRecList,
  describeMeta,
  describeReportResult,
  describeUploadResult,
  normalizeCommunityUrl,
  resolveServiceUrls,
  type ReportReason,
  type UploadChannel,
  type UploadMode,
  type UploadOutcome,
} from "../core/recommend";
import type { RecItem } from "../core/types";
import { getText } from "./http";
import { getFlags, getSettings, setFlag } from "./settings";

export interface RecLists {
  author: RecItem[];
  user: RecItem[];
}

let cached: RecLists | null = null;
/** 缓存是按哪组地址拉的：设置里换了服务地址，旧缓存就不能再用。 */
let cachedKey = "";
let inflight: Promise<RecLists> | null = null;
const listeners = new Set<() => void>();

/** 列表更新、或「新」角标被清掉时通知（App 根视图据此刷新 Tab 角标）。 */
export function onRecommendChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function emit(): void {
  for (const l of listeners) l();
}

export function cachedRecLists(): RecLists | null {
  return cached;
}

/**
 * 订阅推荐列表的更新。卡片上的「推荐」角标靠 recKindOf 查缓存，而列表常常比首页网格晚到，
 * 不订阅的话角标要等下一次重绘才出现。返回值没用，只是让调用它的组件跟着重绘。
 */
export function useRecVersion(): number {
  const [version, setVersion] = useState(0);
  useEffect(() => onRecommendChange(() => setVersion((n) => n + 1)), []);
  return version;
}

async function fetchList(url: string): Promise<RecItem[]> {
  const { text, status } = await getText(url, { timeout: 15 });
  if (status !== 200) throw new Error(`推荐列表返回 ${status}`);
  // 原作者的服务给的是 text/plain，不是 application/json，所以自己解析
  return cleanRecList(JSON.parse(text));
}

/**
 * 拉两份列表。一份失败另一份照用（失败那份保持上次的）；两份都失败才抛错。
 * 并发调用合并成一次。
 */
export function fetchRecLists(force = false): Promise<RecLists> {
  const urls = resolveServiceUrls(getSettings());
  const key = `${urls.recAuthor}\n${urls.recUser}`;
  if (cached && !force && cachedKey === key) return Promise.resolve(cached);
  if (inflight) return inflight;
  // 换了服务地址：旧缓存属于另一个服务，一份失败时也不能拿它顶替
  const previous = cachedKey === key ? cached : null;
  inflight = (async () => {
    const [author, user] = await Promise.allSettled([fetchList(urls.recAuthor), fetchList(urls.recUser)]);
    if (author.status === "rejected" && user.status === "rejected") {
      throw new Error("推荐列表加载失败，请检查网络");
    }
    cached = {
      author: author.status === "fulfilled" ? author.value : (previous?.author ?? []),
      user: user.status === "fulfilled" ? user.value : (previous?.user ?? []),
    };
    cachedKey = key;
    emit();
    return cached;
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}

/** 作者推荐比上次看的时候多了，就亮「新」（原版用缓存里的 recommend 条数比）。 */
export function hasNewRecommendations(lists: RecLists | null): boolean {
  return !!lists && lists.author.length > getFlags().recSeen;
}

export function markRecommendationsSeen(lists: RecLists): void {
  setFlag("recSeen", lists.author.length);
  emit();
}

/** 这个番号在不在推荐里、是哪一边推的（卡片角标颜色用：作者橙、网友紫）。 */
export function recKindOf(code: string): "author" | "user" | null {
  if (!cached) return null;
  if (cached.author.some((r) => r.code === code)) return "author";
  if (cached.user.some((r) => r.code === code)) return "user";
  return null;
}

// ———— 社区服务 ————

/** 这个频道是不是走社区服务（页面据此决定显示不显示举报、问哪种口令、撤销先不先认设备）。 */
export function usesCommunity(channel: UploadChannel): boolean {
  return channelUsesCommunity(channel, getSettings().communityUrl);
}

const DEVICE_KEY = "javbus.deviceId";
const DEVICE_ID = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * 这台设备的随机编号：第一次用到时生成、存在本脚本自己的 Storage 里。只在请求社区服务时作为 X-Device-Id 带上，
 * 服务端只存它的加盐哈希，用来按设备限频、认出「这条是不是你自己提交的」（才能让你自己撤销）。不含任何个人信息；重装脚本会换一个。
 */
function deviceId(): string {
  const stored = Storage.get<string>(DEVICE_KEY);
  if (typeof stored === "string" && DEVICE_ID.test(stored)) return stored;
  const fresh = UUID.string().replace(/-/g, "").toLowerCase();
  Storage.set(DEVICE_KEY, fresh);
  return fresh;
}

/** 点「测试连接」：读社区服务的 /api/v1/meta，看是不是真的社区服务、现在收不收稿。 */
export async function testCommunity(base: string): Promise<{ ok: boolean; message: string }> {
  const url = normalizeCommunityUrl(base);
  if (!url) return { ok: false, message: "地址要以 http:// 或 https:// 开头" };
  try {
    const { text, status } = await getText(`${url}/api/v1/meta`, { timeout: 10 });
    if (status !== 200) return { ok: false, message: `服务返回了 ${status}，地址对吗？` };
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return describeMeta(null);
    }
    return describeMeta(json);
  } catch {
    return { ok: false, message: "连不上这个地址，检查一下网络和地址" };
  }
}

// ———— 上传 / 撤销 / 举报 ————

/**
 * 上传 / 删除一条推荐。原作者的服务：作者通道要密码；网友通道上传不要密码，删除要密码。
 * 社区服务（归它管的频道）：密码是维护者的「App 口令」，网友通道的撤销不带口令也行——服务端认设备，自己提交的、期限内的可以撤。
 * 服务端只回一个文本码，由 describeUploadResult 按这个频道的服务端翻成提示。
 */
export async function sendRecommendation(
  channel: UploadChannel,
  mode: UploadMode,
  av: RecItem | string,
  password?: string,
): Promise<UploadOutcome> {
  const settings = getSettings();
  const urls = resolveServiceUrls(settings);
  const community = usesCommunity(channel);
  const url = channel === "author" ? urls.uploadAuthor : urls.uploadUser;
  try {
    const init: RequestInit = {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(community ? { "X-Device-Id": deviceId() } : {}) },
      body: JSON.stringify(buildPayload(mode, av, password)),
      timeout: 20,
    };
    if (!community) {
      // 原作者的 Apps Script：POST 执行完先回 302，Location 指向 script.googleusercontent.com/macros/echo，
      // 结果要用 GET 去那里取（curl 实测：空内容 → FE，无密码的删除 → NA）。
      // POST 遇 302 要不要改成 GET 是运行时的事，这里不赌，显式改。
      // 社区服务直接回结果，不跳转；它前面万一有 http → https 的 308，要保持 POST，所以不能套这个。
      init.handleRedirect = async (next) => ({
        ...next,
        method: "GET",
        body: undefined,
        headers: Object.fromEntries(
          Object.entries(next.headers).filter(([name]) => !/^content-(type|length)$/i.test(name)),
        ),
      });
    }
    const res = await fetch(url, init);
    const outcome = describeUploadResult(await res.text(), community);
    if (outcome.serviceError) {
      // 回的是错误页时带上状态码和最终落在哪个地址（不含查询串里的令牌）：
      // 判断是「跳转后方法不对」还是「对方脚本抛了错」，就靠这一行
      const where = (res.url || url).replace(/^https?:\/\//, "").split(/[?#]/)[0];
      outcome.serviceError += `\n\n（HTTP ${res.status}，最终地址 ${where}）`;
      outcome.copy = outcome.serviceError;
    }
    return outcome;
  } catch {
    return { ok: false, message: "网络错误，没有发送出去" };
  }
}

/** 举报一条推荐（只有社区服务有这个接口，所以只有归它管的列表能举报）。 */
export async function sendReport(channel: UploadChannel, code: string, reason: ReportReason): Promise<UploadOutcome> {
  const base = normalizeCommunityUrl(getSettings().communityUrl);
  if (!base || !usesCommunity(channel)) return { ok: false, message: "只有社区推荐服务里的推荐可以举报" };
  try {
    const res = await fetch(`${base}/api/v1/report`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Device-Id": deviceId() },
      body: JSON.stringify(buildReport(channel, code, reason)),
      timeout: 20,
    });
    return describeReportResult(await res.text());
  } catch {
    return { ok: false, message: "网络错误，没有发送出去" };
  }
}
