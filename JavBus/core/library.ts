// 收藏库：影片 / 归档 / 演员 / 导演 / 系列 / 制作商 / 发行商。
//
// 全是不可变的纯函数——传入旧库、返回新库，由 kit/store.ts 负责落盘和通知。
// 语义照原版 favoriteButtonTapped / favActressButtonTapped / favDetailTapped：
// 新收藏排最前；归档 = 从收藏里取出放进归档；归档里只能「删除」。

import { shortCodeOf } from "./keyword";
import type {
  FavActress,
  FavMovie,
  FavNamed,
  LibraryData,
  NamedKind,
} from "./types";

export function emptyLibrary(): LibraryData {
  return {
    favorite: [],
    archive: [],
    actress: [],
    director: [],
    filmMaker: [],
    filmEstab: [],
    series: [],
  };
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/**
 * 图片地址洗一遍。原版详情页里参演头像是绝对地址时，把整段 `<a>…</a>` HTML 当成地址存了下来，
 * 旧备份里的演员头像可能是这种东西：能从里面抠出 <img src> 就用，抠不出就置空（界面显示占位图）。
 */
function cleanImageSrc(raw: unknown): string {
  const value = str(raw).trim();
  if (!value.includes("<")) return value;
  return /<img[^>]*\ssrc\s*=\s*["']([^"']+)["']/i.exec(value)?.[1] ?? "";
}

function cleanMovie(raw: unknown): FavMovie | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const code = str(r.code);
  const link = str(r.link);
  const shortCode = str(r.shortCode) || (link ? shortCodeOf(link) : code);
  if (!shortCode) return null;
  const movie: FavMovie = {
    code: code || shortCode,
    src: cleanImageSrc(r.src),
    info: str(r.info) || code || shortCode,
    shortCode,
  };
  if (link) movie.link = link;
  return movie;
}

function cleanActress(raw: unknown): FavActress | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const shortCode = str(r.shortCode);
  if (!shortCode) return null;
  return {
    src: cleanImageSrc(r.src),
    info: str(r.info),
    shortCode,
    un: str(r.un) === "uncensored/" ? "uncensored/" : "",
  };
}

function cleanNamed(raw: unknown): FavNamed | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const shortCode = str(r.shortCode);
  if (!shortCode) return null;
  return { name: str(r.name) || shortCode, shortCode };
}

/** 去重（按 shortCode，保留先出现的），顺便洗掉非法条目。 */
function dedupe<T extends { shortCode: string }>(list: unknown, clean: (raw: unknown) => T | null): T[] {
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const out: T[] = [];
  for (const raw of list) {
    const item = clean(raw);
    if (!item || seen.has(item.shortCode)) continue;
    seen.add(item.shortCode);
    out.push(item);
  }
  return out;
}

/**
 * 不管数据从哪来（Storage、导入的备份、原版 JavBusBackup.json），都洗成一份合法的库：
 * 缺的数组补空，坏条目丢掉，多余字段（原版演员条目里的 `source`）去掉。
 * 原版老备份没有 series，补空数组即可。
 */
export function normalizeLibrary(raw: unknown): LibraryData {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    favorite: dedupe(r.favorite, cleanMovie),
    archive: dedupe(r.archive, cleanMovie),
    actress: dedupe(r.actress, cleanActress),
    director: dedupe(r.director, cleanNamed),
    filmMaker: dedupe(r.filmMaker, cleanNamed),
    filmEstab: dedupe(r.filmEstab, cleanNamed),
    series: dedupe(r.series, cleanNamed),
  };
}

/** 备份文件里至少要有一个已知字段，才认它是备份（防止把随便一份 JSON 当成空库导入）。 */
export function looksLikeBackup(raw: unknown): boolean {
  if (!raw || typeof raw !== "object") return false;
  const keys = ["favorite", "archive", "actress", "director", "filmMaker", "filmEstab", "series"];
  return keys.some((k) => Array.isArray((raw as Record<string, unknown>)[k]));
}

export type MovieStatus = "none" | "favorite" | "archived";

export function movieStatus(lib: LibraryData, shortCode: string): MovieStatus {
  if (lib.favorite.some((m) => m.shortCode === shortCode)) return "favorite";
  if (lib.archive.some((m) => m.shortCode === shortCode)) return "archived";
  return "none";
}

