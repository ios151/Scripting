// 应用管理：列出用户装的 App（版本、占用空间、安装来源），以及卸载。
//
// 请求格式照 idevice（installation_proxy.rs）：
//   Lookup {ClientOptions: {ApplicationType, BundleIDs?, ReturnAttributes}} → LookupResult（bundle ID → 属性）
//   Uninstall {ApplicationIdentifier, ClientOptions} → 若干条进度，Status=Complete 收尾，出错带 ErrorDescription
//
// 占用空间（StaticDiskUsage / DynamicDiskUsage）要写进 ReturnAttributes 才有，但设备得把每个 App
// 的数据目录现算一遍。真机实测（152 个 App）：不带大小的 Lookup 70 ms；带大小用 Browse 一次取完
// 要 31.6 s，而且是一个个算、十个一批陆续回来的。所以分两步：
// - 先不带大小 Lookup，列表马上出来；
// - 大小按 bundle ID 十个一组，分几路连接并发 Lookup，回来一组填一组；算完存一份缓存，
//   下次进页先显示上次的数，后台再刷新。

import type { PlistValue } from "../core/bplist";
import { debugLog } from "../core/debug";
import { withTimeout } from "../core/stream";
import { compareNames } from "./homeOrganize";
import { isPlistDict, type PlistDict } from "./plist";
import { asNumber, formatBytes } from "./services";
import type { DeviceSession } from "./session";

export const INSTALLATION_PROXY_SERVICE = "com.apple.mobile.installation_proxy.shim.remote";

/** 只要这几项：不写的话每个 App 会把整份 Info.plist 带回来，两百个 App 能有好几 MB。 */
const BASIC_ATTRIBUTES = [
  "CFBundleIdentifier",
  "CFBundleDisplayName",
  "CFBundleName",
  "CFBundleShortVersionString",
  "CFBundleVersion",
  "SignerIdentity",
  "ProfileValidated",
  "Entitlements",
];

const SIZE_ATTRIBUTES = ["CFBundleIdentifier", "StaticDiskUsage", "DynamicDiskUsage"];

export type AppSource = "appStore" | "testFlight" | "development" | "distribution" | "other";

export const SOURCE_LABEL: Record<AppSource, string> = {
  appStore: "App Store",
  testFlight: "TestFlight",
  development: "开发签",
  distribution: "企业 / Ad Hoc",
  other: "其他签名",
};

export interface AppEntry {
  bundleId: string;
  name: string;
  version: string;
  build: string;
  /** 安装包大小。 */
  appSize: number | null;
  /** 文稿与数据。 */
  dataSize: number | null;
  source: AppSource;
  /** 签名证书名。App Store 下载的是固定的「Apple iPhone OS Application Signing」。 */
  signer: string;
  /** entitlements 里的 application-identifier，形如「TEAMID.com.example.app」，用来对描述文件。 */
  appIdentifier: string;
  teamId: string;
}

const APP_STORE_SIGNER = "Apple iPhone OS Application Signing";

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * 判断安装来源。依据都是公开工具里的通行做法，不是官方定义：
 * - TestFlight 包的 entitlements 带 beta-reports-active（它也是 Apple 重签的，所以先判）
 * - App Store 下载的由 Apple 重签，SignerIdentity 是固定的那个名字
 * - 开发证书签的（Xcode、AltStore、SideStore 这类自签）带 get-task-allow
 * - 企业 / Ad Hoc 用分发证书：证书名带 Distribution，或者带描述文件但没有 get-task-allow
 * 都对不上的归到「其他」，详情页能看到原始证书名。
 */
export function classifyApp(raw: PlistDict): AppSource {
  const entitlements = isPlistDict(raw.Entitlements) ? raw.Entitlements : {};
  const signer = text(raw.SignerIdentity);
  if (entitlements["beta-reports-active"] === true) return "testFlight";
  if (signer === APP_STORE_SIGNER) return "appStore";
  if (entitlements["get-task-allow"] === true) return "development";
  if (/Distribution/i.test(signer) || raw.ProfileValidated !== undefined) return "distribution";
  return "other";
}

export function totalSize(app: AppEntry): number {
  return (app.appSize ?? 0) + (app.dataSize ?? 0);
}

/** 版本号。build 和版本号一样时不重复写，不一样才用括号带上。 */
export function versionText(app: AppEntry): string {
  if (!app.version) return app.build || "—";
  return app.build && app.build !== app.version ? `${app.version}（${app.build}）` : app.version;
}

