// 取详情页。

import { is404, parseDetail } from "../core/parse";
import type { MovieDetail, MovieRef } from "../core/types";
import { getPage } from "./http";

/** javbus.com ↔ javbus.org 互换（旧收藏没存链接、又不知道当初是从哪个站收的）。 */
function otherSite(link: string): string | null {
  if (link.includes("javbus.com")) return link.replace("javbus.com", "javbus.org");
  if (link.includes("javbus.org")) return link.replace("javbus.org", "javbus.com");
  return null;
}

async function attempt(link: string): Promise<MovieDetail | null> {
  const page = await getPage(link);
  if (is404(page.html)) return null;
  const detail = parseDetail(page.html, page.url);
  // 既没封面也没标题，说明拿到的不是影片页（站点错误页、被改版）
  return detail.cover || detail.title ? detail : null;
}

/**
 * 加载一部影片的详情。链接是猜的（旧收藏）且在这个站点 404，就换另一个站点再试一次。
 * 两边都没有抛错，让页面显示出来而不是留一个空白页。
 */
export async function loadDetail(ref: MovieRef): Promise<MovieDetail> {
  let detail = await attempt(ref.link);
  if (!detail && ref.guessed) {
    const alt = otherSite(ref.link);
    if (alt) detail = await attempt(alt);
  }
  if (!detail) throw new Error("没有找到这部影片的页面");
  return detail;
}
