// XML plist 读写，外加「XML 或二进制都认」的统一入口。
//
// 设备连接上的收发**不走这里**——那条路交给原生的 DeviceServices 了（见 kit/lockdown.ts）。
// 这里剩下的是本地那几处：主屏布局备份与导出（kit/backup.ts、HomeScreenPage）写出 XML，
// 描述文件里内嵌的那段 plist（kit/profiles.ts）读进来。二进制交给 core/bplist 处理。
//
// 值类型沿用 core/bplist 的 PlistValue，两边可以混用。两处取舍：
// - `<date>` 读成 Date，写出去也认 Date。全脚本的日期就这一种表示：备份里存的是
//   设备给的日期，恢复时得原样写回去，中间换成字符串就成了 `<string>`。
// - 超出 JS 安全整数范围的 `<integer>` 读成**十进制字符串**，不读成 number。
//   ECID（UniqueChipID）、电流的补码表示都会超过 2^53，转成 number 会静默丢掉
//   末几位，显示出来是一个看着正常、其实错的数。

import { decodeBplist, isBplist, PReal, PUid, type PlistValue } from "../core/bplist";
import { fromUtf8, utf8 } from "../core/bytes";
import { isoSeconds } from "./dates";

export type PlistDict = { [key: string]: PlistValue };

export function isPlistDict(value: unknown): value is PlistDict {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Uint8Array) &&
    !(value instanceof PUid) &&
    !(value instanceof PReal) &&
    // Date 是对象，不拦住的话遍历时会被当成空字典走进去
    !(value instanceof Date)
  );
}

// ── 写 ────────────────────────────────────────────────────────────────────

function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function base64Of(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}

function encodeValue(value: PlistValue, out: string[]): void {
  if (value === null) throw new Error("plist 不能表示 null");
  if (typeof value === "boolean") out.push(value ? "<true/>" : "<false/>");
  else if (typeof value === "number") {
    if (Number.isInteger(value)) out.push(`<integer>${value}</integer>`);
    else out.push(`<real>${value}</real>`);
  } else if (value instanceof PReal) out.push(`<real>${value.value}</real>`);
  else if (value instanceof PUid) throw new Error("XML plist 不支持 UID");
  else if (typeof value === "string") out.push(`<string>${escapeXml(value)}</string>`);
  else if (value instanceof Date) out.push(`<date>${isoSeconds(value)}</date>`);
  else if (value instanceof Uint8Array) out.push(`<data>${base64Of(value)}</data>`);
  else if (Array.isArray(value)) {
    out.push("<array>");
    for (const item of value) encodeValue(item, out);
    out.push("</array>");
  } else {
    out.push("<dict>");
    for (const [key, item] of Object.entries(value)) {
      out.push(`<key>${escapeXml(key)}</key>`);
      encodeValue(item, out);
    }
    out.push("</dict>");
  }
}

export function encodeXmlPlist(root: PlistValue): Uint8Array {
  const out: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>\n',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n',
    '<plist version="1.0">',
  ];
  encodeValue(root, out);
  out.push("</plist>\n");
  return utf8(out.join(""));
}

// ── 读 ────────────────────────────────────────────────────────────────────

/**
 * 实体反转义。`&amp;` 必须放在最后——先换它的话 `&amp;lt;` 会被还原成 `<`，
 * 再下一轮就成了真的尖括号，plist 直接解坏。
 */
