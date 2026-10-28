// AEA1 容器与 AA01 归档：把一份 plist 打成「已签名」的 .shortcut，以及读回来 / 验一遍。
//
// 这套格式没有公开文档。下面的偏移和密钥推导，是对着 24 个 Apple 官方签名的 .shortcut
// 逐项验证出来的（根头 HMAC / 簇头 HMAC / 每段 HMAC / ECDSA 签名 / 段 SHA-256 全部对得上），
// 签名流程另参考了 MIT 许可的 libshortcutsign（0xilis），见 NOTICE.md。
//
// profile 0 = 只签名、不加密。文件布局（括号里是字节数）：
//
//     "AEA1"(4)  profile(4)  authSize(4)  authData(authSize，二进制 plist)
//     -- 以下偏移从 authData 之后算起 --
//     +0x000  ECDSA-P256 签名(128，DER 右补零)；签的是「本字段清零后」的 [0, +0x130)
//     +0x080  密钥派生密钥 KDK(32，随机，明文存放)
//     +0x0A0  盐 salt(32，随机)
//     +0x0C0  根头 HMAC(32)
//     +0x0E0  根头(48)
//     +0x110  簇头 HMAC(32)
//     +0x130  簇头：256 个段条目 x 40（原始长度 u32，压缩后长度 u32，原始段的 SHA-256）
//             HMAC 区：32（占位）+ 256 x 32（每段一个 HMAC）；没用上的槽位 Apple 填随机字节
//             段数据：每段 LZFSE；压不小就原样存（压缩后长度 == 原始长度）
//
// 密钥推导（HKDF-SHA256，每步输出 32 字节）：
//
//     AMK  = HKDF(ikm=KDK, salt=盐, info="AEA_AMK" + profile(4) + 签名公钥(65 字节未压缩点))
//     CK   = HKDF(ikm=AMK, info="AEA_CK" + 4 个 0)
//     SK_i = HKDF(ikm=CK,  info="AEA_SK" + i(int32 小端))      第 i 段
//     CHEK = HKDF(ikm=CK,  info="AEA_CHEK")                     簇头
//     RHEK = HKDF(ikm=AMK, info="AEA_RHEK")                     根头
//
// HMAC 一律是 HMAC-SHA256(key, aux || data || len(aux) 的 8 字节小端)。

import { concat, equalBytes, i32le, randomBytes, readU32LE, readU64LE, u32le, u64le, utf8 } from "./bytes";
import { decodeDerSignature, decodePoint, ecdsaVerify, type AffinePoint } from "./p256";
import { hkdfSha256, hmacSha256, sha256 } from "./sha256";

export const AEA_MAGIC = "AEA1";
const PROFILE = new Uint8Array(4); // 签名、不加密

/** authData 之后的固定区：签名 / KDK / 盐 / 两个 HMAC / 根头。 */
export const PROLOGUE_SIZE = 0x130;
export const SIGNATURE_SIZE = 128;
const ROOT_HEADER_SIZE = 0x30;
const HEADER_SIZE = 12;
/** Apple 的实测值：段 1 MiB，一簇 256 段，簇头永远写满 256 个条目。 */
export const SEGMENT_SIZE = 1 << 20;
export const SEGMENTS_PER_CLUSTER = 256;
const ENTRY_SIZE = 40;
const HMAC_SIZE = 32;
/** 根头里的算法字节：压缩 0x65 = 'e' = LZFSE，校验和 0x02 = SHA-256。 */
const COMPRESSION_LZFSE = 0x65;
const CHECKSUM_SHA256 = 0x02;

/** 对「签名位清零后的前导区」做 ECDSA-P256/SHA-256，返回 DER 签名。 */
export type Signer = (message: Uint8Array) => Uint8Array;
/** 压缩一段；压不小就原样返回（调用方按长度判断有没有压）。 */
export type Compressor = (raw: Uint8Array) => Uint8Array;
/** 还原一段；stored 比 rawSize 短说明它被压缩过。 */
export type Decompressor = (stored: Uint8Array, rawSize: number) => Uint8Array;
export type RandomSource = (length: number) => Uint8Array;

function aeaHmac(key: Uint8Array, data: Uint8Array, aux: Uint8Array = new Uint8Array(0)): Uint8Array {
  return hmacSha256(key, concat(aux, data, u64le(aux.length)));
}

