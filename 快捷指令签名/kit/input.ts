// 待签名的快捷指令从哪来：「文件」App、别的 App 通过分享面板递来的文件、剪贴板里的 plist 文本、https 链接。

import { toBytes } from "../core/bytes";
import { linkProblem, nameFromUrl } from "../core/names";
import { MAX_BYTES, sourcesFromPaths, type Source, type SourceFile } from "./sources";

// 读文件那部分搬到了 kit/sources.ts（技能里的本地检查也要用它）；这里原样转出，老的导入路径照用
export { isFailure, sourcesFromPaths, type Source, type SourceFailure, type SourceFile } from "./sources";

const DOWNLOAD_TIMEOUT_SECONDS = 30;

export async function pickFromFiles(): Promise<Source[]> {
  const paths = await DocumentPicker.pickFiles({
    types: ["public.data", "public.item"],
    allowsMultipleSelection: true,
  });
  return sourcesFromPaths(paths ?? []);
}

export async function pickFromClipboard(): Promise<SourceFile> {
  const text = await Pasteboard.getString();
  if (!text || text.trim() === "") {
    throw new Error(
      "剪贴板里没有文字。系统弹出「允许粘贴」时要选允许；也可能是在「设置 → Scripting → 从其他 App 粘贴」里被拒绝了",
    );
  }
  return { name: "剪贴板", bytes: new TextEncoder().encode(text) };
}

export async function pickFromUrl(url: string): Promise<SourceFile> {
  const trimmed = url.trim();
  if (!/^https:\/\//i.test(trimmed)) throw new Error("只支持 https 链接");
  const problem = linkProblem(trimmed);
  if (problem !== null) throw new Error(problem);
  const response = await fetch(trimmed, { timeout: DOWNLOAD_TIMEOUT_SECONDS });
  if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}`);
  const bytes = toBytes(await response.arrayBuffer());
  if (bytes.byteLength > MAX_BYTES) throw new Error("文件太大，不像是快捷指令");
  return { name: nameFromUrl(trimmed), bytes };
}
