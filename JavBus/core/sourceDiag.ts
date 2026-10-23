// 片源诊断：详情页探测几个片源（MissAV 预览 / Jable 搜索 / Jable 完整视频 / MissAV 完整视频）时，每一个取没取到、卡在哪一步、用了多久。
// 纯逻辑，不碰 Scripting 全局，Node 里能直接自测；真去取地址的在 kit/sourceProbe.ts 和 kit/missav.ts，弹窗在详情页。
//
// 为什么要有它：用户反馈「大部分视频都没有完整版」，但 fourhoi 上的预览几乎都有（抽样 37 / 38），说明片多半是有的，
// 而 MissAV 和 Jable 的页面都躲在 Cloudflare 的验证页后面（「Just a moment...」）——取不到的原因在网络和验证上，
// 光看结果（没有 / 有）分不出是「这部片真没有」还是「被拦了」「超时了」「页面改版了」，所以每一步都记下来。

import { MISSAV_ORIGIN } from "./constants";

export type SourceId = "missavPreview" | "jable" | "jableHls" | "missavFull";
export type DiagState = "running" | "ok" | "none" | "failed";

export interface DiagEntry {
  id: SourceId;
  state: DiagState;
  /** 现在做到哪一步（结束后是最后一步）。 */
  step: string;
  /** 补充说明：失败 / 没有的原因，成功时可以是空串。 */
  detail: string;
  startedAt: number;
  /** 用了多久（毫秒）；还在跑的只是最近一次更新时的值，显示时用 `now - startedAt`。 */
  ms: number;
}

export type Board = Partial<Record<SourceId, DiagEntry>>;
export type Reporter = (patch: Partial<Pick<DiagEntry, "state" | "step" | "detail">>) => void;

export const SOURCE_NAMES: Record<SourceId, string> = {
  missavFull: "MissAV 完整视频",
  jable: "Jable 搜索",
  jableHls: "Jable 完整视频地址",
  missavPreview: "MissAV 预览",
};

/** 弹窗里的顺序：完整视频的两条路在前，预览在后。 */
export const SOURCE_ORDER: SourceId[] = ["missavFull", "jable", "jableHls", "missavPreview"];

/** MissAV 的页面地址。站点的地址都是小写的番号（`missav.ws/ssis-001`），预览用的也是小写。 */
export function missavPageUrl(code: string): string {
  return `${MISSAV_ORIGIN}/${code.trim().toLowerCase()}`;
}

/**
 * 是不是 Cloudflare 的验证页：标题是「Just a moment...」/「请稍候…」/「Attention Required」，或者页面里有验证脚本。
 * 真的站点页面这些都不会出现。
 */
export function isChallengePage(html: string): boolean {
  const title = /<title>([^<]*)<\/title>/i.exec(html)?.[1] ?? "";
  if (/just a moment|attention required|请稍候|請稍候|checking your browser/i.test(title)) return true;
  return /cdn-cgi\/challenge-platform|cf-chl-|id="challenge-form"|\/cdn-cgi\/l\/chk_jschl/i.test(html);
}

/** 页面标题（诊断里显示用）；没有就是空串。 */
export function titleOf(html: string): string {
  return (/<title>([^<]*)<\/title>/i.exec(html)?.[1] ?? "").replace(/\s+/g, " ").trim();
}

/** 标题是不是验证页的标题（网页视图里读 `document.title` 时用）。 */
export function isChallengeTitle(title: string): boolean {
  return /just a moment|attention required|请稍候|請稍候|checking your browser/i.test(title);
}

/** WebScraper 返回的错误 → 一句人话。 */
export function describeScrapeFailure(error: { code?: string; message?: string } | undefined, timedOut = false): string {
  if (timedOut) return "浏览器内核等了很久还没加载出真页面（多半卡在 Cloudflare 验证上）";
  if (!error) return "浏览器内核没有返回页面";
  const code = (error.code ?? "").toLowerCase();
  if (/cancel/.test(code)) return "浏览器内核的加载被取消了（超时）";
  if (/timeout/.test(code)) return "浏览器内核加载超时（多半卡在 Cloudflare 验证上）";
  return `浏览器内核报错：${error.message || error.code || "未知"}`;
}

