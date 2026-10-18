// 二进制 plist（bplist00）读写。
//
// 写用于 NSKeyedArchiver（DTX 的方法名与参数必须是归档后的 plist）；
// 读用于解析配对文件与 DTX 回包里的 NSError。
//
// 只实现实际会碰到的类型：null/bool/int/real/data/string/array/dict/uid。
// 不做对象去重——归档的对象图只有几个节点，去重省不下什么。

/** plist 的 CFKeyedArchiverUID，$top/$objects 里的引用。 */
export class PUid {
  constructor(readonly value: number) {}
}

/** 显式浮点数。JS 不区分 1 和 1.0，而 plist 区分。 */
export class PReal {
  constructor(readonly value: number) {}
}

/**
 * 这里的解码器不产生 Date——二进制 plist 的日期解成 PReal（毫秒数）。
 * `Date` 是给 kit/lockdown.ts 那条路留的：原生的 DeviceServices 解出来就是 Date 对象，
 * 两边的值要能混着用，类型得认它。
 */
export type PlistValue =
  | null
  | boolean
  | number
  | PReal
  | PUid
  | string
  | Date
  | Uint8Array
  | PlistValue[]
  | { [key: string]: PlistValue };

const HEADER = "bplist00";

function isDict(value: PlistValue): value is { [key: string]: PlistValue } {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Uint8Array) &&
    !(value instanceof PUid) &&
    !(value instanceof PReal)
  );
}

/** 容纳 value 所需的字节宽度（1/2/4/8）。 */
function byteWidth(value: number): number {
  if (value < 0x100) return 1;
  if (value < 0x10000) return 2;
  if (value < 0x100000000) return 4;
  return 8;
}

function writeUIntBE(value: number, size: number): Uint8Array {
  const out = new Uint8Array(size);
  let v = value;
  for (let i = size - 1; i >= 0; i--) {
    out[i] = v & 0xff;
    v = Math.floor(v / 256);
  }
  return out;
}

// ── 写 ────────────────────────────────────────────────────────────────────

interface ObjectTable {
  objects: PlistValue[];
  arrayRefs: Map<number, number[]>;
  dictRefs: Map<number, { keys: number[]; values: number[] }>;
}

function addObject(value: PlistValue, table: ObjectTable): number {
  const index = table.objects.length;
  table.objects.push(value);

  if (Array.isArray(value)) {
    const refs: number[] = [];
    for (const item of value) refs.push(addObject(item, table));
    table.arrayRefs.set(index, refs);
  } else if (isDict(value)) {
    const keys: number[] = [];
    const values: number[] = [];
    // 键先全部入表再入值，与 CoreFoundation 的布局一致。
    for (const key of Object.keys(value)) keys.push(addObject(key, table));
    for (const key of Object.keys(value)) values.push(addObject(value[key], table));
    table.dictRefs.set(index, { keys, values });
  }

  return index;
}

/** 0x_F 长度前缀：长度 < 15 直接写进低 4 位，否则写 0xF 再跟一个 int。 */
function marker(type: number, length: number): Uint8Array {
  if (length < 15) return new Uint8Array([(type << 4) | length]);
  const size = byteWidth(length);
  const log2 = size === 1 ? 0 : size === 2 ? 1 : size === 4 ? 2 : 3;
  const out = new Uint8Array(2 + size);
  out[0] = (type << 4) | 0x0f;
  out[1] = 0x10 | log2;
  out.set(writeUIntBE(length, size), 2);
  return out;
}

function encodeInt(value: number): Uint8Array {
  if (value < 0) {
    // 负数一律按 8 字节补码写。
    const out = new Uint8Array(9);
    out[0] = 0x13;
    new DataView(out.buffer).setBigInt64(1, BigInt(Math.trunc(value)), false);
    return out;
  }
  const size = byteWidth(value);
  const log2 = size === 1 ? 0 : size === 2 ? 1 : size === 4 ? 2 : 3;
  const out = new Uint8Array(1 + size);
  out[0] = 0x10 | log2;
  out.set(writeUIntBE(value, size), 1);
  return out;
}

function encodeString(value: string): Uint8Array {
  let ascii = true;
  for (let i = 0; i < value.length; i++) {
    if (value.charCodeAt(i) > 0x7f) {
      ascii = false;
      break;
    }
  }

  if (ascii) {
    const head = marker(0x5, value.length);
    const out = new Uint8Array(head.length + value.length);
    out.set(head);
    for (let i = 0; i < value.length; i++) out[head.length + i] = value.charCodeAt(i);
    return out;
  }

  // UTF-16BE，长度按码元数计。
  const head = marker(0x6, value.length);
  const out = new Uint8Array(head.length + value.length * 2);
  out.set(head);
  const view = new DataView(out.buffer);
  for (let i = 0; i < value.length; i++) view.setUint16(head.length + i * 2, value.charCodeAt(i), false);
  return out;
}

