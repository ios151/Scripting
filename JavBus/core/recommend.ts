// 推荐：列表清洗、上传载荷、服务端返回码的含义、社区服务的地址与举报。
//
// 网络部分在 kit/recommend.ts；这里只放不依赖运行时的纯逻辑。
//
// 有两种服务端，返回的都是纯文本码：
//   原作者的 Google Apps Script：succeed 成功 · FE 格式错误 · RE 已在推荐列表（仅网友上传）· NA 密码错误（仅作者通道）· 其他 = 未知错误
//   社区服务（javbus-community，只管 COMMUNITY_CHANNELS 里的列表，现在只有网友推荐）：在上面的基础上多了
//     PD 已收下等审核 · RL 太频繁 · BN 被封禁 · OFF 暂停收稿 · NF 没有这条 · FULL 列表满了
//   社区服务里 NA 的含义更宽：口令不对，或者撤销的不是你自己提交的。
// 哪个频道走哪种服务端由 channelUsesCommunity 决定，返回码按那个频道的服务端解释。

import { COMMUNITY_CHANNELS, RETIRED_SERVICE_URLS } from "./constants";
import { looksLikeHtml, visibleText } from "./parse";
import type { RecItem } from "./types";

/** 设置里的服务地址：空串、或是以前版本的默认地址（用户没动过），都退回当前默认；别的原样保留（去掉首尾空白）。 */
export function pickServiceUrl(value: string, fallback: string): string {
  const url = value.trim();
  return !url || RETIRED_SERVICE_URLS.includes(url) ? fallback : url;
}

/** 清洗服务端 JSON：只留四个字段齐全的条目，按 code 去重（保留靠前的）。 */
export function cleanRecList(raw: unknown): RecItem[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: RecItem[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const code = typeof o.code === "string" ? o.code : "";
    const link = typeof o.link === "string" ? o.link : "";
    if (!code || !link || seen.has(code)) continue;
    seen.add(code);
    out.push({
      code,
      link,
      src: typeof o.src === "string" ? o.src : "",
      info: typeof o.info === "string" && o.info ? o.info : code,
    });
  }
  return out;
}

export type UploadChannel = "user" | "author";
export type UploadMode = "upload" | "del";

export interface UploadPayload {
  pw?: string;
  av: RecItem | string;
  mode: UploadMode;
}

/** 上传：`av` 是整条记录；删除：`av` 只是番号。作者通道多带一个密码。 */
export function buildPayload(mode: UploadMode, av: RecItem | string, password?: string): UploadPayload {
  const payload: UploadPayload = { av, mode };
  if (password !== undefined) payload.pw = password;
  return payload;
}

// ———— 社区服务的地址 ————

export interface ServiceUrls {
  recAuthor: string;
  recUser: string;
  uploadAuthor: string;
  uploadUser: string;
}

