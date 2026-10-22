// 站点请求：UA / Referer / Cookie、超时、年龄验证、统一的错误类型。
//
// 原版直接 `$http.request`，没处理过任何失败形态：网络错只在个别地方弹一句，
// 解析失败直接抛 TypeError。这里把「拿页面」收成一个入口，错误全部落成 SiteError，
// 调用方只需要把 message 展示出来。

import { MOBILE_UA, REQUEST_TIMEOUT } from "../core/constants";
import { is404, isAgeGate, isNoResult } from "../core/parse";
import { absorb, cookieHeader, groupOf, isJavbusUrl } from "./cookies";
import { manualAgeVerify } from "./session";
import { getFlags, setFlag } from "./settings";

export type SiteErrorCode = "network" | "ageGate";

export class SiteError extends Error {
  readonly code: SiteErrorCode;
  constructor(code: SiteErrorCode, message: string) {
    super(message);
    this.name = "SiteError";
    this.code = code;
  }
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface PageOptions {
  /** 「全部」= 带上没有磁链的影片（existmag=all）；默认只看「收录」（existmag=mag）。 */
  all?: boolean;
  timeout?: number;
  referer?: string;
}

export interface Page {
  html: string;
  /** 跟随重定向之后的最终地址。 */
  url: string;
  status: number;
}

function originOf(url: string): string {
  return /^[a-z]+:\/\/[^/?#]+/i.exec(url)?.[0] ?? "";
}

/** 页面请求头。非 javbus 域名不带 cookie，也不乱带 Referer。 */
export function siteHeaders(url: string, opts: Pick<PageOptions, "all" | "referer"> = {}): Record<string, string> {
  const headers: Record<string, string> = {
    "User-Agent": MOBILE_UA,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  };
  if (isJavbusUrl(url)) {
    headers.Referer = opts.referer ?? `${originOf(url)}/`;
    headers.Cookie = cookieHeader(url, { existmag: opts.all ? "all" : "mag" });
  } else if (opts.referer) {
    headers.Referer = opts.referer;
  }
  return headers;
}

async function send(url: string, opts: PageOptions): Promise<Page> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: siteHeaders(url, opts),
      timeout: opts.timeout ?? REQUEST_TIMEOUT,
    });
  } catch {
    throw new SiteError("network", "网络错误或无法访问");
  }
  absorb(res.cookies);
  let html: string;
  try {
    html = await res.text();
  } catch {
    throw new SiteError("network", "读取页面失败");
  }
  return { html, url: res.url || url, status: res.status };
}

// 年龄验证按站点（.com / .org 各一份 cookie 罐）单飞：列表一翻页、首页和搜索并发，常常好几个请求一起撞上
// 验证页，只能弹一次确认、只提交一次；其他请求等这一轮结束后各自重试自己的请求
const gating = new Map<string, Promise<void>>();

/** 提交验证表单。返回这次有没有吸收到新的 cookie。 */
async function postGate(gateUrl: string, follow: boolean): Promise<boolean> {
  const res = await fetch(gateUrl, {
    method: "POST",
    headers: { ...siteHeaders(gateUrl), "Content-Type": "application/x-www-form-urlencoded" },
    body: `Submit=${encodeURIComponent("確認")}`,
    timeout: REQUEST_TIMEOUT,
    handleRedirect: follow
      ? async (next) => {
          absorb(next.cookies);
          return next;
        }
      : async () => null,
  });
  return absorb(res.cookies);
}

/**
 * 通过站点的年龄验证（勾选「我已經成年」再提交本页）。
 *
 * 这是代用户去点站点的同意框，所以：第一次要问，用户同意才提交，同意记下来下次不再问；
 * 用户拒绝就抛 ageGate 错误，不绕过。提交后 cookie 没生效的话，退到让用户在真网页里亲手勾选。
 * @param probeUrl 提交之后拿它再请求一次，看验证页是不是真的放行了
 */
