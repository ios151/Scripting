// 磁链获取。
//
// JavBus 的磁链表是页面脚本异步补上的：
//   $.get("../ajax/uncledatoolsbyajax.php?gid=<gid>&lang=<lang>&img=<img>&uc=<uc>&floor=<随机>")
//   → 响应是一串 <tr>，append 进 #magnet-table
// （脚本在 /js/gallery.js 末尾，gid / uc / img / lang 是详情页内联脚本里的四个 var）
//
// 原版用隐藏 web 视图加载详情页，拦下页面发出的这个请求，再在页面里重发一遍取响应。
// Scripting 的 WebViewController 拦不到子请求，所以：
//  1. 快路径：直接 fetch 同一个地址（带上详情页当 Referer 和 X-Requested-With）
//  2. 兜底：快路径网络失败、或响应非空却一行磁链都解析不出来（多半是被挑战页挡了）时，
//     用 WebScraper 真加载详情页，等 #magnet-table 里出现磁链再取表。
//     响应本身为空是「确实没有磁链」，不走兜底——等 selector 要白等到超时。

import { parseMagnets } from "../core/parse";
import type { Magnet, MagnetParams } from "../core/types";
import { absorb } from "./cookies";
import { siteHeaders } from "./http";

const FALLBACK_TIMEOUT_MS = 20_000;

function originOf(url: string): string {
  return /^[a-z]+:\/\/[^/?#]+/i.exec(url)?.[0] ?? "";
}

export function magnetAjaxUrl(detailUrl: string, p: MagnetParams): string {
  const floor = Math.floor(Math.random() * 1000 + 1);
  return `${originOf(detailUrl)}/ajax/uncledatoolsbyajax.php?gid=${p.gid}&lang=${p.lang}&img=${encodeURI(p.img)}&uc=${p.uc}&floor=${floor}`;
}

async function viaAjax(detailUrl: string, params: MagnetParams): Promise<{ magnets: Magnet[]; suspicious: boolean }> {
  const url = magnetAjaxUrl(detailUrl, params);
  const res = await fetch(url, {
    headers: { ...siteHeaders(url, { referer: detailUrl }), "X-Requested-With": "XMLHttpRequest" },
    timeout: 15,
  });
  absorb(res.cookies);
  const text = await res.text();
  const magnets = parseMagnets(text);
  return { magnets, suspicious: magnets.length === 0 && text.trim().length > 0 };
}

async function viaScraper(detailUrl: string): Promise<Magnet[]> {
  // WebScraper 的 timeout 单位文档里前后写得不一致（毫秒 / 秒），所以自己再兜一层，到点主动取消
  const taskId = `javbus-magnet-${Date.now()}`;
  const timer = setTimeout(() => void WebScraper.cancel(taskId), FALLBACK_TIMEOUT_MS + 5000);
  let result: Awaited<ReturnType<typeof WebScraper.scrape<string>>>;
  try {
    result = await WebScraper.scrape<string>({
      url: detailUrl,
      wait: { mode: "selector", selector: '#magnet-table a[href^="magnet:"]' },
      timeout: FALLBACK_TIMEOUT_MS,
      taskId,
      extractScript: 'const t = document.querySelector("#magnet-table"); return t ? t.outerHTML : "";',
    });
  } finally {
    clearTimeout(timer);
  }
  if (result.ok) return typeof result.data === "string" ? parseMagnets(result.data) : [];
  // 等 selector 超时 = 页面正常、只是没有磁链；其他错误才是真失败
  if (result.error?.code === "TIMEOUT") return [];
  throw new Error(`取磁链失败：${result.error?.message ?? "未知错误"}`);
}

/**
 * 取一部影片的磁链。拿不到详情页里的 gid（页面结构变了）也直接走兜底。
 * 失败时抛错由调用方显示——「暂无磁链」和「取失败」是两回事，别混成同一句。
 */
export async function fetchMagnets(detailUrl: string, params: MagnetParams | null): Promise<Magnet[]> {
  if (params) {
    try {
      const { magnets, suspicious } = await viaAjax(detailUrl, params);
      if (magnets.length > 0 || !suspicious) return magnets;
    } catch {
      /* 落到兜底 */
    }
  }
  return viaScraper(detailUrl);
}

// 详情页打开时就在后台取一遍（原版 JavMag 标志），点「磁链」时直接用；
// 缓存的是 Promise：取到一半点进去不会重复请求，失败的不缓存，下次点还能重取。
const cache = new Map<string, Promise<Magnet[]>>();

export function loadMagnets(detailUrl: string, params: MagnetParams | null, force = false): Promise<Magnet[]> {
  if (!force) {
    const hit = cache.get(detailUrl);
    if (hit) return hit;
  }
  const task = fetchMagnets(detailUrl, params);
  // 没有 gid 等参数时走的是 WebScraper 兜底，它的「空」可能只是超时，不能当成「确实没有磁链」缓存下来
  if (params === null) return task;
  cache.set(detailUrl, task);
  task.catch(() => {
    if (cache.get(detailUrl) === task) cache.delete(detailUrl);
  });
  return task;
}
