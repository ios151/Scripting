// 页面解析：把 JavBus / JavDB / Jable 的 HTML 拆成结构化数据。
//
// 纯函数，不碰任何 Scripting API，所以能在 Node 里直接对着真实页面做自测
// （_selftest/javbus-core.test.ts）。
//
// 原版全靠 `/<a class="movie-box"[\s\S]*?<\/span>\s/g` 这类整段正则，属性顺序一变就全军覆没。
// 这里改成「先切出元素、再按属性名取值」，并在几处原版会直接抛 TypeError 的地方（详情页缺字段、
// 磁链没有 dn 参数）给出退路。每个解析器的结构依据都写在函数头，对照的是 Wayback 存档的真实页面。

import { NO_AVATAR } from "./constants";
import { resolveUrl } from "./site";
import type {
  ActressInfo,
  GenreSection,
  ListPage,
  Magnet,
  MagnetParams,
  MovieDetail,
  MovieItem,
  NamedLink,
  SampleImage,
  StarItem,
} from "./types";

// ———— 通用小工具 ————

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** 最常见的几个实体和数字实体；标题里的 `&amp;`、`&#039;` 原版会原样显示出来。 */
export function decodeHtml(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === "#") {
      const code = body[1].toLowerCase() === "x" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/** 去标签、解实体、压缩空白。 */
export function stripTags(html: string): string {
  return decodeHtml(html.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

/** 取起始标签里的属性值。前面必须是空白，免得 `src` 咬到 `data-src`。 */
export function attr(tag: string, name: string): string {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i").exec(tag);
  return decodeHtml(m ? (m[1] ?? m[2] ?? "") : "");
}

/** 切出所有 `<a ... class="含 cls" ...>…</a>`。这些盒子里不会再嵌套 `<a>`，所以非贪婪到第一个 `</a>` 就是整只盒子。 */
function anchorsWithClass(html: string, cls: string): string[] {
  const re = new RegExp(`<a\\b[^>]*\\bclass="[^"]*\\b${cls}\\b[^"]*"[^>]*>[\\s\\S]*?<\\/a>`, "g");
  return html.match(re) ?? [];
}

function openingTag(block: string): string {
  return /^<[a-z]+\b[^>]*>/i.exec(block)?.[0] ?? "";
}

function firstTag(block: string, name: string): string {
  return new RegExp(`<${name}\\b[^>]*>`, "i").exec(block)?.[0] ?? "";
}

// ———— 页面状态 ————

export function is404(html: string): boolean {
  return html.includes("404 Page Not Found");
}

export function isNoResult(html: string): boolean {
  return html.includes("沒有您要的結果");
}

/** 站点的年龄验证页（勾选「我已經成年」再提交）。 */
export function isAgeGate(html: string, url = ""): boolean {
  return url.includes("/doc/driver-verify") || html.includes('id="ageVerify"');
}

// ———— 影片列表 ————

/**
 * 首页 / 搜索 / 类目 / 演员作品共用的影片卡片。
 *
 * 结构（Wayback 2023 存档）：
 * `<a class="movie-box" href=详情><div class="photo-frame"><img src=缩略图 title=标题></div>
 *  <div class="photo-info"><span>标题<br><div><button title="包含高清HD的磁力連結">高清</button>…</div>
 *  <date>番号</date> / <date>日期</date></span></div></a>`
 *
 * 高清 / 字幕不能像原版那样在整块 HTML 里搜字——片名里带「字幕」二字的片会被误标。
 * 站点给标签按钮都加了 `title="包含…的磁力連結"`，认这个，再退一步认按钮文字。
 */
export function parseMovieBoxes(html: string, pageUrl: string): MovieItem[] {
  const items: MovieItem[] = [];
  for (const block of anchorsWithClass(html, "movie-box")) {
    const open = openingTag(block);
    const href = attr(open, "href");
    const dates = [...block.matchAll(/<date>([\s\S]*?)<\/date>/g)].map((m) => stripTags(m[1]));
    const code = dates[0] ?? "";
    if (!href || !code) continue; // 「同類影片」之类没有 <date> 的卡片不是列表项
    const img = firstTag(block, "img");
    const cover = resolveUrl(attr(img, "src"), pageUrl);
    const title = attr(img, "title") || attr(open, "title") || stripTags(/<span>([\s\S]*?)(?:<br|<\/span>)/i.exec(block)?.[1] ?? "");
    items.push({
      code,
      link: resolveUrl(href, pageUrl),
      cover,
      title,
      date: dates[1] ?? "",
      hd: /title="包含高清|>\s*高清\s*</.test(block),
      sub: /title="包含字幕|>\s*字幕\s*</.test(block),
    });
  }
  return items;
}

export function parseMovieList(html: string, pageUrl: string): ListPage {
  return {
    items: parseMovieBoxes(html, pageUrl),
    ended: is404(html),
    noResult: isNoResult(html),
  };
}

// ———— 演员 ————

/**
 * 演员列表、详情页「演员」栏共用：`<a class="avatar-box" href=演员页><div class="photo-frame"><img src=头像 title=名字></div>
 * <span>名字</span></a>`。头像为空或缺失用站点的占位图（原版同一张）。
 */
export function parseStars(html: string, pageUrl: string): StarItem[] {
  const stars: StarItem[] = [];
  for (const block of anchorsWithClass(html, "avatar-box")) {
    const href = attr(openingTag(block), "href");
    if (!href) continue;
    const img = firstTag(block, "img");
    const name = stripTags(/<span>([\s\S]*?)<\/span>/i.exec(block)?.[1] ?? "") || attr(img, "title");
    const src = attr(img, "src");
    stars.push({
      name,
      link: resolveUrl(href, pageUrl),
      avatar: src ? resolveUrl(src, pageUrl) : NO_AVATAR,
    });
  }
  return stars;
}

export const BLANK_ACTRESS_INFO: ActressInfo = {
  birthday: "????-??-??",
  age: "??岁",
  height: "???cm",
  cup: "?",
  bust: "??cm",
  waist: "??cm",
  hip: "??cm",
};

/**
 * 演员页顶部的资料：`<div class="photo-info"><p>生日: 1993-08-16</p><p>年齡: 30</p>…`。
 * 缺哪项就用原版的问号占位；年龄补「岁」。
 */
export function parseActressInfo(html: string): ActressInfo {
  const start = html.indexOf('class="photo-info"');
  const seg = start >= 0 ? html.slice(start) : html;
  const field = (label: string): string | null => {
    const m = new RegExp(`${label}:\\s*([\\s\\S]*?)<\\/p>`).exec(seg);
    const value = m ? stripTags(m[1]) : "";
    return value || null;
  };
  const age = field("年齡");
  return {
    birthday: field("生日") ?? BLANK_ACTRESS_INFO.birthday,
    age: age ? `${age}岁` : BLANK_ACTRESS_INFO.age,
    height: field("身高") ?? BLANK_ACTRESS_INFO.height,
    cup: field("罩杯") ?? BLANK_ACTRESS_INFO.cup,
    bust: field("胸圍") ?? BLANK_ACTRESS_INFO.bust,
    waist: field("腰圍") ?? BLANK_ACTRESS_INFO.waist,
    hip: field("臀圍") ?? BLANK_ACTRESS_INFO.hip,
  };
}

// ———— 分类 ————

/**
 * 分类总览：`<h4>主題</h4><div class="row genre-box"><a class="col-…" href=…>折磨</a>…</div>`，
 * 一节一个 h4。原版按写死的标题表逐节取；这里按页面实际顺序全取，站点加了新小节（如有码页的「其他」）自动出现。
 */
export function parseGenreSections(html: string, pageUrl: string): GenreSection[] {
  const sections: GenreSection[] = [];
  const re = /<h4>([^<]+)<\/h4>\s*<div class="row genre-box">([\s\S]*?)<\/div>/g;
  for (const m of html.matchAll(re)) {
    const items: NamedLink[] = [];
    for (const a of m[2].matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)) {
      const href = attr(a[1], "href");
      const name = stripTags(a[2]);
      if (href && name) items.push({ name, link: resolveUrl(href, pageUrl) });
    }
    if (items.length > 0) sections.push({ title: stripTags(m[1]), items });
  }
  return sections;
}

// ———— 详情 ————

/** `<span class="header">标签:</span> 值</p>` 里的值，没有就是 null。 */
function infoCell(html: string, label: string): string | null {
  const m = new RegExp(`<span class="header">${label}:?\\s*<\\/span>([\\s\\S]*?)<\\/p>`).exec(html);
  return m ? m[1] : null;
}

function infoLink(html: string, label: string, pageUrl: string): NamedLink | null {
  const cell = infoCell(html, label);
  if (!cell) return null;
  const a = /<a\b([^>]*)>([\s\S]*?)<\/a>/i.exec(cell);
  if (!a) return null;
  const name = stripTags(a[2]);
  const href = attr(a[1], "href");
  return name && href ? { name, link: resolveUrl(href, pageUrl) } : null;
}

export function parseMagnetParams(html: string): MagnetParams | null {
  const gid = /var\s+gid\s*=\s*(\d+)/.exec(html)?.[1];
  if (!gid) return null;
  return {
    gid,
    uc: /var\s+uc\s*=\s*(\d+)/.exec(html)?.[1] ?? "0",
    img: /var\s+img\s*=\s*['"]([^'"]*)['"]/.exec(html)?.[1] ?? "",
    lang: /var\s+lang\s*=\s*['"]([^'"]*)['"]/.exec(html)?.[1] ?? "zh",
  };
}

/**
 * 详情页。结构（Wayback 2021 存档，欧美站同构）：
 * - `<h3>番号 标题</h3>`、`<a class="bigImage" href=大图><img title=标题></a>`（旧版标题在 a 上，两处都认）
 * - `<span class="header">識別碼 / 發行日期 / 長度 / 導演 / 製作商 / 發行商 / 系列:</span> 值`
 * - `<span class="genre"><label><input><a href=类目>名</a></label></span>`
 * - `#avatar-waterfall` 里是 `a.avatar-box`，`#sample-waterfall` 里是 `a.sample-box`
 * - 内联脚本 `var gid / uc / img / lang`
 *
 * 原版对 bigImage、識別碼直接 `exec(...)[n]`，缺一个整页就抛 TypeError；这里缺字段给空值。
 */
export function parseDetail(html: string, pageUrl: string): MovieDetail {
  const bigOpen = /<a\b[^>]*\bclass="[^"]*\bbigImage\b[^"]*"[^>]*>/i.exec(html)?.[0] ?? "";
  const bigBlock = /<a\b[^>]*\bclass="[^"]*\bbigImage\b[^"]*"[^>]*>[\s\S]*?<\/a>/i.exec(html)?.[0] ?? "";
  const heading = stripTags(/<h3>([\s\S]*?)<\/h3>/i.exec(html)?.[1] ?? "");

  const codeCell = infoCell(html, "識別碼");
  const code = codeCell ? stripTags(codeCell) : "";
  const title =
    attr(bigOpen, "title") ||
    attr(firstTag(bigBlock, "img"), "title") ||
    (code && heading.startsWith(code) ? heading.slice(code.length).trim() : heading);

  const dateCell = infoCell(html, "發行日期");
  const lengthCell = infoCell(html, "長度");
  const minutes = lengthCell ? /\d+/.exec(stripTags(lengthCell))?.[0] : undefined;

  const genres: NamedLink[] = [];
  for (const g of html.match(/<span class="genre">[\s\S]*?<\/span>/g) ?? []) {
    const a = /<a\b([^>]*)>([\s\S]*?)<\/a>/i.exec(g);
    if (!a) continue; // 「多選提交」那个按钮
    const name = stripTags(a[2]);
    const href = attr(a[1], "href");
    if (name && href) genres.push({ name, link: resolveUrl(href, pageUrl) });
  }

  const samples: SampleImage[] = [];
  for (const block of anchorsWithClass(html, "sample-box")) {
    const full = attr(openingTag(block), "href");
    if (!full) continue;
    const thumb = attr(firstTag(block, "img"), "src");
    samples.push({
      full: resolveUrl(full, pageUrl),
      thumb: thumb ? resolveUrl(thumb, pageUrl) : resolveUrl(full, pageUrl),
    });
  }

  return {
    link: pageUrl,
    title,
    code: code || pageUrl.split("/").pop() || "",
    cover: resolveUrl(attr(bigOpen, "href"), pageUrl),
    date: dateCell ? stripTags(dateCell) : "",
    minutes: minutes ? Number(minutes) : null,
    director: infoLink(html, "導演", pageUrl),
    filmMaker: infoLink(html, "製作商", pageUrl),
    filmEstab: infoLink(html, "發行商", pageUrl),
    series: infoLink(html, "系列", pageUrl),
    genres,
    stars: parseStars(html, pageUrl),
    samples,
    magnetParams: parseMagnetParams(html),
  };
}

// ———— 磁链 ————

/**
 * `uncledatoolsbyajax.php` 的响应是一串 `<tr>`，页面脚本把它们 append 进 `#magnet-table`：
 * 第 1 格是 `<a href=magnet…>名称</a>` + 高清 / 字幕标签，第 2 格大小，第 3 格日期。
 *
 * 原版从 `dn=` 参数取名字、按 `href…</a>` 的出现顺序取大小和日期：磁链没有 dn 会抛错，
 * 标签带 href 时顺序还会错位。这里按单元格取，名字优先用链接文字。
 */
export function parseMagnets(html: string): Magnet[] {
  const magnets: Magnet[] = [];
  for (const row of html.match(/<tr\b[\s\S]*?<\/tr>/g) ?? []) {
    const link = /magnet:\?[^'"<>\s]+/i.exec(row)?.[0];
    if (!link) continue; // 表头行
    const magnet = decodeHtml(link);
    const cells = [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1]);
    const anchorText = /<a\b[^>]*>([\s\S]*?)<\/a>/i.exec(cells[0] ?? "")?.[1];
    magnets.push({
      link: magnet,
      name: (anchorText && stripTags(anchorText)) || magnetName(magnet),
      size: cells[1] ? stripTags(cells[1]).replace(/\s+/g, "") : "",
      date: cells[2] ? stripTags(cells[2]).replace(/\s+/g, "") : "",
      // 认标签按钮（title="包含高清HD的磁力連結" / 文字恰好是「高清」），不认整格文字：
      // 磁链名字里带「中文字幕」的很多，但那不等于站点给它打了字幕标签
      hd: /title="包含高清|>\s*高清\s*</.test(cells[0] ?? row),
      sub: /title="包含字幕|>\s*字幕\s*</.test(cells[0] ?? row),
    });
  }
  return magnets;
}

/** 磁链的显示名：dn 参数，没有就用 btih 哈希。 */
export function magnetName(magnet: string): string {
  const dn = /[?&]dn=([^&]*)/i.exec(magnet)?.[1];
  if (dn) {
    try {
      return decodeURIComponent(dn.replace(/\+/g, " "));
    } catch {
      return dn;
    }
  }
  return /btih:([0-9a-z]+)/i.exec(magnet)?.[1] ?? magnet;
}

// ———— 其他站点 ————

/** 评分文字「4.43分, 由2266人評價」→ 分数与人数。没评分的卡片没有这行字。 */
export function parseScoreText(text: string): { score: string; count: string } | null {
  const score = /([0-9.]+)分/.exec(text)?.[1];
  const count = /由(\d+)人評價/.exec(text)?.[1];
  return score && count ? { score, count } : null;
}

export interface JavdbCard {
  /** 卡片标题里加粗的番号。 */
  code: string;
  rating: { score: string; count: string } | null;
}

/**
 * JavDB 搜索结果页的卡片：`<div class="video-title"><strong>SSIS-001</strong> 标题</div>` 后面跟着
 * `<div class="score"><span class="value">…4.43分, 由2266人評價</span></div>`。
 *
 * 原版直接取页面里第一个 `class="score"` 块，不看是哪部：搜索是模糊的，要找的番号没收录时，
 * 第一个结果是别的片，评分就显示成别人的。这里先按卡片切开，再由 pickJavdbRating 按番号挑。
 */
export function parseJavdbCards(html: string): JavdbCard[] {
  const starts = [...html.matchAll(/<div class="video-title">\s*<strong>([^<]+)<\/strong>/g)];
  return starts.map((m, i) => {
    const end = i + 1 < starts.length ? (starts[i + 1].index ?? html.length) : html.length;
    const slice = html.slice(m.index ?? 0, end);
    const block = /class="score">([\s\S]*?)<\/div>/.exec(slice)?.[1] ?? "";
    return { code: stripTags(m[1]), rating: parseScoreText(stripTags(block)) };
  });
}

const alnum = (s: string): string => s.toUpperCase().replace(/[^A-Z0-9]/g, "");

/**
 * 从卡片里挑出这个番号的评分：忽略大小写和连字符地精确匹配；一个都对不上、但结果恰好只有一张卡时用它
 * （站点番号写法偶有差异）；多张都对不上就当没有——宁可显示 N/A，也不显示成别的片的评分。
 */
export function pickJavdbRating(cards: JavdbCard[], code: string): { score: string; count: string } | null {
  const target = alnum(code);
  const exact = cards.find((c) => alnum(c.code) === target);
  if (exact) return exact.rating;
  return cards.length === 1 ? cards[0].rating : null;
}

/** JavDB 把这个 IP 当成异常访问时返回的页面（正文里有「異常行為」；原版 9.2 起识别）。 */
export function isJavdbBlocked(html: string): boolean {
  return html.includes("異常行為");
}

/** 这个文本是不是 HTML 页面（而不是 `succeed` / `FE` 这种结果码）。 */
export function looksLikeHtml(text: string): boolean {
  return /^\s*<(?:!doctype|html)/i.test(text);
}

/** HTML 页面里用户看得到的文字（去掉 script / style / 标签）。服务端报错页的真正原因在这里，不在一大坨脚本里。 */
export function visibleText(html: string): string {
  return stripTags(html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " "));
}

export interface JableSearch {
  /** 第一部结果的播放页。 */
  videoUrl: string;
  /** 搜索结果卡片上的 8 秒预览。 */
  preview: string;
}

/** Jable 搜索页：含「部影片」才算有结果；取第一个 `/videos/…` 链接和 `data-preview`。 */
export function parseJableSearch(html: string): JableSearch | null {
  if (!html.includes("部影片")) return null;
  const videoUrl = /https:\/\/jable\.tv\/videos\/[^"'\s<>]+/.exec(html)?.[0];
  if (!videoUrl) return null;
  const preview = /data-preview="(https[^"]*?_preview\.mp4)/.exec(html)?.[1] ?? "";
  return { videoUrl, preview };
}

