// MovieRef 的各种来路，以及收藏时要存的那条记录。

import { FALLBACK_THUMB, UNKNOWN_DATE } from "./constants";
import { shortCodeOf } from "./keyword";
import { movieUrl, thumbFromCover } from "./site";
import type { DetailContext, FavMovie, MovieDetail, MovieItem, MovieRef, RecItem } from "./types";

export function refFromItem(item: MovieItem, context: DetailContext = "browse"): MovieRef {
  return { link: item.link, code: item.code, cover: item.cover, info: `${item.code} | ${item.date}`, context };
}

export function refFromRec(rec: RecItem): MovieRef {
  return { link: rec.link, code: rec.code, cover: rec.src, info: rec.info, context: "recommend" };
}

/** 收藏 / 归档里的条目。旧数据没有 link：用 shortCode 拼，标记成「猜的」。存着兜底封面的是兜底详情。 */
export function refFromFav(fav: FavMovie, context: DetailContext): MovieRef {
  return {
    link: fav.link ?? movieUrl(fav.shortCode),
    code: fav.code,
    cover: fav.src,
    info: fav.info,
    context,
    guessed: !fav.link,
    fallback: fav.src === FALLBACK_THUMB,
  };
}

/** 只知道番号（URL scheme / 剪贴板直开）。 */
export function refFromCode(code: string): MovieRef {
  return { link: movieUrl(code), code, cover: "", info: code, context: "browse", guessed: true };
}

/**
 * 搜不到 JavBus 条目、但别的站有片源时的兜底详情。原版 9.2：番号统一大写（库里的番号都是大写，
 * 收藏时才不会和别的条目对不上），日期未知写 0000-00-00。
 */
export function fallbackRef(code: string, date: string = UNKNOWN_DATE): MovieRef {
  const upper = code.toUpperCase();
  return {
    link: "",
    code: upper,
    cover: FALLBACK_THUMB,
    info: `${upper} | ${date}`,
    context: "browse",
    fallback: true,
  };
}

/** 详情页点收藏 / 归档时要存的那条记录。日期以详情页为准（推荐列表里的日期是收藏日，不是上映日）。 */
export function favMovieOf(ref: MovieRef, detail: MovieDetail | null): FavMovie {
  const code = ref.code || detail?.code || "";
  const date = detail?.date;
  const movie: FavMovie = {
    code,
    src: ref.cover || thumbFromCover(detail?.cover ?? ""),
    info: date ? `${code} | ${date}` : ref.info || code,
    shortCode: ref.fallback ? code : shortCodeOf(ref.link),
  };
  // 链接以详情页实际取到的地址为准：旧收藏的链接是猜的（.com），欧美片换到 .org 才取成功时，不能把猜错的存回去
  if (!ref.fallback && (detail?.link || ref.link)) movie.link = detail?.link || ref.link;
  return movie;
}
