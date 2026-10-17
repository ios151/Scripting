// 字节与编码工具：hex / base64 / 拼接 / 定长读写。
//
// base64 走 Node 的 Buffer（本运行时内置），集中在这里以便将来替换。

export function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}

export function fromBase64(text: string): Uint8Array {
  const buf = Buffer.from(text, "base64");
  return new Uint8Array(buf.buffer as ArrayBuffer, buf.byteOffset, buf.byteLength);
}

export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, "0");
  return out;
}

export function fromHex(hex: string): Uint8Array {
  const clean = hex.replace(/[^0-9a-fA-F]/g, "");
  const out = new Uint8Array(clean.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

export function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export function fromUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

/** 转成独立的 ArrayBuffer，避免把整块底层 buffer 传给原生侧。 */
export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}

export function u32le(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value >>> 0, true);
  return out;
}

export function i32le(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setInt32(0, value, true);
  return out;
}

export function u16be(value: number): Uint8Array {
  const out = new Uint8Array(2);
  new DataView(out.buffer).setUint16(0, value & 0xffff, false);
  return out;
}

export function u64le(value: number): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(Math.max(0, Math.trunc(value))), true);
  return out;
}

export function f64le(value: number): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setFloat64(0, value, true);
  return out;
}

export function readU32LE(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer as ArrayBuffer, bytes.byteOffset).getUint32(offset, true);
}

export function readI32LE(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer as ArrayBuffer, bytes.byteOffset).getInt32(offset, true);
}

export function readU16LE(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer as ArrayBuffer, bytes.byteOffset).getUint16(offset, true);
}

export function readU16BE(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer as ArrayBuffer, bytes.byteOffset).getUint16(offset, false);
}
