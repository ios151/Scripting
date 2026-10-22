// 字幕：搜索、下载、解码。搜法、挑选、编码识别和解析的纯逻辑在 core/subtitle.ts（迅雷）和 core/subtitlecat.ts（字幕猫）。
//
// 两个来源，搜的时候一起发：
// - 迅雷字幕库：接口 api-shoulei-ssl.xunlei.com，字幕文件在迅雷自己的 CDN（subtitle.v.geilijiasu.com）；
// - 字幕猫（Subtitle Cat，subtitlecat.com，朋友给的）：搜索页、详情页、字幕文件都在这个站上。覆盖面比迅雷广（迅雷一条没有的 IPX / EBOD / SSIS-001 它有），
//   但不少是机翻的，所以排在迅雷的后面；中文原版（人工字幕）在它们里面排最前。
// 请求里只有番号，不带别的信息；设置里没有开关——只有用户点「搜索字幕」才会发，一个来源连不上不影响另一个。

import { MOBILE_UA, REQUEST_TIMEOUT, SUBTITLE_API } from "../core/constants";
import {
  buildChoices,
  decodeUtf16,
  detectLanguage,
  parseSubtitle,
  parseXunleiItems,
  sniffEncoding,
  subtitleQueries,
  type SubtitleChoice,
  type SubtitleCue,
  type SubtitleItem,
} from "../core/subtitle";
import {
  catChoices,
  catQueries,
  catSearchUrl,
  catToChoice,
  parseCatDetail,
  parseCatSearch,
  pickCatUrls,
  type CatEntry,
} from "../core/subtitlecat";

/** 一份字幕文件超过这么大就当它不是字幕（实测正常的 30~120 KB）。 */
const MAX_BYTES = 3_000_000;
/** 内存里最多留这么多份解析好的字幕，来回「换一条」不用重新下载。 */
const KEEP_LOADED = 8;

export interface LoadedSubtitle {
  cues: SubtitleCue[];
  /** 「中文」「日文」「英文」，认不出是空串。 */
  language: string;
  /** 实际下载成功的那条地址（主链接打不开时是备用链接），给外部播放器当外挂字幕用。 */
  url: string;
}

const itemsByCode = new Map<string, SubtitleItem[]>();
const catByCode = new Map<string, CatEntry[]>();
/** 字幕猫的详情页 → 要下载的中文文件地址（读过的不用再读一遍，那一页有一百多 KB）。 */
const catUrlsByPage = new Map<string, string[]>();
const loaded = new Map<string, LoadedSubtitle>();

async function fetchItems(query: string): Promise<SubtitleItem[]> {
  const res = await fetch(`${SUBTITLE_API}?name=${encodeURIComponent(query)}`, { timeout: REQUEST_TIMEOUT });
  if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
  return parseXunleiItems(JSON.parse(await res.text()));
}

/**
 * 搜迅雷字幕库，返回候选（最合适的在前）。videoDuration 是视频时长（秒），知道的话用来把时长对得上的排前面。
 * 一个番号的几种写法并发各搜一遍：全部失败才报错，部分失败就用成功的那几个；
 * 原始条目按番号缓存，只缓存全部成功的那次（有一路失败说明可能漏了东西，下次再搜）。
 */
async function searchXunlei(code: string, videoDuration: number): Promise<SubtitleChoice[]> {
  const queries = subtitleQueries(code);
  if (queries.length === 0) return [];
  let items = itemsByCode.get(code);
  if (!items) {
    const settled = await Promise.allSettled(queries.map(fetchItems));
    const done = settled.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
    if (done.length === 0) throw new Error("连不上迅雷字幕接口，检查一下网络");
    const unique = new Map<string, SubtitleItem>();
    for (const item of done.flat()) if (!unique.has(item.id)) unique.set(item.id, item);
    items = [...unique.values()];
    if (done.length === settled.length) itemsByCode.set(code, items);
  }
  return buildChoices(items, code, videoDuration);
}

async function fetchCatEntries(query: string): Promise<CatEntry[]> {
  const res = await fetch(catSearchUrl(query), { timeout: REQUEST_TIMEOUT, headers: { "User-Agent": MOBILE_UA } });
  if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
  return parseCatSearch(await res.text());
}

/**
 * 搜字幕猫：带横杠和紧凑两种写法并发各搜一遍，按详情页合并，名字对得上番号的挑出来（站上的搜索是按词模糊匹配的，会带一堆无关的）。
 * 缓存和部分失败的处理同迅雷。候选的下载地址这里还不知道，点到那一条时才去读详情页（resolveCatUrls）。
 */
