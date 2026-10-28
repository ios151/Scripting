// P-256（secp256r1 / prime256v1）曲线与 ECDSA，纯 TS + BigInt。
//
// 为什么要自己写：Scripting 的 `crypto.subtle` 只有 HKDF / X25519 / Ed25519 / AES-GCM，
// 没有 ECDSA P-256，而快捷指令的签名（AEA1 的签名位、X.509 证书）都是 ECDSA-P256/SHA-256。
// 这里只实现签名要用的：生成密钥、签名、验签（验签给自检和离线自测用）。
//
// 取舍：
// - 雅可比坐标 + 4 位窗口，一次标量乘大约 2800 次域乘法；BigInt 在 JavaScriptCore 里
//   每次几微秒，一次签名 / 生成密钥在十到几十毫秒，一次完整流程（两个密钥 + 三次签名）远小于 1 秒。
// - 不做常数时间。这是只在本机跑、没有远程对手能掐表的工具，换来的是代码短到能一眼审完。
// - 签名随机数 k 用系统随机数 + 拒绝采样（均匀分布在 [1, n-1]），不做 RFC 6979 确定性。
//   自测靠 RFC 6979 附录 A.2.5 的已知答案（注入固定的 k）和对拍 node:crypto。

import { bigIntToBytes, bytesToBigInt, concat, randomBytes } from "./bytes";

export const P = (1n << 256n) - (1n << 224n) + (1n << 192n) + (1n << 96n) - 1n;
export const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const B = 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn;
const GX = 0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296n;
const GY = 0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5n;

export interface AffinePoint {
  x: bigint;
  y: bigint;
}

export interface KeyPair extends AffinePoint {
  /** 私钥标量，1 <= d < N */
  d: bigint;
}

export type RandomSource = (length: number) => Uint8Array;

/** 雅可比坐标，z = 0 表示无穷远点。 */
interface Jacobian {
  x: bigint;
  y: bigint;
  z: bigint;
}

const INFINITY: Jacobian = { x: 0n, y: 1n, z: 0n };
const G: Jacobian = { x: GX, y: GY, z: 1n };

function mod(a: bigint, m: bigint = P): bigint {
  const r = a % m;
  return r >= 0n ? r : r + m;
}

/** 扩展欧几里得求逆元。 */
function invert(a: bigint, m: bigint): bigint {
  let oldR = mod(a, m);
  let r = m;
  let oldS = 1n;
  let s = 0n;
  while (r !== 0n) {
    const q = oldR / r;
    [oldR, r] = [r, oldR - q * r];
    [oldS, s] = [s, oldS - q * s];
  }
  if (oldR !== 1n) throw new Error("没有逆元");
  return mod(oldS, m);
}

/** dbl-2001-b（a = -3 的专用倍点公式）。 */
function double(p: Jacobian): Jacobian {
  if (p.z === 0n || p.y === 0n) return INFINITY;
  const delta = (p.z * p.z) % P;
  const gamma = (p.y * p.y) % P;
  const beta = (p.x * gamma) % P;
  const alpha = mod(3n * (p.x - delta) * (p.x + delta));
  const x3 = mod(alpha * alpha - 8n * beta);
  const z3 = mod((p.y + p.z) * (p.y + p.z) - gamma - delta);
  const y3 = mod(alpha * (4n * beta - x3) - 8n * gamma * gamma);
  return { x: x3, y: y3, z: z3 };
}

/** add-2007-bl。 */
function add(p: Jacobian, q: Jacobian): Jacobian {
  if (p.z === 0n) return q;
  if (q.z === 0n) return p;
  const z1z1 = (p.z * p.z) % P;
  const z2z2 = (q.z * q.z) % P;
  const u1 = (p.x * z2z2) % P;
  const u2 = (q.x * z1z1) % P;
  const s1 = (((p.y * q.z) % P) * z2z2) % P;
  const s2 = (((q.y * p.z) % P) * z1z1) % P;
  const h = mod(u2 - u1);
  const r = mod(2n * (s2 - s1));
  if (h === 0n) return r === 0n ? double(p) : INFINITY;
  const i = (4n * h * h) % P;
  const j = (h * i) % P;
  const v = (u1 * i) % P;
  const x3 = mod(r * r - j - 2n * v);
  const y3 = mod(r * (v - x3) - 2n * s1 * j);
  const z3 = mod(((p.z + q.z) * (p.z + q.z) - z1z1 - z2z2) * h);
  return { x: x3, y: y3, z: z3 };
}

/** 1..15 倍点表，4 位窗口用。 */
function windowTable(p: Jacobian): Jacobian[] {
  const table: Jacobian[] = [INFINITY, p];
  for (let i = 2; i < 16; i++) table.push(i % 2 === 0 ? double(table[i >> 1]) : add(table[i - 1], p));
  return table;
}

let baseTable: Jacobian[] | null = null;

function multiply(p: Jacobian, k: bigint, table?: Jacobian[]): Jacobian {
  if (k <= 0n) return INFINITY;
  const multiples = table ?? windowTable(p);
  let acc = INFINITY;
  for (const digit of k.toString(16)) {
    acc = double(double(double(double(acc))));
    const d = parseInt(digit, 16);
    if (d !== 0) acc = add(acc, multiples[d]);
  }
  return acc;
}

function multiplyBase(k: bigint): Jacobian {
  if (baseTable === null) baseTable = windowTable(G);
  return multiply(G, k, baseTable);
}

