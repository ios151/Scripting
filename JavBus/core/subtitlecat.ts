// 字幕猫（Subtitle Cat，subtitlecat.com）：第二个字幕来源，朋友给的接口。纯逻辑：搜索结果页 / 详情页的解析、挑选、排序、挑要下的文件；
// 联网和合并进候选列表在 kit/subtitle.ts。迅雷那边的搜法与挑选在 core/subtitle.ts。
//
// 2026-10-22 实测的样子（朋友给的直链 https://www.subtitlecat.com/subs/765/ABF-123.V4-zh-CN.srt 能直接下，UTF-8 的 SRT）：
// - 搜索：GET /index.php?search=<番号>，回一页 HTML，结果是一张表，每行 `<a href="subs/765/ABF-123.V4.html">名字</a> (translated from English)`，
//   后面是大小 / 下载数 / 语言数，大家点过赞的行有 👍。**搜索是按词模糊匹配的**：搜 IPX-123 会带出 IPX-239__English-123，搜 SDJS-385 回了 120 条、没有一条是它，
//   所以要拿名字对回番号（用迅雷那边的 matchesCode）。番号要带横杠：SSIS-001 有 4 条，SSIS00001 一条没有，SSIS001 有 1 条（SSIS001.FHD，是前面 4 条之外的），
//   补零的写法没用，所以只搜带横杠和紧凑两种；
// - 详情页：每种语言一行，有现成文件的是「Download」链接（…/subs/<目录>/<名字>-zh-CN.srt），没有的只有一个「Translate」按钮（浏览器里用 JS 现翻，脚本里不做）。
//   **目录号每种语言不一样**（STARS-123 的原文在 307、zh-CN 在 308、zh-TW 在 315），猜不出来，只能从详情页的链接里读；
// - 「translated from X」是这份字幕**原本**的语言：Chinese = 中文原版（人工字幕，和迅雷里的一个水平），其余是机翻（英文 / 日文 / 韩文 → 中文，意思能懂、不太通顺）。
//   中文原版有 zh-CN（简体）和 zh-TW（繁体）两份，原文本身是 <名字>-orig.srt（也能直接下，可能是繁体）。

import { decodeHtml } from "./parse";
import { matchesCode, subtitleQueries, type SubtitleChoice } from "./subtitle";

/** 字幕猫的站点地址（搜索页、详情页、字幕文件都在它下面）。 */
export const CAT_ORIGIN = "https://www.subtitlecat.com";
/** 最多留几条字幕猫的候选（迅雷的候选另算）。 */
const MAX_CAT_CHOICES = 6;

/** 搜索结果里的一行。 */
export interface CatEntry {
  /** 详情页的完整地址。 */
  page: string;
  name: string;
  /** 这份字幕原本的语言，站上的英文写法原样（Chinese / English / Japanese…）；没写是空串。 */
  origin: string;
  /** 站上有人点过赞。 */
  liked: boolean;
  downloads: number;
  /** 有几种语言的现成文件。 */
  languages: number;
  /** 在搜索结果里的顺序（0 起）。 */
  index: number;
}

/** 详情页里读到的：各语言的现成文件，和原文文件。 */
export interface CatDetail {
  /** 语言代码（zh-CN / zh-TW / en…）→ 完整下载地址。 */
  files: Map<string, string>;
  /** 原文文件（…-orig.srt）的完整地址；页面里找不到是空串。 */
  orig: string;
}

const SAFE_CHAR = /^[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]$/;

/** 地址里不安全的字符（空格、中文…）百分号编码，已有的 %XX 原样留着（encodeURI 会把 % 再编一遍）。 */
function encodeLoose(text: string): string {
  return Array.from(text)
    .map((ch) => {
      if (SAFE_CHAR.test(ch)) return ch;
      try {
        return encodeURIComponent(ch);
      } catch {
        return ""; // 落单的代理字符，编不了，丢掉
      }
    })
    .join("");
}

/** 页面里的链接（相对的、带不带开头的斜杠都有）→ 完整地址。 */
function absolute(href: string): string {
  const url = /^https?:\/\//i.test(href) ? href : `${CAT_ORIGIN}/${href.replace(/^\/+/, "")}`;
  return encodeLoose(url.replace(/^http:/i, "https:"));
}

/** 搜索页的地址。 */
export function catSearchUrl(query: string): string {
  return `${CAT_ORIGIN}/index.php?search=${encodeURIComponent(query)}`;
}

/** 一个番号要搜的写法：带横杠和紧凑两种（迅雷那边的补零写法在这儿没用，见文件头）。 */
export function catQueries(code: string): string[] {
  const all = subtitleQueries(code);
  return all.length >= 3 ? [all[0], all[all.length - 1]] : all;
}

