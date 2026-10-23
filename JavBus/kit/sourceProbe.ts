// 详情页探测片源的带诊断版本：MissAV 预览、Jable 搜索、Jable 完整视频地址。每一步通过 report 交出去（core/sourceDiag.ts 的 createTracker 收），
// 取不到时写明原因。MissAV 完整视频在 kit/missav.ts（同样带 report）。首页搜索那边还用 kit/previews.ts 里原来的 findJable / findMissavPreview，没动。
//
// Jable 的取法：先用普通请求（快，网络干净时一两秒），被 Cloudflare 的验证页挡住（403 / 「Just a moment...」）才改用浏览器内核（WebScraper，
// 能跑验证页里的 JS）。Jable 的页面一直躲在 Cloudflare 后面，原来只有普通请求，一被挡就等于「没有这部片」——用户反馈大部分片没有完整版，
// 在这台机器上两个站的页面都是验证页（8 种 UA / 大小写组合全部 403）。浏览器内核能不能过验证、要多久，没有在真机上验证过，诊断里会写。
// 搜索结果也不再无脑拿第一条：对不上番号的算「没有」（见 core/parse.ts 的 pickJableResult）。
//
// 网络和浏览器内核都放在 deps 里：自测用假的换进去，覆盖「直接取到 / 被拦后浏览器内核取到 / 浏览器内核也被拦 / 超时」这些分支。

import { parseJableHls, parseJableResults, pickJableResult, type JableSearch } from "../core/parse";
import { describeScrapeFailure, isChallengePage, type Reporter } from "../core/sourceDiag";
import { describeError, getText } from "./http";
import { missavPreviewUrl } from "./previews";

export interface ScrapeResult {
  ok: boolean;
  html?: string;
  error?: { code?: string; message?: string };
  /** 是我们这边的兜底计时先到、取消了它。 */
  timedOut?: boolean;
  /** 根本没去加载：请求方已经离开详情页（stale），或者刚失败过、冷却期内不再试（cooldown）；原因在 error.message。 */
  skipped?: "stale" | "cooldown";
}

export interface ProbeDeps {
  fetchText(url: string, timeoutSec: number): Promise<{ text: string; status: number }>;
  /** 用浏览器内核加载，等到页面里出现 waitSelector 才算加载完（验证页里没有它，所以验证没过会一直等到超时）。isStale 为真就别去加载了。 */
  scrape(url: string, waitSelector: string, isStale?: () => boolean): Promise<ScrapeResult>;
  /** 只要前两个字节：状态码和内容类型。 */
  head(url: string): Promise<{ status: number; type: string }>;
}

/**
 * 交给 WebScraper 的 timeout，数值是毫秒。WebScraper 的 timeout 单位文档里前后写得不一致（英文版写秒、中文版有的地方写毫秒），没法确定，
 * 所以真正管用的是下面自己的计时（SCRAPE_GUARD_MS）：到点我们自己取消并交出结果，不指望它的 timeout。
 * 数值取毫秒是因为猜错的代价不对称：是秒的话 25000 只是等于没设（有自己的计时兜着），是毫秒的话传 25 会 25 毫秒就超时、永远取不到。
 */
const SCRAPE_TIMEOUT_MS = 25_000;
/** 浏览器内核最多等多久（毫秒）：到点取消、不管它有没有回话都交出「超时」。 */
const SCRAPE_GUARD_MS = 30_000;
/** 浏览器内核失败后多久之内不再试（毫秒）：网络真被拦的时候，每进一个详情页都白等 30 秒、还一个个排队，没意义；过了这段时间再进详情页会重试。 */
const SCRAPE_COOLDOWN_MS = 120_000;
let scrapeSeq = 0;

function loadWithGuard(url: string, waitSelector: string, guardMs: number): Promise<ScrapeResult> {
  const taskId = `javbus-scrape-${Date.now()}-${++scrapeSeq}`;
  return new Promise((resolve) => {
    let settled = false;
    const settle = (result: ScrapeResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      Promise.resolve()
        .then(() => WebScraper.cancel(taskId))
        .catch(() => undefined);
      settle({ ok: false, timedOut: true });
    }, guardMs);
    WebScraper.load({ url, wait: { mode: "selector", selector: waitSelector }, timeout: SCRAPE_TIMEOUT_MS, taskId }).then(
      (result) => settle({ ok: result.ok, html: result.html, error: result.error }),
      (error) => settle({ ok: false, error: { message: describeError(error) } }),
    );
  });
}

/**
 * 浏览器内核的加载入口：一次只跑一个（隐藏网页视图吃内存，连点几个详情页不能同时开好几个）；轮到它时请求方已经走了就不加载；
 * 失败后冷却一阵不再试；自己计时兜底。参数只给自测缩短时间用。
 */
export function createScraper(options: { guardMs?: number; cooldownMs?: number; now?: () => number } = {}): ProbeDeps["scrape"] {
  const guardMs = options.guardMs ?? SCRAPE_GUARD_MS;
  const cooldownMs = options.cooldownMs ?? SCRAPE_COOLDOWN_MS;
  const now = options.now ?? Date.now;
  let queue: Promise<unknown> = Promise.resolve();
  let failure: { at: number; reason: string } | null = null;

  const run = async (url: string, waitSelector: string, isStale?: () => boolean): Promise<ScrapeResult> => {
    if (isStale?.()) return { ok: false, skipped: "stale", error: { message: "你已经离开详情页，没有再用浏览器内核" } };
    if (failure && now() - failure.at < cooldownMs) {
      const ago = Math.round((now() - failure.at) / 1000);
      return {
        ok: false,
        skipped: "cooldown",
        error: { message: `${ago} 秒前浏览器内核刚失败过（${failure.reason}），${Math.round(cooldownMs / 60_000)} 分钟内不再重试` },
      };
    }
    const result = await loadWithGuard(url, waitSelector, guardMs);
    failure = result.ok && result.html ? null : { at: now(), reason: describeScrapeFailure(result.error, result.timedOut) };
    return result;
  };

  return (url, waitSelector, isStale) => {
    const job = queue.then(() => run(url, waitSelector, isStale));
    queue = job.catch(() => undefined);
    return job;
  };
}

