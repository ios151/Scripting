// 按分类方案把主屏上的 App 收进文件夹。纯函数，不碰设备、不碰 AI。
//
// 动的范围刻意收得很窄，每一条都是为了「写坏了也好还原、不会丢东西」：
//   - Dock 不动
//   - 只处理用户选中的页；没选的页原样保留
//   - 选中页上只收「散放的 App」；小组件、已有文件夹、网页快捷方式留在原地
//     （唯一的例外是用户明确要求「解散文件夹」时，colorFolderLayout 会先拆开选中页上的已有文件夹）
//   - 方案里没提到的 App 留在原位
//   - App 条目整份原样搬进文件夹，一个字段不改（同 homeEdit.ts 的理由）
//
// AI 的输出一律当不可信输入：不认识的 bundle ID 丢掉，重复的只认第一次，
// 空文件夹丢掉，文件夹名去重、限长。

import type { PlistValue } from "../core/bplist";
import { clonePlist } from "./homeEdit";
import { isPlistDict, type PlistDict } from "./plist";

/** 一页文件夹放几个。iPhone 的文件夹一页是 3×3。 */
export const FOLDER_PAGE_SIZE = 9;
/** 文件夹名上限。主屏上太长会被截断。 */
export const FOLDER_NAME_LIMIT = 12;

export interface LooseApp {
  /** 页码，从 0 起（不含 Dock）。 */
  page: number;
  bundleId: string;
  name: string;
}

export interface FolderPlan {
  name: string;
  bundleIds: string[];
}

function asLayout(raw: PlistValue): PlistValue[][] {
  if (!Array.isArray(raw) || raw.length === 0 || !raw.every(Array.isArray)) {
    throw new Error("布局格式不认识，为安全起见不做修改");
  }
  return raw as PlistValue[][];
}

/** 散放的 App：有 bundle ID、不是文件夹、不是小组件、不是网页快捷方式。 */
function looseBundleId(value: PlistValue): string | null {
  if (!isPlistDict(value)) return null;
  if (value.listType === "folder") return null;
  if (value.iconType === "custom" || value.gridSize !== undefined || value.elementType !== undefined) return null;
  if (typeof value.webClipIdentifier === "string" || value.iconType === "webClip") return null;
  const id =
    (typeof value.bundleIdentifier === "string" && value.bundleIdentifier) ||
    (typeof value.displayIdentifier === "string" && value.displayIdentifier) ||
    "";
  return id || null;
}

/** 选中页上所有散放的 App。同一个 bundle ID 出现两次（不该发生）只取第一次。 */
export function collectLooseApps(raw: PlistValue, pages: number[]): LooseApp[] {
  const layout = asLayout(raw);
  const seen = new Set<string>();
  const out: LooseApp[] = [];
  for (const page of [...pages].sort((a, b) => a - b)) {
    for (const item of layout[page + 1] ?? []) {
      const bundleId = looseBundleId(item);
      if (!bundleId || seen.has(bundleId)) continue;
      seen.add(bundleId);
      const name = isPlistDict(item) && typeof item.displayName === "string" ? item.displayName : bundleId;
      out.push({ page, bundleId, name });
    }
  }
  return out;
}

export interface SanitizedPlan {
  folders: FolderPlan[];
  /** 方案没覆盖到的 App，留在原位。 */
  unassigned: string[];
  /** 被丢掉的不认识的 ID 个数，给用户看「AI 编了几个」。 */
  dropped: number;
}

/** 把 AI 给的方案清洗成可以安全执行的样子。 */
export function sanitizePlan(raw: unknown, allowed: string[]): SanitizedPlan {
  const allowedSet = new Set(allowed);
  const used = new Set<string>();
  const names = new Set<string>();
  let dropped = 0;
  const folders: FolderPlan[] = [];
  const list = isPlistDict(raw as PlistValue) && Array.isArray((raw as PlistDict).folders) ? ((raw as PlistDict).folders as unknown[]) : [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as { name?: unknown; bundleIds?: unknown };
    let name = typeof record.name === "string" ? record.name.trim().slice(0, FOLDER_NAME_LIMIT) : "";
    if (!name) name = "未命名";
    // 重名就加序号，免得两个同名文件夹分不清
    let unique = name;
    for (let n = 2; names.has(unique); n++) unique = `${name} ${n}`;
    const ids: string[] = [];
    for (const id of Array.isArray(record.bundleIds) ? record.bundleIds : []) {
      if (typeof id !== "string") continue;
      if (!allowedSet.has(id)) {
        dropped++;
        continue;
      }
      if (used.has(id)) continue;
      used.add(id);
      ids.push(id);
    }
    if (ids.length === 0) continue;
    names.add(unique);
    folders.push({ name: unique, bundleIds: ids });
  }
  return { folders, unassigned: allowed.filter((id) => !used.has(id)), dropped };
}