function unescapeXml(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function parseInteger(text: string): number | string {
  const trimmed = text.trim();
  if (!/^-?\d+$/.test(trimmed)) throw new Error(`plist 整数格式不对：${trimmed.slice(0, 40)}`);
  const value = Number(trimmed);
  return Number.isSafeInteger(value) ? value : trimmed;
}

/** `liftDataBlocks` 留在 `<data>` 里的占位：`@` 加序号。base64 里不会出现 `@`。 */
const LIFTED = /^@(\d+)$/;

function decodeData(text: string, lifted: Uint8Array[]): Uint8Array {
  const mark = LIFTED.exec(text);
  if (mark) {
    const bytes = lifted[Number(mark[1])];
    if (!bytes) throw new Error("plist 的 <data> 占位对不上");
    return bytes;
  }
  // 必须拷贝：Buffer 取自共享内存池，开视图的话底层随时可能被复用（SKILL.md 2.1）。
  return new Uint8Array(Buffer.from(text.replace(/\s+/g, ""), "base64"));
}

// ── 大块 <data> 在字节层面解 ────────────────────────────────────────────────
//
// 依据是真机日志（v0.9.0，2026-10-17）：
//   com.apple.misagent.shim.remote 大包 1976006 字节：收 40 ms，解析 336 ms
// misagent 的 CopyAll 回的是 XML（同样大小的二进制 plist 只要 1–2 ms），每个描述文件
// 是一段 base64 的 <data>。走字符串那条路要整包转字符串、正则分词、反转义、去空白、
// Buffer 解码，全在主线程上，进「签名到期」页会卡一下。
//
// 这里先在字节里找到每个 `<data>…</data>`，直接把 base64 字节解成二进制，文本里只留
// 一个占位；剩下的结构（标签、键名）才转字符串走下面的解析。base64 里没有 `<`，
// 用原生的 indexOf 一跳就到 `</data>`。
//
// 注意：壁纸预览那条路（springboardservices）回的是二进制 plist，不经过这里。壁纸卡顿
// 当初是因为把大 Uint8Array 放进了页面状态，和这里无关。

const LT = 0x3c;
const OPEN_DATA = utf8("<data>");
const CLOSE_DATA = utf8("</data>");
const PAD = 0x3d; // '='
const SKIP = 254;
const BAD = 255;

/** base64 字符 → 6 位值；空白记 SKIP，其余记 BAD。 */
const BASE64_TABLE = (() => {
  const table = new Uint8Array(256).fill(BAD);
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  for (let i = 0; i < alphabet.length; i++) table[alphabet.charCodeAt(i)] = i;
  for (const space of [0x20, 0x09, 0x0a, 0x0d]) table[space] = SKIP;
  return table;
})();

function bytesAt(bytes: Uint8Array, at: number, pattern: Uint8Array): boolean {
  if (at + pattern.length > bytes.length) return false;
  for (let i = 0; i < pattern.length; i++) if (bytes[at + i] !== pattern[i]) return false;
  return true;
}

/** 解 bytes[start, end) 里的 base64，跳过空白，遇到 `=` 收尾。 */
function decodeBase64Bytes(bytes: Uint8Array, start: number, end: number): Uint8Array {
  const out = new Uint8Array(Math.floor(((end - start) * 3) / 4) + 3);
  let length = 0;
  let acc = 0;
  let bits = 0;
  let i = start;
  while (i < end) {
    // 快路：对齐时整组 4 个字符一起解。CF 排版每行 68 字符正好 17 组，空白只落在组间。
    if (bits === 0 && i + 4 <= end) {
      const a = BASE64_TABLE[bytes[i]];
      const b = BASE64_TABLE[bytes[i + 1]];
      const c = BASE64_TABLE[bytes[i + 2]];
      const d = BASE64_TABLE[bytes[i + 3]];
      if ((a | b | c | d) < 64) {
        out[length++] = (a << 2) | (b >> 4);
        out[length++] = ((b & 15) << 4) | (c >> 2);
        out[length++] = ((c & 3) << 6) | d;
        i += 4;
        continue;
      }
    }
    const code = bytes[i++];
    if (code === PAD) break;
    const value = BASE64_TABLE[code];
    if (value === SKIP) continue;
    if (value === BAD) throw new Error("plist 的 <data> 不是合法的 base64");
    acc = ((acc << 6) | value) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[length++] = (acc >> bits) & 0xff;
    }
  }
  // 拷成刚好的长度：交给原生侧的 Uint8Array 不能带多余的底层 buffer。
  return out.slice(0, length);
}

/** 把 `<data>` 的内容换成占位，返回剩下的文本和解好的二进制。 */
function liftDataBlocks(bytes: Uint8Array): { text: string; lifted: Uint8Array[] } {
  const lifted: Uint8Array[] = [];
  const parts: string[] = [];
  let cursor = 0;
  let at = bytes.indexOf(LT);
  while (at !== -1) {
    if (bytesAt(bytes, at, OPEN_DATA)) {
      const bodyStart = at + OPEN_DATA.length;
      const bodyEnd = bytes.indexOf(LT, bodyStart);
      if (bodyEnd === -1 || !bytesAt(bytes, bodyEnd, CLOSE_DATA)) throw new Error("plist 的 <data> 没有闭合");
      // 切点都落在 `>` / `<` 上，不会把多字节的 UTF-8 字符切开。
      parts.push(fromUtf8(bytes.subarray(cursor, bodyStart)), `@${lifted.length}`);
      lifted.push(decodeBase64Bytes(bytes, bodyStart, bodyEnd));
      cursor = bodyEnd;
      at = bodyEnd;
    }
    at = bytes.indexOf(LT, at + 1);
  }
  parts.push(fromUtf8(bytes.subarray(cursor)));
  return { text: parts.join(""), lifted };
}

