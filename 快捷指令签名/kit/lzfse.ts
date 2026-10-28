// 原生 LZFSE：Scripting 的 `Data` 自带压缩 / 解压（Apple 的 Compression 框架）。
//
// AEA 的每一段都是裸 LZFSE 流（Apple 的 24 个样本：开头 bvx2 / bvxn，结尾 bvx$）。
// 原生压出来的东西不合这个形状就一律不用——宁可原样存（格式允许，压缩后长度 == 原始长度），
// 也不把来路不明的字节塞进签名文件。模块加载时不碰 `Data`，只在调用时用，离线自测里也能 import。

import type { Compressor, Decompressor } from "../core/aea";
import { toBytes } from "../core/bytes";

const STREAM_MAGICS = ["bvx-", "bvx1", "bvx2", "bvxn"];
const END_MARKER = "bvx$";

function tag(bytes: Uint8Array, at: number): string {
  return String.fromCharCode(...bytes.subarray(at, at + 4));
}

/** 像不像一条标准 LZFSE 流：开头是 bvx 系魔数，末尾是 bvx$ 结束标记。 */
export function looksLikeLzfse(bytes: Uint8Array): boolean {
  return bytes.length >= 12 && STREAM_MAGICS.includes(tag(bytes, 0)) && tag(bytes, bytes.length - 4) === END_MARKER;
}

/**
 * 只把「独占整块缓冲」的数组交给 `Data.fromUint8Array`。
 * 签名时传进来的段是整份归档上的一小段视图（byteOffset 不为 0），桥接层会不会按整块缓冲拷贝，文档没写；
 * 多拷一份几 KB 的数据没有代价，换来不用赌。
 */
function exact(bytes: Uint8Array): Uint8Array {
  return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes : bytes.slice();
}

/**
 * `CompressionAlgorithm` 是 dts 里声明的全局枚举，运行时有没有，之前没人验过。
 * 没有的话直接用它的值（lzfse = 0），不让一个 ReferenceError 把压缩 / 解压整个废掉。
 */
function lzfse(): CompressionAlgorithm {
  return typeof CompressionAlgorithm === "undefined" ? (0 as CompressionAlgorithm) : CompressionAlgorithm.lzfse;
}

// 原生交回来的值一律先 `== null`（null / undefined 都算没有）、再过 toBytes：
// dts 写 Uint8Array 的地方真机上回过 ArrayBuffer，写 null 的地方回过 undefined。
export const nativeCompress: Compressor = (raw) => {
  try {
    const packed = Data.fromUint8Array(exact(raw))?.compressed(lzfse()).toUint8Array();
    if (packed == null) return raw;
    const bytes = toBytes(packed);
    return looksLikeLzfse(bytes) ? bytes : raw;
  } catch {
    return raw;
  }
};

export const nativeDecompress: Decompressor = (stored, rawSize) => {
  const source = Data.fromUint8Array(exact(stored));
  if (source == null) throw new Error("读不了这段压缩数据");
  const decoded = source.decompressed(lzfse()).toUint8Array();
  if (decoded == null) throw new Error("LZFSE 解压失败");
  const out = toBytes(decoded);
  if (out.length !== rawSize) throw new Error(`解压后 ${out.length} 字节，应为 ${rawSize}`);
  return out;
};
