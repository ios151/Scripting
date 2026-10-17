// 应用列表长按菜单里放哪几项、什么顺序，由用户自己定。
//
// 原先这个菜单是写死的三项。每个人常用的不一样——有人天天复制 bundle ID，
// 有人只想快速卸载，有人要的是 Team ID。与其猜，不如让它可配。
// 这里只管「有哪些动作、存了哪几项、什么顺序」，动作本身由页面执行。

import { SOURCE_LABEL, totalSize, versionText, type AppEntry } from "./apps";
import { formatBytes } from "./services";

export type RowActionId =
  | "copy-name"
  | "copy-bundle"
  | "copy-version"
  | "copy-signer"
  | "copy-team"
  | "copy-appid"
  | "copy-line"
  | "store-open"
  | "store-share"
  | "uninstall";

export interface RowAction {
  id: RowActionId;
  label: string;
  systemImage: string;
  /** 一句话说明，设置页里显示。 */
  hint: string;
  /** 红色、要二次确认的那种。 */
  destructive?: boolean;
}

/**
 * 全部可选动作，数组顺序就是设置页里的排列顺序。
 *
 * 图标避开 SF Symbols 里**有中文本地化变体**的那几个：`textformat` 在中文设备上
 * 画的是「格式」两个字，混在一列图标里很突兀（真机截图确认过）。
 * 也避开 `signature` 这类特别宽的符号。
 */
export const ROW_ACTIONS: RowAction[] = [
  { id: "copy-bundle", label: "复制 Bundle ID", systemImage: "doc.on.doc", hint: "com.example.app" },
  { id: "copy-name", label: "复制名称", systemImage: "tag", hint: "列表里显示的那个名字" },
  { id: "copy-version", label: "复制版本", systemImage: "number", hint: "版本号，和 build 不同时带括号" },
  { id: "copy-signer", label: "复制证书名", systemImage: "checkmark.seal", hint: "SignerIdentity" },
  { id: "copy-team", label: "复制 Team ID", systemImage: "person.2", hint: "十位的开发者团队标识" },
  { id: "copy-appid", label: "复制 App ID", systemImage: "key", hint: "TEAMID.com.example.app" },
  { id: "copy-line", label: "复制一整行", systemImage: "list.bullet.rectangle", hint: "名称 · Bundle ID · 版本 · 来源 · 占用" },
  { id: "store-open", label: "在 App Store 打开", systemImage: "arrow.up.forward.app", hint: "按 bundle ID 查到链接后跳转" },
  { id: "store-share", label: "分享 App Store 链接", systemImage: "square.and.arrow.up", hint: "查到链接后调系统分享面板" },
  { id: "uninstall", label: "卸载", systemImage: "trash", hint: "弹窗确认后卸载，左滑也能卸", destructive: true },
];

/** 没配置过时的默认，就是改成可配之前写死的那三项。 */
export const DEFAULT_ROW_ACTIONS: RowActionId[] = ["copy-bundle", "copy-name", "uninstall"];

const STORAGE_KEY = "appRowActions";

export function findRowAction(id: string): RowAction | undefined {
  return ROW_ACTIONS.find((action) => action.id === id);
}

/**
 * 把存下来的东西洗成一份干净的列表：只认识的、去重、保序。
 * 洗完是空的就退回默认——菜单一项都没有的话，长按只会弹个空壳。
 */
export function sanitizeRowActions(saved: unknown): RowActionId[] {
  const picked = Array.isArray(saved) ? saved.filter((item): item is RowActionId => typeof item === "string" && findRowAction(item) !== undefined) : [];
  const unique = [...new Set(picked)];
  return unique.length > 0 ? unique : [...DEFAULT_ROW_ACTIONS];
}

export function loadRowActions(): RowActionId[] {
  return sanitizeRowActions(Storage.get<string[]>(STORAGE_KEY));
}

export function saveRowActions(ids: RowActionId[]): void {
  Storage.set(STORAGE_KEY, ids);
}

/** 勾上就加到末尾，取消就拿掉。加在末尾是为了让「先勾的在上面」符合直觉。 */
export function toggleRowAction(ids: RowActionId[], id: RowActionId, on: boolean): RowActionId[] {
  if (on) return ids.includes(id) ? ids : [...ids, id];
  return ids.filter((item) => item !== id);
}

/** 上移 / 下移一项。到头了就原样返回，调用方据此决定按钮灰不灰。 */
export function moveRowAction(ids: RowActionId[], id: RowActionId, delta: -1 | 1): RowActionId[] {
  const from = ids.indexOf(id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= ids.length) return ids;
  const next = [...ids];
  next[from] = next[to];
  next[to] = id;
  return next;
}

/** 复制类动作要放进剪贴板的内容。不是复制类的返回 null。 */
export function rowActionText(id: RowActionId, app: AppEntry): string | null {
  switch (id) {
    case "copy-name":
      return app.name;
    case "copy-bundle":
      return app.bundleId;
    case "copy-version":
      return versionText(app);
    case "copy-signer":
      return app.signer;
    case "copy-team":
      return app.teamId;
    case "copy-appid":
      return app.appIdentifier;
    case "copy-line":
      return [
        app.name,
        app.bundleId,
        versionText(app),
        SOURCE_LABEL[app.source],
        app.appSize === null && app.dataSize === null ? "—" : formatBytes(totalSize(app)),
      ].join(" · ");
    default:
      return null;
  }
}