async function resolveGate(gateUrl: string, probeUrl: string, opts: PageOptions): Promise<void> {
  if (!getFlags().siteAge) {
    const ok = await Dialog.confirm({
      title: "站点年龄验证",
      message:
        "JavBus 要求先确认你已年满 18 岁（勾选「我已經成年」并提交）。\n\n你已在本脚本的 18+ 提示里确认过，是否让脚本代你向站点提交这次确认？",
      confirmLabel: "确认并继续",
      cancelLabel: "取消",
    });
    if (!ok) throw new SiteError("ageGate", "已取消站点年龄验证，无法浏览");
    setFlag("siteAge", true);
  }

  // Set-Cookie 通常挂在提交后的那一跳 302 上。先不跟随重定向、直接读这一跳的 cookie；
  // 运行时把「取消重定向」当成请求失败抛出来、或者这一跳没带出新 cookie，都换成跟随并从重定向请求里捞。
  // 两种都没带回 cookie 也不要紧：下面会拿原请求再探一次，仍被挡住就让用户去网页上亲手确认
  let submitted = false;
  let got = false;
  try {
    got = await postGate(gateUrl, false);
    submitted = true;
  } catch {
    /* 取消重定向被当成失败：下面换跟随版 */
  }
  if (!got) {
    try {
      await postGate(gateUrl, true);
      submitted = true;
    } catch {
      /* 两种都失败才算网络问题 */
    }
  }
  if (!submitted) throw new SiteError("network", "提交站点年龄验证失败，请检查网络");

  const probe = await send(probeUrl, opts);
  if (!isAgeGate(probe.html, probe.url)) return;

  const manual = await Dialog.confirm({
    title: "需要手动确认",
    message: "自动提交的年龄确认没有生效。要打开站点网页，由你亲手勾选并确认吗？",
    confirmLabel: "打开网页",
    cancelLabel: "取消",
  });
  if (!manual) throw new SiteError("ageGate", "站点年龄验证没有通过");
  await manualAgeVerify(probe.url);
}

/**
 * Cloudflare 挑战页（403 / 503）、限流（429）、5xx 都不是「没有结果」：不认出来的话，
 * 搜索会逐站跳过然后报「搜索无果」，列表显示「暂无影片」，把真正的原因藏起来。
 * 站点自己的 404 页和「沒有您要的結果」页不算，由调用方按内容处理。
 */
function assertUsable(page: Page): Page {
  if (is404(page.html) || isNoResult(page.html)) return page;
  if (page.status === 403 || page.status === 429 || page.status >= 500) {
    throw new SiteError("network", `站点返回 ${page.status}，可能被拦截或暂时不可用`);
  }
  return page;
}

/** 取一个 JavBus 页面的 HTML。碰到年龄验证页会自动走一遍验证再重试。 */
export async function getPage(url: string, opts: PageOptions = {}): Promise<Page> {
  let page = await send(url, opts);
  if (!isAgeGate(page.html, page.url)) return assertUsable(page);

  const key = groupOf(page.url) ?? "other";
  let running = gating.get(key);
  if (!running) {
    running = resolveGate(page.url, url, opts).finally(() => {
      gating.delete(key);
    });
    gating.set(key, running);
  }
  await running;

  page = await send(url, opts);
  if (isAgeGate(page.html, page.url)) throw new SiteError("ageGate", "站点年龄验证没有通过");
  return assertUsable(page);
}

/** 其他站点（JavDB / Jable / 翻译 / 推荐 JSON…）的普通 GET：只管 UA 和超时，不管站点验证。 */
export async function getText(
  url: string,
  init: { headers?: Record<string, string>; timeout?: number } = {},
): Promise<{ text: string; status: number; url: string }> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { "User-Agent": MOBILE_UA, ...init.headers },
      timeout: init.timeout ?? REQUEST_TIMEOUT,
    });
  } catch {
    throw new SiteError("network", "网络错误或无法访问");
  }
  return { text: await res.text(), status: res.status, url: res.url || url };
}