function encodeRefs(refs: number[], refSize: number): Uint8Array {
  const out = new Uint8Array(refs.length * refSize);
  for (let i = 0; i < refs.length; i++) out.set(writeUIntBE(refs[i], refSize), i * refSize);
  return out;
}

function encodeObject(index: number, table: ObjectTable, refSize: number): Uint8Array {
  const value = table.objects[index];

  if (value === null) return new Uint8Array([0x00]);
  if (typeof value === "boolean") return new Uint8Array([value ? 0x09 : 0x08]);
  if (typeof value === "number") return encodeInt(value);

  if (value instanceof PReal) {
    const out = new Uint8Array(9);
    out[0] = 0x23;
    new DataView(out.buffer).setFloat64(1, value.value, false);
    return out;
  }

  if (value instanceof PUid) {
    const size = byteWidth(value.value);
    const out = new Uint8Array(1 + size);
    out[0] = 0x80 | (size - 1);
    out.set(writeUIntBE(value.value, size), 1);
    return out;
  }

  if (typeof value === "string") return encodeString(value);

  if (value instanceof Uint8Array) {
    const head = marker(0x4, value.length);
    const out = new Uint8Array(head.length + value.length);
    out.set(head);
    out.set(value, head.length);
    return out;
  }

  if (Array.isArray(value)) {
    const refs = table.arrayRefs.get(index) ?? [];
    const head = marker(0xa, refs.length);
    const body = encodeRefs(refs, refSize);
    const out = new Uint8Array(head.length + body.length);
    out.set(head);
    out.set(body, head.length);
    return out;
  }

  const refs = table.dictRefs.get(index) ?? { keys: [], values: [] };
  const head = marker(0xd, refs.keys.length);
  const keyBytes = encodeRefs(refs.keys, refSize);
  const valueBytes = encodeRefs(refs.values, refSize);
  const out = new Uint8Array(head.length + keyBytes.length + valueBytes.length);
  out.set(head);
  out.set(keyBytes, head.length);
  out.set(valueBytes, head.length + keyBytes.length);
  return out;
}

export function encodeBplist(root: PlistValue): Uint8Array {
  const table: ObjectTable = { objects: [], arrayRefs: new Map(), dictRefs: new Map() };
  addObject(root, table);

  const count = table.objects.length;
  const refSize = byteWidth(Math.max(0, count - 1));

  const chunks: Uint8Array[] = [];
  const offsets: number[] = [];
  let position = HEADER.length;
  for (let i = 0; i < count; i++) {
    const encoded = encodeObject(i, table, refSize);
    offsets.push(position);
    position += encoded.length;
    chunks.push(encoded);
  }

  const offsetTableOffset = position;
  const offsetSize = byteWidth(offsetTableOffset);

  const out = new Uint8Array(offsetTableOffset + count * offsetSize + 32);
  for (let i = 0; i < HEADER.length; i++) out[i] = HEADER.charCodeAt(i);
  let cursor = HEADER.length;
  for (const chunk of chunks) {
    out.set(chunk, cursor);
    cursor += chunk.length;
  }
  for (let i = 0; i < count; i++) {
    out.set(writeUIntBE(offsets[i], offsetSize), cursor);
    cursor += offsetSize;
  }

  // 尾部 32 字节：5 字节保留 + sortVersion + offsetIntSize + objectRefSize
  // + numObjects + topObject + offsetTableOffset（后三个都是大端 u64）。
  const view = new DataView(out.buffer);
  out[cursor + 5] = 0; // sortVersion
  out[cursor + 6] = offsetSize;
  out[cursor + 7] = refSize;
  view.setBigUint64(cursor + 8, BigInt(count), false);
  view.setBigUint64(cursor + 16, BigInt(0), false); // topObject
  view.setBigUint64(cursor + 24, BigInt(offsetTableOffset), false);

  return out;
}

// ── 读 ────────────────────────────────────────────────────────────────────

export interface ParsedBplist {
  root: PlistValue;
  objects: PlistValue[];
}

function readUIntBE(bytes: Uint8Array, offset: number, size: number): number {
  let value = 0;
  for (let i = 0; i < size; i++) value = value * 256 + bytes[offset + i];
  return value;
}

export function isBplist(bytes: Uint8Array): boolean {
  if (bytes.length < 8) return false;
  for (let i = 0; i < HEADER.length; i++) {
    if (bytes[i] !== HEADER.charCodeAt(i)) return false;
  }
  return true;
}

/**
 * 解析 bplist。UID 原样保留为 PUid，由调用方（NSKeyedUnarchiver）解引用；
 * 嵌套容器按引用延迟解析，循环引用不会导致无限递归。
 */