/**
 * 按方案生成新布局。返回新布局，原布局不变。
 *
 * 新文件夹接在第一个选中页现有内容的后面；选中页被收空了就去掉
 * （至少留一页）。页面放不下时由设备自己顺延，写回后会重读核对。
 */
export function applyPlan(raw: PlistValue, pages: number[], folders: FolderPlan[]): PlistValue {
  if (pages.length === 0) throw new Error("没有选中任何页");
  const layout = asLayout(clonePlist(raw));
  const selected = [...new Set(pages)].sort((a, b) => a - b);
  for (const page of selected) if (!layout[page + 1]) throw new Error(`没有第 ${page + 1} 页`);

  const target = new Map<string, number>();
  folders.forEach((folder, index) => folder.bundleIds.forEach((id) => target.set(id, index)));

  // 把要收进文件夹的 App 从选中页上取下来，条目整份留着
  const picked = new Map<string, PlistValue>();
  for (const page of selected) {
    layout[page + 1] = layout[page + 1].filter((item) => {
      const id = looseBundleId(item);
      if (id && target.has(id) && !picked.has(id)) {
        picked.set(id, item);
        return false;
      }
      return true;
    });
  }

  const folderItems: PlistValue[] = [];
  for (const folder of folders) {
    const apps = folder.bundleIds.map((id) => picked.get(id)).filter((item): item is PlistValue => item !== undefined);
    if (apps.length === 0) continue;
    const iconLists: PlistValue[] = [];
    for (let i = 0; i < apps.length; i += FOLDER_PAGE_SIZE) iconLists.push(apps.slice(i, i + FOLDER_PAGE_SIZE));
    // 最小的文件夹结构：不抄现有文件夹的其他字段，免得把它的标识也复制过来
    folderItems.push({ listType: "folder", displayName: folder.name, iconLists });
  }

  const first = selected[0];
  layout[first + 1] = [...layout[first + 1], ...folderItems];

  // 收空了的选中页去掉（从后往前删，下标不乱）；Dock 之外至少留一页
  for (const page of [...selected].reverse()) {
    if (layout[page + 1].length === 0 && layout.length > 2) layout.splice(page + 1, 1);
  }
  return layout;
}

// ── 按名称排序 ────────────────────────────────────────────────────────────

/**
 * 主屏「按名称排序」的规则，照 App 资源库 / 通讯录的习惯：
 *   - 中英文按首字母混排：「百度」和「Bilibili」都归 B，不是先排完英文再排中文
 *   - 同一个字母里再按拼音 / 字母细排；数字按数值（App 2 在 App 10 前面）
 *   - 数字和符号开头的归到最后（#）
 *
 * ICU 的中文排序规则（iOS 的 JavaScriptCore 自带完整 ICU）本身是拼音序，但会把
 * 汉字和拉丁字母分成两大块排，不会混排。所以先用「每个拼音首字母的第一个字」
 * 做边界，二分出汉字的拼音首字母，再按首字母分桶——这是在没有拼音字典时
 * 求首字母的通行做法。没有 I、U、V 开头的拼音，所以边界只有 23 个。
 */
const PINYIN = new Intl.Collator("zh-Hans-CN-u-co-pinyin", { sensitivity: "base", numeric: true });
const PINYIN_LETTERS = "ABCDEFGHJKLMNOPQRSTWXYZ";
const PINYIN_BOUNDARIES = ["阿", "八", "嚓", "哒", "妸", "发", "旮", "哈", "讥", "咔", "垃", "痳", "拏", "噢", "妑", "七", "呥", "扨", "它", "穵", "夕", "丫", "帀"];