export type AppSort = "size" | "name" | "installed";

/**
 * 按安装 / 更新时间排（新的在前）。没有时间的垫底。
 *
 * 时间来自主屏布局里每个条目的 iconModDate——真机实测 237 个条目有 235 个不同取值，
 * 分布横跨几个月，最新的那个正是当天刚更新过的 App，所以它就是安装或更新的时间。
 * **这不是「最后使用时间」**：用得再多，只要没更新过，时间也不会变。
 */
export function sortApps(apps: AppEntry[], by: AppSort, installedAt?: Map<string, number>): AppEntry[] {
  if (by === "installed") {
    const at = (app: AppEntry) => installedAt?.get(app.bundleId) ?? -Infinity;
    return [...apps].sort((a, b) => at(b) - at(a) || compareNames(a.name, b.name));
  }
  return [...apps].sort((a, b) =>
    by === "size" ? totalSize(b) - totalSize(a) || compareNames(a.name, b.name) : compareNames(a.name, b.name),
  );
}

/**
 * 从主屏布局里刨出每个 App 的 iconModDate（毫秒）。
 * 文件夹里的也要（它们同样带这个字段），所以整棵树都走一遍。
 */
export function installTimes(raw: PlistValue): Map<string, number> {
  const times = new Map<string, number>();
  const walk = (value: PlistValue) => {
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (!isPlistDict(value)) return;
    const id = typeof value.bundleIdentifier === "string" ? value.bundleIdentifier : "";
    const at = asNumber(value.iconModDate);
    if (id && at !== null && at > 0 && !times.has(id)) times.set(id, at);
    for (const item of Object.values(value)) walk(item);
  };
  walk(raw);
  return times;
}

/** 「3 天前」这类说法，配合安装时间用。 */
export function sinceText(at: number | undefined, now = Date.now()): string {
  if (at === undefined) return "—";
  const days = Math.floor((now - at) / 86400000);
  if (days < 0) return "刚刚";
  if (days === 0) return "今天";
  if (days === 1) return "昨天";
  if (days < 30) return `${days} 天前`;
  const months = Math.floor(days / 30);
  return months < 12 ? `${months} 个月前` : `${Math.floor(days / 365)} 年前`;
}

/** LookupResult → 列表，默认按占用空间从大到小。 */
export function parseApps(result: unknown): AppEntry[] {
  if (!isPlistDict(result)) return [];
  const apps: AppEntry[] = [];
  for (const [key, value] of Object.entries(result)) {
    if (!isPlistDict(value)) continue;
    const entitlements = isPlistDict(value.Entitlements) ? value.Entitlements : {};
    const bundleId = text(value.CFBundleIdentifier) || key;
    const appIdentifier = text(entitlements["application-identifier"]);
    const dot = appIdentifier.indexOf(".");
    apps.push({
      bundleId,
      name: text(value.CFBundleDisplayName) || text(value.CFBundleName) || bundleId,
      version: text(value.CFBundleShortVersionString),
      build: text(value.CFBundleVersion),
      appSize: asNumber(value.StaticDiskUsage),
      dataSize: asNumber(value.DynamicDiskUsage),
      source: classifyApp(value),
      signer: text(value.SignerIdentity),
      appIdentifier,
      teamId: text(entitlements["com.apple.developer.team-identifier"]) || (dot > 0 ? appIdentifier.slice(0, dot) : ""),
    });
  }
  return sortApps(apps, "size");
}

/** 卸载 Scripting 自己等于把正在跑的脚本连根拔掉，界面上不给这个按钮。 */
export function isScriptingItself(app: AppEntry): boolean {
  return app.name.toLowerCase() === "scripting" || app.bundleId.toLowerCase().endsWith(".scripting");
}

export function appListText(apps: AppEntry[]): string {
  return apps
    .map((app) => {
      const version = app.build && app.build !== app.version ? `${app.version}（${app.build}）` : app.version;
      return `${app.name}  ${version} · ${SOURCE_LABEL[app.source]} · ${formatBytes(totalSize(app))} · ${app.bundleId}`;
    })
    .join("\n");
}

