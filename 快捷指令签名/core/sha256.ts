// SHA-256 / HMAC-SHA256 / HKDF-SHA256，纯 TS。
//
// 为什么不用 Scripting 的 `Crypto.sha256`：它吃 `Data`、同步返回 `Data`，离线自测（Node）
// 里没有这个类型。签名只需要这三样原语，输入也就几 KB 到一两 MB，自己写一份，
// 设备和 Node 跑的是同一份代码，自测对拍 node:crypto 就能证明它对。

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const BLOCK = 64;

/** 处理一个 64 字节分组。h 是 8 个状态字，w 是调用方复用的 64 字调度表。 */
function compress(h: Uint32Array, w: Uint32Array, block: Uint8Array, offset: number): void {
  for (let i = 0; i < 16; i++) {
    const j = offset + (i << 2);
    w[i] = (block[j] << 24) | (block[j + 1] << 16) | (block[j + 2] << 8) | block[j + 3];
  }
  for (let i = 16; i < 64; i++) {
    const x = w[i - 15];
    const y = w[i - 2];
    const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
    const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
    // w 是 Uint32Array：赋值时自动对 2^32 取模，中间值是 double，不会丢精度
    w[i] = w[i - 16] + s0 + w[i - 7] + s1;
  }

  let a = h[0];
  let b = h[1];
  let c = h[2];
  let d = h[3];
  let e = h[4];
  let f = h[5];
  let g = h[6];
  let hh = h[7];
  for (let i = 0; i < 64; i++) {
    const s1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
    const ch = (e & f) ^ (~e & g);
    const t1 = (hh + s1 + ch + K[i] + w[i]) | 0;
    const s0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
    const maj = (a & b) ^ (a & c) ^ (b & c);
    const t2 = (s0 + maj) | 0;
    hh = g;
    g = f;
    f = e;
    e = (d + t1) | 0;
    d = c;
    c = b;
    b = a;
    a = (t1 + t2) | 0;
  }
  h[0] += a;
  h[1] += b;
  h[2] += c;
  h[3] += d;
  h[4] += e;
  h[5] += f;
  h[6] += g;
  h[7] += hh;
}

export function sha256(data: Uint8Array): Uint8Array {
  const h = Uint32Array.of(
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  );
  const w = new Uint32Array(64);

  const fullBlocks = Math.floor(data.length / BLOCK);
  for (let i = 0; i < fullBlocks; i++) compress(h, w, data, i * BLOCK);

  // 尾部: 剩余字节 + 0x80 + 补零 + 8 字节大端比特长度，凑成 1 或 2 个分组
  const rest = data.length - fullBlocks * BLOCK;
  const tail = new Uint8Array(rest + 9 <= BLOCK ? BLOCK : BLOCK * 2);
  tail.set(data.subarray(fullBlocks * BLOCK));
  tail[rest] = 0x80;
  const bitsHigh = Math.floor(data.length / 0x20000000); // len * 8 的高 32 位
  const bitsLow = (data.length << 3) >>> 0; // 低 32 位；<< 对 int32 取模，结果正确
  const view = new DataView(tail.buffer);
  view.setUint32(tail.length - 8, bitsHigh);
  view.setUint32(tail.length - 4, bitsLow);
  for (let off = 0; off < tail.length; off += BLOCK) compress(h, w, tail, off);

  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) outView.setUint32(i * 4, h[i]);
  return out;
}

export function hmacSha256(key: Uint8Array, data: Uint8Array): Uint8Array {
  const k = key.length > BLOCK ? sha256(key) : key;
  const inner = new Uint8Array(BLOCK + data.length);
  const outer = new Uint8Array(BLOCK + 32);
  for (let i = 0; i < BLOCK; i++) {
    const byte = i < k.length ? k[i] : 0;
    inner[i] = byte ^ 0x36;
    outer[i] = byte ^ 0x5c;
  }
  inner.set(data, BLOCK);
  outer.set(sha256(inner), BLOCK);
  return sha256(outer);
}

/**
 * HKDF-SHA256（RFC 5869）。salt 为空等价于「不提供 salt」：补成 32 个零字节，
 * 与 OpenSSL / CryptoKit 的行为一致，AEA 的 AEA_CK 等几步就是不带 salt 的。
 */
export function hkdfSha256(
  ikm: Uint8Array,
  salt: Uint8Array | null,
  info: Uint8Array,
  length = 32,
): Uint8Array {
  if (length < 1 || length > 255 * 32) throw new Error("HKDF 输出长度超出范围");
  const prk = hmacSha256(salt && salt.length > 0 ? salt : new Uint8Array(32), ikm);
  const out = new Uint8Array(length);
  let previous: Uint8Array = new Uint8Array(0);
  for (let counter = 1, pos = 0; pos < length; counter++, pos += 32) {
    const input = new Uint8Array(previous.length + info.length + 1);
    input.set(previous, 0);
    input.set(info, previous.length);
    input[input.length - 1] = counter;
    previous = hmacSha256(prk, input);
    out.set(previous.subarray(0, Math.min(32, length - pos)), pos);
  }
  return out;
}
