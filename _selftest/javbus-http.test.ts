// 离线自测：站点请求层（kit/http.ts + kit/cookies.ts）对着本机的模拟 JavBus 服务器跑一遍年龄验证。
//   npx -y -p tsx tsx _selftest/javbus-http.test.ts
//
// 模拟服务器照真实站点的行为：没有 dv cookie 的请求先 302 到 /doc/driver-verify（年龄验证页），
// 往验证页 POST `Submit=確認` 会 302 回原页并 Set-Cookie: dv=1，之后同一个 cookie 才放行。
//
// Scripting 的 fetch 比标准 fetch 多了 Response.cookies 和 handleRedirect，这里用 node:http 写一个同行为的
// 替身，另外把 Storage / Dialog / WebViewController 也换成替身——只验证我们自己的逻辑（cookie 罐、请求头、
// 验证流程的几条分支），不验证 Scripting 运行时本身。
//
// 同一台模拟服务器还扮演推荐上传服务（Google Apps Script：POST 先 302，结果要 GET 跳转后的地址才拿得到；
// 作者精选走这条）、原作者在 GitLab 上的推荐列表、社区推荐服务（网友推荐走这条）和 JavDB 搜索页，
// 用来验证 sendRecommendation 的显式「跳转改 GET」、按频道分开的两种服务端与 findJavdbRating 的三种结果。

import http from "node:http";
import type { AddressInfo } from "node:net";