function hkdf(key: Uint8Array, info: Uint8Array, salt: Uint8Array | null = null): Uint8Array {
  return hkdfSha256(key, salt, info);
}

interface Keys {
  ck: Uint8Array;
  chek: Uint8Array;
  rhek: Uint8Array;
}

function deriveKeys(kdk: Uint8Array, salt: Uint8Array, profile: Uint8Array, signingPublicKey: Uint8Array): Keys {
  const amk = hkdf(kdk, concat(utf8("AEA_AMK"), profile, signingPublicKey), salt);
  const ck = hkdf(amk, concat(utf8("AEA_CK"), new Uint8Array(4)));
  return { ck, chek: hkdf(ck, utf8("AEA_CHEK")), rhek: hkdf(amk, utf8("AEA_RHEK")) };
}

function segmentKey(ck: Uint8Array, index: number): Uint8Array {
  return hkdf(ck, concat(utf8("AEA_SK"), i32le(index)));
}

// ---------------------------------------------------------------------------
// AA01 归档（写）
// ---------------------------------------------------------------------------

function timespec(ns: bigint): Uint8Array {
  const seconds = u64le(ns / 1_000_000_000n); // 小端 i64；时间戳为正，和 u64 同形
  return concat(seconds, u32le(Number(ns % 1_000_000_000n)));
}

function aarEntry(kind: string, path: string, mode: number, mtimeNs: bigint, payload: Uint8Array | null): Uint8Array {
  const encoded = utf8(path);
  const parts: Uint8Array[] = [
    utf8("TYP1"), utf8(kind),
    utf8("PATP"), Uint8Array.of(encoded.length & 0xff, encoded.length >> 8), encoded,
    utf8("MOD2"), Uint8Array.of(mode & 0xff, mode >> 8),
    utf8("MTMT"), timespec(mtimeNs),
  ];
  if (payload !== null) {
    // DATA = 2 字节长度，DATB = 4 字节长度；数据本体紧跟在头后面
    if (payload.length < 1 << 16) parts.push(utf8("DATA"), Uint8Array.of(payload.length & 0xff, payload.length >> 8));
    else parts.push(utf8("DATB"), u32le(payload.length));
  }
  const fields = concat(...parts);
  // 头长 = 魔数(4) + 头长字段(2) + 全部字段
  const headerLength = 6 + fields.length;
  const header = concat(utf8("AA01"), Uint8Array.of(headerLength & 0xff, headerLength >> 8), fields);
  return payload === null ? header : concat(header, payload);
}

/** AA01 归档：一个根目录项(0755) + 一个文件项(0644)。字段与顺序照 Apple 的输出：TYP PAT MOD MTM [DAT]。 */
export function buildAar(name: string, payload: Uint8Array, mtimeNs: bigint): Uint8Array {
  return concat(aarEntry("D", "", 0o755, mtimeNs, null), aarEntry("F", name, 0o644, mtimeNs, payload));
}

// ---------------------------------------------------------------------------
// AEA1 容器（写）
// ---------------------------------------------------------------------------

export interface PackOptions {
  /** 二进制 plist，签名证书链放在这里 */
  authData: Uint8Array;
  /** 签名公钥，65 字节未压缩点（0x04 || X || Y）；参与密钥推导 */
  signingPublicKey: Uint8Array;
  sign: Signer;
  compress?: Compressor;
  /** 只为了让测试能固定随机性、逐字节对拍 Apple 的样本 */
  random?: RandomSource;
}