function toAffine(p: Jacobian): AffinePoint | null {
  if (p.z === 0n) return null;
  const zInv = invert(p.z, P);
  const zInv2 = (zInv * zInv) % P;
  return { x: (p.x * zInv2) % P, y: (((p.y * zInv2) % P) * zInv) % P };
}

export function isOnCurve(point: AffinePoint): boolean {
  if (point.x < 0n || point.x >= P || point.y < 0n || point.y >= P) return false;
  return mod(point.y * point.y) === mod(point.x * point.x * point.x - 3n * point.x + B);
}

/** 均匀分布在 [1, N-1] 的随机标量（拒绝采样，被拒概率约 2^-32）。 */
export function randomScalar(random: RandomSource = randomBytes): bigint {
  for (;;) {
    const candidate = bytesToBigInt(random(32));
    if (candidate >= 1n && candidate < N) return candidate;
  }
}

export function publicFromPrivate(d: bigint): AffinePoint {
  if (d < 1n || d >= N) throw new Error("私钥超出范围");
  const point = toAffine(multiplyBase(d));
  if (point === null) throw new Error("私钥对应无穷远点");
  return point;
}

export function generateKeyPair(random: RandomSource = randomBytes): KeyPair {
  const d = randomScalar(random);
  return { d, ...publicFromPrivate(d) };
}

/** 65 字节未压缩点：0x04 || X || Y（X9.63，也是证书里 BIT STRING 的内容）。 */
export function encodePoint(point: AffinePoint): Uint8Array {
  return concat(Uint8Array.of(0x04), bigIntToBytes(point.x, 32), bigIntToBytes(point.y, 32));
}

export function decodePoint(bytes: Uint8Array): AffinePoint {
  if (bytes.length !== 65 || bytes[0] !== 0x04) throw new Error("只支持 65 字节的未压缩点");
  const point = { x: bytesToBigInt(bytes.subarray(1, 33)), y: bytesToBigInt(bytes.subarray(33, 65)) };
  if (!isOnCurve(point)) throw new Error("点不在曲线上");
  return point;
}

export interface SignOptions {
  /** 只给自测注入已知答案用；正常签名别传 */
  k?: bigint;
  random?: RandomSource;
}

/** ECDSA 签名，hash 必须是 32 字节（SHA-256）。 */
export function ecdsaSign(
  d: bigint,
  hash: Uint8Array,
  options: SignOptions = {},
): { r: bigint; s: bigint } {
  if (hash.length !== 32) throw new Error("ECDSA-P256 只接受 32 字节的 SHA-256 摘要");
  const z = bytesToBigInt(hash);
  for (;;) {
    const k = options.k ?? randomScalar(options.random);
    const point = toAffine(multiplyBase(k));
    const r = point === null ? 0n : mod(point.x, N);
    const s = r === 0n ? 0n : mod(invert(k, N) * (z + r * d), N);
    if (r !== 0n && s !== 0n) return { r, s };
    if (options.k !== undefined) throw new Error("给定的 k 不可用");
  }
}

export function ecdsaVerify(publicKey: AffinePoint, hash: Uint8Array, r: bigint, s: bigint): boolean {
  if (hash.length !== 32) return false;
  if (r < 1n || r >= N || s < 1n || s >= N) return false;
  if (!isOnCurve(publicKey)) return false;
  const w = invert(s, N);
  const u1 = mod(bytesToBigInt(hash) * w, N);
  const u2 = mod(r * w, N);
  const sum = add(multiplyBase(u1), multiply({ x: publicKey.x, y: publicKey.y, z: 1n }, u2));
  const point = toAffine(sum);
  return point !== null && mod(point.x, N) === r;
}

/** DER INTEGER 的内容：去掉前导零的大端数，最高位是 1 就补一个 0x00。 */
function derIntegerBody(value: bigint): Uint8Array {
  let bytes = bigIntToBytes(value, 32);
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) start++;
  bytes = bytes.subarray(start);
  return bytes[0] & 0x80 ? concat(Uint8Array.of(0), bytes) : bytes;
}

/** ECDSA 签名的 DER 编码：SEQUENCE { INTEGER r, INTEGER s }（70 到 72 字节）。 */
export function encodeDerSignature(r: bigint, s: bigint): Uint8Array {
  const ri = derIntegerBody(r);
  const si = derIntegerBody(s);
  const body = concat(Uint8Array.of(0x02, ri.length), ri, Uint8Array.of(0x02, si.length), si);
  return concat(Uint8Array.of(0x30, body.length), body);
}

/** 严格解析 DER 签名；格式不对返回 null。 */
export function decodeDerSignature(der: Uint8Array): { r: bigint; s: bigint } | null {
  if (der.length < 8 || der[0] !== 0x30 || der[1] !== der.length - 2) return null;
  let pos = 2;
  const values: bigint[] = [];
  for (let i = 0; i < 2; i++) {
    if (der[pos] !== 0x02) return null;
    const length = der[pos + 1];
    if (length === 0 || pos + 2 + length > der.length) return null;
    const body = der.subarray(pos + 2, pos + 2 + length);
    // 负数、多余的前导零都不是合法的 DER 正整数
    if (body[0] & 0x80) return null;
    if (body.length > 1 && body[0] === 0 && !(body[1] & 0x80)) return null;
    values.push(bytesToBigInt(body));
    pos += 2 + length;
  }
  return pos === der.length ? { r: values[0], s: values[1] } : null;
}
