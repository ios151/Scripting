// 离线自测：片源诊断和 Jable 的取法。
//   npx -y -p tsx tsx _selftest/javbus-sources.test.ts
//
// 覆盖：core/sourceDiag.ts（验证页识别、状态汇总、诊断文字、登记探测的 createTracker）、
// core/parse.ts 的 Jable 搜索结果解析和「挑对得上番号的那一条」、
// kit/sourceProbe.ts 的探测流程（网络和浏览器内核换成假的：直接取到 / 被拦后浏览器内核取到 / 浏览器内核也被拦 / 超时 / 404 / 对不上番号 ……）。
// Jable 的卡片和搜索页的写法照 2026-10-23 从 Wayback 取到的真实搜索页（卡片 `video-img-box`、`data-preview`、`<footer id="site-footer">`）。
// 不验证的：真机上浏览器内核能不能过 Cloudflare 验证、要多久——这些只能在真机上看，诊断弹窗就是为了看这个。

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseJableResults, pickJableResult } from "../JavBus/core/parse";
import {
  SOURCE_NAMES,
  SOURCE_ORDER,
  createTracker,
  describeScrapeFailure,
  formatDiagnostics,
  formatSeconds,
  fullVideoStatus,
  isChallengePage,
  isChallengeTitle,
  missavPageUrl,
  stateText,
  titleOf,
  type Board,
  type DiagEntry,
} from "../JavBus/core/sourceDiag";
import { createScraper, traceFindJable, traceFindJableHls, traceFindMissavPreview, type ProbeDeps, type ScrapeResult } from "../JavBus/kit/sourceProbe";

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ———— 夹具 ————

const card = (slug: string, title: string) => `<div class="col-6 col-sm-4 col-lg-3">
<div class="video-img-box mb-e-20">
<div class="img-box cover-md">
<a href="https://jable.tv/videos/${slug}/">
<img class="lazyload" src="https://assets-cdn.jable.tv/assets/images/placeholder-md.jpg" data-src="https://assets-cdn.jable.tv/contents/videos_screenshots/0/10/320x180/1.jpg" data-preview="https://assets-cdn.jable.tv/contents/videos_screenshots/0/10/${slug}_preview.mp4">
</a>
</div>
<div class="detail">
<h6 class="title"><a href="https://jable.tv/videos/${slug}/">${title}</a></h6>
</div>
</div>
</div>`;

const searchPage = (cards: string[], total = cards.length) =>
  `<html><head><title>搜尋結果 - Jable.TV</title></head><body><header id="site-header"></header><h4>${total} 部影片</h4>\n${cards.join("\n")}\n<footer id="site-footer"></footer></body></html>`;

const playPage = (hls: string | null) =>
  `<html><head><title>某片 - Jable.TV</title></head><body><header id="site-header"></header>${hls ? `<script>var hlsUrl = '${hls}';</script>` : ""}<footer id="site-footer"></footer></body></html>`;

const CHALLENGE = `<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script src="/cdn-cgi/challenge-platform/h/g/orchestrate/chl_page/v1"></script></body></html>`;
const HLS = "https://cdn.example/vod/13000/13787/13787.m3u8?token=abc&expires=1";

// ———— 假的网络和浏览器内核 ————

interface FakeSetup {
  fetch?: (url: string) => { text: string; status: number } | Error;
  scrape?: (url: string) => ScrapeResult;
  head?: (url: string) => { status: number; type: string } | Error;
}

function fakeDeps(setup: FakeSetup): ProbeDeps & { calls: { fetch: string[]; scrape: string[]; scrapeSelectors: string[]; head: string[] } } {
  const calls = { fetch: [] as string[], scrape: [] as string[], scrapeSelectors: [] as string[], head: [] as string[] };
  return {
    calls,
    fetchText: async (url) => {
      calls.fetch.push(url);
      const r = setup.fetch?.(url) ?? { text: "", status: 200 };
      if (r instanceof Error) throw r;
      return r;
    },
    scrape: async (url, selector) => {
      calls.scrape.push(url);
      calls.scrapeSelectors.push(selector);
      return setup.scrape?.(url) ?? { ok: false, error: { code: "unavailable", message: "没有浏览器内核" } };
    },
    head: async (url) => {
      calls.head.push(url);
      const r = setup.head?.(url) ?? { status: 200, type: "video/mp4" };
      if (r instanceof Error) throw r;
      return r;
    },
  };
}