export function packAea(aar: Uint8Array, options: PackOptions): Uint8Array {
  const compress = options.compress ?? ((raw: Uint8Array) => raw);
  const random = options.random ?? randomBytes;

  const segments: Uint8Array[] = [];
  for (let at = 0; at < aar.length; at += SEGMENT_SIZE) segments.push(aar.subarray(at, at + SEGMENT_SIZE));
  if (segments.length === 0) throw new Error("归档是空的");
  if (segments.length > SEGMENTS_PER_CLUSTER) throw new Error(`归档超过 ${SEGMENTS_PER_CLUSTER} MiB，超出单簇上限`);

  const kdk = random(32);
  const salt = random(32);
  const keys = deriveKeys(kdk, salt, PROFILE, options.signingPublicKey);

  const entries = new Uint8Array(SEGMENTS_PER_CLUSTER * ENTRY_SIZE);
  // 占位和空槽填随机字节（Apple 就是这样），真实段的 HMAC 随后覆盖进去
  const hmacs = random(HMAC_SIZE + SEGMENTS_PER_CLUSTER * HMAC_SIZE).slice();
  const stored: Uint8Array[] = [];
  segments.forEach((raw, index) => {
    const packed = compress(raw);
    const body = packed.length < raw.length ? packed : raw; // 压不小就原样存
    entries.set(u32le(raw.length), index * ENTRY_SIZE);
    entries.set(u32le(body.length), index * ENTRY_SIZE + 4);
    entries.set(sha256(raw), index * ENTRY_SIZE + 8);
    hmacs.set(aeaHmac(segmentKey(keys.ck, index), body), HMAC_SIZE + index * HMAC_SIZE);
    stored.push(body);
  });
  const segmentData = concat(...stored);

  const total =
    HEADER_SIZE + options.authData.length + PROLOGUE_SIZE + entries.length + hmacs.length + segmentData.length;
  const rootHeader = concat(
    u64le(aar.length),
    u64le(total),
    u32le(SEGMENT_SIZE),
    u32le(SEGMENTS_PER_CLUSTER),
    Uint8Array.of(COMPRESSION_LZFSE, CHECKSUM_SHA256),
    new Uint8Array(ROOT_HEADER_SIZE - 26),
  );
  const clusterHmac = aeaHmac(keys.chek, entries, hmacs);
  const rootHmac = aeaHmac(keys.rhek, rootHeader, concat(clusterHmac, options.authData));

  const head = concat(utf8(AEA_MAGIC), PROFILE, u32le(options.authData.length), options.authData);
  const prologue = concat(head, new Uint8Array(SIGNATURE_SIZE), kdk, salt, rootHmac, rootHeader, clusterHmac);
  const signature = options.sign(prologue); // 此刻签名位还是全零，正是要签的内容
  if (signature.length > SIGNATURE_SIZE) throw new Error(`签名 ${signature.length} 字节，超出 ${SIGNATURE_SIZE} 字节的签名位`);
  prologue.set(signature, head.length);

  return concat(prologue, entries, hmacs, segmentData);
}

// ---------------------------------------------------------------------------
// AEA1 容器（读 / 验）
// ---------------------------------------------------------------------------

export interface AeaSegment {
  rawSize: number;
  storedSize: number;
  checksum: Uint8Array;
  stored: Uint8Array;
}

export interface ParsedAea {
  profile: Uint8Array;
  authData: Uint8Array;
  /** 签名位原样的 128 字节 */
  signatureField: Uint8Array;
  kdk: Uint8Array;
  salt: Uint8Array;
  rootHmac: Uint8Array;
  rootHeader: Uint8Array;
  clusterHmac: Uint8Array;
  /** 簇头整块（条目 x 每簇段数） */
  entries: Uint8Array;
  /** HMAC 区整块 */
  hmacs: Uint8Array;
  segments: AeaSegment[];
  /** 从文件开头到簇头 HMAC 末尾，签名位保持原样 */
  prologue: Uint8Array;
  /** 签名位偏移 */
  signatureOffset: number;
  rawSize: bigint;
  containerSize: bigint;
}