async function searchCat(code: string): Promise<SubtitleChoice[]> {
  const queries = catQueries(code);
  if (queries.length === 0) return [];
  let entries = catByCode.get(code);
  if (!entries) {
    const settled = await Promise.allSettled(queries.map(fetchCatEntries));
    const done = settled.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
    if (done.length === 0) throw new Error("连不上字幕猫，检查一下网络");
    const unique = new Map<string, CatEntry>();
    for (const entry of done.flat()) if (!unique.has(entry.page)) unique.set(entry.page, { ...entry, index: unique.size });
    entries = [...unique.values()];
    if (done.length === settled.length) catByCode.set(code, entries);
  }
  return catChoices(entries, code).map(catToChoice);
}

/**
 * 搜字幕，返回候选：迅雷的在前（最合适的在最前），字幕猫的接在后面（中文原版 > 点过赞 > 下载多）。
 * 两个来源并发搜，一个连不上就用另一个的；两个都连不上才报错。
 */
export async function searchSubtitles(code: string, videoDuration = 0): Promise<SubtitleChoice[]> {
  const [xunlei, cat] = await Promise.allSettled([searchXunlei(code, videoDuration), searchCat(code)]);
  if (xunlei.status === "rejected" && cat.status === "rejected") throw new Error("连不上迅雷字幕库和字幕猫，检查一下网络");
  return [...(xunlei.status === "fulfilled" ? xunlei.value : []), ...(cat.status === "fulfilled" ? cat.value : [])];
}

/**
 * 按识别出的编码解成文本。UTF-16 自己解（宽松，见 decodeUtf16）；其余交给系统，
 * 系统的严格解码失败（比如文件尾巴被截掉了半个字符）就退到「坏字节换成替换符」的 UTF-8——不能退到 GB18030，
 * 它几乎什么字节都能解，会把本来好好的 UTF-8 解成乱码。
 */
function decodeBytes(bytes: Uint8Array): string {
  const { encoding, skip } = sniffEncoding(bytes);
  const body = skip > 0 ? bytes.slice(skip) : bytes;
  if (encoding === "utf16LittleEndian" || encoding === "utf16BigEndian") return decodeUtf16(body, encoding === "utf16LittleEndian");
  const data = Data.fromUint8Array(body);
  if (!data) return "";
  return data.toRawString(encoding) ?? data.toDecodedString("utf8");
}

function remember(key: string, value: LoadedSubtitle): void {
  loaded.set(key, value);
  if (loaded.size > KEEP_LOADED) loaded.delete(loaded.keys().next().value as string);
}

/**
 * 字幕猫的候选：读详情页，找出要下的中文文件（简体 > 繁体，中文原版最后退到原文）。
 * 目录号每种语言不一样，只能从详情页里读（见 core/subtitlecat.ts 的文件头）。机翻的条目没有中文文件就抛错，调用方换下一条。
 */
async function resolveCatUrls(cat: { page: string; origin: string }): Promise<string[]> {
  const known = catUrlsByPage.get(cat.page);
  if (known) return known;
  const res = await fetch(cat.page, { timeout: REQUEST_TIMEOUT * 2, headers: { "User-Agent": MOBILE_UA } });
  if (res.status !== 200) throw new Error(`字幕猫的页面打不开（HTTP ${res.status}）`);
  const urls = pickCatUrls(parseCatDetail(await res.text()), cat.origin);
  if (urls.length === 0) throw new Error("字幕猫上这条没有中文版本");
  catUrlsByPage.set(cat.page, urls);
  return urls;
}

/**
 * 下载并解析一条候选。主链接打不开（失效、不是字幕）就换同一份的备用链接；都不行抛错，由调用方换下一条候选。
 */
export async function loadSubtitle(choice: SubtitleChoice): Promise<LoadedSubtitle> {
  const key = choice.cat?.page ?? choice.urls[0] ?? "";
  const hit = loaded.get(key);
  if (hit) return hit;
  const urls = choice.cat ? await resolveCatUrls(choice.cat) : choice.urls;
  const headers = choice.cat ? { "User-Agent": MOBILE_UA } : undefined;
  let reason = "没有可用的下载地址";
  for (const url of urls) {
    try {
      const res = await fetch(url, headers ? { timeout: REQUEST_TIMEOUT * 2, headers } : { timeout: REQUEST_TIMEOUT * 2 });
      if (res.status !== 200) {
        reason = `HTTP ${res.status}`;
        continue;
      }
      const bytes = await res.bytes();
      if (bytes.length === 0 || bytes.length > MAX_BYTES) {
        reason = "文件大小不对";
        continue;
      }
      const cues = parseSubtitle(decodeBytes(bytes));
      if (cues.length === 0) {
        reason = "文件里没有字幕（链接已失效，或者不是字幕）";
        continue;
      }
      const result: LoadedSubtitle = { cues, language: detectLanguage(cues), url };
      remember(key, result);
      return result;
    } catch (error) {
      reason = error instanceof Error ? error.message : String(error);
    }
  }
  throw new Error(`这条字幕打不开：${reason}`);
}
