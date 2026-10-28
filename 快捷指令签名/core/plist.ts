// plist：读 XML / 二进制，写二进制（bplist00）/ XML。
//
// 签名要做的事：把用户给的未签名快捷指令（XML plist 居多）规规矩矩地转成二进制 plist，
// 塞进归档里的 Shortcut.wflow ——Apple 自己签出来的文件里就是二进制 plist。
//
// 值的表示：
//   整数    number（安全范围内）或 bigint（超出 2^53 的，像 ECID 那样的）
//   浮点    PReal（JS 分不清 1 和 1.0，而 plist 分得清，所以显式包一层）
//   字典    读出来是 Map（保持键的插入顺序；对象会把「0」「1」这种整数样的键排到前面）
//           写进去时 Map 和普通对象都认
//   日期    Date；数据 Uint8Array；其余是 boolean / string / 数组
//
// 本文件在脚本（core/）和技能（vendor/core/）里各有一份逐字节相同的副本（共 7 个文件，清单和同步命令见 MAINTAINING.md 第 14 节）：
// 源头是脚本这边，改任何一份都要同步另一份，自测会比对。

import { concat, fromBase64, toBase64, utf8 } from "./bytes";

export class PReal {
  constructor(readonly value: number) {}
}

export type PlistValue =
  | boolean
  | number
  | bigint
  | PReal
  | string
  | Date
  | Uint8Array
  | PlistValue[]
  | Map<string, PlistValue>
  | { [key: string]: PlistValue };

export type PlistDict = Map<string, PlistValue>;

export function isDict(value: unknown): value is PlistDict {
  return value instanceof Map;
}

/** Map 和普通对象统一成键值对。 */
function entriesOf(value: Map<string, PlistValue> | { [key: string]: PlistValue }): [string, PlistValue][] {
  return value instanceof Map ? [...value.entries()] : Object.entries(value);
}

function isDictLike(value: unknown): value is Map<string, PlistValue> | { [key: string]: PlistValue } {
  return (
    value instanceof Map ||
    (typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      !(value instanceof Uint8Array) &&
      !(value instanceof Date) &&
      !(value instanceof PReal))
  );
}

// ---------------------------------------------------------------------------
// XML 读取
// ---------------------------------------------------------------------------

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body] ?? whole;
  });
}

/** 一个很小的递归下降解析器，只认 plist 用到的那十来种标签。 */
class XmlPlistParser {
  private pos = 0;

  constructor(private readonly text: string) {}

  parse(): PlistValue {
    this.skipProlog();
    if (!this.peekTag("plist")) throw new Error("不是 plist：找不到 <plist>");
    this.expectOpen("plist");
    const value = this.parseValue();
    this.skipMisc();
    this.expectClose("plist");
    return value;
  }

  private fail(message: string): never {
    throw new Error(`plist 解析失败（第 ${this.pos} 个字符附近）：${message}`);
  }

  /** 跳过 BOM、<?xml?>、<!DOCTYPE>、注释和空白。 */
  private skipProlog(): void {
    if (this.text.charCodeAt(0) === 0xfeff) this.pos = 1;
    this.skipMisc();
  }

  private skipMisc(): void {
    for (;;) {
      while (this.pos < this.text.length && /\s/.test(this.text[this.pos])) this.pos++;
      if (this.text.startsWith("<?", this.pos)) {
        const end = this.text.indexOf("?>", this.pos);
        if (end < 0) this.fail("<? 没有结束");
        this.pos = end + 2;
      } else if (this.text.startsWith("<!--", this.pos)) {
        const end = this.text.indexOf("-->", this.pos);
        if (end < 0) this.fail("注释没有结束");
        this.pos = end + 3;
      } else if (this.text.startsWith("<!DOCTYPE", this.pos)) {
        const end = this.text.indexOf(">", this.pos);
        if (end < 0) this.fail("DOCTYPE 没有结束");
        this.pos = end + 1;
      } else return;
    }
  }

  private peekTag(name: string): boolean {
    return new RegExp(`^<${name}(\\s[^>]*)?/?>`).test(this.text.slice(this.pos, this.pos + name.length + 200));
  }