/** 应用列表，不带占用空间（见文件头）。大小用 readAppSizes 另取。 */
export async function readApps(session: DeviceSession, report: (status: string) => void = () => {}): Promise<AppEntry[]> {
  const response = await session.withService(INSTALLATION_PROXY_SERVICE, async (client) => {
    report("读取应用列表…");
    const started = Date.now();
    debugLog("apps", "Lookup 已发出");
    const reply = await client.request(
      { Command: "Lookup", ClientOptions: { ApplicationType: "User", ReturnAttributes: BASIC_ATTRIBUTES } },
      30000,
    );
    debugLog("apps", `Lookup 回包 ${Date.now() - started} ms，字段：${Object.keys(reply).join(", ")}`);
    return reply;
  });
  if (!isPlistDict(response.LookupResult)) throw new Error("设备没有返回应用列表");
  const apps = parseApps(response.LookupResult);
  debugLog("apps", `解析出 ${apps.length} 个 App`);
  return apps;
}

/**
 * 单个 App 的完整信息：不写 ReturnAttributes，设备会把整份 Info.plist 连同
 * entitlements 一起回来（这正是列表那边要限定字段的原因——两百个 App 好几 MB）。
 * 查一个 App 的时候没这个顾虑，正好拿来看配置。
 */
export async function readAppDetail(session: DeviceSession, bundleId: string): Promise<PlistDict> {
  const response = await session.withService(INSTALLATION_PROXY_SERVICE, (client) =>
    client.request({ Command: "Lookup", ClientOptions: { BundleIDs: [bundleId] } }, 30000),
  );
  const result = response.LookupResult;
  const detail = isPlistDict(result) ? result[bundleId] : undefined;
  if (!isPlistDict(detail)) throw new Error("设备没有返回这个 App 的信息");
  debugLog("apps", `${bundleId} 完整信息 ${Object.keys(detail).length} 个字段`);
  return detail;
}

/** Info.plist 里对开发者最常用的几项，详情页上直接列出来。 */
export const INFO_HIGHLIGHTS: [string, string][] = [
  ["CFBundleShortVersionString", "版本"],
  ["CFBundleVersion", "构建号"],
  ["MinimumOSVersion", "最低系统"],
  ["DTPlatformVersion", "打包 SDK"],
  ["DTXcode", "Xcode"],
  ["DTSDKName", "SDK 名称"],
  ["UIBackgroundModes", "后台模式"],
  ["LSApplicationQueriesSchemes", "可查询的 URL scheme"],
];

/** 这个 App 对外注册的 URL scheme（做跳转集成时要）。 */
export function urlSchemes(detail: PlistDict): string[] {
  const types = detail.CFBundleURLTypes;
  if (!Array.isArray(types)) return [];
  const schemes: string[] = [];
  for (const entry of types) {
    if (!isPlistDict(entry) || !Array.isArray(entry.CFBundleURLSchemes)) continue;
    for (const scheme of entry.CFBundleURLSchemes) if (typeof scheme === "string") schemes.push(scheme);
  }
  return [...new Set(schemes)];
}

/** entitlements 里最常看的几项，附带人话解释。 */
export const ENTITLEMENT_HIGHLIGHTS: [string, string][] = [
  ["aps-environment", "推送环境"],
  ["com.apple.security.application-groups", "App Groups"],
  ["keychain-access-groups", "Keychain 共享组"],
  ["com.apple.developer.associated-domains", "关联域名"],
  ["get-task-allow", "可调试"],
  ["beta-reports-active", "TestFlight 测试"],
];

export function entitlementsOf(detail: PlistDict): PlistDict {
  return isPlistDict(detail.Entitlements) ? detail.Entitlements : {};
}

export interface AppSizes {
  appSize: number | null;
  dataSize: number | null;
}

/** LookupResult → bundle ID → 大小。 */
export function parseSizes(result: unknown): Map<string, AppSizes> {
  const sizes = new Map<string, AppSizes>();
  if (!isPlistDict(result)) return sizes;
  for (const [key, item] of Object.entries(result)) {
    if (!isPlistDict(item)) continue;
    sizes.set(text(item.CFBundleIdentifier) || key, {
      appSize: asNumber(item.StaticDiskUsage),
      dataSize: asNumber(item.DynamicDiskUsage),
    });
  }
  return sizes;
}

export function withSizes(app: AppEntry, sizes: AppSizes | undefined): AppEntry {
  return sizes ? { ...app, appSize: sizes.appSize, dataSize: sizes.dataSize } : app;
}