/** 用登记探测的方式跑一次，返回结果和最终那条诊断（时钟是假的，每次读都 +100 毫秒）。 */
async function traced<T>(id: Parameters<ReturnType<typeof createTracker>>[0], run: Parameters<ReturnType<typeof createTracker>>[1]) {
  let clock = 1000;
  const history: DiagEntry[] = [];
  const track = createTracker((_id, entry) => history.push(entry), () => (clock += 100));
  const value = (await track(id, run)) as T | null;
  return { value, entry: history[history.length - 1] as DiagEntry, history };
}

async function main(): Promise<void> {
  console.log("验证页识别、标题、地址");
  {
    check("标题「Just a moment...」是验证页", isChallengePage(CHALLENGE));
    check("标题「请稍候…」「Attention Required」也是", isChallengePage("<title>请稍候…</title>") && isChallengePage("<title>Attention Required! | Cloudflare</title>"));
    check("没有标题但带验证脚本也认", isChallengePage('<html><body><script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script></body></html>'));
    check("真实的 Jable 页面不是验证页", !isChallengePage(searchPage([card("ssis-001", "某片")])) && !isChallengePage(playPage(HLS)));
    check("空串不是验证页", !isChallengePage(""));
    check("titleOf：取标题、压空白", titleOf("<html><title>  A\n  B </title></html>") === "A B" && titleOf("<html></html>") === "");
    check("isChallengeTitle", isChallengeTitle("Just a moment...") && isChallengeTitle("請稍候…") && !isChallengeTitle("SSIS-001 某片 - Jable.TV"));
    check("MissAV 页面地址用小写番号、去首尾空白", missavPageUrl(" SSIS-001 ") === "https://missav.ws/ssis-001");
    check(
      "浏览器内核的失败写成人话",
      describeScrapeFailure(undefined).includes("没有返回") &&
        describeScrapeFailure({ code: "cancelled" }).includes("取消") &&
        describeScrapeFailure({ code: "timeout" }).includes("验证") &&
        describeScrapeFailure({ code: "x", message: "boom" }).includes("boom") &&
        describeScrapeFailure({ code: "x" }, true).includes("验证"),
    );
    check("用时的写法", formatSeconds(80) === "0.1 秒" && formatSeconds(1234) === "1.2 秒" && formatSeconds(80_000) === "80.0 秒" && formatSeconds(-1) === "—");
    check("结果的写法", stateText("ok") === "取到了" && stateText("none") === "没有" && stateText("failed") === "失败" && stateText("running") === "进行中");
  }

  console.log("Jable 搜索结果：解析和挑选");
  {
    const page = searchPage([
      card("ssis-0012", "另一部"),
      card("ssis-001-c", "中文字幕版"),
      card("ssis-001", "原版"),
      card("ssis-001-uncensored-leak", "无码流出"),
      card("ssis-001-c", "重复的卡片"),
    ]);
    const results = parseJableResults(page);
    check("每张卡片一条，重复的合并", results.length === 4 && results.map((r) => r.slug).join() === "ssis-0012,ssis-001-c,ssis-001,ssis-001-uncensored-leak", results.map((r) => r.slug).join());
    check("播放页地址和预览", results[2].videoUrl === "https://jable.tv/videos/ssis-001/" && results[2].preview.endsWith("/ssis-001_preview.mp4"));
    check("没有「部影片」标题（验证页 / 别的页面）→ 空", parseJableResults(CHALLENGE).length === 0 && parseJableResults("").length === 0);
    check("有标题没有卡片 → 空", parseJableResults("<h4>0 部影片</h4>").length === 0);
    check("番号完全对上的排最前，不管它排第几", pickJableResult(results, "SSIS-001")?.slug === "ssis-001");
    check("大小写、连字符不影响", pickJableResult(results, "ssis001")?.slug === "ssis-001" && pickJableResult(results, "Ssis-001")?.slug === "ssis-001");
    check(
      "没有原版时认同一部片的其它版本（-c 中文字幕）",
      pickJableResult(results.filter((r) => r.slug !== "ssis-001"), "SSIS-001")?.slug === "ssis-001-c",
    );
    check("后面多的是数字（ssis-0012）是另一部，不要", pickJableResult([results[0]], "SSIS-001") === null);
    check("一条都对不上 → null（以前会直接拿第一条）", pickJableResult(results, "IPX-239") === null && pickJableResult([], "SSIS-001") === null);
    check("番号是空的 → null", pickJableResult(results, "") === null);
    check("没有预览的卡片，preview 是空串", parseJableResults('<h4>1 部影片</h4><div class="video-img-box"><a href="https://jable.tv/videos/abc-001/">x</a></div>')[0]?.preview === "");

    const fc2 = parseJableResults(searchPage([card("fc2-ppv-12345678", "别的片"), card("fc2-ppv-1234567", "要的片")]));
    check("FC2：番号带 PPV、地址不带（或反过来）算同一个", pickJableResult(fc2.slice(1), "FC2-1234567")?.slug === "fc2-ppv-1234567" && pickJableResult(parseJableResults(searchPage([card("fc2-1234567", "x")])), "FC2-PPV-1234567")?.slug === "fc2-1234567");
    check("FC2：多出来的是数字（fc2-ppv-12345678）还是另一部", pickJableResult(fc2.slice(0, 1), "FC2-PPV-1234567") === null && pickJableResult(fc2, "FC2-1234567")?.slug === "fc2-ppv-1234567");
    check("PPV 只在 FC2 开头时才去掉", pickJableResult(parseJableResults(searchPage([card("abc-ppv-001", "x")])), "ABC-001") === null);
  }

  console.log("Jable 搜索：直接取到 / 被拦后浏览器内核 / 各种失败");
  {
    const url = "https://jable.tv/search/SSIS-001/";
    const good = searchPage([card("ssis-001", "某片")]);

    const direct = fakeDeps({ fetch: () => ({ text: good, status: 200 }) });
    const a = await traced<unknown>("jable", (r) => traceFindJable("SSIS-001", r, direct));
    check("直接请求就取到：不碰浏览器内核", a.value !== null && direct.calls.scrape.length === 0 && direct.calls.fetch[0] === url, JSON.stringify(direct.calls));
    check("结果：取到了，原因里写着命中的是哪一条", a.entry.state === "ok" && a.entry.detail.includes("ssis-001"));
    check("用时是登记的（假时钟）", a.entry.ms > 0 && a.entry.startedAt === 1100);

    const blocked = fakeDeps({ fetch: () => ({ text: CHALLENGE, status: 403 }), scrape: () => ({ ok: true, html: good }) });
    const b = await traced<{ videoUrl: string }>("jable", (r) => traceFindJable("SSIS-001", r, blocked));
    check("直接请求被验证页挡住 → 改用浏览器内核取到", b.value?.videoUrl === "https://jable.tv/videos/ssis-001/" && blocked.calls.scrape.length === 1);
    check("浏览器内核等的是真页面才有的元素", blocked.calls.scrapeSelectors[0] === "#site-footer");
    check("诊断里写明直接请求被拦、浏览器内核取到了", b.entry.state === "ok" && b.history.some((e) => e.step.includes("改用浏览器内核")) && b.entry.detail.includes("浏览器内核取到了"), JSON.stringify(b.entry));

    const status200 = fakeDeps({ fetch: () => ({ text: CHALLENGE, status: 200 }), scrape: () => ({ ok: true, html: good }) });
    const c = await traced<unknown>("jable", (r) => traceFindJable("SSIS-001", r, status200));
    check("状态码 200 但内容是验证页，同样改用浏览器内核", c.value !== null && status200.calls.scrape.length === 1);

    const thrown = fakeDeps({ fetch: () => new Error("连不上"), scrape: () => ({ ok: true, html: good }) });
    const d = await traced<unknown>("jable", (r) => traceFindJable("SSIS-001", r, thrown));
    check("直接请求抛错（网络不通）也改用浏览器内核", d.value !== null && thrown.calls.scrape.length === 1);

    const stillBlocked = fakeDeps({ fetch: () => ({ text: CHALLENGE, status: 403 }), scrape: () => ({ ok: true, html: CHALLENGE }) });
    const e = await traced<unknown>("jable", (r) => traceFindJable("SSIS-001", r, stillBlocked));
    check("浏览器内核拿到的还是验证页 → 失败，原因写明两次都被拦", e.value === null && e.entry.state === "failed" && e.entry.detail.includes("还是 Cloudflare 验证页") && e.entry.detail.includes("直接请求"), e.entry.detail);

    const timedOut = fakeDeps({ fetch: () => ({ text: CHALLENGE, status: 403 }), scrape: () => ({ ok: false, timedOut: true, error: { code: "cancelled" } }) });
    const f = await traced<unknown>("jable", (r) => traceFindJable("SSIS-001", r, timedOut));
    check("浏览器内核超时 → 失败，原因提到验证", f.value === null && f.entry.state === "failed" && f.entry.detail.includes("验证"), f.entry.detail);

    const scrapeError = fakeDeps({ fetch: () => ({ text: "", status: 500 }), scrape: () => ({ ok: false, error: { code: "navigation", message: "无法打开页面" } }) });
    const g = await traced<unknown>("jable", (r) => traceFindJable("SSIS-001", r, scrapeError));
    check("直接请求 500、浏览器内核报错 → 失败，两个原因都写", g.entry.state === "failed" && g.entry.detail.includes("HTTP 500") && g.entry.detail.includes("无法打开页面"), g.entry.detail);

    const missing = fakeDeps({ fetch: () => ({ text: "", status: 404 }) });
    const h = await traced<unknown>("jable", (r) => traceFindJable("SSIS-001", r, missing));
    check("404 = 站点上没有：算「没有」，不去开浏览器内核", h.value === null && h.entry.state === "none" && missing.calls.scrape.length === 0, h.entry.state);

    const empty = fakeDeps({ fetch: () => ({ text: "<title>搜尋結果 - Jable.TV</title><h4>0 部影片</h4><footer id=\"site-footer\"></footer>", status: 200 }) });
    const i = await traced<unknown>("jable", (r) => traceFindJable("SSIS-001", r, empty));
    check("搜索结果是空的 → 「没有」，不是失败", i.entry.state === "none" && i.entry.detail.includes("没有这个番号"));

    const wrong = fakeDeps({ fetch: () => ({ text: searchPage([card("ipx-239-c", "别的片"), card("ssis-0012", "另一部")]), status: 200 }) });
    const j = await traced<unknown>("jable", (r) => traceFindJable("SSIS-001", r, wrong));
    check("搜到了但没有番号对得上的 → 「没有」，并写出第一条是什么", j.value === null && j.entry.state === "none" && j.entry.detail.includes("ipx-239-c") && j.entry.detail.includes("2 条"), j.entry.detail);

    const leftPage = fakeDeps({ fetch: () => ({ text: CHALLENGE, status: 403 }), scrape: () => ({ ok: false, skipped: "stale", error: { message: "你已经离开详情页，没有再用浏览器内核" } }) });
    const k = await traced<unknown>("jable", (r) => traceFindJable("SSIS-001", r, leftPage, () => true));
    check("浏览器内核说请求方已离开 → 算「没有」，原因写明离开了（不算失败）", k.value === null && k.entry.state === "none" && k.entry.detail.includes("离开"), JSON.stringify(k.entry));

    const cooling = fakeDeps({ fetch: () => ({ text: CHALLENGE, status: 403 }), scrape: () => ({ ok: false, skipped: "cooldown", error: { message: "30 秒前浏览器内核刚失败过（x），2 分钟内不再重试" } }) });
    const l = await traced<unknown>("jable", (r) => traceFindJable("SSIS-001", r, cooling));
    check("冷却期内没再试 → 失败，原因里有直接请求的结果和冷却的说明", l.entry.state === "failed" && l.entry.detail.includes("直接请求：Cloudflare 验证页") && l.entry.detail.includes("不再重试"), l.entry.detail);

    let sawStale: (() => boolean) | undefined;
    const passthrough = fakeDeps({ fetch: () => ({ text: CHALLENGE, status: 403 }), scrape: () => ({ ok: true, html: good }) });
    const originalScrape = passthrough.scrape;
    passthrough.scrape = (u, s, stale) => {
      sawStale = stale;
      return originalScrape(u, s, stale);
    };
    const isStale = () => false;
    await traced<unknown>("jable", (r) => traceFindJable("SSIS-001", r, passthrough, isStale));
    check("「是否已离开」会一路传到浏览器内核那一步", sawStale === isStale);
  }

  console.log("浏览器内核入口（createScraper）：计时兜底 / 一次一个 / 离开不加载 / 失败冷却");
  {
    interface LoadCall {
      taskId: string;
      url: string;
      selector: string;
      timeout: number;
    }
    const loads: LoadCall[] = [];
    const cancels: string[] = [];
    let running = 0;
    let maxRunning = 0;
    let loadImpl: (call: LoadCall) => Promise<{ ok: boolean; html?: string; error?: { code?: string; message?: string } }> = async () => ({ ok: true, html: "<html></html>" });
    let cancelImpl: (taskId: string) => Promise<boolean> = async () => true;
    (globalThis as any).WebScraper = {
      load: async (options: { url: string; wait: { selector: string }; timeout: number; taskId: string }) => {
        const call = { taskId: options.taskId, url: options.url, selector: options.wait.selector, timeout: options.timeout };
        loads.push(call);
        running++;
        maxRunning = Math.max(maxRunning, running);
        try {
          return await loadImpl(call);
        } finally {
          running--;
        }
      },
      cancel: (taskId: string) => {
        cancels.push(taskId);
        return cancelImpl(taskId);
      },
    };
    const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
    const reset = () => {
      loads.length = 0;
      cancels.length = 0;
      running = 0;
      maxRunning = 0;
      loadImpl = async () => ({ ok: true, html: "<html></html>" });
      cancelImpl = async () => true;
    };

    reset();
    const plain = createScraper({ guardMs: 200 });
    const a = await plain("https://jable.tv/x/", "#site-footer");
    check("正常：交出页面，等的是传进去的元素，没取消", a.ok && a.html === "<html></html>" && loads[0].selector === "#site-footer" && loads[0].timeout > 0 && cancels.length === 0);

    reset();
    loadImpl = () => new Promise(() => undefined);
    const hang = createScraper({ guardMs: 40 });
    const t0 = Date.now();
    const b = await hang("https://jable.tv/x/", "#site-footer");
    check("WebScraper 一直不回话：到点自己交出「超时」，并取消那个任务", !b.ok && b.timedOut === true && cancels[0] === loads[0].taskId && Date.now() - t0 < 1000, JSON.stringify(b));

    reset();
    loadImpl = () => new Promise(() => undefined);
    cancelImpl = async () => {
      throw new Error("取消失败");
    };
    const c = await createScraper({ guardMs: 30 })("https://jable.tv/x/", "#site-footer");
    check("取消本身抛错也照样交出结果", !c.ok && c.timedOut === true);

    reset();
    loadImpl = async () => {
      throw new Error("炸了");
    };
    const d = await createScraper({ guardMs: 200 })("https://jable.tv/x/", "#site-footer");
    check("load 抛异常：交出失败和异常信息，不往外抛", !d.ok && d.error?.message === "炸了" && d.timedOut !== true, JSON.stringify(d));

    reset();
    loadImpl = async () => {
      await sleep(25);
      return { ok: true, html: "<html></html>" };
    };
    const serial = createScraper({ guardMs: 500 });
    const all = await Promise.all([serial("https://jable.tv/1/", "#a"), serial("https://jable.tv/2/", "#a"), serial("https://jable.tv/3/", "#a")]);
    check("三个同时来：一次只跑一个，顺序不乱，都取到", maxRunning === 1 && all.every((r) => r.ok) && loads.map((l) => l.url).join() === "https://jable.tv/1/,https://jable.tv/2/,https://jable.tv/3/", `max=${maxRunning}`);

    reset();
    loadImpl = async () => {
      await sleep(30);
      return { ok: true, html: "<html></html>" };
    };
    let left = false;
    const queued = createScraper({ guardMs: 500 });
    const first = queued("https://jable.tv/1/", "#a");
    const second = queued("https://jable.tv/2/", "#a", () => left);
    left = true; // 第二个还在排队时请求方走了
    const [r1, r2] = await Promise.all([first, second]);
    check("排队时请求方走了：轮到它时不再加载", r1.ok && !r2.ok && r2.skipped === "stale" && loads.length === 1, JSON.stringify(r2));
    check("已经离开的，一开始就不加载", (await createScraper()("https://jable.tv/x/", "#a", () => true)).skipped === "stale" && loads.length === 1);

    reset();
    let clock = 1_000_000;
    loadImpl = async () => ({ ok: false, error: { code: "timeout" } });
    const cool = createScraper({ guardMs: 200, cooldownMs: 120_000, now: () => clock });
    const e1 = await cool("https://jable.tv/1/", "#a");
    clock += 30_000;
    const e2 = await cool("https://jable.tv/2/", "#a");
    check("失败后冷却期内不再加载，说明里有「几秒前」和原因", !e1.ok && e1.skipped === undefined && e2.skipped === "cooldown" && loads.length === 1 && (e2.error?.message ?? "").includes("30 秒前") && (e2.error?.message ?? "").includes("不再重试"), JSON.stringify(e2));
    clock += 100_000;
    loadImpl = async () => ({ ok: true, html: "<html></html>" });
    const e3 = await cool("https://jable.tv/3/", "#a");
    check("冷却期过了重新试，成功后冷却解除", e3.ok && loads.length === 2);
    loadImpl = async () => ({ ok: false });
    const e4 = await cool("https://jable.tv/4/", "#a");
    loadImpl = async () => ({ ok: true, html: "<html></html>" });
    clock += 200_000;
    const e5 = await cool("https://jable.tv/5/", "#a");
    check("再失败又进冷却；冷却过后又能成功", !e4.ok && e5.ok && loads.length === 4);

    reset();
    loadImpl = async () => ({ ok: true, html: "" });
    const emptyHtml = createScraper({ guardMs: 200, now: () => clock });
    await emptyHtml("https://jable.tv/1/", "#a");
    const afterEmpty = await emptyHtml("https://jable.tv/2/", "#a");
    check("取回来是空页面也算失败、进冷却", afterEmpty.skipped === "cooldown");
  }

  console.log("Jable 播放页、MissAV 预览");
  {
    const ok = fakeDeps({ fetch: () => ({ text: playPage(HLS), status: 200 }) });
    const a = await traced<string>("jableHls", (r) => traceFindJableHls("https://jable.tv/videos/ssis-001/", r, ok));
    check("播放页里的 hlsUrl", a.value === HLS && a.entry.state === "ok");

    const none = fakeDeps({ fetch: () => ({ text: playPage(null), status: 200 }) });
    const b = await traced<string>("jableHls", (r) => traceFindJableHls("https://jable.tv/videos/ssis-001/", r, none));
    check("播放页里没有 hlsUrl → 失败，原因写明", b.value === null && b.entry.state === "failed" && b.entry.detail.includes("hlsUrl"));

    const viaScrape = fakeDeps({ fetch: () => ({ text: CHALLENGE, status: 403 }), scrape: () => ({ ok: true, html: playPage(HLS) }) });
    const c = await traced<string>("jableHls", (r) => traceFindJableHls("https://jable.tv/videos/ssis-001/", r, viaScrape));
    check("播放页被拦时同样改用浏览器内核", c.value === HLS && viaScrape.calls.scrape.length === 1);

    const preview = fakeDeps({ head: () => ({ status: 206, type: "video/mp4" }) });
    const d = await traced<string>("missavPreview", (r) => traceFindMissavPreview("SSIS-001", r, preview));
    check("预览：206 + 视频 → 地址是小写番号", d.value === "https://fourhoi.com/ssis-001/preview.mp4" && d.entry.state === "ok" && preview.calls.head[0] === d.value);

    const gone = fakeDeps({ head: () => ({ status: 404, type: "application/xml" }) });
    const e = await traced<string>("missavPreview", (r) => traceFindMissavPreview("SSIS-001", r, gone));
    check("预览：404 = 没有", e.value === null && e.entry.state === "none" && e.entry.detail.includes("404"));

    const html = fakeDeps({ head: () => ({ status: 200, type: "text/html; charset=utf-8" }) });
    const f = await traced<string>("missavPreview", (r) => traceFindMissavPreview("SSIS-001", r, html));
    check("预览：200 但是网页 → 失败（被拦的页面）", f.value === null && f.entry.state === "failed" && f.entry.detail.includes("text/html"));

    const down = fakeDeps({ head: () => new Error("连不上") });
    const g = await traced<string>("missavPreview", (r) => traceFindMissavPreview("SSIS-001", r, down));
    check("预览：请求抛错 → 失败", g.entry.state === "failed" && g.entry.detail.length > 0);
  }

  console.log("登记探测（createTracker）");
  {
    const ok = await traced<string>("missavFull", async (report) => {
      report({ step: "打开页面" });
      report({ step: "等视频地址", detail: "页面标题「x」" });
      return "https://x/y.m3u8";
    });
    check("返回了东西 = 取到了", ok.value !== null && ok.entry.state === "ok" && ok.entry.step === "等视频地址");
    check("过程里每次更新都发出去", ok.history[0].state === "running" && ok.history.length >= 4, String(ok.history.length));

    const none = await traced<string>("missavFull", async () => null);
    check("返回 null 且没写明结果 = 没有", none.entry.state === "none");

    const explicitFailed = await traced<string>("missavFull", async (report) => {
      report({ state: "failed", detail: "被拦了" });
      return null;
    });
    check("探测自己写了「失败」的以它为准", explicitFailed.entry.state === "failed" && explicitFailed.entry.detail === "被拦了");

    const threw = await traced<string>("missavFull", async () => {
      throw new Error("炸了");
    });
    check("抛异常 = 失败，原因是异常信息，不往外抛", threw.value === null && threw.entry.state === "failed" && threw.entry.detail === "炸了");

    const live = await traced<string>("missavFull", async (report) => {
      report({ step: "还在等" });
      return null;
    });
    check("用时写在每次更新上、结束后固定", live.history.every((e, i, all) => i === 0 || e.ms >= all[i - 1].ms) && live.entry.ms > 0);
  }

  console.log("汇总和诊断文字");
  {
    const entry = (id: DiagEntry["id"], state: DiagEntry["state"], extra: Partial<DiagEntry> = {}): DiagEntry => ({
      id,
      state,
      step: "某一步",
      detail: "",
      startedAt: 0,
      ms: 1500,
      ...extra,
    });
    const board = (...entries: DiagEntry[]): Board => Object.fromEntries(entries.map((e) => [e.id, e]));

    check("一条都没开始 → unknown", fullVideoStatus({}) === "unknown");
    check("MissAV 取到了 → ok", fullVideoStatus(board(entry("missavFull", "ok"))) === "ok");
    check("Jable 播放页取到了 → ok", fullVideoStatus(board(entry("jable", "ok"), entry("jableHls", "ok"))) === "ok");
    check("MissAV 还在取 → running", fullVideoStatus(board(entry("missavFull", "running"), entry("jable", "none"))) === "running");
    check("Jable 搜索命中、播放页还没开始 / 在取 → running", fullVideoStatus(board(entry("jable", "ok"))) === "running" && fullVideoStatus(board(entry("jable", "ok"), entry("jableHls", "running"))) === "running");
    check("Jable 搜索还在跑 → running", fullVideoStatus(board(entry("jable", "running"))) === "running");
    check("两条路都没取到 → failed", fullVideoStatus(board(entry("missavFull", "failed"), entry("jable", "none"))) === "failed");
    check("Jable 命中但播放页没取到、MissAV 也没 → failed", fullVideoStatus(board(entry("missavFull", "none"), entry("jable", "ok"), entry("jableHls", "failed"))) === "failed");
    check("只有一条路试过（MissAV 预取关了）也没取到 → failed", fullVideoStatus(board(entry("jable", "none"))) === "failed");
    check("预览取到了不算完整视频", fullVideoStatus(board(entry("missavPreview", "ok"))) === "unknown");

    const text = formatDiagnostics(
      "SSIS-001",
      board(
        entry("missavFull", "failed", { step: "等了 80 秒仍没有视频地址", detail: "页面标题「Just a moment...」：这是 Cloudflare 验证页", ms: 80_000 }),
        entry("jable", "failed", { step: "搜索页：直接请求不行", detail: "直接请求：HTTP 403；浏览器内核拿到的还是 Cloudflare 验证页" }),
        entry("missavPreview", "ok"),
      ),
      99_999,
    );
    check("开头是番号", text.startsWith("番号 SSIS-001"));
    check("每个片源一段，写结果和用时", text.includes("【MissAV 完整视频】失败，80.0 秒") && text.includes("【Jable 搜索】失败，1.5 秒") && text.includes("【MissAV 预览】取到了"));
    check("写最后一步和原因", text.includes("最后一步：等了 80 秒仍没有视频地址") && text.includes("原因：页面标题「Just a moment...」"));
    check("成功的写「说明」不写「原因」", formatDiagnostics("X", board(entry("missavPreview", "ok", { detail: "好" })), 0).includes("说明：好"));
    check("没拿到的片源不出现", !text.includes("Jable 完整视频地址"));
    check("顺序：完整视频在前，预览在后", text.indexOf("MissAV 完整视频") < text.indexOf("Jable 搜索") && text.indexOf("Jable 搜索") < text.indexOf("MissAV 预览"));
    check("两条路都没取到时给出建议（换网络 / 在 Safari 里看）", text.includes("Safari") && text.includes("换个节点"));
    check("还在跑的用「现在 − 开始时间」算用时", formatDiagnostics("X", board(entry("jable", "running", { startedAt: 1000 })), 4000).includes("进行中，3.0 秒"));
    check("一条都没有时的说明", formatDiagnostics("X", {}, 0).includes("还没有开始探测"));
    check("取到了完整视频时不给「都没取到」的建议", !formatDiagnostics("X", board(entry("missavFull", "ok")), 0).includes("Safari"));
    check("名字和顺序覆盖全部片源", SOURCE_ORDER.length === 4 && SOURCE_ORDER.every((id) => SOURCE_NAMES[id].length > 0));
  }

  console.log("设备转译兼容：.ts 里不能有裸的泛型箭头函数");
  {
    // 设备上的转译把 .ts 也当 TSX 解析：`async <T>(id, run) =>` 里的 `<T>` 被当成 JSX 标签，报「Unexpected identifier 'run'」整个脚本起不来
    // （2026-10-23 sourceDiag.ts 里犯过；这里用 TypeScript 按 TSX 解析验证过，只有那一处）。要写泛型箭头就写 `<T,>` 或 `<T extends unknown>`，或者改用 function。
    const root = join(__dirname, "../JavBus");
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const p = join(dir, name);
        return statSync(p).isDirectory() ? walk(p) : [p];
      });
    const bare = /(?:=|return|async|\(|,)\s*<[A-Za-z_]\w*>\s*\(/;
    const offenders = walk(root)
      .filter((f) => f.endsWith(".ts"))
      .flatMap((f) =>
        readFileSync(f, "utf8")
          .split(/\r?\n/)
          .map((line, i) => ({ f, line, n: i + 1 }))
          // 注释和类型别名（`type X = <T>(…) => …` 是类型、不是表达式，TSX 里没问题）不算
          .filter(({ line }) => !/^\s*(?:\/\/|\*|\/\*|(?:export\s+)?type\s)/.test(line) && bare.test(line)),
      );
    check("没有裸的泛型箭头函数", offenders.length === 0, offenders.map((o) => `${o.f}:${o.n}`).join("; "));
  }

  console.log(`\n${passed} 项通过，${failed} 项失败`);
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
