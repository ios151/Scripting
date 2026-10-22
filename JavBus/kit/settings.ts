// 偏好设置与一次性标记。
//
// 存在本脚本自己的 Storage 里（默认按脚本隔离）。原版的 `$cache` 键（adultCheck / samp /
// recommend / qkMail / qkCode / 各种 showTips）对应这里的 flags 与 settings。

import {
  COMMUNITY_URL,
  REC_UPLOAD_AUTHOR,
  REC_UPLOAD_USER,
  REC_URL_AUTHOR,
  REC_URL_USER,
} from "../core/constants";
import { normalizeCommunityUrl, pickServiceUrl } from "../core/recommend";
import { DEFAULT_SUBTITLE_STYLE, normalizeSubtitleStyle, type SubtitleStyle } from "../core/subtitleStyle";

export interface Settings {
  /** 启动时读剪贴板、抠番号直接搜（原版默认就是开的）。 */
  checkClipboard: boolean;
  /** 进详情页自动播放预览（原版默认就是开的）。 */
  autoPreview: boolean;
  /** 进详情页后台预取 MissAV 完整视频地址（原版每次都会取，开着一个隐藏 web 视图）。 */
  prefetchMissav: boolean;
  /** MissAV 完整视频的隐藏页用电脑版 UA（见 kit/missav.ts）：据用户反馈电脑版能出 1080p。取不到片源时关掉它就回到原版的手机 UA。 */
  missavDesktop: boolean;
  /** 字幕的颜色 / 字号 / 底色 / 拖到的位置（详情页的字幕菜单里改、拖字幕改，所有影片共用一份）。 */
  subtitleStyle: SubtitleStyle;
  /** Quicker 推送：点磁链复制后顺手推到电脑。 */
  quickerMail: string;
  quickerCode: string;
  /** 自定义外部播放器的链接模板，{url} 换成编码后的视频地址、{raw} 换成原样地址（见 core/player.ts）。 */
  playerTemplate: string;
  /** 分享链接模板，{code} 会换成番号。留空用 scripting:// 链接；http(s) 开头会再过一遍 is.gd 缩短。 */
  shareTemplate: string;
  /**
   * 社区推荐服务的地址（javbus-community）。归它管的列表（COMMUNITY_CHANNELS，现在只有网友推荐）用它收发推荐，
   * 这些列表在下面的两个高级地址不再起作用；作者精选照旧用下面的地址。存空串会退回出厂默认（COMMUNITY_URL）。
   */
  communityUrl: string;
  recUrlAuthor: string;
  recUrlUser: string;
  uploadUrlAuthor: string;
  uploadUrlUser: string;
}

export const DEFAULT_SETTINGS: Settings = {
  checkClipboard: true,
  autoPreview: true,
  prefetchMissav: true,
  missavDesktop: true,
  subtitleStyle: DEFAULT_SUBTITLE_STYLE,
  quickerMail: "",
  quickerCode: "",
  playerTemplate: "",
  shareTemplate: "",
  communityUrl: COMMUNITY_URL,
  recUrlAuthor: REC_URL_AUTHOR,
  recUrlUser: REC_URL_USER,
  uploadUrlAuthor: REC_UPLOAD_AUTHOR,
  uploadUrlUser: REC_UPLOAD_USER,
};

const SETTINGS_KEY = "javbus.settings";

let current: Settings = { ...DEFAULT_SETTINGS };
let loaded = false;
const listeners = new Set<(s: Settings) => void>();

/** 空的地址设置、以前版本的默认地址都退回当前默认值——清空一个输入框不该让整个功能失效，原版换了服务地址时升级也要跟上。 */
function sanitize(s: Settings): Settings {
  return {
    ...s,
    // 空的 / 不合格的社区地址退回默认，和下面四个地址同一个道理：以后发版把 COMMUNITY_URL 填上时，
    // 没动过它的老用户（存下来的是当时的空默认值）也能自动用上，不用一个个去设置里填
    communityUrl: normalizeCommunityUrl(s.communityUrl) || normalizeCommunityUrl(DEFAULT_SETTINGS.communityUrl),
    recUrlAuthor: pickServiceUrl(s.recUrlAuthor, DEFAULT_SETTINGS.recUrlAuthor),
    recUrlUser: pickServiceUrl(s.recUrlUser, DEFAULT_SETTINGS.recUrlUser),
    uploadUrlAuthor: pickServiceUrl(s.uploadUrlAuthor, DEFAULT_SETTINGS.uploadUrlAuthor),
    uploadUrlUser: pickServiceUrl(s.uploadUrlUser, DEFAULT_SETTINGS.uploadUrlUser),
    subtitleStyle: normalizeSubtitleStyle(s.subtitleStyle),
    quickerMail: s.quickerMail.trim(),
    quickerCode: s.quickerCode.trim(),
    playerTemplate: s.playerTemplate.trim(),
    shareTemplate: s.shareTemplate.trim(),
  };
}

function load(): void {
  if (loaded) return;
  loaded = true;
  try {
    const stored = Storage.get<Partial<Settings>>(SETTINGS_KEY);
    if (stored && typeof stored === "object") current = sanitize({ ...DEFAULT_SETTINGS, ...stored });
  } catch {
    /* 读不出来就用默认值 */
  }
}

export function getSettings(): Settings {
  load();
  return current;
}

export function updateSettings(patch: Partial<Settings>): Settings {
  load();
  current = sanitize({ ...current, ...patch });
  Storage.set(SETTINGS_KEY, current);
  for (const l of listeners) l(current);
  return current;
}

export function onSettingsChange(listener: (s: Settings) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// ———— 一次性标记 ————

/**
 * - adult：已通过 18+ 提示（原版 adultCheck）
 * - readme：看过更新说明（原版 samp）
 * - siteAge：同意让脚本代为向站点提交年龄确认
 * - recSeen：上次看推荐时作者推荐的条数，比它多就亮「新」角标（原版 recommend）
 * - tips：已经弹过的首次提示（原版 showTips 的键：Rec / downPics）
 */
export interface Flags {
  adult: boolean;
  readme: boolean;
  siteAge: boolean;
  recSeen: number;
  tips: Record<string, boolean>;
}

const FLAGS_KEY = "javbus.flags";

function readFlags(): Flags {
  const stored = Storage.get<Partial<Flags>>(FLAGS_KEY) ?? {};
  return {
    adult: stored.adult === true,
    readme: stored.readme === true,
    siteAge: stored.siteAge === true,
    recSeen: typeof stored.recSeen === "number" ? stored.recSeen : 0,
    tips: stored.tips && typeof stored.tips === "object" ? stored.tips : {},
  };
}

export function getFlags(): Flags {
  return readFlags();
}

export function setFlag<K extends keyof Flags>(key: K, value: Flags[K]): void {
  const flags = readFlags();
  flags[key] = value;
  Storage.set(FLAGS_KEY, flags);
}

/** 首次提示：这个名字没弹过就返回 true 并记下；弹过返回 false（原版 showTips）。 */
export function takeTip(name: string): boolean {
  const flags = readFlags();
  if (flags.tips[name]) return false;
  flags.tips[name] = true;
  Storage.set(FLAGS_KEY, flags);
  return true;
}

/** 设置页「重置」：18+ 确认、站点年龄同意、一次性提示全部清掉。 */
export function resetFlags(): void {
  Storage.set(FLAGS_KEY, null);
}
