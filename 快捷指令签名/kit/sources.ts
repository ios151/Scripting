// 把一批文件路径读成来料：「文件」App 里选的、分享面板递来的（kit/input.ts），无界面 API 的 check / sign，
// 和技能里的本地检查都走这一份。不 import "scripting"，用全局的 FileManager（自测里塞假的）。
//
// 本文件在脚本（kit/）和技能（vendor/kit/）里各有一份逐字节相同的副本（共 7 个文件，清单和同步命令见 MAINTAINING.md 第 14 节）：
// 源头是脚本这边，改任何一份都要同步另一份，自测会比对。

import { toBytes } from "../core/bytes";
import { baseName, formatSize, sharedFilePath } from "../core/names";

export interface SourceFile {
  /** 显示用：文件名，或「剪贴板」之类的来源说明 */
  name: string;
  bytes: Uint8Array;
}

/** 读不了的来料：界面里作为一条失败记录摆出来，不让一份坏文件拖垮整批。 */
export interface SourceFailure {
  name: string;
  error: string;
}

export type Source = SourceFile | SourceFailure;

export function isFailure(source: Source): source is SourceFailure {
  return "error" in source;
}

/** 体积上限（选文件和链接下载都用）。快捷指令几十 KB 到几 MB，再大基本是点错了，整份读进内存还可能把 Scripting 撑挂。 */
export const MAX_BYTES = 20 * 1024 * 1024;

/**
 * 把一批文件路径读成来料（选文件和分享面板共用）。
 * 逐个读：一个读不了（比如 iCloud 里还没下载）不影响别的。按字节读，二进制 plist 和已签名的 AEA1 都不能当字符串读。
 * 分享面板递来的路径要趁早读——分享结束后系统可能回收它们。
 */
export function sourcesFromPaths(rawPaths: readonly string[]): Source[] {
  return rawPaths.map((raw): Source => {
    const path = sharedFilePath(raw);
    const name = baseName(path);
    try {
      const size = FileManager.statSync(path).size;
      if (size > MAX_BYTES) return { name, error: `文件太大（${formatSize(size)}），不像是快捷指令` };
      // readAsBytesSync 真机上回的是 ArrayBuffer（文档写 Uint8Array）：不统一一下，后面一律判成「认不出这个文件」
      return { name, bytes: toBytes(FileManager.readAsBytesSync(path)) };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { name, error: `读不了这个文件：${reason}。如果它在 iCloud 里还没下载，先在「文件」里点一下下载` };
    }
  });
}