/** 只解结构、做边界检查，不验密码学部分。认不出来就抛错。 */
export function parseAea(data: Uint8Array): ParsedAea {
  if (data.length < HEADER_SIZE + PROLOGUE_SIZE) throw new Error("AEA1 文件被截断了");
  if (String.fromCharCode(...data.subarray(0, 4)) !== AEA_MAGIC) throw new Error("不是 AEA1 文件");
  const profile = data.slice(4, 8);
  const authSize = readU32LE(data, 8);
  const p = HEADER_SIZE + authSize;
  if (p + PROLOGUE_SIZE > data.length) throw new Error("AEA1 的授权数据长度不合理");

  const rootHeader = data.slice(p + 0xe0, p + 0x110);
  const perCluster = readU32LE(rootHeader, 20);
  if (perCluster < 1 || perCluster > 4096) throw new Error("AEA1 的每簇段数不合理");
  const entriesStart = p + PROLOGUE_SIZE;
  const hmacsStart = entriesStart + perCluster * ENTRY_SIZE;
  const dataStart = hmacsStart + HMAC_SIZE + perCluster * HMAC_SIZE;
  if (dataStart > data.length) throw new Error("AEA1 的簇头被截断了");

  const segments: AeaSegment[] = [];
  let cursor = dataStart;
  for (let i = 0; i < perCluster; i++) {
    const rawSize = readU32LE(data, entriesStart + i * ENTRY_SIZE);
    const storedSize = readU32LE(data, entriesStart + i * ENTRY_SIZE + 4);
    if (rawSize === 0 && storedSize === 0) break;
    if (storedSize > rawSize || cursor + storedSize > data.length) throw new Error("AEA1 的段长度不合理");
    segments.push({
      rawSize,
      storedSize,
      checksum: data.slice(entriesStart + i * ENTRY_SIZE + 8, entriesStart + (i + 1) * ENTRY_SIZE),
      stored: data.slice(cursor, cursor + storedSize),
    });
    cursor += storedSize;
  }

  return {
    profile,
    authData: data.slice(HEADER_SIZE, p),
    signatureField: data.slice(p, p + SIGNATURE_SIZE),
    kdk: data.slice(p + 0x80, p + 0xa0),
    salt: data.slice(p + 0xa0, p + 0xc0),
    rootHmac: data.slice(p + 0xc0, p + 0xe0),
    rootHeader,
    clusterHmac: data.slice(p + 0x110, p + 0x130),
    entries: data.slice(entriesStart, hmacsStart),
    hmacs: data.slice(hmacsStart, dataStart),
    segments,
    prologue: data.slice(0, p + PROLOGUE_SIZE),
    signatureOffset: p,
    rawSize: readU64LE(rootHeader, 0),
    containerSize: readU64LE(rootHeader, 8),
  };
}

export interface VerifyResult {
  ok: boolean;
  /** 没通过的检查项，全过时为空 */
  problems: string[];
}

/** 还原一段；没压缩过的原样返回。 */
function segmentBytes(segment: AeaSegment, decompress: Decompressor): Uint8Array {
  return segment.storedSize === segment.rawSize ? segment.stored : decompress(segment.stored, segment.rawSize);
}

/** 拼出解压后的 AA01 归档。 */
export function extractAar(parsed: ParsedAea, decompress: Decompressor): Uint8Array {
  return concat(...parsed.segments.map((segment) => segmentBytes(segment, decompress)));
}

/**
 * 把 Apple 校验时会校验的东西都验一遍：根头 / 簇头 / 每段的 HMAC、ECDSA 签名、
 * 每段 SHA-256、文件总长。签完先自检再交付，Node 自测里拿它验 Apple 的样本。
 *
 * signingPublicKey：签名公钥（65 字节未压缩点）。iCloud 风格的文件里它就是链首（叶）证书的公钥。
 */
export function verifyAea(
  data: Uint8Array,
  signingPublicKey: Uint8Array,
  decompress: Decompressor,
): VerifyResult {
  const problems: string[] = [];
  let parsed: ParsedAea;
  try {
    parsed = parseAea(data);
  } catch (error) {
    return { ok: false, problems: [(error as Error).message] };
  }

  const keys = deriveKeys(parsed.kdk, parsed.salt, parsed.profile, signingPublicKey);
  if (!equalBytes(aeaHmac(keys.chek, parsed.entries, parsed.hmacs), parsed.clusterHmac)) problems.push("簇头 HMAC 不对");
  if (!equalBytes(aeaHmac(keys.rhek, parsed.rootHeader, concat(parsed.clusterHmac, parsed.authData)), parsed.rootHmac)) {
    problems.push("根头 HMAC 不对");
  }

  let rawTotal = 0;
  let storedTotal = 0;
  parsed.segments.forEach((segment, index) => {
    const want = parsed.hmacs.subarray(HMAC_SIZE + index * HMAC_SIZE, HMAC_SIZE + (index + 1) * HMAC_SIZE);
    if (!equalBytes(aeaHmac(segmentKey(keys.ck, index), segment.stored), want)) problems.push(`第 ${index} 段 HMAC 不对`);
    let raw: Uint8Array | null = null;
    try {
      raw = segmentBytes(segment, decompress);
    } catch (error) {
      problems.push(`第 ${index} 段解压失败：${(error as Error).message}`);
    }
    if (raw !== null) {
      if (raw.length !== segment.rawSize) problems.push(`第 ${index} 段解压后长度不对`);
      if (!equalBytes(sha256(raw), segment.checksum)) problems.push(`第 ${index} 段 SHA-256 不对`);
    }
    rawTotal += segment.rawSize;
    storedTotal += segment.storedSize;
  });
  if (BigInt(rawTotal) !== parsed.rawSize) problems.push("根头里的归档长度和各段之和对不上");
  if (parsed.containerSize !== BigInt(data.length)) problems.push("根头里的文件总长和实际对不上");
  if (
    data.length !==
    parsed.prologue.length + parsed.entries.length + parsed.hmacs.length + storedTotal
  ) {
    problems.push("文件末尾有多余字节");
  }

  // 签名：签名位清零后对 [0, 前导区末尾) 做 ECDSA-SHA256
  const field = parsed.signatureField;
  const length = field[0] === 0x30 ? field[1] + 2 : 0;
  const signature = length > 0 && length <= SIGNATURE_SIZE ? decodeDerSignature(field.subarray(0, length)) : null;
  if (signature === null) problems.push("签名位里不是合法的 DER 签名");
  else {
    const message = parsed.prologue.slice();
    message.fill(0, parsed.signatureOffset, parsed.signatureOffset + SIGNATURE_SIZE);
    let key: AffinePoint | null = null;
    try {
      key = decodePoint(signingPublicKey);
    } catch {
      problems.push("签名公钥不是 P-256 曲线上的点");
    }
    if (key !== null && !ecdsaVerify(key, sha256(message), signature.r, signature.s)) problems.push("ECDSA 签名验不过");
  }

  return { ok: problems.length === 0, problems };
}

