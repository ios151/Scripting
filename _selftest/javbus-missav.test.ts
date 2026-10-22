// 离线自测：kit/missav.ts 的探测脚本与「电脑版 / 手机版页面」的选择（WebViewController 换成假页面）。
//   npx -y -p tsx tsx _selftest/javbus-missav.test.ts
//
// 探测脚本是一段要在真实页面里跑的 JS，这里用 new Function 把它放进假的 document / performance 里执行，
// 验证它在几种页面形态下挑出的地址：原生 HLS（src 直接是 m3u8）、hls.js + MSE（src 是 blob:，清单只在资源请求里）、
// 清单请求被缩略图挤出缓冲区之外。真实的 MissAV 页面这台机器上打不开（Cloudflare 挑战页），所以页面形态是按
// hls.js 的通行做法假设的，没有对着真页面验证过。

import { DESKTOP_UA, MISSAV_ORIGIN, MOBILE_UA } from "../JavBus/core/constants";
import { PROBE_SCRIPT, resolveMissavStream } from "../JavBus/kit/missav";
import { updateSettings } from "../JavBus/kit/settings";

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

// ———— Scripting 运行时替身 ————

(globalThis as any).Storage = { get: () => null, set: () => true };

interface FakePage {
  /** video 元素的 src / currentSrc；null = 页面里没有 video。 */
  video: { src: string; currentSrc: string } | null;
  /** 资源请求（performance 里的 name）。 */
  resources: string[];
}

const page: FakePage = { video: null, resources: [] };
let bufferSizeCalls: number[] = [];

/** 在假页面里跑探测脚本。 */
function runProbe(p: FakePage, script: string = PROBE_SCRIPT): unknown {
  bufferSizeCalls = [];
  const document = { querySelector: (selector: string) => (p.video && /video/.test(selector) ? p.video : null) };
  const performance = {
    setResourceTimingBufferSize: (n: number) => bufferSizeCalls.push(n),
    getEntriesByType: () => p.resources.map((name) => ({ name })),
  };
  return new Function("document", "performance", script)(document, performance);
}

class FakeWeb {
  static created: FakeWeb[] = [];
  ua = "";
  url = "";
  disposed = false;
  constructor() {
    FakeWeb.created.push(this);
  }
  setCustomUserAgent(ua: string): boolean {
    this.ua = ua;
    return true;
  }
  loadURL(url: string): Promise<boolean> {
    this.url = url;
    return Promise.resolve(true);
  }
  async evaluateJavaScript(script: string): Promise<unknown> {
    return runProbe(page, script);
  }
  async getHTML(): Promise<string> {
    return "<html></html>";
  }
  dispose(): void {
    this.disposed = true;
  }
}
(globalThis as any).WebViewController = FakeWeb;

const MASTER = "https://surrit.com/0c1d2e3f-0000-4000-8000-123456789abc/playlist.m3u8";
const VARIANT = "https://surrit.com/0c1d2e3f-0000-4000-8000-123456789abc/1920x1080/video.m3u8";

async function main(): Promise<void> {
  const watchdog = setTimeout(() => {
    console.log("  ✗ 超时：探测循环没有在预期时间内返回");
    process.exit(1);
  }, 30_000);

  console.log("探测脚本");
  {
    check("原生 HLS：video.src 直接是 http(s) 清单，就用它", runProbe({ video: { src: MASTER, currentSrc: "" }, resources: [] }) === MASTER);
    check("src 空、currentSrc 有地址也行", runProbe({ video: { src: "", currentSrc: MASTER }, resources: [] }) === MASTER);
    check(
      "hls.js + MSE：src 是 blob:，从资源请求里取主清单（playlist.m3u8），排在子清单前后都一样",
      runProbe({ video: { src: "blob:https://missav.ws/abc", currentSrc: "" }, resources: ["https://x/a.jpg", VARIANT, MASTER] }) === MASTER &&
        runProbe({ video: { src: "blob:https://missav.ws/abc", currentSrc: "" }, resources: [MASTER, VARIANT] }) === MASTER,
    );
    check("只找得到子清单时退而求其次", runProbe({ video: { src: "blob:x", currentSrc: "" }, resources: ["https://x/a.jpg", VARIANT] }) === VARIANT);
    check("清单地址带查询串也认", runProbe({ video: { src: "", currentSrc: "" }, resources: [`${MASTER}?token=1`] }) === `${MASTER}?token=1`);
    check("页面里没有 video 元素时也看资源请求", runProbe({ video: null, resources: [MASTER] }) === MASTER);
    check("什么都没有返回空串（调用方当作还没好，下一轮再试）", runProbe({ video: { src: "blob:x", currentSrc: "" }, resources: ["https://x/a.jpg"] }) === "" && runProbe({ video: null, resources: [] }) === "");
    check("每次都先把资源计时缓冲区放大（缩略图多了会把清单请求挤掉）", bufferSizeCalls.length === 1 && bufferSizeCalls[0] >= 1000);
    // 缓冲区设置抛错（老环境没有这个方法）不能连累后面的判断
    const throwing = PROBE_SCRIPT.replace("performance.setResourceTimingBufferSize(2000)", "performance.noSuchMethod(2000)");
    check("放大缓冲区失败也不影响取地址", runProbe({ video: { src: MASTER, currentSrc: "" }, resources: [] }, throwing) === MASTER);
  }

  console.log("页面版本：电脑版 / 手机版 UA，缓存按版本分开");
  {
    page.video = { src: MASTER, currentSrc: "" };
    page.resources = [];
    FakeWeb.created.length = 0;

    const first = await resolveMissavStream("SSIS-123");
    const web = FakeWeb.created[0];
    check("默认用电脑版 UA，页面地址是 站点/番号", first === MASTER && web.ua === DESKTOP_UA && web.url === `${MISSAV_ORIGIN}/SSIS-123`);
    check("取完就拆掉隐藏页", web.disposed);

    await resolveMissavStream("SSIS-123");
    check("同一番号同一版本：命中缓存，不再开页面", FakeWeb.created.length === 1);

    updateSettings({ missavDesktop: false });
    await resolveMissavStream("SSIS-123");
    check("在设置里关掉电脑版后：重新探测，用手机版 UA", FakeWeb.created.length === 2 && FakeWeb.created[1].ua === MOBILE_UA);

    await resolveMissavStream("SSIS-123");
    check("手机版的结果也各自缓存", FakeWeb.created.length === 2);

    updateSettings({ missavDesktop: true });
    await resolveMissavStream("SSIS-123");
    check("切回电脑版：直接用之前电脑版的缓存", FakeWeb.created.length === 2);

    page.video = { src: "blob:https://missav.ws/abc", currentSrc: "" };
    page.resources = ["https://x/a.jpg", VARIANT, MASTER];
    const viaResources = await resolveMissavStream("ABC-001");
    check("电脑版页面把 src 换成 blob: 时，从资源请求里取到主清单", viaResources === MASTER);
  }

  clearTimeout(watchdog);
  console.log(`\n${passed} 项通过，${failed} 项失败`);
  if (failed > 0) process.exit(1);
}

void main();
