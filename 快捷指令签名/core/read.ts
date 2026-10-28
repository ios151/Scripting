// 认格式并解析 XML / 二进制 plist：check（脚本的无界面 API、技能里的本地检查）和 sign 共用的「读」。
// 纯函数，不碰文件和全局。已签名的 .shortcut（AEA1）这里不拆——那要解归档、解压，在 core/sign.ts 里。
//
// 本文件在脚本（core/）和技能（vendor/core/）里各有一份逐字节相同的副本（共 7 个文件，清单和同步命令见 MAINTAINING.md 第 14 节）：
// 源头是脚本这边，改任何一份都要同步另一份，自测会比对。

import { isBplist, parsePlist, type PlistValue } from "./plist";

/** 能直接给用户看的错误。 */
export class ShortcutError extends Error {}

export type ShortcutKind = "empty" | "xml" | "bplist" | "signed" | "unknown";

/** 跳过开头的 UTF-8 BOM 和空白，返回第一个有内容的字节的下标。 */
function contentStart(bytes: Uint8Array): number {
  let at = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  while (at < bytes.length && (bytes[at] === 0x20 || bytes[at] === 0x09 || bytes[at] === 0x0a || bytes[at] === 0x0d)) at++;
  return at;
}

export function sniffShortcut(bytes: Uint8Array): ShortcutKind {
  if (bytes.length === 0) return "empty";
  if (bytes.length >= 4 && String.fromCharCode(...bytes.subarray(0, 4)) === "AEA1") return "signed";
  if (isBplist(bytes)) return "bplist";
  // XML：跳过 UTF-8 BOM 和空白，第一个有效字符是 <
  return bytes[contentStart(bytes)] === 0x3c ? "xml" : "unknown";
}

const printable = (byte: number): string => (byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : "·");

/** 来料最前面几个字节：十六进制 + 能显示的字符。报错里带上，用户（和我）一眼就能看出这到底是个什么文件。 */
export function headPreview(bytes: Uint8Array, count = 12): string {
  const head = Array.from(bytes.subarray(0, count));
  const hex = head.map((byte) => byte.toString(16).padStart(2, "0").toUpperCase()).join(" ");
  return `${hex}（${head.map(printable).join("")}）`;
}

/** 跳过 BOM / 空白之后的开头一小段，当 ASCII 文本看。 */
function asciiHead(bytes: Uint8Array, count: number): string {
  const at = contentStart(bytes);
  return Array.from(bytes.subarray(at, at + count), printable).join("");
}

/** 认不出的来料多半是什么：按开头猜一句，帮用户核对选的是不是对的文件。猜不出返回 null。 */
function guessContent(bytes: Uint8Array): string | null {
  const text = asciiHead(bytes, 8);
  if (text.startsWith("PK")) return "像是 zip 压缩包：先解压，再选里面的 .shortcut 文件。";
  if (/^https?:\/\//i.test(text)) return "这是一段链接文字，不是文件内容；要签链接指向的文件，请用「输入链接…」。";
  if (text.startsWith("%PDF")) return "这是 PDF 文档，不是快捷指令。";
  if (text.startsWith("{") || text.startsWith("[")) return "像是 JSON 文本，不是 plist。";
  return null;
}

function unknownFileMessage(bytes: Uint8Array): string {
  return (
    "认不出这个文件：不是 plist（XML / 二进制），也不是已签名的快捷指令。" +
    `共 ${bytes.length} 字节，开头是 ${headPreview(bytes)}。${guessContent(bytes) ?? ""}`
  );
}

/** 网页（HTML）而不是 plist：链接下载常常拿回登录页、GitHub 的文件页之类。 */
function looksLikeHtml(bytes: Uint8Array): boolean {
  const text = asciiHead(bytes, 15).toLowerCase();
  return text.startsWith("<!doctype html") || text.startsWith("<html");
}

const HTML_MESSAGE =
  "这是网页（HTML），不是快捷指令文件。如果是从链接下载的，多半链接不是文件直链（GitHub 的文件页要换成 raw 链接），或者要先登录才能下载。";

const isBytes = (value: unknown): value is Uint8Array =>
  value instanceof Uint8Array || Object.prototype.toString.call(value) === "[object Uint8Array]";

export interface PlainWorkflow {
  /** 来料原本的样子 */
  source: "xml" | "bplist";
  /** 解析出来的 plist 值（字典是 Map） */
  workflow: PlistValue;
  /** 来料里现成的二进制 plist：二进制来料原样；XML 来料没有，签名时要重新编码 */
  payload: Uint8Array | null;
}

/**
 * 认格式并解析 XML / 二进制 plist。已签名的来料（AEA1）回 { source: "signed" }，由调用方（core/sign.ts）去拆。
 * **不**校验它是不是快捷指令：签名走 prepareShortcut（要求有 WFWorkflowActions），检查器走 core/check.ts（逐条报问题）。
 * 认不出来、解析不了都抛 ShortcutError，信息能直接给用户看。
 */
export function readPlainWorkflow(input: Uint8Array): PlainWorkflow | { source: "signed" } {
  // 原生接口交来的「字节」常常不是 Uint8Array（readAsBytesSync 回过 ArrayBuffer）。不在这里拦下，
  // 它会被判成「认不出这个文件」，把人带到错的方向；拦下来就能一眼看出是类型问题
  if (!isBytes(input)) {
    throw new ShortcutError(`内部错误：来料不是字节数组，而是 ${Object.prototype.toString.call(input)}。请把这条报错告诉作者。`);
  }
  const source = sniffShortcut(input);
  switch (source) {
    case "empty":
      throw new ShortcutError("文件是空的");
    case "unknown":
      throw new ShortcutError(unknownFileMessage(input));
    case "signed":
      return { source };
    case "xml": {
      if (looksLikeHtml(input)) throw new ShortcutError(HTML_MESSAGE);
      try {
        return { source, workflow: parsePlist(input), payload: null };
      } catch (error) {
        throw new ShortcutError(`plist 解析失败：${(error as Error).message}`);
      }
    }
    case "bplist": {
      try {
        // 二进制的原样放进去，不重新编码——保留来料每一个字节
        return { source, workflow: parsePlist(input), payload: input };
      } catch (error) {
        throw new ShortcutError(`二进制 plist 解析失败：${(error as Error).message}`);
      }
    }
  }
}
