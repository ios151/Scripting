// 缓存：图标落盘，其余散在 Storage 里的也在这里统一登记，好一起看、一起清。
//
// 为什么要缓存图标：一百多个 App 的图标是一个个取的，每次进应用管理都重取一遍，
// 要等十几秒，而图标基本不变。存在文件里，下次直接读，只补新装的那几个。
//
// 清理这件事要做得干净：用户点「清除全部缓存」之后，应该连带把内存里那份也扔掉，
// 否则界面还显示着旧数据，看着像没清掉。所以内存缓存也登记在这儿，由这里统一清。

import { debugLog, describeError } from "../core/debug";
import { clearStoreLinkCache } from "./appStore";
import { formatBytes } from "./services";

/** 图标缓存目录。放文档目录下，和主屏备份并列。 */
function iconDirectory(): string {
  return `${FileManager.documentsDirectory}/缓存/图标`;
}

/** bundle ID 直接当文件名不安全（有点号没关系，但别的字符要挡）。 */
function iconPath(bundleId: string): string {
  return `${iconDirectory()}/${bundleId.replace(/[^A-Za-z0-9._-]/g, "_")}.png`;
}

/** 读缓存里已有的图标。缺的不在返回值里，由调用方去设备上取。 */
export async function loadCachedIcons(bundleIds: string[]): Promise<Map<string, Uint8Array>> {
  const found = new Map<string, Uint8Array>();
  const dir = iconDirectory();
  if (!(await FileManager.exists(dir))) return found;
  for (const bundleId of bundleIds) {
    const path = iconPath(bundleId);
    try {
      if (await FileManager.exists(path)) found.set(bundleId, await FileManager.readAsBytes(path));
    } catch (error) {
      // 单个文件坏了不影响其余，当成没缓存重取就行
      debugLog("cache", `图标缓存读不出 ${bundleId}`, describeError(error));
    }
  }
  debugLog("cache", `图标缓存命中 ${found.size}/${bundleIds.length}`);
  return found;
}

export async function saveCachedIcons(icons: Map<string, Uint8Array>): Promise<void> {
  if (icons.size === 0) return;
  const dir = iconDirectory();
  await FileManager.createDirectory(dir, true);
  for (const [bundleId, png] of icons) {
    try {
      await FileManager.writeAsBytes(iconPath(bundleId), png);
    } catch (error) {
      debugLog("cache", `图标缓存写不进 ${bundleId}`, describeError(error));
    }
  }
  debugLog("cache", `图标缓存写入 ${icons.size} 个`);
}

// ── 登记：所有缓存都在这张表里 ────────────────────────────────────────────

/** 存在 Storage 里的缓存键。只登记「重算得出来」的，用户设置不算缓存。 */
const STORAGE_CACHE_KEYS = ["appSizes", "storeLinks"];

export interface CacheEntry {
  name: string;
  detail: string;
  /** 占用字节；算不出来为 null。 */
  bytes: number | null;
}

async function iconCacheInfo(): Promise<CacheEntry> {
  const dir = iconDirectory();
  if (!(await FileManager.exists(dir))) return { name: "App 图标", detail: "没有缓存", bytes: 0 };
  try {
    const names = await FileManager.readDirectory(dir);
    let total = 0;
    for (const name of names) {
      const path = name.startsWith("/") ? name : `${dir}/${name}`;
      total += (await FileManager.stat(path)).size;
    }
    return { name: "App 图标", detail: `${names.length} 个`, bytes: total };
  } catch (error) {
    debugLog("cache", "算图标缓存大小失败", describeError(error));
    return { name: "App 图标", detail: "算不出来", bytes: null };
  }
}

/** 给界面看的缓存清单。 */
export async function cacheSummary(): Promise<CacheEntry[]> {
  const entries: CacheEntry[] = [await iconCacheInfo()];
  const sizes = Storage.get<{ sizes?: Record<string, unknown> }>("appSizes");
  const sizeCount = sizes?.sizes ? Object.keys(sizes.sizes).length : 0;
  entries.push({ name: "App 占用空间", detail: sizeCount > 0 ? `${sizeCount} 个` : "没有缓存", bytes: null });
  const links = Storage.get<Record<string, unknown>>("storeLinks");
  const linkCount = links ? Object.keys(links).length : 0;
  entries.push({ name: "App Store 链接", detail: linkCount > 0 ? `${linkCount} 个` : "没有缓存", bytes: null });
  return entries;
}

export function totalCacheBytes(entries: CacheEntry[]): number {
  return entries.reduce((sum, entry) => sum + (entry.bytes ?? 0), 0);
}

export function cacheSizeText(entries: CacheEntry[]): string {
  const known = entries.filter((entry) => entry.bytes !== null);
  if (known.length === 0) return "—";
  return formatBytes(totalCacheBytes(entries));
}

/**
 * 清掉全部缓存，包括内存里的那几份。
 * 只删缓存，不碰设置、配对记录和主屏备份——那些丢了要重新配，不是「重算得出来」的东西。
 */
export async function clearAllCaches(): Promise<void> {
  const dir = iconDirectory();
  if (await FileManager.exists(dir)) {
    await FileManager.remove(dir).catch((error) => debugLog("cache", "删图标缓存失败", describeError(error)));
  }
  for (const key of STORAGE_CACHE_KEYS) Storage.remove(key);
  // 内存里那份也要扔，不然界面还显示着旧数据
  clearStoreLinkCache();
  debugLog("cache", "缓存已清空");
}
