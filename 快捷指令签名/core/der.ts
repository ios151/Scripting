// ASN.1 DER 编码小工具，只覆盖生成 X.509 证书要用到的那几种类型。

import { bigIntToBytes, concat, utf8 } from "./bytes";

export function encodeLength(length: number): Uint8Array {
  if (length < 0x80) return Uint8Array.of(length);
  const bytes: number[] = [];
  for (let rest = length; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest % 256);
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

export function tlv(tag: number, content: Uint8Array): Uint8Array {
  return concat(Uint8Array.of(tag), encodeLength(content.length), content);
}

export function sequence(...items: Uint8Array[]): Uint8Array {
  return tlv(0x30, concat(...items));
}

export function set(...items: Uint8Array[]): Uint8Array {
  return tlv(0x31, concat(...items));
}

/** 非负整数；最高位为 1 时补 00，避免被读成负数。 */
export function integer(value: bigint | number): Uint8Array {
  const n = BigInt(value);
  if (n < 0n) throw new Error("只支持非负整数");
  let length = 1;
  while (n >> BigInt(length * 8) > 0n) length++;
  const bytes = bigIntToBytes(n, length);
  return tlv(0x02, bytes[0] & 0x80 ? concat(Uint8Array.of(0), bytes) : bytes);
}

export function boolean(value: boolean): Uint8Array {
  return tlv(0x01, Uint8Array.of(value ? 0xff : 0x00));
}

export function nullValue(): Uint8Array {
  return Uint8Array.of(0x05, 0x00);
}

/** 点分十进制 OID，如 "1.2.840.113635.100.18.1"。 */
export function oid(dotted: string): Uint8Array {
  const arcs = dotted.split(".").map((part) => BigInt(part));
  if (arcs.length < 2 || arcs[0] > 2n || (arcs[0] < 2n && arcs[1] >= 40n)) {
    throw new Error(`OID 不合法: ${dotted}`);
  }
  const bytes: number[] = [];
  const pushArc = (arc: bigint): void => {
    const groups = [Number(arc & 0x7fn)];
    for (let rest = arc >> 7n; rest > 0n; rest >>= 7n) groups.unshift(Number(rest & 0x7fn) | 0x80);
    bytes.push(...groups);
  };
  pushArc(arcs[0] * 40n + arcs[1]);
  for (const arc of arcs.slice(2)) pushArc(arc);
  return tlv(0x06, Uint8Array.from(bytes));
}

export function utf8String(text: string): Uint8Array {
  return tlv(0x0c, utf8(text));
}

export function octetString(bytes: Uint8Array): Uint8Array {
  return tlv(0x04, bytes);
}

/** unusedBits：最后一个字节里末尾不用的比特数。 */
export function bitString(bytes: Uint8Array, unusedBits = 0): Uint8Array {
  return tlv(0x03, concat(Uint8Array.of(unusedBits), bytes));
}

/** [n] EXPLICIT：把内容再包一层上下文标签（构造类型）。 */
export function explicit(tagNumber: number, content: Uint8Array): Uint8Array {
  return tlv(0xa0 | tagNumber, content);
}

/** [n] IMPLICIT 原始类型（如 AuthorityKeyIdentifier 的 keyIdentifier [0]）。 */
export function implicitPrimitive(tagNumber: number, content: Uint8Array): Uint8Array {
  return tlv(0x80 | tagNumber, content);
}

const pad2 = (value: number): string => String(value).padStart(2, "0");

/** 1950..2049 年用 UTCTime（YYMMDDHHMMSSZ），之外用 GeneralizedTime，这是 RFC 5280 的规定。 */
export function time(date: Date): Uint8Array {
  const year = date.getUTCFullYear();
  const rest =
    pad2(date.getUTCMonth() + 1) +
    pad2(date.getUTCDate()) +
    pad2(date.getUTCHours()) +
    pad2(date.getUTCMinutes()) +
    pad2(date.getUTCSeconds()) +
    "Z";
  if (year >= 1950 && year <= 2049) return tlv(0x17, utf8(pad2(year % 100) + rest));
  return tlv(0x18, utf8(String(year).padStart(4, "0") + rest));
}
