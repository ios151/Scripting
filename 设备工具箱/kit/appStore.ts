// App Store 链接：按 bundle ID 查苹果的公开接口（itunes.apple.com/lookup），拿下载页链接和分类。
//
// 实测（2026-10-18）：
//   - bundleId 可以逗号分隔一次查多个，结果里带 bundleId，查不到的直接不出现
//   - lang 参数不影响分类名（总是英文），所以分类名在这里自己翻成中文
// 只发 bundle ID 和地区，别的什么都不发。接口有频率限制，所以只查用户选中的、一次一批，结果缓存。
//
// TestFlight、自签的 App 也拿去查：bundle ID 和 App Store 上的正式版一样时，能查到正式版的页面。
// TestFlight 的邀请链接（testflight.apple.com/join/…）设备上没有，查不到。

export interface StoreLink {
  url: string;
  /** App Store 上的名字，可能比主屏上的显示名长。 */
  name: string;
  /** 中文分类名。 */
  genre: string;
  /** 查到它的地区，如 cn、us。 */
  country: string;
}

/** 一次请求最多带几个 bundle ID。 */
export const LOOKUP_BATCH = 50;
const LOOKUP_TIMEOUT_MS = 15000;

/** App Store 的固定分类。没在表里的原样用英文。 */
const GENRE_NAMES: Record<string, string> = {
  Books: "图书",
  Business: "商务",
  "Developer Tools": "开发者工具",
  Education: "教育",
  Entertainment: "娱乐",
  Finance: "财务",
  "Food & Drink": "美食佳饮",
  Games: "游戏",
  "Graphics & Design": "图形和设计",
  "Health & Fitness": "健康健美",
  Kids: "儿童",
  Lifestyle: "生活",
  "Magazines & Newspapers": "报刊杂志",
  Medical: "医疗",
  Music: "音乐",
  Navigation: "导航",
  News: "新闻",
  "Photo & Video": "摄影与录像",
  Productivity: "效率",
  Reference: "参考资料",
  Shopping: "购物",
  "Social Networking": "社交",
  Sports: "体育",
  Travel: "旅游",
  Utilities: "工具",
  Weather: "天气",
};

export function genreName(english: string): string {
  return GENRE_NAMES[english] ?? english;
}

/** 去掉统计参数（?uo=4），分享出去干净些。 */
export function cleanStoreUrl(url: string): string {
  return url.split("?")[0];
}

/** 先查本机地区，查不到再查美区。systemLocale 形如 zh_CN、en_US。 */
export function countriesFor(locale: string): string[] {
  const region = (locale.split(/[_-]/)[1] ?? "").toLowerCase();
  return [...new Set([region, "us"].filter((code) => /^[a-z]{2}$/.test(code)))];
}

export function lookupUrl(bundleIds: string[], country: string): string {
  return `https://itunes.apple.com/lookup?bundleId=${bundleIds.map(encodeURIComponent).join(",")}&country=${country}&entity=software`;
}

/** 接口返回的 JSON → bundle ID → 链接。字段不全的条目丢掉。 */
export function parseLookup(json: unknown, country: string): Map<string, StoreLink> {
  const links = new Map<string, StoreLink>();
  const results = json && typeof json === "object" ? (json as { results?: unknown }).results : undefined;
  if (!Array.isArray(results)) return links;
  for (const item of results) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (typeof record.bundleId !== "string" || typeof record.trackViewUrl !== "string") continue;
    links.set(record.bundleId, {
      url: cleanStoreUrl(record.trackViewUrl),
      name: typeof record.trackName === "string" ? record.trackName : record.bundleId,
      genre: genreName(typeof record.primaryGenreName === "string" ? record.primaryGenreName : ""),
      country,
    });
  }
  return links;
}

export type JsonFetcher = (url: string) => Promise<unknown>;

const defaultFetcher: JsonFetcher = async (url) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`App Store 查询失败（HTTP ${response.status}）`);
  return response.json();
};

// 查过的结果存起来：接口有频率限制，而且同一个 App 的链接基本不变。
// null 表示各地区都没查到，这个「没有」也要记住，免得每次都白查一轮。
const CACHE_KEY = "storeLinks";

type CacheRecord = Record<string, StoreLink | null>;

/**
 * 第一次用到时才从 Storage 读，不在模块加载时读：模块级的副作用会让这个文件
 * 一被导入就要求 Storage 已经就绪，导入顺序一变就炸（离线测试里就是这么炸的）。
 */
let cache: Map<string, StoreLink | null> | null = null;

function links(): Map<string, StoreLink | null> {
  if (!cache) cache = new Map(Object.entries(Storage.get<CacheRecord>(CACHE_KEY) ?? {}));
  return cache;
}

function persistCache(): void {
  const record: CacheRecord = {};
  for (const [id, link] of links()) record[id] = link;
  Storage.set(CACHE_KEY, record);
}

export function clearStoreLinkCache(): void {
  cache = new Map();
  Storage.remove(CACHE_KEY);
}

/**
 * 查一组 App 的链接。返回的 Map 里只有查到的；查不到的不在里面。
 * 先查本机地区，剩下的再查下一个地区；每个地区按 LOOKUP_BATCH 分批。
 */
export async function findStoreLinks(
  bundleIds: string[],
  options: { locale: string; fetcher?: JsonFetcher },
): Promise<Map<string, StoreLink>> {
  const fetcher = options.fetcher ?? defaultFetcher;
  const found = new Map<string, StoreLink>();
  let pending = [...new Set(bundleIds)].filter((id) => {
    const cached = links().get(id);
    if (cached) found.set(id, cached);
    return cached === undefined;
  });
  for (const country of countriesFor(options.locale)) {
    if (pending.length === 0) break;
    for (let i = 0; i < pending.length; i += LOOKUP_BATCH) {
      const batch = pending.slice(i, i + LOOKUP_BATCH);
      for (const [id, link] of parseLookup(await fetcher(lookupUrl(batch, country)), country)) {
        if (batch.includes(id)) found.set(id, link);
      }
    }
    pending = pending.filter((id) => !found.has(id));
  }
  for (const id of bundleIds) links().set(id, found.get(id) ?? null);
  persistCache();
  return found;
}

/** 分享成一段文字：按分类分组，每行「名称  链接」。收藏类 App 一次只收一条链接时用这个。 */
export function shareText(entries: { name: string; link: StoreLink }[]): string {
  const groups = new Map<string, string[]>();
  for (const { name, link } of entries) {
    const genre = link.genre || "其他";
    groups.set(genre, [...(groups.get(genre) ?? []), `${name}  ${link.url}`]);
  }
  return [...groups].map(([genre, lines]) => `【${genre}】\n${lines.join("\n")}`).join("\n\n");
}