// ---------------------------------------------------------------------------
// AA01 归档（读）
// ---------------------------------------------------------------------------

export interface AarEntry {
  type: string;
  path: string;
  mode: number | null;
  /** 字段名 → 值（数字 / 字符串 / 12 字节时间）；DATA / DATB 记录数据长度 */
  fields: Record<string, number | string | Uint8Array>;
  data: Uint8Array;
}

export function parseAar(aar: Uint8Array): AarEntry[] {
  const entries: AarEntry[] = [];
  let pos = 0;
  while (pos + 6 <= aar.length) {
    if (String.fromCharCode(...aar.subarray(pos, pos + 4)) !== "AA01") throw new Error("AA01 归档的头不对");
    const headerLength = aar[pos + 4] | (aar[pos + 5] << 8);
    if (headerLength < 6 || pos + headerLength > aar.length) throw new Error("AA01 条目的头长不合理");
    const fields: Record<string, number | string | Uint8Array> = {};
    let cursor = pos + 6;
    let dataSize = 0;
    while (cursor + 4 <= pos + headerLength) {
      const key = String.fromCharCode(...aar.subarray(cursor, cursor + 3));
      const kind = String.fromCharCode(aar[cursor + 3]);
      cursor += 4;
      const at = (width: number): number => {
        let value = 0;
        for (let i = width - 1; i >= 0; i--) value = value * 256 + aar[cursor + i];
        return value;
      };
      switch (kind) {
        case "1":
        case "2":
        case "4":
          fields[key] = at(Number(kind));
          cursor += Number(kind);
          break;
        case "8":
          fields[key] = at(8);
          cursor += 8;
          break;
        case "T":
          fields[key] = aar.slice(cursor, cursor + 12);
          cursor += 12;
          break;
        case "P": {
          const length = at(2);
          fields[key] = new TextDecoder().decode(aar.subarray(cursor + 2, cursor + 2 + length));
          cursor += 2 + length;
          break;
        }
        case "A":
        case "B":
        case "C": {
          const width = kind === "A" ? 2 : kind === "B" ? 4 : 8;
          dataSize = at(width);
          fields[key] = dataSize;
          cursor += width;
          break;
        }
        default:
          throw new Error(`AA01 里有不认识的字段类型 ${key}${kind}`);
      }
    }
    const end = pos + headerLength + dataSize;
    if (end > aar.length) throw new Error("AA01 条目的数据被截断了");
    entries.push({
      type: typeof fields.TYP === "number" ? String.fromCharCode(fields.TYP) : "",
      path: typeof fields.PAT === "string" ? fields.PAT : "",
      mode: typeof fields.MOD === "number" ? fields.MOD : null,
      fields,
      data: aar.slice(pos + headerLength, end),
    });
    pos = end;
  }
  return entries;
}