/** 名称的首字母桶：A–Z 返回 0–25，其他（数字、符号、取不到）返回 26。 */
function initialRank(name: string): number {
  const first = name.trim().charAt(0);
  if (/[A-Za-z]/.test(first)) return first.toUpperCase().charCodeAt(0) - 65;
  if (/[㐀-鿿]/.test(first)) {
    for (let i = PINYIN_BOUNDARIES.length - 1; i >= 0; i--) {
      if (PINYIN.compare(first, PINYIN_BOUNDARIES[i]) >= 0) return PINYIN_LETTERS.charCodeAt(i) - 65;
    }
  }
  return 26;
}

export function compareNames(a: string, b: string): number {
  return initialRank(a) - initialRank(b) || PINYIN.compare(a, b);
}

function displayName(value: PlistValue): string {
  return isPlistDict(value) && typeof value.displayName === "string" ? value.displayName : "";
}

/** 排序时拿来比较的东西：bundle ID 和显示名。 */
export interface SortableApp {
  bundleId: string;
  name: string;
}

type Comparer = (a: SortableApp, b: SortableApp) => number;

/**
 * 在一组格子里重排 App：只换「放着散 App 的格子」里的内容，其他格子原地不动。
 * 稳定排序：比较结果相等的保持原来的先后。
 */
function reorderSlots(lists: PlistValue[][], compare: Comparer): void {
  const slots: [number, number][] = [];
  const apps: { item: PlistValue; key: SortableApp; order: number }[] = [];
  lists.forEach((items, listIndex) => {
    items.forEach((item, index) => {
      const bundleId = looseBundleId(item);
      if (bundleId) {
        slots.push([listIndex, index]);
        apps.push({ item, key: { bundleId, name: displayName(item) }, order: apps.length });
      }
    });
  });
  const sorted = [...apps].sort((a, b) => compare(a.key, b.key) || a.order - b.order);
  slots.forEach(([listIndex, index], i) => {
    lists[listIndex][index] = sorted[i].item;
  });
}

/** 选中页上的已有文件夹（只看页面一级，文件夹不会嵌套）。 */
function foldersOn(layout: PlistValue[][], selected: number[]): PlistDict[] {
  const folders: PlistDict[] = [];
  for (const page of selected) {
    for (const item of layout[page + 1] ?? []) {
      if (isPlistDict(item) && item.listType === "folder" && Array.isArray(item.iconLists)) folders.push(item);
    }
  }
  return folders;
}

/** 选中页上已有文件夹里的 App（算颜色、显示数量用）。同一个 ID 只取一次。 */
export function collectFolderApps(raw: PlistValue, pages: number[]): SortableApp[] {
  const seen = new Set<string>();
  const out: SortableApp[] = [];
  for (const folder of foldersOn(asLayout(raw), [...new Set(pages)])) {
    for (const list of folder.iconLists as PlistValue[]) {
      if (!Array.isArray(list)) continue;
      for (const item of list) {
        const bundleId = looseBundleId(item);
        if (!bundleId || seen.has(bundleId)) continue;
        seen.add(bundleId);
        out.push({ bundleId, name: displayName(item) || bundleId });
      }
    }
  }
  return out;
}

/**
 * 把选中页上的 App 按给定的规则重新排一遍。
 *
 * 只换「放着散 App 的格子」里的内容：小组件、文件夹、网页快捷方式原地不动，
 * 页数、每页的格子数都不变。所以这个操作不会让任何东西换页溢出。
 * 跨多页时按页序连成一串来排，前面的页放排在前面的 App。
 *
 * `insideFolders` 为 true 时，选中页上每个已有文件夹的内部也按同样的规则排：
 * 文件夹本身位置不动、不拆，App 不跨文件夹，文件夹里每一页的个数也不变。
 */