interface Token {
  /** 标签名；文本节点为 null。 */
  tag: string | null;
  closing: boolean;
  selfClosing: boolean;
  text: string;
}

class XmlTokens {
  private readonly pattern = /<(\/?)([A-Za-z][\w-]*)[^>]*?(\/?)>|([^<]+)|<[?!][^>]*>/g;
  private peeked: Token | null = null;

  constructor(
    private readonly source: string,
    /** `liftDataBlocks` 预先解好的 `<data>`。 */
    readonly lifted: Uint8Array[],
  ) {}

  next(): Token | null {
    if (this.peeked) {
      const token = this.peeked;
      this.peeked = null;
      return token;
    }
    for (;;) {
      const match = this.pattern.exec(this.source);
      if (!match) return null;
      if (match[2]) return { tag: match[2], closing: match[1] === "/", selfClosing: match[3] === "/", text: "" };
      if (match[4] !== undefined) {
        // 标签之间的空白不算内容
        if (match[4].trim() === "") continue;
        return { tag: null, closing: false, selfClosing: false, text: match[4] };
      }
      // `<?xml …?>` 和 `<!DOCTYPE …>` 直接跳过
    }
  }

  peek(): Token | null {
    if (!this.peeked) this.peeked = this.next();
    return this.peeked;
  }
}

/** 读一个元素的文本内容，一直到它的闭合标签。 */
function readText(tokens: XmlTokens, tag: string): string {
  let text = "";
  for (;;) {
    const token = tokens.next();
    if (!token) throw new Error(`plist 在 <${tag}> 里提前结束`);
    if (token.tag === null) text += token.text;
    else if (token.closing && token.tag === tag) return unescapeXml(text);
    else throw new Error(`plist 的 <${tag}> 里不该有 <${token.tag}>`);
  }
}

function parseElement(tokens: XmlTokens, open: Token, depth: number): PlistValue {
  if (depth > 64) throw new Error("plist 嵌套过深");
  const tag = open.tag!;
  switch (tag) {
    case "true":
    case "false":
      if (!open.selfClosing) readText(tokens, tag);
      return tag === "true";
    case "string":
      return open.selfClosing ? "" : readText(tokens, tag);
    case "integer":
      return parseInteger(readText(tokens, tag));
    case "real": {
      const value = Number(readText(tokens, tag).trim());
      if (Number.isNaN(value)) throw new Error("plist 浮点数格式不对");
      return value;
    }
    case "date": {
      const raw = readText(tokens, tag).trim();
      const at = Date.parse(raw);
      if (Number.isNaN(at)) throw new Error(`plist 日期格式不对：${raw.slice(0, 40)}`);
      return new Date(at);
    }
    case "data":
      return open.selfClosing ? new Uint8Array(0) : decodeData(readText(tokens, tag), tokens.lifted);
    case "array": {
      const items: PlistValue[] = [];
      if (open.selfClosing) return items;
      for (;;) {
        const token = tokens.next();
        if (!token) throw new Error("plist 的 <array> 没有闭合");
        if (token.closing && token.tag === "array") return items;
        if (token.tag === null || token.closing) throw new Error("plist 的 <array> 里有多余内容");
        items.push(parseElement(tokens, token, depth + 1));
      }
    }
    case "dict": {
      const dict: PlistDict = {};
      if (open.selfClosing) return dict;
      for (;;) {
        const token = tokens.next();
        if (!token) throw new Error("plist 的 <dict> 没有闭合");
        if (token.closing && token.tag === "dict") return dict;
        if (token.tag !== "key" || token.closing) throw new Error("plist 的 <dict> 里缺 <key>");
        const key = token.selfClosing ? "" : readText(tokens, "key");
        const valueToken = tokens.next();
        if (!valueToken || valueToken.tag === null || valueToken.closing) {
          throw new Error(`plist 的键 ${key} 没有值`);
        }
        dict[key] = parseElement(tokens, valueToken, depth + 1);
      }
    }
    default:
      throw new Error(`plist 里有不认识的类型 <${tag}>`);
  }
}

export function decodeXmlPlist(text: string, lifted: Uint8Array[] = []): PlistValue {
  const tokens = new XmlTokens(text, lifted);
  let token = tokens.next();
  if (token?.tag === "plist" && !token.closing) token = tokens.next();
  if (!token || token.tag === null || token.closing) throw new Error("plist 没有根元素");
  return parseElement(tokens, token, 0);
}

/** XML 和二进制都认。 */
export function decodePlist(bytes: Uint8Array): PlistValue {
  if (isBplist(bytes)) return decodeBplist(bytes).root;
  const { text, lifted } = liftDataBlocks(bytes);
  return decodeXmlPlist(text, lifted);
}
