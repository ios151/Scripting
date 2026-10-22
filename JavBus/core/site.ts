// 站点地址的构造与归一化。页面里的相对路径、双斜杠、带 uncensored 的类目链接都在这里收拾。

import { HOMEPAGE, SITE_ORIGIN } from "./constants";
import type { NamedKind, SiteKind } from "./types";

export function homepage(kind: SiteKind): string {
  return HOMEPAGE[kind];
}

/** 最新列表：`<首页>page/<页>`（原版 `homepage + "page/"` 再拼页码）。 */
export function listUrl(kind: SiteKind, page: number): string {
  return `${HOMEPAGE[kind]}page/${page}`;
}

/**
 * 搜索：`<首页>search/<关键词>/<页>`。关键词按原版 9.2 的写法：`encodeURIComponent`，空格换成 `+`
 * （中文演员名带空格、带 `&` 的词也能搜；9.1 是 `encodeURI`，那两种都会出错）。
 */
export function searchUrl(kind: SiteKind, keyword: string, page: number): string {
  return `${HOMEPAGE[kind]}search/${encodeURIComponent(keyword).replace(/%20/g, "+")}/${page}`;
}

/** 演员列表只有有码 / 无码两套。 */
export function actressListUrl(kind: Exclude<SiteKind, "western">, page: number): string {
  return kind === "uncensored"
    ? `${SITE_ORIGIN}/uncensored/actresses/${page}`
    : `${SITE_ORIGIN}/actresses/${page}`;
}

export function genreIndexUrl(kind: Exclude<SiteKind, "western">): string {
  return kind === "uncensored" ? `${SITE_ORIGIN}/uncensored/genre` : `${SITE_ORIGIN}/genre`;
}

/** 类目 / 演员作品的翻页：`<链接>/<页>`。 */
export function pagedUrl(base: string, page: number): string {
  return `${base.replace(/\/+$/, "")}/${page}`;
}

/** 站点上详情页的默认地址（只知道番号时用）。 */
export function movieUrl(code: string, kind: SiteKind = "censored"): string {
  return `${kind === "western" ? HOMEPAGE.western : `${SITE_ORIGIN}/`}${code}`;
}

/**
 * 相对地址 → 绝对地址。列表里图片是 `/imgs/thumbs/xx.jpg`，原版直接拼在首页后面，
 * 无码首页是 `.../uncensored/`，拼出来会多一层目录；这里一律按页面所在域名解析。
 */
export function resolveUrl(href: string, base: string): string {
  const value = href.trim();
  if (!value) return "";
  try {
    return new URL(value, base).toString();
  } catch {
    return value;
  }
}

/** 链接是不是无码来源（原版靠 `indexOf("uncensored")` 判断）。 */
export function isUncensoredLink(link: string): boolean {
  return link.includes("uncensored");
}

/** 类目在站点上的路径段：制作商是 studio，发行商是 label（其余同名）。 */
const NAMED_PATH: Record<NamedKind, string> = {
  director: "director",
  series: "series",
  filmMaker: "studio",
  filmEstab: "label",
};

/**
 * 收藏里存的类目只有 shortCode（无码来源带 `/uncensored` 后缀），这里还原成链接。
 * 原版逐个类目复制粘贴了这段逻辑，这里合成一处。
 */
export function namedLink(kind: NamedKind, shortCode: string): string {
  const uncensored = shortCode.includes("uncensored");
  const code = shortCode.replace("/uncensored", "");
  const root = uncensored ? `${SITE_ORIGIN}/uncensored/` : `${SITE_ORIGIN}/`;
  return `${root}${NAMED_PATH[kind]}/${code}`;
}

/** 点开类目时算出要存进收藏的 shortCode：链接最后一段，无码来源补 `/uncensored`。 */
export function namedShortCode(link: string): string {
  const last = link.split("/").pop() ?? "";
  return isUncensoredLink(link) ? `${last}/uncensored` : last;
}

/** 演员收藏的链接：`https://www.javbus.com/<un>star/<shortCode>`。 */
export function starLink(shortCode: string, un: string): string {
  return `${SITE_ORIGIN}/${un}star/${shortCode}`;
}

/** 链接所在的分区，推导「用哪个域名的 Referer / 解析相对地址」。 */
export function kindOfLink(link: string): SiteKind {
  if (link.includes("javbus.org")) return "western";
  if (isUncensoredLink(link)) return "uncensored";
  return "censored";
}

/**
 * 从封面大图反推列表缩略图。只在「只知道番号、没走列表」的路径里用（收藏时要存一张封面），
 * 反推不出来就原样返回大图。
 */
export function thumbFromCover(cover: string): string {
  const m = /\/pics\/cover\/([^/]+?)_b\.jpg$/i.exec(cover);
  if (m) return cover.replace(/\/pics\/cover\/[^/]+$/, `/pics/thumb/${m[1]}.jpg`);
  const u = /\/imgs\/cover\/([^/]+?)_b\.jpg$/i.exec(cover);
  if (u) return cover.replace(/\/imgs\/cover\/[^/]+$/, `/imgs/thumbs/${u[1]}.jpg`);
  return cover;
}

/**
 * 从列表缩略图推详情页的大封面（thumbFromCover 的反向）。缩略图只有 147×200，铺到详情页的海报上会放大 2.5 倍、糊得厉害；
 * 大封面 800×538。进详情页时详情 HTML 还没回来，先拿推出来的地址去载大图，不用等详情。
 * 推出来的地址不保证存在（调用方要留着缩略图垫底）；推不出来（已经是大图、欧美站的图床规则不一样）返回空串。
 */
export function coverFromThumb(thumb: string): string {
  const m = /\/pics\/thumb\/([^/]+?)\.jpg$/i.exec(thumb);
  if (m) return thumb.replace(/\/pics\/thumb\/[^/]+$/, `/pics/cover/${m[1]}_b.jpg`);
  const u = /\/imgs\/thumbs\/([^/]+?)\.jpg$/i.exec(thumb);
  if (u) return thumb.replace(/\/imgs\/thumbs\/[^/]+$/, `/imgs/cover/${u[1]}_b.jpg`);
  return "";
}

/** 这个地址本身就是大封面（`…/cover/<id>_b.jpg`）。 */
export function isBigCover(url: string): boolean {
  return /\/cover\/[^/]+_b\.jpg$/i.test(url);
}

/**
 * 搜索的回退顺序（原版 getInitial 里 Again / Oumei 状态机的展开）：
 * 有码 → 无码；无码 → 有码；欧美 → 无码 → 有码。
 */
export function fallbackOrder(start: SiteKind): SiteKind[] {
  switch (start) {
    case "censored":
      return ["censored", "uncensored"];
    case "uncensored":
      return ["uncensored", "censored"];
    default:
      return ["western", "uncensored", "censored"];
  }
}
