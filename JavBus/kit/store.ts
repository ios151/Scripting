// 收藏库的持久化与订阅。
//
// 库整个当一个 JSON 存进 Storage（原版是一个 JavBusBackup.json 文件）。模块级单例：
// 各页面里的回调常拿着首帧闭包，从这里现取永远是最新的库；变更后通知订阅者，
// 列表、详情页的按钮状态、收藏计数都靠这个同步，不用各自维护副本。

import { useEffect, useState } from "scripting";

import {
  addActress,
  addFavorite,
  addNamed,
  archiveMovie,
  emptyLibrary,
  looksLikeBackup,
  mergeLibrary,
  normalizeLibrary,
  removeActress,
  removeArchived,
  removeFavorite,
  removeNamed,
} from "../core/library";
import type { FavActress, FavMovie, FavNamed, LibraryData, NamedKind } from "../core/types";

const KEY = "javbus.library";

let current: LibraryData | null = null;
const listeners = new Set<() => void>();

export function library(): LibraryData {
  if (!current) {
    try {
      current = normalizeLibrary(Storage.get<unknown>(KEY));
    } catch {
      current = emptyLibrary();
    }
  }
  return current;
}

function commit(next: LibraryData): void {
  if (next === current) return;
  current = next;
  Storage.set(KEY, next);
  for (const l of listeners) l();
}

export function onLibraryChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 订阅库的变化，库一变组件就重绘。 */
export function useLibrary(): LibraryData {
  const [snapshot, setSnapshot] = useState<LibraryData>(library());
  useEffect(() => {
    setSnapshot(library());
    return onLibraryChange(() => setSnapshot(library()));
  }, []);
  return snapshot;
}

export const store = {
  addFavorite: (movie: FavMovie) => commit(addFavorite(library(), movie)),
  cancelFavorite: (shortCode: string, code?: string) => commit(removeFavorite(library(), shortCode, code)),
  archive: (movie: FavMovie) => commit(archiveMovie(library(), movie)),
  deleteArchived: (shortCode: string, code?: string) => commit(removeArchived(library(), shortCode, code)),
  addActress: (a: FavActress) => commit(addActress(library(), a)),
  removeActress: (shortCode: string) => commit(removeActress(library(), shortCode)),
  addNamed: (kind: NamedKind, item: FavNamed) => commit(addNamed(library(), kind, item)),
  removeNamed: (kind: NamedKind, shortCode: string) => commit(removeNamed(library(), kind, shortCode)),
  clear: () => commit(emptyLibrary()),
};

/** 导出：和原版 JavBusBackup.json 同形的 JSON 文本。 */
export function exportLibrary(): string {
  return JSON.stringify(library());
}

export type ImportMode = "merge" | "replace";

export interface ImportResult {
  before: LibraryData;
  after: LibraryData;
}

/**
 * 导入备份。文本不是备份格式时抛错（调用方要把错误显示给用户，别静默吞）。
 * merge 保留本机已有的，replace 整个换成备份内容。
 */
export function importLibrary(text: string, mode: ImportMode): ImportResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("不是有效的 JSON 文件");
  }
  if (!looksLikeBackup(raw)) throw new Error("文件里没有收藏数据（缺 favorite / archive / actress 等字段）");
  const incoming = normalizeLibrary(raw);
  const before = library();
  const after = mode === "replace" ? incoming : mergeLibrary(before, incoming);
  commit(after);
  return { before, after };
}
