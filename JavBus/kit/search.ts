// 搜索：番号搜不到时自动换站重搜。
//
// 原版靠一堆全局标志（Again / Oumei / uncensored）在 getInitial 里递归实现：
// 有码搜不到 → 换无码；无码搜不到 → 换有码；欧美搜不到 → 无码 → 有码；全不中就失败。
// 这里把这个状态机摊平成「按顺序逐站试」，返回命中的那一站。

import { fallbackOrder, searchUrl } from "../core/site";
import { parseMovieList } from "../core/parse";
import type { MovieItem, SiteKind } from "../core/types";
import { getPage } from "./http";

export interface SearchHit {
  kind: SiteKind;
  /** 命中站点的第一页结果，调用方直接拿来铺列表，不用再请求一遍。 */
  items: MovieItem[];
}

/** 从 start 站开始，按回退顺序逐站搜第一页。一站都没命中返回 null；网络 / 验证错误照常抛出。 */
export async function searchAcrossKinds(keyword: string, start: SiteKind, all: boolean): Promise<SearchHit | null> {
  for (const kind of fallbackOrder(start)) {
    const res = await getPage(searchUrl(kind, keyword, 1), { all });
    const list = parseMovieList(res.html, res.url);
    if (!list.ended && !list.noResult && list.items.length > 0) return { kind, items: list.items };
  }
  return null;
}