export function addFavorite(lib: LibraryData, movie: FavMovie): LibraryData {
  if (movieStatus(lib, movie.shortCode) === "favorite") return lib;
  return { ...lib, favorite: [movie, ...lib.favorite] };
}

/**
 * 取消收藏。同一部片在旧数据里可能 shortCode 和番号对不上（原版有的入口把番号当 shortCode 存），
 * 所以传了 code 就两个都认——界面上「在收藏里」的判断也是两个都查的，删除必须同样宽。
 */
export function removeFavorite(lib: LibraryData, shortCode: string, code?: string): LibraryData {
  return { ...lib, favorite: lib.favorite.filter((m) => m.shortCode !== shortCode && (!code || m.code !== code)) };
}

/** 归档：从收藏里拿掉，放进归档最前面。本来不在收藏里也行（原版推荐页就能直接归档）。 */
export function archiveMovie(lib: LibraryData, movie: FavMovie): LibraryData {
  const other = (m: FavMovie) => m.shortCode !== movie.shortCode && m.code !== movie.code;
  return { ...lib, favorite: lib.favorite.filter(other), archive: [movie, ...lib.archive.filter(other)] };
}

export function removeArchived(lib: LibraryData, shortCode: string, code?: string): LibraryData {
  return { ...lib, archive: lib.archive.filter((m) => m.shortCode !== shortCode && (!code || m.code !== code)) };
}

export function hasActress(lib: LibraryData, shortCode: string): boolean {
  return lib.actress.some((a) => a.shortCode === shortCode);
}

export function addActress(lib: LibraryData, actress: FavActress): LibraryData {
  if (hasActress(lib, actress.shortCode)) return lib;
  return { ...lib, actress: [...lib.actress, actress] };
}

export function removeActress(lib: LibraryData, shortCode: string): LibraryData {
  return { ...lib, actress: lib.actress.filter((a) => a.shortCode !== shortCode) };
}

export function hasNamed(lib: LibraryData, kind: NamedKind, shortCode: string): boolean {
  return lib[kind].some((n) => n.shortCode === shortCode);
}

export function addNamed(lib: LibraryData, kind: NamedKind, item: FavNamed): LibraryData {
  if (hasNamed(lib, kind, item.shortCode)) return lib;
  return { ...lib, [kind]: [...lib[kind], item] };
}

export function removeNamed(lib: LibraryData, kind: NamedKind, shortCode: string): LibraryData {
  return { ...lib, [kind]: lib[kind].filter((n) => n.shortCode !== shortCode) };
}

/**
 * 导入合并：已有的原样保留，备份里没见过的追加在后面（新收藏排最前的习惯不被老数据挤下去）。
 * 电影还要跨表去重：同一部在本机已归档、备份里却在收藏，以本机为准，不重复收录。
 */
export function mergeLibrary(current: LibraryData, incoming: LibraryData): LibraryData {
  const knownMovies = new Set([...current.favorite, ...current.archive].map((m) => m.shortCode));
  const extend = <T extends { shortCode: string }>(base: T[], extra: T[], skip?: Set<string>): T[] => {
    const have = new Set(base.map((x) => x.shortCode));
    return [...base, ...extra.filter((x) => !have.has(x.shortCode) && !skip?.has(x.shortCode))];
  };
  return {
    favorite: extend(current.favorite, incoming.favorite, knownMovies),
    archive: extend(current.archive, incoming.archive, knownMovies),
    actress: extend(current.actress, incoming.actress),
    director: extend(current.director, incoming.director),
    filmMaker: extend(current.filmMaker, incoming.filmMaker),
    filmEstab: extend(current.filmEstab, incoming.filmEstab),
    series: extend(current.series, incoming.series),
  };
}

/** 各表条数，设置页和导入结果提示用。 */
export function libraryCounts(lib: LibraryData): Record<keyof LibraryData, number> {
  return {
    favorite: lib.favorite.length,
    archive: lib.archive.length,
    actress: lib.actress.length,
    director: lib.director.length,
    filmMaker: lib.filmMaker.length,
    filmEstab: lib.filmEstab.length,
    series: lib.series.length,
  };
}