  /** 读一个开始标签，返回是否自闭合（<x/>）。 */
  private expectOpen(name: string): boolean {
    this.skipMisc();
    const match = new RegExp(`^<${name}(\\s[^>]*?)?(/?)>`).exec(this.text.slice(this.pos, this.pos + 400));
    if (!match) this.fail(`应为 <${name}>`);
    this.pos += match[0].length;
    return match[2] === "/";
  }

  private expectClose(name: string): void {
    this.skipMisc();
    const tag = `</${name}>`;
    if (!this.text.startsWith(tag, this.pos)) this.fail(`应为 ${tag}`);
    this.pos += tag.length;
  }

  /** 标签之间的原始文本（不 trim；字符串要原样保留空白）。 */
  private readText(closeName: string): string {
    const close = `</${closeName}>`;
    const end = this.text.indexOf(close, this.pos);
    if (end < 0) this.fail(`找不到 ${close}`);
    const raw = this.text.slice(this.pos, end);
    this.pos = end + close.length;
    // CDATA 段原样取出，其余部分解码实体
    return raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>|([^<]+|<)/g, (_whole, cdata: string | undefined, other: string | undefined) =>
      cdata !== undefined ? cdata : decodeEntities(other ?? ""),
    );
  }

  private parseValue(): PlistValue {
    this.skipMisc();
    const match = /^<([a-zA-Z]+)/.exec(this.text.slice(this.pos, this.pos + 40));
    if (!match) this.fail("应为一个值");
    const tag = match[1];
    switch (tag) {
      case "dict":
        return this.parseDict();
      case "array":
        return this.parseArray();
      case "string": {
        if (this.expectOpen("string")) return "";
        return this.readText("string");
      }
      case "integer": {
        if (this.expectOpen("integer")) this.fail("<integer/> 是空的");
        return this.toInteger(this.readText("integer").trim());
      }
      case "real": {
        if (this.expectOpen("real")) this.fail("<real/> 是空的");
        return new PReal(this.toReal(this.readText("real").trim()));
      }
      case "true":
      case "false": {
        const selfClosed = this.expectOpen(tag);
        if (!selfClosed) this.expectClose(tag);
        return tag === "true";
      }
      case "data": {
        if (this.expectOpen("data")) return new Uint8Array(0);
        return fromBase64(this.readText("data"));
      }
      case "date": {
        if (this.expectOpen("date")) this.fail("<date/> 是空的");
        const date = new Date(this.readText("date").trim());
        if (Number.isNaN(date.getTime())) this.fail("日期格式不对");
        return date;
      }
      default:
        return this.fail(`不认识的标签 <${tag}>`);
    }
  }

  private parseDict(): PlistValue {
    const dict: PlistDict = new Map();
    if (this.expectOpen("dict")) return dict;
    for (;;) {
      this.skipMisc();
      if (this.text.startsWith("</dict>", this.pos)) break;
      if (this.expectOpen("key")) this.fail("<key/> 是空的");
      const key = this.readText("key");
      dict.set(key, this.parseValue());
    }
    this.expectClose("dict");
    return dict;
  }

  private parseArray(): PlistValue {
    const items: PlistValue[] = [];
    if (this.expectOpen("array")) return items;
    for (;;) {
      this.skipMisc();
      if (this.text.startsWith("</array>", this.pos)) break;
      items.push(this.parseValue());
    }
    this.expectClose("array");
    return items;
  }

  private toInteger(text: string): number | bigint {
    if (!/^(?:[+-]?\d+|0[xX][0-9a-fA-F]+)$/.test(text)) this.fail(`整数格式不对：${text}`);
    const value = BigInt(text.replace(/^\+/, ""));
    return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : value;
  }

  private toReal(text: string): number {
    const lower = text.toLowerCase();
    if (lower === "nan") return NaN;
    if (lower === "inf" || lower === "+inf" || lower === "infinity") return Infinity;
    if (lower === "-inf" || lower === "-infinity") return -Infinity;
    const value = Number(text);
    if (Number.isNaN(value)) this.fail(`浮点数格式不对：${text}`);
    return value;
  }
}

export function parseXmlPlist(text: string): PlistValue {
  return new XmlPlistParser(text).parse();
}

// ---------------------------------------------------------------------------
// 二进制 plist 写入
// ---------------------------------------------------------------------------

/** 1 / 2 / 4 / 8 字节里放得下 value 的最小宽度。 */
function minWidth(value: number): number {
  if (value < 0x100) return 1;
  if (value < 0x10000) return 2;
  if (value < 0x100000000) return 4;
  return 8;
}

