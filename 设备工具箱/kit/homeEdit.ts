// 主屏布局的编辑：只在设备返回的原始布局上做最小的挪动，然后整份写回。
//
// 为什么不从解析后的 HomeItem 重新拼一份：那样会丢掉设备塞在每个条目里、
// 我们不认识的字段（小组件的尺寸、叠放、iconModDate 等），写回去就是另一份布局了。
// 所以这里只挪数组里的元素本身，每个元素原样搬，一个字段都不碰。
//
// 原始布局的形状（getIconState，formatVersion 2）：
//   [ Dock 数组, 第 1 页数组, 第 2 页数组, … ]
// 只开放两种操作：Dock 内调顺序、从 Dock 移到某一页（「从页面放进 Dock」用户反馈用不上，删了）。
// 文件夹结构和小组件不碰。

import { PReal, PUid, type PlistValue } from "../core/bplist";
import { isPlistDict } from "./plist";

/** iPhone 的 Dock 最多 4 个位置。 */
export const DOCK_LIMIT = 4;

/**
 * 写回前给单独摆放的小组件补上 uniqueIdentifier。
 *
 * 依据是用户反馈时导出的真机布局（2026-10-17）：叠放里的每个小组件都带 uniqueIdentifier，
 * 单独摆放的小组件（那次是 Scripting 的 RunScript）却没有，只有 userSelectedElementIdentifier。
 * 小组件的设置（选的脚本、参数）绑在实例 ID 上，原样写回时 SpringBoard 多半当成新的小组件、
 * 换了 ID，设置就丢了——被抹掉参数的正是那个单独摆放的。
 * 叠放里 userSelectedElementIdentifier 就是当前那个小组件的 uniqueIdentifier，所以拿它来补，
 * 结构和叠放里的一致。
 *
 * 返回新的一份，传进来的原始布局不动（备份、写后核对都用原样的）。已经有 uniqueIdentifier 的、
 * 叠放本身（带 elements）都不碰。
 */
export function withWidgetIdentifiers(raw: PlistValue): { layout: PlistValue; patched: number } {
  let patched = 0;
  const walk = (value: PlistValue): PlistValue => {
    if (Array.isArray(value)) return value.map(walk);
    if (!isPlistDict(value)) return value;
    const out: { [key: string]: PlistValue } = {};
    for (const [key, item] of Object.entries(value)) out[key] = walk(item);
    const selected = out.userSelectedElementIdentifier;
    if (
      out.elementType === "widget" &&
      out.uniqueIdentifier === undefined &&
      !Array.isArray(out.elements) &&
      typeof selected === "string" &&
      selected !== ""
    ) {
      out.uniqueIdentifier = selected;
      patched++;
    }
    return out;
  };
  return { layout: walk(raw), patched };
}

export function clonePlist(value: PlistValue): PlistValue {
  if (value instanceof Uint8Array) return value.slice();
  if (value instanceof PReal) return new PReal(value.value);
  if (value instanceof PUid) return new PUid(value.value);
  if (Array.isArray(value)) return value.map(clonePlist);
  if (isPlistDict(value)) {
    const out: { [key: string]: PlistValue } = {};
    for (const [key, item] of Object.entries(value)) out[key] = clonePlist(item);
    return out;
  }
  return value;
}

function asLayout(raw: PlistValue): PlistValue[][] {
  if (!Array.isArray(raw) || raw.length === 0 || !raw.every(Array.isArray)) {
    throw new Error("布局格式不认识，为安全起见不做修改");
  }
  return raw as PlistValue[][];
}

/** 条目的稳定标识，用来核对写回后的结果。 */
export function itemKey(value: PlistValue): string {
  if (!isPlistDict(value)) return "?";
  for (const key of ["bundleIdentifier", "displayIdentifier", "webClipIdentifier"]) {
    if (typeof value[key] === "string") return value[key] as string;
  }
  if (value.listType === "folder") return `folder:${typeof value.displayName === "string" ? value.displayName : ""}`;
  return `item:${typeof value.displayName === "string" ? value.displayName : "?"}`;
}

/** Dock 内把 from 挪到 to。返回新布局，原布局不变。 */
export function moveInDock(raw: PlistValue, from: number, to: number): PlistValue {
  const layout = asLayout(clonePlist(raw));
  const dock = layout[0];
  if (from < 0 || from >= dock.length || to < 0 || to >= dock.length) throw new Error("Dock 位置越界");
  const [item] = dock.splice(from, 1);
  dock.splice(to, 0, item);
  return layout;
}

/**
 * 把 Dock 的第 dockIndex 个移到第 pageIndex 页（从 0 起）的末尾。
 *
 * 页满了怎么排由设备决定（通常顺延到下一页）——写回后会重读核对，结果以设备为准。
 */
export function dockToPage(raw: PlistValue, dockIndex: number, pageIndex: number): PlistValue {
  const layout = asLayout(clonePlist(raw));
  const dock = layout[0];
  const page = layout[pageIndex + 1];
  if (dockIndex < 0 || dockIndex >= dock.length) throw new Error("Dock 位置越界");
  if (!page) throw new Error("没有这一页");
  const [item] = dock.splice(dockIndex, 1);
  page.push(item);
  return layout;
}

export function dockKeys(raw: PlistValue): string[] {
  return asLayout(raw)[0].map(itemKey);
}

/** 全部条目的标识（含文件夹内），排序后用于核对「有没有东西丢了」。 */
export function allKeys(raw: PlistValue): string[] {
  const keys: string[] = [];
  const walk = (items: PlistValue[]) => {
    for (const item of items) {
      keys.push(itemKey(item));
      if (isPlistDict(item) && Array.isArray(item.iconLists)) {
        for (const list of item.iconLists) if (Array.isArray(list)) walk(list);
      }
    }
  };
  asLayout(raw).forEach(walk);
  return keys.sort();
}

/** 排列指纹：每页条目的标识按顺序拼起来。两份布局指纹相同 = 排列没变。 */
export function arrangementKey(raw: PlistValue): string {
  return JSON.stringify(asLayout(raw).map((page) => page.map(itemKey)));
}

export interface WriteCheck {
  /** Dock 和预期完全一致。 */
  dockMatches: boolean;
  /** 写回前后条目一个没少。 */
  nothingLost: boolean;
  missing: string[];
}

/** 写回后重读的布局和预期对比。 */
export function compareLayouts(expected: PlistValue, actual: PlistValue): WriteCheck {
  const expectedDock = dockKeys(expected);
  const actualDock = dockKeys(actual);
  const remaining = new Map<string, number>();
  for (const key of allKeys(actual)) remaining.set(key, (remaining.get(key) ?? 0) + 1);
  const missing: string[] = [];
  for (const key of allKeys(expected)) {
    const count = remaining.get(key) ?? 0;
    if (count === 0) missing.push(key);
    else remaining.set(key, count - 1);
  }
  return {
    dockMatches: expectedDock.length === actualDock.length && expectedDock.every((key, i) => key === actualDock[i]),
    nothingLost: missing.length === 0,
    missing,
  };
}
