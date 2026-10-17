// RemoteXPC 的对象编码（对应 idevice 的 xpc::format）。
//
// 对象体：magic 0x42133742 + 版本 5 + 对象树，全部小端。
// 消息外壳：magic 0x29b00b92 + flags(u32) + body_len(u64) + message_id(u64)，共 24 字节。
// 字符串与数据按 4 字节对齐补零。

import { concat, readU32LE, toHex, u32le, u64le } from "./bytes";

const OBJECT_MAGIC = 0x42133742;
const OBJECT_VERSION = 0x00000005;
const MESSAGE_MAGIC = 0x29b00b92;
export const MESSAGE_HEADER_LEN = 24;

const XpcType = {
  Null: 0x00001000,
  Bool: 0x00002000,
  Int64: 0x00003000,
  UInt64: 0x00004000,
  Double: 0x00005000,
  Date: 0x00007000,
  Data: 0x00008000,
  String: 0x00009000,
  Uuid: 0x0000a000,
  Array: 0x0000e000,
  Dictionary: 0x0000f000,
} as const;

export const XpcFlag = {
  AlwaysSet: 0x00000001,
  DataFlag: 0x00000100,
  WantingReply: 0x00010000,
  Reply: 0x00020000,
  InitHandshake: 0x00400000,
} as const;

export class XpcUInt64 {
  constructor(readonly value: bigint) {}
}

export class XpcDouble {
  constructor(readonly value: number) {}
}

export class XpcUuid {
  constructor(readonly bytes: Uint8Array) {}

  static random(): XpcUuid {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    return new XpcUuid(bytes);
  }
}

export type XpcValue =
  | null
  | boolean
  | number
  | XpcUInt64
  | XpcDouble
  | XpcUuid
  | string
  | Uint8Array
  | XpcValue[]
  | { [key: string]: XpcValue };

function padding(length: number): number {
  return (4 - (length % 4)) % 4;
}

function encodeValue(value: XpcValue): Uint8Array {
  if (value === null) return u32le(XpcType.Null);

  if (typeof value === "boolean") {
    return concat(u32le(XpcType.Bool), new Uint8Array([value ? 1 : 0, 0, 0, 0]));
  }

  if (typeof value === "number") {
    const out = new Uint8Array(8);
    new DataView(out.buffer).setBigInt64(0, BigInt(Math.trunc(value)), true);
    return concat(u32le(XpcType.Int64), out);
  }

  if (value instanceof XpcUInt64) {
    const out = new Uint8Array(8);
    new DataView(out.buffer).setBigUint64(0, value.value, true);
    return concat(u32le(XpcType.UInt64), out);
  }

  if (value instanceof XpcDouble) {
    const out = new Uint8Array(8);
    new DataView(out.buffer).setFloat64(0, value.value, true);
    return concat(u32le(XpcType.Double), out);
  }

  if (value instanceof XpcUuid) {
    return concat(u32le(XpcType.Uuid), value.bytes);
  }

  if (typeof value === "string") {
    const text = new TextEncoder().encode(value);
    const length = text.length + 1; // 含结尾 NUL
    return concat(
      u32le(XpcType.String),
      u32le(length),
      text,
      new Uint8Array(1 + padding(length)),
    );
  }

  if (value instanceof Uint8Array) {
    return concat(u32le(XpcType.Data), u32le(value.length), value, new Uint8Array(padding(value.length)));
  }

  if (Array.isArray(value)) {
    const body = concat(u32le(value.length), ...value.map(encodeValue));
    return concat(u32le(XpcType.Array), u32le(body.length), body);
  }

  const entries = Object.entries(value);
  const parts: Uint8Array[] = [u32le(entries.length)];
  for (const [key, item] of entries) {
    const keyBytes = new TextEncoder().encode(key);
    parts.push(keyBytes, new Uint8Array(1 + padding(keyBytes.length + 1)), encodeValue(item));
  }
  const body = concat(...parts);
  return concat(u32le(XpcType.Dictionary), u32le(body.length), body);
}

export function encodeXpcObject(value: XpcValue): Uint8Array {
  return concat(u32le(OBJECT_MAGIC), u32le(OBJECT_VERSION), encodeValue(value));
}

interface Cursor {
  bytes: Uint8Array;
  offset: number;
}

function readU32(cursor: Cursor): number {
  const value = readU32LE(cursor.bytes, cursor.offset);
  cursor.offset += 4;
  return value;
}