/** 搜索结果页 → 条目（页面上的顺序）。认不出结构就是空数组。 */
export function parseCatSearch(html: string): CatEntry[] {
  const entries: CatEntry[] = [];
  const rows = html.matchAll(/<tr>\s*<td><a href="([^"]+)">([\s\S]*?)<\/a>\s*(?:\(translated from ([^)]*)\))?\s*<\/td>([\s\S]*?)<\/tr>/g);
  for (const m of rows) {
    const name = decodeHtml(m[2].replace(/<[^>]*>/g, "")).trim();
    if (!name) continue;
    const metrics = [...m[4].matchAll(/sub-table__metric-value">([^<]*)</g)].map((x) => Number.parseInt(x[1].replace(/,/g, ""), 10));
    entries.push({
      page: absolute(decodeHtml(m[1])),
      name,
      origin: (m[3] ?? "").trim(),
      liked: /Rated good/i.test(m[4]),
      downloads: Number.isFinite(metrics[1]) ? metrics[1] : 0,
      languages: Number.isFinite(metrics[2]) ? metrics[2] : 0,
      index: entries.length,
    });
  }
  return entries;
}

/** 这份字幕原本就是中文（人工字幕）。 */
export const isChineseOrigin = (origin: string): boolean => /^chinese/i.test(origin);

/**
 * 从搜索结果里挑候选：名字对得上番号的、同一个详情页只留一条，
 * 然后「中文原版 > 点过赞 > 下载多 > 语言多 > 原顺序」排，最多留 6 条。
 */
export function catChoices(entries: CatEntry[], code: string): CatEntry[] {
  const seen = new Set<string>();
  const kept = entries.filter((e) => {
    if (seen.has(e.page) || !matchesCode(e.name, code)) return false;
    seen.add(e.page);
    return true;
  });
  const rank = (e: CatEntry): number[] => [isChineseOrigin(e.origin) ? 1 : 0, e.liked ? 1 : 0, e.downloads, e.languages];
  kept.sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return rb[i] - ra[i];
    return a.index - b.index;
  });
  return kept.slice(0, MAX_CAT_CHOICES);
}

/** 详情页 → 各语言的现成文件和原文文件。 */
export function parseCatDetail(html: string): CatDetail {
  const files = new Map<string, string>();
  for (const m of html.matchAll(/<a id="download_([^"]+)"[^>]*?href="([^"]+)"/g)) {
    if (!files.has(m[1])) files.set(m[1], absolute(decodeHtml(m[2])));
  }
  // 没有现成文件的语言都挂着「Translate」按钮，参数里写着原文文件名和所在目录：translate_from_server_folder('af', 'X-orig.srt', '/subs/307/')
  const t = /translate_from_server_folder\('[^']*',\s*'([^']+)',\s*'([^']+)'\)/.exec(html);
  return { files, orig: t ? absolute(`${t[2]}${t[1]}`) : "" };
}

/**
 * 要下载的文件，按先后：简体中文 > 繁体中文；中文原版最后再退到原文。
 * 其余语言不要（这里找的是中文字幕）。机翻的字幕没有中文文件就返回空数组，调用方换下一条。
 */
export function pickCatUrls(detail: CatDetail, origin: string): string[] {
  const urls = ["zh-CN", "zh-TW"].flatMap((lang) => detail.files.get(lang) ?? []);
  if (isChineseOrigin(origin) && detail.orig) urls.push(detail.orig);
  return urls;
}

/** 站上写的原始语言 → 中文名（认不得的原样）。 */
const ORIGIN_NAMES = new Map([
  ["chinese", "中文"],
  ["english", "英文"],
  ["japanese", "日文"],
  ["korean", "韩文"],
  ["indonesian", "印尼文"],
  ["vietnamese", "越南文"],
  ["thai", "泰文"],
  ["malay", "马来文"],
  ["filipino", "菲律宾文"],
  ["portuguese", "葡萄牙文"],
  ["spanish", "西班牙文"],
  ["french", "法文"],
  ["german", "德文"],
  ["russian", "俄文"],
  ["turkish", "土耳其文"],
  ["arabic", "阿拉伯文"],
]);

/** 候选给人看的来源标签：迅雷的是空串，字幕猫的是「字幕猫 · 中文原版」「字幕猫 · 机翻自英文」。 */
export function choiceLabel(choice: SubtitleChoice): string {
  if (!choice.cat) return "";
  const { origin } = choice.cat;
  if (!origin) return "字幕猫";
  if (isChineseOrigin(origin)) return "字幕猫 · 中文原版";
  return `字幕猫 · 机翻自${ORIGIN_NAMES.get(origin.toLowerCase()) ?? origin}`;
}

/** 字幕猫的条目 → 候选。下载地址要进详情页才找得到，所以 urls 是空的，见 kit/subtitle.ts 的 loadSubtitle。 */
export function catToChoice(entry: CatEntry): SubtitleChoice {
  return { name: entry.name, ext: "srt", duration: 0, copies: 1, urls: [], cat: { page: entry.page, origin: entry.origin } };
}