/** 并发几路。会话最多 3 条连接，留一条给卸载这类操作，不然要等大小全算完才轮得到。 */
const SIZE_WORKERS = 2;
/** 每次 Lookup 带几个 App，和设备自己 Browse 时一批的个数一样。 */
const SIZE_CHUNK = 10;
/** 一组最多等多久。真机上慢的一组（碰上数据多的 App）要四五秒，给足余量。 */
const SIZE_CHUNK_TIMEOUT_MS = 120000;

/**
 * 后台取占用空间。每回来一组调一次 onBatch（这一组的大小、已完成几个、总数）。
 * 某一路出错时其余几路照常做完，最后再把第一个错误抛出来。
 */
export async function readAppSizes(
  session: DeviceSession,
  bundleIds: string[],
  onBatch: (sizes: Map<string, AppSizes>, done: number, total: number) => void,
): Promise<void> {
  const chunks: string[][] = [];
  for (let i = 0; i < bundleIds.length; i += SIZE_CHUNK) chunks.push(bundleIds.slice(i, i + SIZE_CHUNK));
  const started = Date.now();
  let next = 0;
  let done = 0;
  const worker = () =>
    session.withService(INSTALLATION_PROXY_SERVICE, async (client) => {
      while (next < chunks.length) {
        const chunk = chunks[next++];
        const reply = await client.request(
          { Command: "Lookup", ClientOptions: { ApplicationType: "User", BundleIDs: chunk, ReturnAttributes: SIZE_ATTRIBUTES } },
          SIZE_CHUNK_TIMEOUT_MS,
        );
        done += chunk.length;
        debugLog("apps", `占用空间 ${done}/${bundleIds.length}，已用 ${Date.now() - started} ms`);
        onBatch(parseSizes(reply.LookupResult), done, bundleIds.length);
      }
    });
  const workers = Math.min(SIZE_WORKERS, chunks.length);
  const results = await Promise.allSettled(Array.from({ length: workers }, worker));
  debugLog("apps", `占用空间取完：${workers} 路并发，${bundleIds.length} 个，${Date.now() - started} ms`);
  const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failure) throw failure.reason;
}

// ── 占用空间缓存 ──────────────────────────────────────────────────────────

const SIZE_CACHE_KEY = "appSizes";

interface SizeCacheRecord {
  savedAt: number;
  /** bundle ID → [安装包, 文稿与数据]。 */
  sizes: Record<string, [number | null, number | null]>;
}

function sizeOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function loadSizeCache(): { savedAt: number; sizes: Map<string, AppSizes> } | null {
  const record = Storage.get<SizeCacheRecord>(SIZE_CACHE_KEY);
  if (!record || typeof record.savedAt !== "number" || !record.sizes || typeof record.sizes !== "object") return null;
  const sizes = new Map<string, AppSizes>();
  for (const [bundleId, pair] of Object.entries(record.sizes)) {
    if (Array.isArray(pair)) sizes.set(bundleId, { appSize: sizeOrNull(pair[0]), dataSize: sizeOrNull(pair[1]) });
  }
  return { savedAt: record.savedAt, sizes };
}

/** 整份替换：已卸载的 App 自然就不在里面了。 */
export function saveSizeCache(sizes: Map<string, AppSizes>, now = Date.now()): void {
  const record: SizeCacheRecord = { savedAt: now, sizes: {} };
  for (const [bundleId, size] of sizes) record.sizes[bundleId] = [size.appSize, size.dataSize];
  Storage.set(SIZE_CACHE_KEY, record);
}

/** 「3 分钟前」这类说法。 */
export function formatAge(ms: number): string {
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours} 小时前` : `${Math.floor(hours / 24)} 天前`;
}

/** 卸载。App 和它的数据一起删掉，不可恢复——确认放在界面上做。 */
export async function uninstallApp(
  session: DeviceSession,
  bundleId: string,
  onProgress?: (percent: number) => void,
): Promise<void> {
  await session.withService(INSTALLATION_PROXY_SERVICE, async (client) => {
    await client.send({ Command: "Uninstall", ApplicationIdentifier: bundleId, ClientOptions: {} });
    await withTimeout(
      (async () => {
        for (;;) {
          // 带 Error 的回包 receiveDict 自己会抛，ErrorDescription 已经拼进消息里
          const message = await client.receiveDict();
          if (typeof message.ErrorDescription === "string") throw new Error(message.ErrorDescription);
          const percent = asNumber(message.PercentComplete);
          if (percent !== null) onProgress?.(percent);
          if (message.Status === "Complete") return;
        }
      })(),
      120000,
      "卸载超时",
    );
  });
}