export const defaultProbeDeps: ProbeDeps = {
  fetchText: (url, timeoutSec) => getText(url, { timeout: timeoutSec }),
  scrape: createScraper(),
  head: async (url) => {
    const res = await fetch(url, { headers: { Range: "bytes=0-1" }, timeout: 6 });
    return { status: res.status, type: (res.headers.get("content-type") ?? "").toLowerCase() };
  },
};

/** Jable 每个真页面都有的元素（`<footer id="site-footer">`，Wayback 里的真实页面核过）：验证页没有，拿它判断「真页面出来了」。 */
const JABLE_READY = "#site-footer";

/** 先直接请求，被拦再用浏览器内核。成功给 html 和一句说明（是不是浏览器内核取的）；失败给原因，missing = 站点明确说没有这个页面（404）。 */
async function fetchPage(
  url: string,
  label: string,
  deps: ProbeDeps,
  report: Reporter,
  isStale?: () => boolean,
): Promise<{ html: string; note: string } | { reason: string; missing?: boolean }> {
  report({ step: `${label}：直接请求` });
  let blocked: string;
  try {
    const { text, status } = await deps.fetchText(url, 10);
    if (status === 404) return { reason: "HTTP 404（站点上没有这个页面）", missing: true };
    if (status === 200 && !isChallengePage(text)) return { html: text, note: "" };
    blocked = isChallengePage(text) ? "Cloudflare 验证页" : `HTTP ${status}`;
  } catch (error) {
    blocked = describeError(error);
  }
  report({ step: `${label}：直接请求不行（${blocked}），改用浏览器内核`, detail: `直接请求：${blocked}` });
  const scraped = await deps.scrape(url, JABLE_READY, isStale);
  if (scraped.skipped === "stale") return { reason: scraped.error?.message ?? "已经离开详情页", missing: true };
  if (scraped.skipped === "cooldown") return { reason: `直接请求：${blocked}；${scraped.error?.message ?? "冷却中"}` };
  if (!scraped.ok || !scraped.html) return { reason: `直接请求：${blocked}；${describeScrapeFailure(scraped.error, scraped.timedOut)}` };
  if (isChallengePage(scraped.html)) return { reason: `直接请求：${blocked}；浏览器内核拿到的还是 Cloudflare 验证页` };
  return { html: scraped.html, note: `直接请求不行（${blocked}），浏览器内核取到了` };
}

/** Jable 搜索：命中返回播放页和预览；没有、搜不到对得上番号的、被拦、超时都返回 null，原因写在诊断里。 */
export async function traceFindJable(
  code: string,
  report: Reporter,
  deps: ProbeDeps = defaultProbeDeps,
  isStale?: () => boolean,
): Promise<JableSearch | null> {
  const page = await fetchPage(`https://jable.tv/search/${encodeURIComponent(code)}/`, "搜索页", deps, report, isStale);
  if ("reason" in page) {
    report({ state: page.missing ? "none" : "failed", detail: page.reason });
    return null;
  }
  report({ step: "解析搜索结果" });
  const via = page.note ? `；${page.note}` : "";
  const results = parseJableResults(page.html);
  if (results.length === 0) {
    report({ state: "none", detail: `搜索结果是空的（Jable 上没有这个番号）${via}` });
    return null;
  }
  const picked = pickJableResult(results, code);
  if (!picked) {
    report({ state: "none", detail: `搜到 ${results.length} 条，但没有番号对得上的（第一条是 ${results[0].slug}）${via}` });
    return null;
  }
  report({ detail: `命中 ${picked.slug}${via}` });
  return { videoUrl: picked.videoUrl, preview: picked.preview };
}

/** Jable 播放页里的 HLS 地址。 */
export async function traceFindJableHls(
  videoUrl: string,
  report: Reporter,
  deps: ProbeDeps = defaultProbeDeps,
  isStale?: () => boolean,
): Promise<string | null> {
  const page = await fetchPage(videoUrl, "播放页", deps, report, isStale);
  if ("reason" in page) {
    report({ state: page.missing ? "none" : "failed", detail: page.reason });
    return null;
  }
  report({ step: "从播放页里找 hlsUrl" });
  const via = page.note ? `；${page.note}` : "";
  const hls = parseJableHls(page.html);
  if (!hls) {
    report({ state: "failed", detail: `播放页里没有 hlsUrl（页面改版、要登录，或者这部不能在线看）${via}` });
    return null;
  }
  if (page.note) report({ detail: page.note });
  return hls;
}

/** MissAV 预览（fourhoi 上的 preview.mp4）：200 / 206 且不是网页就算有，404 是「没有」，其它状态码算失败。 */
export async function traceFindMissavPreview(code: string, report: Reporter, deps: ProbeDeps = defaultProbeDeps): Promise<string | null> {
  const url = missavPreviewUrl(code);
  report({ step: "请求 fourhoi 上的预览" });
  try {
    const { status, type } = await deps.head(url);
    if ((status === 200 || status === 206) && !type.includes("text/html")) return url;
    report({ state: status === 404 ? "none" : "failed", detail: `HTTP ${status}${type ? `（${type.split(";")[0]}）` : ""}` });
    return null;
  } catch (error) {
    report({ state: "failed", detail: describeError(error) });
    return null;
  }
}