import { COMMUNITY_URL } from "../JavBus/core/constants";
import { cookieHeader, clearCookies, cookieCounts } from "../JavBus/kit/cookies";
import { SiteError, getPage } from "../JavBus/kit/http";
import { findJavdbRating } from "../JavBus/kit/previews";
import { getFlags, getSettings, setFlag, resetFlags } from "../JavBus/kit/settings";

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean): void {
  if (ok) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}`);
  }
}

// ———— 模拟站点 ————

type Behaviour = {
  /** POST 验证后是否真的下发 dv cookie。 */
  grantCookie: boolean;
  /** 运行时遇到 302 时是否沿用原来的方法和请求体（假设中真机上出事的那种行为）。 */
  redirectKeepsMethod: boolean;
  /** 推荐上传服务 GET 取结果时返回的内容。 */
  echoResult: string;
  /** JavDB 搜索页的样子。 */
  javdb: "ok" | "empty" | "challenge" | "blocked" | "forbidden" | "drop";
  /** 社区推荐服务（javbus-community）的上传 / 举报接口返回的文本码。 */
  communityResult: string;
  /** 社区服务 /api/v1/meta 的响应。 */
  communityMeta: { status: number; body: string };
};

const behaviour: Behaviour = {
  grantCookie: true,
  redirectKeepsMethod: false,
  echoResult: "succeed",
  javdb: "ok",
  communityResult: "succeed",
  communityMeta: { status: 200, body: "{}" },
};
const seen: { path: string; method: string; cookie: string; body: string; contentType: string; deviceId: string }[] = [];

/** 社区服务各返回码对应的 HTTP 状态码（和 javbus-community 的实现一致；App 只读正文，不看状态码）。 */
const COMMUNITY_STATUS: Record<string, number> = { succeed: 200, PD: 202, FE: 400, NA: 401, BN: 403, NF: 404, RE: 409, RL: 429, OFF: 503, FULL: 507 };
const COMMUNITY_LIST = JSON.stringify([
  { code: "CMT-001", info: "CMT-001 | 2026-10-22", src: "https://x/c1.jpg", link: "https://x/CMT-001" },
  { code: "CMT-002", info: "CMT-002 | 2026-10-21", src: "https://x/c2.jpg", link: "https://x/CMT-002" },
]);
/** 原作者在 GitLab 上的作者精选（Rec）：和真的一样是 text/plain 的 JSON。 */
const ORIGINAL_AUTHOR_LIST = JSON.stringify([{ code: "ORI-001", info: "ORI-001 | 2026-10-19", src: "https://x/o1.jpg", link: "https://x/ORI-001" }]);

const GATE_HTML = `<html><body><div class="modal show" id="ageVerify"><form method="post" action=""><input id="submit" value="確認" type="submit" name="Submit"/></form></div></body></html>`;
const LIST_HTML = `<div class="item"><a class="movie-box" href="https://www.javbus.com/TST-001"><div class="photo-frame"><img src="/pics/thumb/a.jpg" title="t"></div><div class="photo-info"><span>t<br /><date>TST-001</date> / <date>2021-01-01</date></span></div></a></div>`;

// 结构取自真实的 JavDB 搜索页：第一张卡片不是要找的片，第三张没人评分
const JAVDB_HTML = `<html><head><title> JavDB 成人影片數據庫 </title></head><body><div class="movie-list h cols-4 vcols-8">
<div class="item"><a href="/v/aaa" class="box"><div class="video-title"><strong>TST-101</strong> 一</div>
<div class="score"><span class="value"><span class="score-stars"><i class="icon-star"></i></span>&nbsp;4.13分, 由594人評價</span></div></a></div>
<div class="item"><a href="/v/bbb" class="box"><div class="video-title"><strong>TST-014</strong> 二</div>
<div class="score"><span class="value"><span class="score-stars"><i class="icon-star"></i></span>&nbsp;4.57分, 由4217人評價</span></div></a></div>
<div class="item"><a href="/v/ccc" class="box"><div class="video-title"><strong>TST-015</strong> 三</div><div class="meta">2021-03-01</div></a></div>
</div></body></html>`;
const JAVDB_EMPTY_HTML = `<html><head><title> JavDB 成人影片數據庫 </title></head><body><div class="empty-message">暫無內容</div></body></html>`;
const JAVDB_BLOCKED_HTML = `<html><head><title> JavDB 成人影片數據庫 </title></head><body>偵測到異常行為，您的 IP 已被暫時封鎖</body></html>`;
const CHALLENGE_HTML = `<html><head><title>Just a moment...</title></head><body>Checking your browser</body></html>`;
const GOOGLE_ERROR_HTML = `<!DOCTYPE html><html lang="en"><head><script nonce="abc">window['ppConfig'] = {productName: '26981ed0d57bbad37e728ff58134270c', heartbeatRate:  0.5 };</script><title>Page not found</title></head><body><p class="errorMessage">Sorry, unable to open the file at present.</p><p> Please check the address and try again.</p></body></html>`;

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    const cookies = parseCookies(req.headers.cookie);
    seen.push({
      path: req.url ?? "",
      method: req.method ?? "",
      cookie: req.headers.cookie ?? "",
      body,
      contentType: String(req.headers["content-type"] ?? ""),
      deviceId: String(req.headers["x-device-id"] ?? ""),
    });
    const url = req.url ?? "/";
    // 社区推荐服务：直接回结果，不跳转，不要 cookie
    if (url.startsWith("/api/v1/upload/") || url === "/api/v1/report") {
      res.writeHead(COMMUNITY_STATUS[behaviour.communityResult] ?? 200, { "content-type": "text/plain; charset=utf-8" });
      res.end(behaviour.communityResult);
      return;
    }
    if (url === "/api/v1/meta") {
      res.writeHead(behaviour.communityMeta.status, { "content-type": "application/json" });
      res.end(behaviour.communityMeta.body);
      return;
    }
    if (url.startsWith("/api/v1/rec/")) {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(url.endsWith("/author") ? "[]" : COMMUNITY_LIST);
      return;
    }
    // 原作者的两份列表（gitlab.com/Nicked639/javrev/raw/master/Rec、RecBot）
    if (url.startsWith("/Nicked639/javrev/raw/master/")) {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end(url.endsWith("/Rec") ? ORIGINAL_AUTHOR_LIST : "[]");
      return;
    }
    if (url.startsWith("/macros/s/")) {
      // Apps Script：POST 执行完先 302 到 echo 地址
      res.writeHead(302, { Location: "https://script.googleusercontent.com/macros/echo?user_content_key=k" });
      res.end();
      return;
    }
    if (url.startsWith("/macros/echo")) {
      if (req.method === "GET") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end(behaviour.echoResult);
      } else {
        res.writeHead(405, { "content-type": "text/html" });
        res.end(GOOGLE_ERROR_HTML);
      }
      return;
    }
    // JavDB 的搜索是 /search?q=…；JavBus 自己的搜索是 /search/<词>/<页>，不能混
    if (url.startsWith("/search?")) {
      if (behaviour.javdb === "drop") {
        res.destroy();
        return;
      }
      if (behaviour.javdb === "forbidden") {
        res.writeHead(403, { "content-type": "text/html" });
        res.end("<html>Attention Required</html>");
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end({ ok: JAVDB_HTML, empty: JAVDB_EMPTY_HTML, challenge: CHALLENGE_HTML, blocked: JAVDB_BLOCKED_HTML }[behaviour.javdb]);
      return;
    }
    if (url.startsWith("/doc/driver-verify")) {
      if (req.method === "POST" && body.includes("Submit=")) {
        const referer = new URL(url, "http://x").searchParams.get("referer") ?? "/";
        res.writeHead(302, {
          Location: referer,
          ...(behaviour.grantCookie ? { "Set-Cookie": ["dv=1; Path=/; Max-Age=3600; Domain=.javbus.com"] } : {}),
        });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(GATE_HTML);
      return;
    }
    if (cookies.dv !== "1") {
      res.writeHead(302, {
        Location: `/doc/driver-verify?referer=${encodeURIComponent(`https://www.javbus.com${url}`)}`,
        "Set-Cookie": ["PHPSESSID=abc; Path=/; Domain=.javbus.com"],
      });
      res.end();
      return;
    }
    if (url.startsWith("/blocked")) {
      res.writeHead(503, { "content-type": "text/html" });
      res.end("<html>Just a moment...</html>");
      return;
    }
    if (url.startsWith("/forbidden")) {
      res.writeHead(403, { "content-type": "text/html" });
      res.end("<html>Attention Required</html>");
      return;
    }
    if (url.startsWith("/missing")) {
      res.writeHead(404, { "content-type": "text/html" });
      res.end("<h1>404 Page Not Found</h1>");
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`${LIST_HTML}<!--existmag=${cookies.existmag}-->`);
  });
});

// ———— Scripting 运行时替身 ————

const store = new Map<string, unknown>();
(globalThis as any).Storage = {
  get: (key: string) => (store.has(key) ? store.get(key) : null),
  set: (key: string, value: unknown) => {
    if (value === null) store.delete(key);
    else store.set(key, JSON.parse(JSON.stringify(value)));
    return true;
  },
};

/** kit/recommend.ts 用 UUID.string() 生成设备号；固定成一个值，方便断言。 */
(globalThis as any).UUID = { string: () => "12345678-9ABC-4DEF-8123-456789ABCDEF" };
const EXPECTED_DEVICE_ID = "123456789abc4def8123456789abcdef";

let confirmAnswers: boolean[] = [];
const prompts: string[] = [];
(globalThis as any).Dialog = {
  confirm: async (options: { title?: string }) => {
    prompts.push(options.title ?? "");
    return confirmAnswers.shift() ?? false;
  },
};

// kit/recommend.ts 为了 useRecVersion 从 "scripting" 导入 React 钩子，Node 里没有这个模块；
// 上传逻辑用不到它，替身只要能让模块加载进来。
const nodeModule = require("node:module");
const originalLoad = nodeModule._load;
nodeModule._load = function (request: string, ...rest: unknown[]) {
  if (request === "scripting") return { useEffect: () => undefined, useState: (v: unknown) => [v, () => undefined] };
  return originalLoad.call(this, request, ...rest);
};

/** 浏览器兜底（WebScraper）：null = 没有这个全局，否则按给定结果返回，并记录每次调用。 */
const scraperCalls: any[] = [];
function installScraper(result: unknown | null): void {
  scraperCalls.length = 0;
  if (result === null) {
    delete (globalThis as any).WebScraper;
    return;
  }
  (globalThis as any).WebScraper = {
    scrape: async (options: unknown) => {
      scraperCalls.push(options);
      return result;
    },
    cancel: async () => undefined,
  };
}

let cancelRedirectThrows = false;
let webCookies: { name: string; value: string; domain: string }[] = [];
(globalThis as any).WebViewController = class {
  setCustomUserAgent() {
    return true;
  }
  async loadURL() {
    return true;
  }
  async present() {
    return undefined;
  }
  async getAllCookies() {
    return webCookies;
  }
  dispose() {}
};

function parseSetCookie(values: string[]): any[] {
  return values.map((v) => {
    const [pair, ...attrs] = v.split(";").map((s) => s.trim());
    const i = pair.indexOf("=");
    const domain = attrs.find((a) => /^domain=/i.test(a))?.split("=")[1] ?? "www.javbus.com";
    return { name: pair.slice(0, i), value: pair.slice(i + 1), domain, path: "/", isSecure: false, isHTTPOnly: false, isSessionOnly: true };
  });
}

/** 行为对齐 Scripting 的 fetch：把 https://www.javbus.com 改写到本机服务器；支持 handleRedirect 与 Response.cookies。 */
function installFetch(port: number): void {
  const impl = async (input: string, init: any = {}): Promise<any> => {
    const run = (url: string, method: string, headers: Record<string, string>, body?: string): Promise<any> =>
      new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const req = http.request(
          { host: "127.0.0.1", port, path: parsed.pathname + parsed.search, method, headers },
          (res) => {
            let text = "";
            res.on("data", (c) => (text += c));
            res.on("end", async () => {
              const setCookie = res.headers["set-cookie"] ?? [];
              const cookies = parseSetCookie(setCookie);
              const location = res.headers.location;
              const status = res.statusCode ?? 0;
              const response = (finalUrl: string) => ({
                status,
                url: finalUrl,
                cookies,
                ok: status >= 200 && status < 300,
                text: async () => text,
                headers: { get: () => null },
              });
              if (status >= 300 && status < 400 && location) {
                const next = new URL(location, url).toString();
                // 默认情况下 302 后改成 GET；redirectKeepsMethod 模拟「沿用原方法和请求体」的运行时
                const keep = behaviour.redirectKeepsMethod;
                if (init.handleRedirect) {
                  const decision = await init.handleRedirect({
                    method: keep ? method : "GET",
                    url: next,
                    headers,
                    cookies,
                    body: keep ? body : undefined,
                    timeout: 10,
                  });
                  if (decision === null) {
                    if (cancelRedirectThrows) return reject(new Error("cancelled"));
                    return resolve(response(url));
                  }
                  return resolve(await run(decision.url ?? next, decision.method ?? "GET", decision.headers ?? headers, decision.body));
                }
                // 默认跟随：和真实 URLSession 一样不会把 Set-Cookie 合进我们手写的 Cookie 头
                return resolve(await run(next, keep ? method : "GET", headers, keep ? body : undefined));
              }
              resolve(response(url));
            });
          },
        );
        req.on("error", reject);
        if (body) req.write(body);
        req.end();
      });
    return run(input, init.method ?? "GET", { ...(init.headers ?? {}) }, init.body);
  };
  (globalThis as any).fetch = impl;
}

function reset(): void {
  store.clear();
  clearCookies();
  resetFlags();
  seen.length = 0;
  prompts.length = 0;
  behaviour.grantCookie = true;
  behaviour.redirectKeepsMethod = false;
  behaviour.echoResult = "succeed";
  behaviour.javdb = "ok";
  behaviour.communityResult = "succeed";
  behaviour.communityMeta = { status: 200, body: "{}" };
  installScraper(null);
  cancelRedirectThrows = false;
  webCookies = [];
  confirmAnswers = [];
}

async function main(): Promise<void> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  installFetch((server.address() as AddressInfo).port);

  console.log("已同意代提交：自动过验证");
  {
    reset();
    setFlag("siteAge", true);
    const page = await getPage("https://www.javbus.com/page/1");
    check("没验证过、已同意代提交：自动过验证并拿到列表", page.html.includes("TST-001"));
    check("没有再弹确认", prompts.length === 0);
    const posted = seen.find((s) => s.method === "POST");
    check("提交的是 Submit=確認", !!posted && decodeURIComponent(posted.body) === "Submit=確認");
    check("cookie 罐里有了 dv", cookieHeader("https://www.javbus.com/page/1").includes("dv=1"));
    const again = await getPage("https://www.javbus.com/page/2");
    check("之后的请求直接放行，不再走验证", again.html.includes("TST-001") && seen.filter((s) => s.method === "POST").length === 1);
  }

  console.log("existmag：全部 / 收录");
  {
    reset();
    setFlag("siteAge", true);
    await getPage("https://www.javbus.com/page/1");
    const mag = await getPage("https://www.javbus.com/page/1");
    check("默认收录 existmag=mag", mag.html.includes("existmag=mag"));
    const all = await getPage("https://www.javbus.com/page/1", { all: true });
    check("全部 existmag=all，覆盖罐里的值", all.html.includes("existmag=all"));
    check("请求头里带 Referer 与 Cookie", seen[seen.length - 1].cookie.includes("existmag=all"));
  }

  console.log("第一次要先问用户");
  {
    reset();
    confirmAnswers = [true];
    const page = await getPage("https://www.javbus.com/page/1");
    check("弹了一次确认，同意后通过", prompts.length === 1 && page.html.includes("TST-001"));
    check("同意被记住", getFlags().siteAge === true);
    clearCookies();
    await getPage("https://www.javbus.com/page/1");
    check("记住之后再次遇到验证页不再问", prompts.length === 1);
  }

  console.log("用户拒绝");
  {
    reset();
    confirmAnswers = [false];
    let error: unknown;
    try {
      await getPage("https://www.javbus.com/page/1");
    } catch (e) {
      error = e;
    }
    check("拒绝就抛 ageGate 错误，不提交", error instanceof SiteError && error.code === "ageGate");
    check("没有发出过 POST", !seen.some((s) => s.method === "POST"));
  }

  console.log("取消重定向在运行时里表现为抛错");
  {
    reset();
    setFlag("siteAge", true);
    cancelRedirectThrows = true;
    const page = await getPage("https://www.javbus.com/page/1");
    check("退到「跟随重定向并从重定向请求里捞 cookie」", page.html.includes("TST-001"));
  }

  console.log("站点没有下发 cookie → 手动网页验证");
  {
    reset();
    setFlag("siteAge", true);
    behaviour.grantCookie = false;
    confirmAnswers = [true]; // 「自动确认没有生效，要打开网页吗」
    webCookies = [{ name: "dv", value: "1", domain: ".javbus.com" }];
    const page = await getPage("https://www.javbus.com/page/1");
    check("提示用户去网页上亲手确认，读回 web 视图 cookie 后通过", page.html.includes("TST-001") && prompts.length === 1);
  }

  console.log("手动验证也被拒绝");
  {
    reset();
    setFlag("siteAge", true);
    behaviour.grantCookie = false;
    confirmAnswers = [false];
    let error: unknown;
    try {
      await getPage("https://www.javbus.com/page/1");
    } catch (e) {
      error = e;
    }
    check("抛 ageGate 错误", error instanceof SiteError && error.code === "ageGate");
  }

  console.log("HTTP 状态码");
  {
    reset();
    setFlag("siteAge", true);
    await getPage("https://www.javbus.com/page/1"); // 先过验证
    let blocked: unknown;
    try {
      await getPage("https://www.javbus.com/blocked");
    } catch (e) {
      blocked = e;
    }
    check("503（挑战页 / 站点故障）抛 network 错误，不当成没有结果", blocked instanceof SiteError && blocked.code === "network" && blocked.message.includes("503"));
    let forbidden: unknown;
    try {
      await getPage("https://www.javbus.com/forbidden");
    } catch (e) {
      forbidden = e;
    }
    check("403 同样抛错", forbidden instanceof SiteError && forbidden.message.includes("403"));
    const missing = await getPage("https://www.javbus.com/missing");
    check("站点自己的 404 页不抛错（翻到头了由调用方按内容判断）", missing.status === 404 && missing.html.includes("404 Page Not Found"));
  }

  console.log("并发撞上验证页");
  {
    reset();
    setFlag("siteAge", true);
    behaviour.grantCookie = false; // 自动提交拿不到 cookie，只能走手动确认
    confirmAnswers = [true, true, true];
    webCookies = [{ name: "dv", value: "1", domain: ".javbus.com" }];
    const [a, b, c] = await Promise.all([
      getPage("https://www.javbus.com/page/1"),
      getPage("https://www.javbus.com/page/2"),
      getPage("https://www.javbus.com/search/x/1"),
    ]);
    check("三个并发请求都通过", [a, b, c].every((p) => p.html.includes("TST-001")));
    check("「需要手动确认」只弹一次", prompts.length === 1);
    check("验证表单只提交了一轮（取消重定向 + 跟随各一次）", seen.filter((s) => s.method === "POST").length === 2);
  }

  // 出厂设置里网友推荐已经交给社区服务，还走原作者 Apps Script 的是作者精选，所以这一节用作者通道
  console.log("推荐上传（原作者的 Apps Script，作者精选走它）：POST → 302 → 显式用 GET 取结果码");
  {
    const { sendRecommendation } = await import("../JavBus/kit/recommend");
    const item = { code: "TST-001", info: "TST-001 | 2026-10-22", src: "s", link: "l" };
    for (const keeps of [false, true]) {
      reset();
      behaviour.redirectKeepsMethod = keeps;
      const outcome = await sendRecommendation("author", "upload", item, "1234");
      const hops = seen.filter((x) => x.path.startsWith("/macros/"));
      const label = keeps ? "运行时沿用 POST 时" : "运行时改 GET 时";
      check(`${label}：拿到「成功」`, outcome.ok && outcome.message === "成功！");
      check(`${label}：第一跳是带 JSON 的 POST，载荷带作者密码`, hops[0]?.method === "POST" && JSON.parse(hops[0].body).mode === "upload" && JSON.parse(hops[0].body).pw === "1234");
      check(`${label}：跳转后是 GET，没有请求体和 Content-Type`, hops[1]?.method === "GET" && hops[1].body === "" && hops[1].contentType === "");
    }
    reset();
    behaviour.echoResult = "RE";
    check("返回码 RE 照常翻译", (await sendRecommendation("author", "upload", item, "1234")).message === "该影片已在推荐列表！");
    reset();
    behaviour.echoResult = "NA";
    check("作者通道的 NA 用原版文案「密码错误！」（不是社区服务那句）", (await sendRecommendation("author", "upload", item, "0000")).message === "密码错误！");
    reset();
    behaviour.echoResult = GOOGLE_ERROR_HTML;
    const page = await sendRecommendation("author", "upload", item, "1234");
    check("服务端回 Google 错误页：给出可见文字，不把网页当错误代码", !page.ok && !!page.serviceError?.includes("Sorry, unable to open the file") && !page.message.includes("<"));
    check("错误页提示带上状态码和最终地址（不带令牌），剪贴板同一份", !!page.serviceError?.includes("HTTP 200") && page.serviceError.includes("script.googleusercontent.com/macros/echo") && !page.serviceError.includes("user_content_key") && page.copy === page.serviceError);
    check("原作者的服务：请求里没有设备号（设备号只发给社区服务）", seen.every((s) => s.deviceId === ""));
  }

  console.log("社区推荐服务（只管网友推荐）：上传 / 撤销 / 举报 / 测试连接 / 列表");
  {
    const { sendRecommendation, sendReport, testCommunity, fetchRecLists, usesCommunity } = await import("../JavBus/kit/recommend");
    const { updateSettings } = await import("../JavBus/kit/settings");
    const item = { code: "TST-001", info: "TST-001 | 2026-10-22", src: "s", link: "l" };
    const COMMUNITY = "https://jc.example.workers.dev";
    const uploads = (path: string) => seen.filter((s) => s.path === path);

    reset();
    check("出厂设置：已经填好社区地址，网友推荐走它，作者精选不走", getSettings().communityUrl === COMMUNITY_URL && usesCommunity("user") && !usesCommunity("author"));
    const authorReport = await sendReport("author", "TST-001", "dead");
    check("作者精选不归社区服务管：举报直接拒绝，也不发请求", !authorReport.ok && authorReport.message.includes("社区") && seen.length === 0);

    updateSettings({ communityUrl: `${COMMUNITY}/` });
    check("改成别的社区地址（末尾斜杠被去掉）→ 网友推荐走它", getSettings().communityUrl === COMMUNITY && usesCommunity("user"));

    // 上传
    const ok = await sendRecommendation("user", "upload", item);
    const post = uploads("/api/v1/upload/user");
    check("上传：成功", ok.ok && ok.message === "成功！");
    check("上传：POST 到社区的 /api/v1/upload/user，JSON 载荷", post.length === 1 && post[0].method === "POST" && post[0].contentType === "application/json" && JSON.stringify(JSON.parse(post[0].body)) === JSON.stringify({ av: item, mode: "upload" }));
    check("上传：带设备号（32 位十六进制）", post[0].deviceId === EXPECTED_DEVICE_ID);
    check("上传：直接拿结果，没有 Apps Script 那套跳转（只有一次请求）", seen.length === 1);
    check("设备号存进了 Storage，下次还是这一个", store.get("javbus.deviceId") === EXPECTED_DEVICE_ID);

    // 返回码
    for (const [code, expectOk, word] of [
      ["PD", true, "审核"],
      ["RE", false, "已在推荐列表"],
      ["FE", false, "格式错误"],
      ["RL", false, "太频繁"],
      ["BN", false, "封禁"],
      ["OFF", false, "暂停收稿"],
      ["FULL", false, "已满"],
    ] as const) {
      behaviour.communityResult = code;
      const outcome = await sendRecommendation("user", "upload", item);
      check(`返回码 ${code}：${expectOk ? "算成功" : "不算成功"}，提示里有「${word}」`, outcome.ok === expectOk && outcome.code === code && outcome.message.includes(word));
    }

    // 作者通道：不归社区服务管，照旧打到原作者的 Apps Script（作者密码、302 改 GET、不带设备号）
    seen.length = 0;
    behaviour.communityResult = "succeed";
    behaviour.echoResult = "succeed";
    const author = await sendRecommendation("author", "upload", item, "1234");
    const authorHops = seen.filter((s) => s.path.startsWith("/macros/"));
    check("作者通道：不往社区的 /api/v1/upload/author 发", uploads("/api/v1/upload/author").length === 0);
    check(
      "作者通道：POST 到原作者的 Apps Script，载荷带作者密码，跳转后用 GET 取结果",
      author.ok && authorHops[0]?.method === "POST" && JSON.parse(authorHops[0].body).pw === "1234" && authorHops[1]?.method === "GET",
    );
    check("作者通道：不带设备号（设备号只发给社区服务）", authorHops.length === 2 && authorHops.every((s) => s.deviceId === ""));

    // 撤销：不带口令也能发，NA 带 code 回来（页面据此改问口令）
    seen.length = 0;
    behaviour.communityResult = "NA";
    const del = await sendRecommendation("user", "del", "TST-001");
    const delBody = JSON.parse(uploads("/api/v1/upload/user")[0].body);
    check("撤销：av 是番号字符串，不带 pw 字段", delBody.av === "TST-001" && delBody.mode === "del" && !("pw" in delBody));
    check("撤销被拒绝（NA）：不算成功，带 code，提示里说明是口令不对或不是你提交的", !del.ok && del.code === "NA" && del.message.includes("不是你提交"));

    // 举报
    seen.length = 0;
    behaviour.communityResult = "succeed";
    const report = await sendReport("user", "TST-001", "dead");
    const reportPost = uploads("/api/v1/report");
    check("举报：POST /api/v1/report，载荷是 channel / code / reason，带设备号", report.ok && reportPost.length === 1 && JSON.stringify(JSON.parse(reportPost[0].body)) === JSON.stringify({ channel: "user", code: "TST-001", reason: "dead" }) && reportPost[0].deviceId === EXPECTED_DEVICE_ID);
    behaviour.communityResult = "NF";
    check("举报：条目已不在列表 → NF 的提示", (await sendReport("user", "TST-001", "dead")).message.includes("不在列表"));

    // 测试连接
    seen.length = 0;
    behaviour.communityMeta = { status: 200, body: JSON.stringify({ name: "我们的推荐", version: "1.0.0", maintenance: false, autoApprove: true, channels: { user: 7, author: 3 } }) };
    const connected = await testCommunity(`${COMMUNITY}/`);
    check("测试连接：通过，显示名字和网友推荐的条数", connected.ok && connected.message === "连接成功：我们的推荐（网友推荐 7 条）");
    check("测试连接：请求的是 /api/v1/meta，不带设备号", seen.length === 1 && seen[0].path === "/api/v1/meta" && seen[0].deviceId === "");
    behaviour.communityMeta = { status: 404, body: "Not Found" };
    check("测试连接：地址对不上（404）→ 提示状态码", (await testCommunity(COMMUNITY)).message.includes("404"));
    behaviour.communityMeta = { status: 200, body: "<html>hello</html>" };
    check("测试连接：返回的不是 JSON → 不是社区服务", (await testCommunity(COMMUNITY)).message.includes("不是社区推荐服务"));
    behaviour.communityMeta = { status: 200, body: JSON.stringify({ hello: "world" }) };
    check("测试连接：是 JSON 但结构不对 → 不是社区服务", !(await testCommunity(COMMUNITY)).ok);
    seen.length = 0;
    check("测试连接：地址不合格不发请求", !(await testCommunity("nope")).ok && seen.length === 0);

    // 列表
    seen.length = 0;
    const lists = await fetchRecLists(true);
    check("列表：网友推荐从社区服务拉，作者精选照旧从原作者的 GitLab 地址拉", seen.map((s) => s.path).sort().join() === "/Nicked639/javrev/raw/master/Rec,/api/v1/rec/user");
    check("列表：照常清洗（作者精选是原作者的一条，网友推荐是社区的两条）", lists.author.length === 1 && lists.author[0].code === "ORI-001" && lists.user.length === 2 && lists.user[0].code === "CMT-001");
    seen.length = 0;
    await fetchRecLists();
    check("同一个地址：用缓存，不重复请求", seen.length === 0);

    // 清空地址：回到出厂的默认地址（出厂填了地址，网友推荐就关不掉社区服务——原作者的网友推荐上传早就坏了，这是有意的）
    updateSettings({ communityUrl: "" });
    check("清空社区地址 → 回到出厂默认地址，网友推荐照旧走社区", getSettings().communityUrl === COMMUNITY_URL && usesCommunity("user"));
    // 缓存是按地址的：换了服务地址，旧列表不能顶替，要重新拉
    seen.length = 0;
    await fetchRecLists();
    check("换了服务地址：不沿用旧缓存，重新拉了两份", seen.map((s) => s.path).sort().join() === "/Nicked639/javrev/raw/master/Rec,/api/v1/rec/user");
  }

  console.log("JavDB 评分：三种结果与浏览器兜底");
  {
    reset();
    const ok = await findJavdbRating("TST-014");
    check("取目标番号那张卡片，不是第一张", ok.kind === "ok" && ok.score === "4.57" && ok.count === "4217");
    const none = await findJavdbRating("TST-015");
    check("那张卡片没人评分：none", none.kind === "none");
    behaviour.javdb = "empty";
    check("JavDB 自己的「暫無內容」页：none，不是失败", (await findJavdbRating("TST-014")).kind === "none");

    reset();
    behaviour.javdb = "forbidden";
    const blocked = await findJavdbRating("TST-014");
    check("403 且没有浏览器兜底：failed 并带状态码", blocked.kind === "failed" && blocked.reason === "HTTP 403");
    behaviour.javdb = "challenge";
    const challenge = await findJavdbRating("TST-014");
    check("200 但是挑战页：failed，不当成没有评分", challenge.kind === "failed" && challenge.reason.includes("拦截"));
    behaviour.javdb = "drop";
    const dropped = await findJavdbRating("TST-014");
    check("连接被掐断：failed，原因是网络", dropped.kind === "failed" && dropped.reason.includes("网络"));

    reset();
    behaviour.javdb = "blocked";
    installScraper({ ok: true, data: [{ code: "TST-014", text: "4.57分, 由4217人評價" }] });
    const blockedIp = await findJavdbRating("TST-014");
    check("JavDB 把 IP 屏蔽了：failed，原因写明", blockedIp.kind === "failed" && blockedIp.reason === "IP 被 JavDB 屏蔽");
    check("被屏蔽时不再走浏览器兜底（同一个出口，白等）", scraperCalls.length === 0);

    reset();
    behaviour.javdb = "forbidden";
    installScraper({ ok: true, data: [{ code: "TST-101", text: "4.13分, 由594人評價" }, { code: "tst014", text: "4.57分, 由4217人評價" }] });
    const viaBrowser = await findJavdbRating("TST-014");
    check("直接请求被拦、浏览器内核兜底拿到评分", viaBrowser.kind === "ok" && viaBrowser.score === "4.57" && scraperCalls.length === 1);
    check("兜底请求的地址与选择器", String(scraperCalls[0]?.url).includes("search?q=TST-014") && String(scraperCalls[0]?.extractScript).includes(".movie-list .item"));
    installScraper({ ok: false });
    const bothFail = await findJavdbRating("TST-014");
    check("兜底也失败：仍报第一次的原因", bothFail.kind === "failed" && bothFail.reason === "HTTP 403");
    installScraper({ ok: true, data: [] });
    const emptyBrowser = await findJavdbRating("TST-014");
    check("浏览器里一张卡片都没有：none", emptyBrowser.kind === "none");
  }

  console.log("cookie 罐");
  {
    reset();
    check("非 javbus 域名不带 cookie", cookieHeader("https://example.com/x") === "");
    const jar = cookieCounts();
    check("罐初始为空", jar.com === 0 && jar.org === 0);
  }

  server.close();
  console.log(`\n${passed} 项通过，${failed} 项失败`);
  if (failed > 0) process.exit(1);
}

void main();