export interface JableResult {
  /** 地址里的那一段：`ssis-001`、`ssis-001-c`（中文字幕版）、`ssis-001-uncensored-leak`…… */
  slug: string;
  videoUrl: string;
  preview: string;
}

/**
 * Jable 搜索页里的每一张卡片（`video-img-box`）：播放页地址和预览。搜索页只有「N 部影片」的标题行时（没有卡片）返回空。
 * 2026-10-23 对着 Wayback 里存的真实搜索页核过卡片写法（一页 24 张，每张有 `https://jable.tv/videos/<slug>/` 和 `data-preview`）。
 */
export function parseJableResults(html: string): JableResult[] {
  if (!html.includes("部影片")) return [];
  const out: JableResult[] = [];
  const seen = new Set<string>();
  for (const chunk of html.split('class="video-img-box').slice(1)) {
    const slug = /https:\/\/jable\.tv\/videos\/([^"'\s<>/]+)/.exec(chunk)?.[1];
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    const preview = /data-preview="(https[^"]*?_preview\.mp4)/.exec(chunk)?.[1] ?? "";
    out.push({ slug, videoUrl: `https://jable.tv/videos/${slug}/`, preview });
  }
  return out;
}

/**
 * 搜索结果里挑「就是这个番号」的那一条：地址的那一段去掉符号后和番号一样排最前（`ssis-001`），
 * 其次是同一部片的其它版本——后面多出来的是字母开头的后缀（`-c` 中文字幕、`-uncensored-leak`）；
 * 多出来的是数字（`ssis-0012`）说明是另一部，不要。一条都对不上返回 null——
 * 以前是直接拿第一条，搜 `SSIS-001` 排第一的可能是别的片，播出来就是错的。
 * FC2 两种写法（`FC2-PPV-1234567` / `FC2-1234567`）算同一个。
 */