function writeUInt(value: number | bigint, width: number): Uint8Array {
  const out = new Uint8Array(width);
  let rest = BigInt(value);
  for (let i = width - 1; i >= 0; i--) {
    out[i] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  return out;
}

const APPLE_EPOCH_MS = Date.UTC(2001, 0, 1);

function doubleBytes(value: number): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setFloat64(0, value);
  return out;
}

/** 整数对象：0x1N + 大端补码。 */
function encodeIntObject(value: number | bigint): Uint8Array {
  const n = BigInt(value);
  if (n < 0n) {
    if (n < -(1n << 63n)) throw new Error("整数太小，二进制 plist 放不下");
    return concat(Uint8Array.of(0x13), writeUInt(n + (1n << 64n), 8));
  }
  if (n < 0x100n) return concat(Uint8Array.of(0x10), writeUInt(n, 1));
  if (n < 0x10000n) return concat(Uint8Array.of(0x11), writeUInt(n, 2));
  if (n < 0x100000000n) return concat(Uint8Array.of(0x12), writeUInt(n, 4));
  if (n < 1n << 63n) return concat(Uint8Array.of(0x13), writeUInt(n, 8));
  if (n < 1n << 64n) return concat(Uint8Array.of(0x14), writeUInt(n, 16));
  throw new Error("整数太大，二进制 plist 放不下");
}

/** 带长度的对象头：长度 < 15 直接放低 4 位，否则低 4 位是 F，后面跟一个整数对象。 */
function lengthHeader(marker: number, length: number): Uint8Array {
  return length < 15
    ? Uint8Array.of(marker | length)
    : concat(Uint8Array.of(marker | 0x0f), encodeIntObject(length));
}

const isAscii = (text: string): boolean => /^[\x00-\x7f]*$/.test(text);

function utf16be(text: string): Uint8Array {
  const out = new Uint8Array(text.length * 2);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    out[i * 2] = code >> 8;
    out[i * 2 + 1] = code & 0xff;
  }
  return out;
}

export function encodeBplist(root: PlistValue): Uint8Array {
  // 先把对象树铺平：相同的字符串 / 数字 / 日期 / 数据只存一份（Apple 和 plistlib 都这么做），
  // 键名在几百个动作里会重复成千上万次，不去重文件会大好几倍。
  interface Node {
    kind: "leaf" | "array" | "dict";
    bytes?: Uint8Array;
    children?: number[]; // array: 元素；dict: 先全部键、后全部值
  }
  const nodes: Node[] = [];
  const seen = new Map<string, number>();

  const leaf = (key: string, build: () => Uint8Array): number => {
    const known = seen.get(key);
    if (known !== undefined) return known;
    nodes.push({ kind: "leaf", bytes: build() });
    seen.set(key, nodes.length - 1);
    return nodes.length - 1;
  };

  const flatten = (value: PlistValue): number => {
    if (typeof value === "boolean") return leaf(value ? "t" : "f", () => Uint8Array.of(value ? 0x09 : 0x08));
    if (typeof value === "number" || typeof value === "bigint") {
      if (typeof value === "number" && !Number.isInteger(value)) throw new Error("非整数请用 PReal 包起来");
      return leaf(`i${value}`, () => encodeIntObject(value));
    }
    if (value instanceof PReal) {
      const bytes = doubleBytes(value.value);
      return leaf(`r${Array.from(bytes).join(",")}`, () => concat(Uint8Array.of(0x23), bytes));
    }
    if (typeof value === "string") {
      return leaf(`s${value}`, () =>
        isAscii(value)
          ? concat(lengthHeader(0x50, value.length), utf8(value))
          : concat(lengthHeader(0x60, value.length), utf16be(value)),
      );
    }
    if (value instanceof Date) {
      const bytes = doubleBytes((value.getTime() - APPLE_EPOCH_MS) / 1000);
      return leaf(`d${value.getTime()}`, () => concat(Uint8Array.of(0x33), bytes));
    }
    if (value instanceof Uint8Array) {
      return leaf(`b${toBase64(value)}`, () => concat(lengthHeader(0x40, value.length), value));
    }
    if (Array.isArray(value)) {
      const index = nodes.length;
      nodes.push({ kind: "array", children: [] });
      nodes[index].children = value.map(flatten);
      return index;
    }
    if (isDictLike(value)) {
      const index = nodes.length;
      nodes.push({ kind: "dict", children: [] });
      const pairs = entriesOf(value);
      const keys = pairs.map(([key]) => flatten(key));
      const values = pairs.map(([, item]) => flatten(item));
      nodes[index].children = [...keys, ...values];
      return index;
    }
    throw new Error("二进制 plist 不支持这种值");
  };

  flatten(root);

  const refWidth = minWidth(Math.max(nodes.length - 1, 0));
  const header = utf8("bplist00");
  const parts: Uint8Array[] = [header];
  const offsets: number[] = [];
  let cursor = header.length;
  for (const node of nodes) {
    let bytes: Uint8Array;
    if (node.kind === "leaf") bytes = node.bytes as Uint8Array;
    else {
      const children = node.children as number[];
      const count = node.kind === "array" ? children.length : children.length / 2;
      const refs = concat(...children.map((child) => writeUInt(child, refWidth)));
      bytes = concat(lengthHeader(node.kind === "array" ? 0xa0 : 0xd0, count), refs);
    }
    offsets.push(cursor);
    parts.push(bytes);
    cursor += bytes.length;
  }

  const offsetWidth = minWidth(cursor);
  const table = concat(...offsets.map((offset) => writeUInt(offset, offsetWidth)));
  const trailer = new Uint8Array(32);
  trailer[6] = offsetWidth;
  trailer[7] = refWidth;
  trailer.set(writeUInt(nodes.length, 8), 8);
  trailer.set(writeUInt(0, 8), 16); // 顶层对象就是第 0 个
  trailer.set(writeUInt(cursor, 8), 24);
  return concat(...parts, table, trailer);
}