export function decodeBplist(bytes: Uint8Array): ParsedBplist {
  if (!isBplist(bytes)) throw new Error("不是 bplist00 数据");
  if (bytes.length < 40) throw new Error("bplist 数据过短");

  const trailer = bytes.length - 32;
  const offsetSize = bytes[trailer + 6];
  const refSize = bytes[trailer + 7];
  const count = readUIntBE(bytes, trailer + 8, 8);
  const topObject = readUIntBE(bytes, trailer + 16, 8);
  const offsetTableOffset = readUIntBE(bytes, trailer + 24, 8);

  if (offsetSize < 1 || offsetSize > 8 || refSize < 1 || refSize > 8
      || !Number.isSafeInteger(count) || count < 1 || topObject >= count
      || offsetTableOffset < 8 || offsetTableOffset > trailer
      || count > Math.floor((trailer - offsetTableOffset) / offsetSize)) {
    throw new Error("bplist 尾部字段无效");
  }

  const offsets: number[] = [];
  for (let i = 0; i < count; i++) {
    const offset = readUIntBE(bytes, offsetTableOffset + i * offsetSize, offsetSize);
    if (offset < 8 || offset >= offsetTableOffset) throw new Error("bplist 对象偏移无效");
    offsets.push(offset);
  }

  const cache = new Map<number, PlistValue>();

  // depth 用来挡住自引用的对象图——不设上限的话一个指回自己的数组就能让它无限递归。
  function parseAt(index: number, depth = 0): PlistValue {
    if (depth > 128 || !Number.isSafeInteger(index) || index < 0 || index >= count) throw new Error("bplist 对象引用越界");
    const cached = cache.get(index);
    if (cached !== undefined) return cached;

    let offset = offsets[index];
    const head = bytes[offset];
    const type = head >> 4;
    let length = head & 0x0f;
    offset += 1;

    // 容器与变长类型的 0xF 表示长度另起一个 int。
    if (length === 0x0f && type !== 0x0 && type !== 0x1 && type !== 0x2 && type !== 0x8) {
      const intHead = bytes[offset];
      const intSize = 1 << (intHead & 0x0f);
      if (intHead >> 4 !== 1 || intSize > 8 || offset + 1 + intSize > offsetTableOffset) throw new Error("bplist 长度无效");
      length = readUIntBE(bytes, offset + 1, intSize);
      offset += 1 + intSize;
    }

    const sizes: Record<number, number> = {
      1: 1 << length, 2: 1 << length, 3: 8, 4: length, 5: length,
      6: length * 2, 8: length + 1, 10: length * refSize,
      12: length * refSize, 13: length * refSize * 2,
    };
    const size = sizes[type] ?? 0;
    if (!Number.isSafeInteger(length) || !Number.isSafeInteger(size) || size < 0
        || offset + size > offsetTableOffset || ((type === 1 || type === 2) && length > 3)) {
      throw new Error("bplist 对象长度无效");
    }

    let result: PlistValue;
    switch (type) {
      case 0x0:
        result = head === 0x09 ? true : head === 0x08 ? false : null;
        break;
      case 0x1:
        result = readUIntBE(bytes, offset, 1 << length);
        break;
      case 0x2: {
        const view = new DataView(bytes.buffer as ArrayBuffer, bytes.byteOffset);
        result = new PReal(length === 2 ? view.getFloat32(offset, false) : view.getFloat64(offset, false));
        break;
      }
      case 0x3: {
        // 日期：Apple 纪元起的秒数，转成毫秒时间戳。
        const view = new DataView(bytes.buffer as ArrayBuffer, bytes.byteOffset);
        result = new PReal(view.getFloat64(offset, false) * 1000 + 978307200000);
        break;
      }
      case 0x4:
        result = bytes.slice(offset, offset + length);
        break;
      case 0x5: {
        let text = "";
        for (let i = 0; i < length; i++) text += String.fromCharCode(bytes[offset + i]);
        result = text;
        break;
      }
      case 0x6: {
        const view = new DataView(bytes.buffer as ArrayBuffer, bytes.byteOffset);
        let text = "";
        for (let i = 0; i < length; i++) text += String.fromCharCode(view.getUint16(offset + i * 2, false));
        result = text;
        break;
      }
      case 0x8:
        result = new PUid(readUIntBE(bytes, offset, length + 1));
        break;
      case 0xa:
      case 0xc: {
        const items: PlistValue[] = [];
        cache.set(index, items);
        for (let i = 0; i < length; i++) items.push(parseAt(readUIntBE(bytes, offset + i * refSize, refSize), depth + 1));
        return items;
      }
      case 0xd: {
        // 用无原型对象：键名直接来自设备，普通字面量会被 __proto__ 一类的键污染。
        const dict: { [key: string]: PlistValue } = Object.create(null);
        cache.set(index, dict);
        for (let i = 0; i < length; i++) {
          const keyRef = readUIntBE(bytes, offset + i * refSize, refSize);
          const valueRef = readUIntBE(bytes, offset + (length + i) * refSize, refSize);
          dict[String(parseAt(keyRef, depth + 1))] = parseAt(valueRef, depth + 1);
        }
        return dict;
      }
      default:
        throw new Error(`bplist 不支持的类型 0x${type.toString(16)}`);
    }

    cache.set(index, result);
    return result;
  }

  const objects: PlistValue[] = [];
  for (let i = 0; i < count; i++) objects.push(parseAt(i));

  return { root: parseAt(topObject), objects };
}