export function pickJableResult(results: JableResult[], code: string): JableResult | null {
  const key = (s: string): string => alnum(s).replace(/^FC2PPV/, "FC2");
  const want = key(code);
  if (!want) return null;
  let best: JableResult | null = null;
  let bestRank = Number.POSITIVE_INFINITY;
  for (const result of results) {
    const got = key(result.slug);
    const rank = got === want ? 0 : got.startsWith(want) && /^[A-Z]/.test(got.slice(want.length)) ? 1 : -1;
    if (rank >= 0 && rank < bestRank) {
      best = result;
      bestRank = rank;
    }
  }
  return best;
}

/** Jable 播放页里的 HLS 地址：`var hlsUrl = '…m3u8'`。 */
export function parseJableHls(html: string): string | null {
  return /hlsUrl\s*=\s*'([^']*)'/.exec(html)?.[1] || null;
}

/**
 * 在 Missav 页面源码里找 HLS 清单，只当 web 视图轮询失败后的兜底。
 * 两种写法都是社区里公开的做法（明文地址 / packed 参数倒序拼 uuid），没有在设备上验证过，
 * 站点一改就会落空——落空返回 null，不影响主路径。
 */
export function findMissavHls(html: string): string | null {
  const direct = /https?:\/\/[a-z0-9.-]+\/[0-9a-f-]{36}\/(?:playlist|video)\.m3u8/i.exec(html)?.[0];
  if (direct) return direct;
  // packed 形式：m3u8|<uuid 分段，倒序>|com|<域名>|https|video…，拼回去
  const packed = /m3u8\|((?:[0-9a-f]+\|){4}[0-9a-f]+)\|(com|net|org|cc|me)\|([a-z0-9]+)\|https/i.exec(html);
  if (packed) {
    const uuid = packed[1].split("|").reverse().join("-");
    return `https://${packed[3]}.${packed[2]}/${uuid}/playlist.m3u8`;
  }
  return null;
}