export function formatSeconds(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  // 一位小数；不到 0.1 秒的也写 0.1，不写成「0.0 秒」
  return `${(Math.max(ms, 100) / 1000).toFixed(1)} 秒`;
}

export function stateText(state: DiagState): string {
  return state === "ok" ? "取到了" : state === "none" ? "没有" : state === "failed" ? "失败" : "进行中";
}

/** 诊断弹窗的正文：每个片源一段，写明结果、最后一步、原因、用时；也是「复制」出去发给开发者的那段文字。 */
export function formatDiagnostics(code: string, board: Board, now: number): string {
  const lines: string[] = [`番号 ${code}`];
  let any = false;
  for (const id of SOURCE_ORDER) {
    const entry = board[id];
    if (!entry) continue;
    any = true;
    const ms = entry.state === "running" ? now - entry.startedAt : entry.ms;
    lines.push("", `【${SOURCE_NAMES[id]}】${stateText(entry.state)}，${formatSeconds(ms)}`);
    if (entry.step) lines.push(`  最后一步：${entry.step}`);
    if (entry.detail) lines.push(`  ${entry.state === "ok" ? "说明" : "原因"}：${entry.detail}`);
  }
  if (!any) lines.push("", "还没有开始探测（进入详情页后才会去找片源）。");
  const status = fullVideoStatus(board);
  if (status === "failed") {
    lines.push(
      "",
      "完整视频两条路都没取到。如果上面写着 Cloudflare 验证页 / HTTP 403：多半是你现在的网络出口被站点判成可疑，" +
        "可以试试换个节点、关掉代理，或在 Safari 里直接打开 jable.tv / missav.ws 看看是不是也停在「请稍候…」。",
    );
  }
  return lines.join("\n");
}

/**
 * 完整视频现在的整体状况：ok = 至少一条路取到了；running = 还有路在取；failed = 试过的路都没取到；unknown = 一条都没开始。
 * Jable 是两步（搜索 → 播放页），只有搜索成功而播放页还没结果时也算在跑。
 */
export function fullVideoStatus(board: Board): "ok" | "running" | "failed" | "unknown" {
  const missav = board.missavFull;
  const jable = board.jable;
  const hls = board.jableHls;
  if (missav?.state === "ok" || hls?.state === "ok") return "ok";
  const jableRunning = jable?.state === "running" || (jable?.state === "ok" && (!hls || hls.state === "running"));
  if (missav?.state === "running" || jableRunning) return "running";
  // 到这里还在跑的已经在上面返回了：有记录就说明那条路跑完了（没取到）
  return missav !== undefined || jable !== undefined ? "failed" : "unknown";
}

/**
 * 登记一次探测：开始时记一条「进行中」，探测过程里通过 report 更新步骤 / 原因，结束时按返回值定结果——
 * 返回了东西 = 取到了；返回 null 且探测自己没写明结果 = 没有；抛异常 = 失败。探测自己写了 failed / none 的以它为准。
 *
 * 里面用 `async function track<T>` 而不是泛型箭头函数 `async <T>(…) =>`：设备上的转译把 .ts 也当 TSX 解析，
 * 裸的 `<T>(` 会被当成 JSX 标签，报「SyntaxError: Unexpected identifier 'run'」整个脚本起不来（要写箭头就得 `<T,>`）。
 */
export type Track = <T>(id: SourceId, run: (report: Reporter) => Promise<T | null>) => Promise<T | null>;

export function createTracker(onChange: (id: SourceId, entry: DiagEntry) => void, now: () => number = Date.now): Track {
  return async function track<T>(id: SourceId, run: (report: Reporter) => Promise<T | null>): Promise<T | null> {
    const startedAt = now();
    let entry: DiagEntry = { id, state: "running", step: "开始", detail: "", startedAt, ms: 0 };
    const publish = () => {
      entry = { ...entry, ms: now() - startedAt };
      onChange(id, entry);
    };
    publish();
    const report: Reporter = (patch) => {
      entry = { ...entry, ...patch };
      publish();
    };
    try {
      const value = await run(report);
      if (value) entry = { ...entry, state: "ok" };
      else if (entry.state === "running") entry = { ...entry, state: "none" };
      publish();
      return value;
    } catch (error) {
      entry = { ...entry, state: "failed", detail: error instanceof Error ? error.message : String(error) };
      publish();
      return null;
    }
  };
}
