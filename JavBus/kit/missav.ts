// Missav 完整视频地址。
//
// 原版在详情页里挂一个隐藏 web 视图加载 `missav.ws/<番号>`（9.2 起从 .ai 换成 .ws），页面里每 200ms 查一次
// `video.player` 的 `src`（属性，不是 `currentSrc`），查到就把它通过 $notify 送回来，最长等 80 秒（9.1 是 10 秒）；
// 原版注释说 .ws 现在返回的是 HLS（.m3u8）。
// 这里同一套办法：隐藏 WebViewController 加载页面，原生侧轮询 `src`（没有再看 `currentSrc`），到点就拆掉。
//
// 和原版不同的几处：
// - 只认 http(s) 开头的地址。页面用 MSE 播放时 src 是 `blob:…`，拿它没用；
//   原版不检查，会把 blob 地址当成片源缓存下来。
// - 等得久了（80 秒），隐藏的 web 视图和排在后面的任务都被占着：所有请求方都离开了详情页，就立刻收摊。
// - 轮询落空后，退一步从页面源码里找 m3u8（parse.findMissavHls），不用再开一次页面。
// - 全局同一时刻只开一个 web 视图，同一个番号的并发请求合并，找到的地址按「番号 + 页面版本」缓存：
//   进详情页预取、点菜单现取、连着翻好几部，都不会叠出一堆隐藏的 WKWebView。
// - UA 默认用电脑版（设置里「MissAV 用电脑版页面」可关）：用户反馈电脑 UA 下 MissAV 能出 1080p、而且免费。
//   电脑版页面多半改用 hls.js + MSE 播放，video.src 变成 blob:，所以探测脚本还会去资源请求里找清单地址。
//   这条路没有在设备上验证过：取不到时关掉那个设置就回到原版的手机 UA。

import { DESKTOP_UA, MISSAV_ORIGIN, MOBILE_UA } from "../core/constants";
import { findMissavHls } from "../core/parse";
import { getSettings } from "./settings";

const POLL_INTERVAL_MS = 300;
const MAX_WAIT_MS = 80_000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * 页面里取清单地址。先看 video 的 src：手机版页面走系统原生 HLS，src 直接就是 m3u8（原版就靠这个）。
 * src 不是 http(s)（电脑版页面的 hls.js 会换成 blob:）就从资源请求里找：主清单叫 playlist.m3u8，
 * 里面有 1080p / 720p 各档，播放器自己按网速选；各档画质的子清单叫 video.m3u8，只有找不到主清单时才退而求其次。
 * 资源计时缓冲区默认只存 250 条，页面缩略图多的话清单请求会被挤掉，所以先把它放大（每轮都设，页面还没就绪的几轮不起作用）。
 */
export const PROBE_SCRIPT = `
  try { performance.setResourceTimingBufferSize(2000); } catch (e) {}
  const v = document.querySelector("video.player") || document.querySelector("video");
  const direct = v ? (v.src || v.currentSrc || "") : "";
  if (/^https?:\\/\\//i.test(direct)) return direct;
  const urls = performance.getEntriesByType("resource").map((e) => e.name).filter((n) => /\\.m3u8(\\?|$)/i.test(n));
  return urls.find((n) => /playlist\\.m3u8/i.test(n)) || urls[0] || "";
`;

/** desktop：用电脑版 UA；abandoned：所有请求方都已经离开了，不用再等。 */
async function probe(code: string, desktop: boolean, abandoned: () => boolean): Promise<string | null> {
  const web = new WebViewController({ ephemeral: true });
  try {
    web.setCustomUserAgent(desktop ? DESKTOP_UA : MOBILE_UA);
    // 不 await：页面加载完成前播放器就可能已经初始化好了，轮询并行跑
    const loading = web.loadURL(`${MISSAV_ORIGIN}/${code}`).catch(() => false);

    const deadline = Date.now() + MAX_WAIT_MS;
    while (Date.now() < deadline) {
      await sleep(POLL_INTERVAL_MS);
      if (abandoned()) return null;
      try {
        const src = await web.evaluateJavaScript<string>(PROBE_SCRIPT);
        if (typeof src === "string" && /^https?:\/\//i.test(src)) return src;
      } catch {
        /* 页面还没就绪，下一轮再试 */
      }
    }

    await Promise.race([loading, sleep(1000)]);
    const html = await web.getHTML();
    return html ? findMissavHls(html) : null;
  } catch {
    return null;
  } finally {
    web.dispose();
  }
}

const found = new Map<string, string>();
interface Pending {
  promise: Promise<string | null>;
  /**
   * 每个请求方的「我已经离开详情页」判断。轮到这个任务时，**所有**请求方都过期了才跳过，
   * 否则离开又马上重进同一部片时，新的请求方会拿到老请求方留下的 null。
   * 点菜单的现取没有判断，登记成「永远没过期」。
   */
  stale: (() => boolean)[];
}
const pending = new Map<string, Pending>();
let tail: Promise<unknown> = Promise.resolve();

/**
 * 找得到返回 HLS 地址，找不到（超时、站点打不开、被挑战页挡住）返回 null。找不到的不缓存，下次还会再试。
 * isStale 只给后台预取用；用户点菜单的现取不传，并且会让已排队的预取不再被跳过。
 */
export function resolveMissavStream(code: string, isStale?: () => boolean): Promise<string | null> {
  // 缓存和合并都按「番号 + 用哪种页面」记：在设置里切了电脑版 / 手机版以后，下一次取就是新的，不会拿到上一种的缓存
  const desktop = getSettings().missavDesktop;
  const key = `${desktop ? "desktop" : "mobile"}:${code}`;
  const hit = found.get(key);
  if (hit) return Promise.resolve(hit);
  const running = pending.get(key);
  if (running) {
    running.stale.push(isStale ?? (() => false));
    return running.promise;
  }

  const entry: Pending = { promise: Promise.resolve(null), stale: [isStale ?? (() => false)] };
  entry.promise = tail.then(async () => {
    const again = found.get(key); // 排队期间别人可能已经找到了
    if (again) return again;
    if (entry.stale.every((isGone) => isGone())) return null;
    const url = await probe(code, desktop, () => entry.stale.every((isGone) => isGone()));
    if (url) found.set(key, url);
    return url;
  });
  tail = entry.promise.catch(() => undefined);
  pending.set(key, entry);
  void entry.promise.finally(() => pending.delete(key));
  return entry.promise;
}
