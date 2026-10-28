// 字节小工具。
//
// 刻意不依赖 Node 的 Buffer：设备上有 Buffer，但离线自测（Node）和设备走同一份代码，
// 只用 Uint8Array / TextEncoder / btoa / atob 这几样两边都有的东西最省心。
//
// 本文件在脚本（core/）和技能（vendor/core/）里各有一份逐字节相同的副本（共 7 个文件，清单和同步命令见 MAINTAINING.md 第 14 节）：
// 源头是脚本这边，改任何一份都要同步另一份，自测会比对。

export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, "0");
  return out;
}

export function fromHex(hex: string): Uint8Array {
  const clean = hex.replace(/\s+/g, "");
  if (clean.length % 2 !== 0 || /[^0-9a-fA-F]/.test(clean)) throw new Error("十六进制串不合法");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export function fromUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export function u16le(value: number): Uint8Array {
  return Uint8Array.of(value & 0xff, (value >>> 8) & 0xff);
}

export function u32le(value: number): Uint8Array {
  return Uint8Array.of(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
}

/** 有符号 32 位小端：HKDF 的 info 里段序号是 int32。 */
export function i32le(value: number): Uint8Array {
  return u32le(value | 0);
}

export function u64le(value: number | bigint): Uint8Array {
  let rest = BigInt(value);
  const out = new Uint8Array(8);
  for (let i = 0; i < 8; i++) {
    out[i] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  return out;
}

export function readU32LE(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0
  );
}

export function readU16LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

export function readU64LE(bytes: Uint8Array, offset: number): bigint {
  let value = 0n;
  for (let i = 7; i >= 0; i--) value = (value << 8n) | BigInt(bytes[offset + i]);
  return value;
}

export function bytesToBigInt(bytes: Uint8Array): bigint {
  let value = 0n;
  for (let i = 0; i < bytes.length; i++) value = (value << 8n) | BigInt(bytes[i]);
  return value;
}

/** 大端、定长；放不下就抛错，别悄悄截断。 */
export function bigIntToBytes(value: bigint, length: number): Uint8Array {
  if (value < 0n) throw new Error("不支持负数");
  const out = new Uint8Array(length);
  let rest = value;
  for (let i = length - 1; i >= 0; i--) {
    out[i] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  if (rest !== 0n) throw new Error(`数值放不进 ${length} 字节`);
  return out;
}

const CHUNK = 0x8000;

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function fromBase64(text: string): Uint8Array {
  const binary = atob(text.replace(/\s+/g, ""));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** Uint8Array / 其它类型化数组 / ArrayBuffer 本身，认得就给出对应的 Uint8Array 视图（不复制数据），不认得返回 null。 */
function viewOf(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value;
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  // 标签判断兜住「不是本环境构造出来的 ArrayBuffer」，instanceof 对它会失败
  if (value instanceof ArrayBuffer || Object.prototype.toString.call(value) === "[object ArrayBuffer]") {
    return new Uint8Array(value as ArrayBuffer);
  }
  return null;
}

/**
 * 把运行时交来的「一段字节」统一成 Uint8Array。
 *
 * 实测（2026-10-28，用户真机）：`FileManager.readAsBytesSync` 回来的是 **ArrayBuffer**，文档和 dts 却写 Uint8Array。
 * ArrayBuffer 没有 `length`，按 Uint8Array 用不会立刻报错，而是悄悄走歪——这里的表现是任何文件都被判成「认不出」。
 * 设备工具箱、工具箱提示音早就记过这条。凡是从原生接口拿到的字节，都先过这个函数再用。
 * 也认原生 `Data`（带 `toUint8Array()`，它的结果同样过一遍）。
 */
export function toBytes(value: unknown): Uint8Array {
  const direct = viewOf(value);
  if (direct !== null) return direct;
  const converted: unknown = (value as { toUint8Array?: () => unknown } | null | undefined)?.toUint8Array?.();
  const viaData = viewOf(converted);
  if (viaData !== null) return viaData;
  throw new TypeError(`认不出的字节类型：${Object.prototype.toString.call(value)}`);
}

/** 系统随机数。WebCrypto 的 getRandomValues 一次最多 65536 字节，这里按块取。 */
export function randomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i += 65536) crypto.getRandomValues(out.subarray(i, i + 65536));
  return out;
}