// ---------------------------------------------------------------------------
// 二进制 plist 读取
// ---------------------------------------------------------------------------

export function isBplist(bytes: Uint8Array): boolean {
  return bytes.length >= 8 && String.fromCharCode(...bytes.subarray(0, 8)) === "bplist00";
}

export function parseBplist(bytes: Uint8Array): PlistValue {
  if (!isBplist(bytes) || bytes.length < 8 + 32) throw new Error("不是二进制 plist");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const trailer = bytes.length - 32;
  const offsetWidth = bytes[trailer + 6];
  const refWidth = bytes[trailer + 7];
  const count = Number(view.getBigUint64(trailer + 8));
  const top = Number(view.getBigUint64(trailer + 16));
  const tableOffset = Number(view.getBigUint64(trailer + 24));
  if (offsetWidth < 1 || offsetWidth > 8 || refWidth < 1 || refWidth > 8) throw new Error("二进制 plist 的宽度字段不合法");
  if (top >= count || tableOffset + count * offsetWidth > trailer) throw new Error("二进制 plist 的偏移表不合法");

  const readUInt = (at: number, width: number): number => {
    let value = 0;
    for (let i = 0; i < width; i++) value = value * 256 + bytes[at + i];
    return value;
  };

  const decode = (index: number, depth: number): PlistValue => {
    if (depth > 64) throw new Error("二进制 plist 嵌套太深");
    if (index >= count) throw new Error("二进制 plist 的对象引用越界");
    let at = readUInt(tableOffset + index * offsetWidth, offsetWidth);
    const marker = bytes[at++];
    const high = marker >> 4;
    const low = marker & 0x0f;

    // 带长度的类型：低 4 位是 F 时，长度在后面的整数对象里
    const readLength = (): number => {
      if (low !== 0x0f) return low;
      const intMarker = bytes[at++];
      if (intMarker >> 4 !== 1) throw new Error("二进制 plist 的长度字段不合法");
      const width = 1 << (intMarker & 0x0f);
      const value = readUInt(at, width);
      at += width;
      return value;
    };

    switch (high) {
      case 0x0:
        if (low === 0x08) return false;
        if (low === 0x09) return true;
        throw new Error("二进制 plist 里有不支持的简单值");
      case 0x1: {
        const width = 1 << low;
        if (width === 16) {
          let value = 0n;
          for (let i = 0; i < 16; i++) value = (value << 8n) | BigInt(bytes[at + i]);
          return value >= 1n << 127n ? value - (1n << 128n) : value;
        }
        if (width === 8) {
          const value = view.getBigInt64(at);
          return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
            ? Number(value)
            : value;
        }
        return readUInt(at, width);
      }
      case 0x2:
        return new PReal(low === 3 ? view.getFloat64(at) : view.getFloat32(at));
      case 0x3:
        return new Date(APPLE_EPOCH_MS + view.getFloat64(at) * 1000);
      case 0x4: {
        const length = readLength();
        return bytes.slice(at, at + length);
      }
      case 0x5: {
        const length = readLength();
        return String.fromCharCode(...bytes.subarray(at, at + length));
      }
      case 0x6: {
        const length = readLength();
        let text = "";
        for (let i = 0; i < length; i++) text += String.fromCharCode((bytes[at + i * 2] << 8) | bytes[at + i * 2 + 1]);
        return text;
      }
      case 0x7: {
        const length = readLength();
        return new TextDecoder().decode(bytes.subarray(at, at + length));
      }
      case 0xa:
      case 0xc: {
        const length = readLength();
        const items: PlistValue[] = [];
        for (let i = 0; i < length; i++) items.push(decode(readUInt(at + i * refWidth, refWidth), depth + 1));
        return items;
      }
      case 0xd: {
        const length = readLength();
        const dict: PlistDict = new Map();
        for (let i = 0; i < length; i++) {
          const key = decode(readUInt(at + i * refWidth, refWidth), depth + 1);
          const value = decode(readUInt(at + (length + i) * refWidth, refWidth), depth + 1);
          if (typeof key !== "string") throw new Error("二进制 plist 的键不是字符串");
          dict.set(key, value);
        }
        return dict;
      }
      default:
        throw new Error(`二进制 plist 里有不支持的类型 0x${marker.toString(16)}`);
    }
  };

  return decode(top, 0);
}