/** 社区服务地址：只收 http(s)，去掉首尾空白和末尾的斜杠；不合格的返回空串（= 不用社区服务）。 */
export function normalizeCommunityUrl(value: string): string {
  const url = value.trim().replace(/\/+$/, "");
  return /^https?:\/\/[^\s/?#]+(\/[^\s?#]*)?$/i.test(url) ? url : "";
}

/** 社区服务的四个接口地址（列表和上传都在 /api/v1 下）。 */
export function communityEndpoints(base: string): ServiceUrls {
  const root = `${base}/api/v1`;
  return {
    recAuthor: `${root}/rec/author`,
    recUser: `${root}/rec/user`,
    uploadAuthor: `${root}/upload/author`,
    uploadUser: `${root}/upload/user`,
  };
}

export interface ServiceSettings {
  communityUrl: string;
  recUrlAuthor: string;
  recUrlUser: string;
  uploadUrlAuthor: string;
  uploadUrlUser: string;
}

/** 这个频道走不走社区服务：填了合格的社区地址，并且这份列表归社区服务管（COMMUNITY_CHANNELS）。 */
export function channelUsesCommunity(
  channel: UploadChannel,
  communityUrl: string,
  channels: readonly UploadChannel[] = COMMUNITY_CHANNELS,
): boolean {
  return channels.includes(channel) && normalizeCommunityUrl(communityUrl) !== "";
}

/**
 * 现在该用哪四个地址：归社区服务管的列表（COMMUNITY_CHANNELS，现在只有网友推荐）换成社区的接口，
 * 它们在设置里的两个高级地址不再起作用；其余列表（作者精选）照旧用设置里的。没填社区地址就全用设置里的。
 */
export function resolveServiceUrls(s: ServiceSettings, channels: readonly UploadChannel[] = COMMUNITY_CHANNELS): ServiceUrls {
  const urls: ServiceUrls = { recAuthor: s.recUrlAuthor, recUser: s.recUrlUser, uploadAuthor: s.uploadUrlAuthor, uploadUser: s.uploadUrlUser };
  const community = normalizeCommunityUrl(s.communityUrl);
  if (!community) return urls;
  const remote = communityEndpoints(community);
  if (channels.includes("author")) {
    urls.recAuthor = remote.recAuthor;
    urls.uploadAuthor = remote.uploadAuthor;
  }
  if (channels.includes("user")) {
    urls.recUser = remote.recUser;
    urls.uploadUser = remote.uploadUser;
  }
  return urls;
}

// ———— 返回码 → 提示 ————

export interface UploadOutcome {
  ok: boolean;
  /** 服务端返回的码（认得的才有；整页 HTML 之类不认识的没有）：界面据此决定下一步，比如撤销被拒绝（NA）后改问维护者口令。 */
  code?: string;
  /** 给用户看的话。 */
  message: string;
  /** 未知返回码需要原样复制到剪贴板（原版就是这么做的，方便发给作者排查）。 */
  copy?: string;
  /** 服务端返回的是网页（Google 的错误页）时，页面上用户看得到的那几句话，界面用弹窗完整展示。 */
  serviceError?: string;
}

/**
 * 不认识的返回码。
 * 返回的是整张 Google 错误页时，原版把整页 HTML 当「错误代码」塞进提示（真机上就是满屏脚本），
 * 这里只取页面上看得到的那几句（如「Script function not found: doGet」），整页 HTML 不进提示也不进剪贴板。
 */
function describeUnknown(code: string): UploadOutcome {
  if (looksLikeHtml(code)) {
    const text = visibleText(code) || "（页面没有可读的文字）";
    return { ok: false, message: "推荐服务返回了错误页", copy: text, serviceError: text };
  }
  return { ok: false, message: `错误代码：${code.slice(0, 120)}`, copy: code };
}

/**
 * 上传 / 撤销的返回码 → 提示。文案照原版，社区服务新增的码是我们自己加的。
 * @param community 是不是社区服务返回的：NA 的含义不一样（原版只有「作者密码错」，社区服务里还可能是「这条不是你提交的」）
 */
export function describeUploadResult(result: string, community = false): UploadOutcome {
  const code = result.trim();
  switch (code) {
    case "succeed":
      return { code, ok: true, message: "成功！" };
    case "PD":
      return { code, ok: true, message: "已提交，维护者审核通过后会出现在「网友推荐」" };
    case "FE":
      return { code, ok: false, message: "上传格式错误！" };
    case "RE":
      return { code, ok: false, message: "该影片已在推荐列表！" };
    case "NA":
      return { code, ok: false, message: community ? "没有权限：口令不对，或者这条不是你提交的" : "密码错误！" };
    case "RL":
      return { code, ok: false, message: "提交太频繁了，稍后再试" };
    case "BN":
      return { code, ok: false, message: "你的设备或网络已被封禁，无法提交" };
    case "OFF":
      return { code, ok: false, message: "推荐服务暂停收稿，稍后再试" };
    case "NF":
      return { code, ok: false, message: "没有找到这条推荐" };
    case "FULL":
      return { code, ok: false, message: "推荐列表已满，请联系维护者" };
    default:
      return describeUnknown(code);
  }
}

// ———— 举报（社区服务才有）————

export type ReportReason = "dead" | "inappropriate" | "duplicate" | "other";

/** 举报原因，顺序就是选择菜单里的顺序。 */
export const REPORT_REASONS: { reason: ReportReason; label: string }[] = [
  { reason: "dead", label: "链接或封面已失效" },
  { reason: "inappropriate", label: "内容不当" },
  { reason: "duplicate", label: "重复推荐" },
  { reason: "other", label: "其他" },
];

export interface ReportPayload {
  channel: UploadChannel;
  code: string;
  reason: ReportReason;
}

export function buildReport(channel: UploadChannel, code: string, reason: ReportReason): ReportPayload {
  return { channel, code, reason };
}

/** 举报的返回码 → 提示。 */
export function describeReportResult(result: string): UploadOutcome {
  const code = result.trim();
  switch (code) {
    case "succeed":
      return { code, ok: true, message: "已举报，谢谢你的反馈" };
    case "NF":
      return { code, ok: false, message: "这条推荐已经不在列表里了" };
    case "RL":
      return { code, ok: false, message: "举报太频繁了，稍后再试" };
    case "BN":
      return { code, ok: false, message: "你的设备或网络已被封禁" };
    case "FE":
      return { code, ok: false, message: "举报格式错误" };
    default:
      return describeUnknown(code);
  }
}

// ———— 测试连接（社区服务的 /api/v1/meta）————

const CHANNEL_LABELS: Record<UploadChannel, string> = { user: "网友推荐", author: "作者精选" };

/**
 * 认出 meta 响应并翻成一句话；不是社区服务返回的（别的网站 / 地址填错了）就说清楚不是。
 * 只报归社区服务管的列表的条数：作者精选不走它，社区那边的作者精选条数（通常是 0）对用户没有意义。
 */
export function describeMeta(raw: unknown, channels: readonly UploadChannel[] = COMMUNITY_CHANNELS): { ok: boolean; message: string } {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
  const counts = o?.channels && typeof o.channels === "object" ? (o.channels as Record<string, unknown>) : null;
  if (!o || typeof o.name !== "string" || typeof o.version !== "string" || !counts) {
    return { ok: false, message: "这个地址不是社区推荐服务（返回的内容不对）" };
  }
  const count = (key: string) => (typeof counts[key] === "number" ? counts[key] : 0);
  const lists = (["user", "author"] as const).filter((c) => channels.includes(c)).map((c) => `${CHANNEL_LABELS[c]} ${count(c)} 条`);
  const state = o.maintenance === true ? "当前暂停收稿" : o.autoApprove === false ? "新提交需要审核" : "";
  const detail = [lists.join(" · "), state].filter(Boolean).join("，");
  return { ok: true, message: `连接成功：${o.name}${detail ? `（${detail}）` : ""}` };
}
