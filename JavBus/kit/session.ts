// 站点会话：靠 web 视图取 cookie。
//
// 1. warmSession：原版启动时在后台加载一遍 javbus.com，把 web 视图里的 cookie 读出来给图片请求用
//    （Cloudflare 的 cf_clearance 之类只有真浏览器内核能拿到）。UA 和我们自己的请求保持一致，
//    因为 cf_clearance 是和 UA 绑定的。
// 2. manualAgeVerify：站点年龄验证自动提交失败时的兜底——弹出真网页让用户亲手勾选，
//    关掉后把 web 视图里的 cookie 读回来。这条路不需要猜站点用的是哪个 cookie。

import { MOBILE_UA, SITE_ORIGIN } from "../core/constants";
import { absorb } from "./cookies";

const WARM_TIMEOUT_MS = 12_000;

let warming: Promise<void> | null = null;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(undefined);
      },
    );
  });
}

/** 启动时调一次，后台跑，失败无声（只影响图片是否能过 Cloudflare，不影响功能）。重复调用复用同一次。 */
export function warmSession(): Promise<void> {
  if (!warming) {
    warming = (async () => {
      const web = new WebViewController({ ephemeral: false });
      try {
        web.setCustomUserAgent(MOBILE_UA);
        await withTimeout(web.loadURL(`${SITE_ORIGIN}/`), WARM_TIMEOUT_MS);
        absorb(await web.getAllCookies());
      } catch (error) {
        console.log(`[JavBus] 预热站点会话失败：${String(error)}`);
      } finally {
        web.dispose();
      }
    })();
  }
  return warming;
}

/** 弹出站点的年龄验证页让用户手动确认；关闭后吸收 web 视图里的 cookie。 */
export async function manualAgeVerify(gateUrl: string): Promise<void> {
  const web = new WebViewController({ ephemeral: false });
  try {
    web.setCustomUserAgent(MOBILE_UA);
    // 不等加载完：页面卡住时用户也得先看到界面，加载过程在界面里自己看得到
    void web.loadURL(gateUrl).catch(() => false);
    await web.present({ navigationTitle: "站点年龄验证" });
    absorb(await web.getAllCookies());
  } finally {
    web.dispose();
  }
}