/** XML 或二进制都认。 */
export function parsePlist(bytes: Uint8Array): PlistValue {
  return isBplist(bytes) ? parseBplist(bytes) : parseXmlPlist(new TextDecoder().decode(bytes));
}

// ---------------------------------------------------------------------------
// XML 写入（给描述文件用）
// ---------------------------------------------------------------------------

function escapeXml(text: string): string {
  // XML 1.0 放不下大部分控制字符；写出去再读回来会悄悄变样，不如当场报错
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) throw new Error("XML plist 放不下控制字符");
  // 回车必须写成字符引用：XML 解析器会把裸的 \r / \r\n 统一成 \n
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\r/g, "&#13;");
}

export function encodeXmlPlist(root: PlistValue): Uint8Array {
  const lines: string[] = [];
  const walk = (value: PlistValue, depth: number): void => {
    const pad = "\t".repeat(depth);
    if (typeof value === "boolean") lines.push(`${pad}<${value}/>`);
    else if (typeof value === "number" || typeof value === "bigint") {
      if (typeof value === "number" && !Number.isInteger(value)) throw new Error("非整数请用 PReal 包起来");
      lines.push(`${pad}<integer>${value}</integer>`);
    } else if (value instanceof PReal) lines.push(`${pad}<real>${value.value}</real>`);
    else if (typeof value === "string") lines.push(`${pad}<string>${escapeXml(value)}</string>`);
    else if (value instanceof Date) lines.push(`${pad}<date>${value.toISOString().replace(/\.\d+Z$/, "Z")}</date>`);
    else if (value instanceof Uint8Array) lines.push(`${pad}<data>${toBase64(value)}</data>`);
    else if (Array.isArray(value)) {
      if (value.length === 0) lines.push(`${pad}<array/>`);
      else {
        lines.push(`${pad}<array>`);
        for (const item of value) walk(item, depth + 1);
        lines.push(`${pad}</array>`);
      }
    } else if (isDictLike(value)) {
      const pairs = entriesOf(value);
      if (pairs.length === 0) lines.push(`${pad}<dict/>`);
      else {
        lines.push(`${pad}<dict>`);
        for (const [key, item] of pairs) {
          lines.push(`${pad}\t<key>${escapeXml(key)}</key>`);
          walk(item, depth + 1);
        }
        lines.push(`${pad}</dict>`);
      }
    } else throw new Error("XML plist 不支持这种值");
  };
  walk(root, 1);
  const head =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
    '<plist version="1.0">\n';
  return utf8(`${head}${lines.join("\n")}\n</plist>\n`);
}
