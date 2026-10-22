// 预览与外部片源：Fanza 预告、MissAV 预览（fourhoi）、Jable、JavDB 评分。
//
// 原版的几个探测都是「发请求、看有没有东西」，这里一一对应：
// - fourhoi：原版 GET 整个 mp4、看 `data.info` 在不在；这里改成只请求前两个字节
// - Jable：搜索页 → 取第一部的预览与播放页 → 播放页里抠 hlsUrl
// - Fanza：不探测，直接按番号规则拼地址

import {
  isJavdbBlocked,
  parseJableHls,
  parseJableSearch,
  parseJavdbCards,
  parseScoreText,
  pickJavdbRating,
  type JableSearch,
  type JavdbCard,
} from "../core/parse";
import { describeError, getText } from "./http";

/**
 * Fanza 免费预告：番号小写、`-` 换成 `00`（`ssis-123` → `ssis00123`），
 * 路径是 `freepv/<首字母>/<前三位>/<cid>/<cid>_sm_w.mp4`。原版同一规则，对带前缀数字的 cid 不一定命中。
 */
export function fanzaPreviewUrl(code: string): string {
  const cid = code.toLowerCase().replace("-", "00");
  return `https://cc3001.dmm.co.jp/litevideo/freepv/${cid.slice(0, 1)}/${cid.slice(0, 3)}/${cid}/${cid}_sm_w.mp4`;
}

export function missavPreviewUrl(code: string): string {
  return `https://fourhoi.com/${code.toLowerCase()}/preview.mp4`;
}

/** 地址是不是真的有视频：只要前两个字节，状态 200/206 且不是 HTML 就算有。 */
export async function probeVideo(url: string, timeoutSec = 6): Promise<boolean> {
  try {
    const res = await fetch(url, { headers: { Range: "bytes=0-1" }, timeout: timeoutSec });
    if (res.status !== 200 && res.status !== 206) return false;
    const type = (res.headers.get("content-type") ?? "").toLowerCase();
    return !type.includes("text/html");
  } catch {
    return false;
  }
}

/** MissAV 预览：有就返回地址，没有 null。 */
export async function findMissavPreview(code: string): Promise<string | null> {
  const url = missavPreviewUrl(code);
  return (await probeVideo(url)) ? url : null;
}

/** Jable 搜索：搜不到或站点连不上都返回 null。 */
export async function findJable(code: string): Promise<JableSearch | null> {
  try {
    const { text } = await getText(`https://jable.tv/search/${encodeURIComponent(code)}/`);
    return parseJableSearch(text);
  } catch {
    return null;
  }
}

/** Jable 完整视频的 m3u8（播放页里的 hlsUrl）。 */
export async function findJableHls(videoUrl: string): Promise<string | null> {
  try {
    const { text } = await getText(videoUrl);
    return parseJableHls(text);
  } catch {
    return null;
  }
}

/**
 * JavDB 评分的三种结果。原版把「没有评分」和「请求失败」都显示成 N/A，用户分不清是这部片没评分
 * 还是网络 / 站点出了问题，所以这里分开：failed 带原因，界面会写出来。
 */
export type RatingState =
  | { kind: "ok"; score: string; count: string }
  | { kind: "none" }
  | { kind: "failed"; reason: string };

/** JavDB 把这个 IP 屏蔽了的失败原因（评分胶囊上会写出来）。 */
const JAVDB_BLOCKED = "IP 被 JavDB 屏蔽";

function ratingFrom(cards: JavdbCard[], code: string): RatingState {
  const rating = pickJavdbRating(cards, code);
  return rating ? { kind: "ok", ...rating } : { kind: "none" };
}

async function ratingViaFetch(url: string, code: string): Promise<RatingState> {
  try {
    const { text, status } = await getText(url, {
      headers: { "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.8" },
      timeout: 12,
    });
    if (status !== 200) return { kind: "failed", reason: `HTTP ${status}` };
    if (isJavdbBlocked(text)) return { kind: "failed", reason: JAVDB_BLOCKED };
    const cards = parseJavdbCards(text);
    if (cards.length > 0) return ratingFrom(cards, code);
    // 没有卡片：正常的「没有搜索结果」页是 JavDB 自己的页面，挑战页 / 登录页不是
    return /<title>[^<]*JavDB/i.test(text)
      ? { kind: "none" }
      : { kind: "failed", reason: "返回的不是 JavDB 搜索页，可能被拦截" };
  } catch (error) {
    return { kind: "failed", reason: describeError(error) };
  }
}

/** 浏览器兜底取评分的等待上限（毫秒）。 */
const BROWSER_TIMEOUT_MS = 20_000;

/** 兜底：用真浏览器内核加载（能过 Cloudflare 的 JS 挑战），直接从 DOM 里取每张卡片的番号和评分文字。 */
async function ratingViaBrowser(url: string, code: string): Promise<RatingState | null> {
  const taskId = `javbus-rating-${Date.now()}`;
  // WebScraper 的 timeout 单位文档里前后写得不一致，自己再兜一层
  const timer = setTimeout(() => void WebScraper.cancel(taskId), BROWSER_TIMEOUT_MS + 5000);
  try {
    const result = await WebScraper.scrape<{ code: string; text: string }[]>({
      url,
      wait: { mode: "selector", selector: ".movie-list .item" },
      timeout: BROWSER_TIMEOUT_MS,
      taskId,
      extractScript:
        'return Array.from(document.querySelectorAll(".movie-list .item")).map(function (el) {' +
        ' var t = el.querySelector(".video-title strong"); var s = el.querySelector(".score");' +
        ' return { code: t ? t.innerText : "", text: s ? s.innerText : "" }; })',
    });
    if (!result.ok || !Array.isArray(result.data)) return null;
    const cards = result.data.map((d) => ({ code: d.code.trim(), rating: parseScoreText(d.text) }));
    return ratingFrom(cards, code);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** JavDB 评分：先直接请求；被拦或失败再用浏览器内核兜底；都不行就带着第一次的失败原因返回。 */
export async function findJavdbRating(code: string): Promise<RatingState> {
  const url = `https://javdb.com/search?q=${encodeURIComponent(code)}&f=all`;
  const fast = await ratingViaFetch(url, code);
  if (fast.kind !== "failed") return fast;
  // 被屏蔽的是这个 IP，浏览器内核走同一个出口，再试也一样，别白等
  if (fast.reason === JAVDB_BLOCKED) return fast;
  return (await ratingViaBrowser(url, code)) ?? fast;
}