function decodeValue(cursor: Cursor): unknown {
  const type = readU32(cursor);
  const view = new DataView(cursor.bytes.buffer as ArrayBuffer, cursor.bytes.byteOffset);

  switch (type) {
    case XpcType.Null:
      return null;
    case XpcType.Bool: {
      const value = cursor.bytes[cursor.offset] !== 0;
      cursor.offset += 4;
      return value;
    }
    case XpcType.Int64: {
      const value = view.getBigInt64(cursor.offset, true);
      cursor.offset += 8;
      return Number(value);
    }
    case XpcType.UInt64: {
      const value = view.getBigUint64(cursor.offset, true);
      cursor.offset += 8;
      return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value;
    }
    case XpcType.Double: {
      const value = view.getFloat64(cursor.offset, true);
      cursor.offset += 8;
      return value;
    }
    case XpcType.Date: {
      const value = view.getBigUint64(cursor.offset, true);
      cursor.offset += 8;
      return Number(value / BigInt(1000000));
    }
    case XpcType.Data: {
      const length = readU32(cursor);
      const data = cursor.bytes.slice(cursor.offset, cursor.offset + length);
      cursor.offset += length + padding(length);
      return data;
    }
    case XpcType.String: {
      const length = readU32(cursor);
      const text = new TextDecoder().decode(cursor.bytes.subarray(cursor.offset, cursor.offset + length - 1));
      cursor.offset += length + padding(length);
      return text;
    }
    case XpcType.Uuid: {
      const data = cursor.bytes.slice(cursor.offset, cursor.offset + 16);
      cursor.offset += 16;
      return toHex(data);
    }
    case XpcType.Array: {
      readU32(cursor); // 内容长度，按条目数遍历即可
      const count = readU32(cursor);
      const items: unknown[] = [];
      for (let i = 0; i < count; i++) items.push(decodeValue(cursor));
      return items;
    }
    case XpcType.Dictionary: {
      readU32(cursor);
      const count = readU32(cursor);
      const dict: Record<string, unknown> = {};
      for (let i = 0; i < count; i++) {
        let end = cursor.offset;
        while (end < cursor.bytes.length && cursor.bytes[end] !== 0) end++;
        const key = new TextDecoder().decode(cursor.bytes.subarray(cursor.offset, end));
        const keyLength = end - cursor.offset + 1;
        cursor.offset += keyLength + padding(keyLength);
        dict[key] = decodeValue(cursor);
      }
      return dict;
    }
    default:
      throw new Error(`XPC 未知类型 0x${type.toString(16)}`);
  }
}

export function decodeXpcObject(bytes: Uint8Array): unknown {
  if (bytes.length < 8) throw new Error("XPC 对象数据过短");
  if (readU32LE(bytes, 0) !== OBJECT_MAGIC) throw new Error("XPC 对象魔数不对");
  return decodeValue({ bytes, offset: 8 });
}

export interface XpcMessage {
  flags: number;
  messageId: number;
  body: unknown;
}

export function encodeXpcMessage(flags: number, messageId: number, body?: XpcValue): Uint8Array {
  const encoded = body === undefined ? new Uint8Array(0) : encodeXpcObject(body);
  return concat(
    u32le(MESSAGE_MAGIC),
    u32le(flags),
    u64le(encoded.length),
    u64le(messageId),
    encoded,
  );
}

/** 数据不足时返回 null，调用方继续收包。 */
export function decodeXpcMessage(bytes: Uint8Array): { message: XpcMessage; consumed: number } | null {
  if (bytes.length < MESSAGE_HEADER_LEN) return null;
  if (readU32LE(bytes, 0) !== MESSAGE_MAGIC) throw new Error("XPC 消息魔数不对");

  const view = new DataView(bytes.buffer as ArrayBuffer, bytes.byteOffset);
  const flags = readU32LE(bytes, 4);
  const bodyLength = Number(view.getBigUint64(8, true));
  const messageId = Number(view.getBigUint64(16, true));

  if (bytes.length < MESSAGE_HEADER_LEN + bodyLength) return null;

  const body =
    bodyLength > 0
      ? decodeXpcObject(bytes.subarray(MESSAGE_HEADER_LEN, MESSAGE_HEADER_LEN + bodyLength))
      : undefined;

  return { message: { flags, messageId, body }, consumed: MESSAGE_HEADER_LEN + bodyLength };
}