export function reorderLooseApps(
  raw: PlistValue,
  pages: number[],
  compare: Comparer,
  options: { insideFolders?: boolean } = {},
): PlistValue {
  if (pages.length === 0) throw new Error("没有选中任何页");
  const layout = asLayout(clonePlist(raw));
  const selected = [...new Set(pages)].sort((a, b) => a - b);
  for (const page of selected) if (!layout[page + 1]) throw new Error(`没有第 ${page + 1} 页`);
  reorderSlots(
    selected.map((page) => layout[page + 1]),
    compare,
  );
  if (options.insideFolders) {
    for (const folder of foldersOn(layout, selected)) {
      const lists = (folder.iconLists as PlistValue[]).filter((list): list is PlistValue[] => Array.isArray(list));
      reorderSlots(lists, compare);
    }
  }
  return layout;
}

// ── 解散文件夹 + 按颜色建文件夹 ──────────────────────────────────────────

/**
 * 把选中页上的已有文件夹拆开：里面的东西（App、网页快捷方式）按原来的顺序放回文件夹原来的位置，
 * 文件夹条目本身去掉。只动选中页，Dock 和别的页原样。返回新布局，原布局不变。
 */
export function dissolveFolders(raw: PlistValue, pages: number[]): { layout: PlistValue; folders: number; released: number } {
  const layout = asLayout(clonePlist(raw));
  let folders = 0;
  let released = 0;
  for (const page of [...new Set(pages)]) {
    const items = layout[page + 1];
    if (!items) throw new Error(`没有第 ${page + 1} 页`);
    const next: PlistValue[] = [];
    for (const item of items) {
      if (isPlistDict(item) && item.listType === "folder" && Array.isArray(item.iconLists)) {
        folders++;
        for (const list of item.iconLists) {
          if (!Array.isArray(list)) continue;
          next.push(...list);
          released += list.length;
        }
      } else {
        next.push(item);
      }
    }
    layout[page + 1] = next;
  }
  return { layout, folders, released };
}

export interface ColorFolderResult {
  layout: PlistValue;
  /** 新建的文件夹，按 order 的顺序。 */
  plan: FolderPlan[];
  /** 拆了几个已有文件夹、放出来几个条目。 */
  dissolved: number;
  released: number;
  /** 没进文件夹、留在页面上的散放 App 个数：同色不足 2 个，或者取不到颜色。 */
  leftLoose: number;
}

/**
 * 按颜色建文件夹：（可选）先拆掉选中页上的已有文件夹，再把选中页上的散放 App 按颜色分组，
 * 每组建一个文件夹，名字就是组名。同组不足 2 个的、bucketOf 返回 null 的留在原位——
 * 和「分文件夹」的规矩一致：一个 App 不值得单独一个文件夹。
 *
 * 颜色怎么算不在这里（见 colorSort.colorBucket），由调用方传进来，这里只管布局。
 */
export function colorFolderLayout(
  raw: PlistValue,
  pages: number[],
  bucketOf: (bundleId: string) => string | null,
  options: { dissolve: boolean; order: readonly string[] },
): ColorFolderResult {
  if (pages.length === 0) throw new Error("没有选中任何页");
  const base = options.dissolve ? dissolveFolders(raw, pages) : { layout: raw, folders: 0, released: 0 };
  const loose = collectLooseApps(base.layout, pages);
  const groups = new Map<string, string[]>();
  for (const app of loose) {
    const bucket = bucketOf(app.bundleId);
    if (bucket === null) continue;
    groups.set(bucket, [...(groups.get(bucket) ?? []), app.bundleId]);
  }
  const plan: FolderPlan[] = [];
  for (const name of options.order) {
    const ids = groups.get(name) ?? [];
    if (ids.length >= 2) plan.push({ name, bundleIds: ids });
  }
  const foldered = plan.reduce((sum, folder) => sum + folder.bundleIds.length, 0);
  return {
    layout: plan.length > 0 ? applyPlan(base.layout, pages, plan) : base.layout,
    plan,
    dissolved: base.folders,
    released: base.released,
    leftLoose: loose.length - foldered,
  };
}

/** 按名称排（规则见 compareNames）。 */
export function sortLooseApps(raw: PlistValue, pages: number[], descending = false, insideFolders = false): PlistValue {
  return reorderLooseApps(raw, pages, (a, b) => compareNames(a.name, b.name) * (descending ? -1 : 1), { insideFolders });
}
