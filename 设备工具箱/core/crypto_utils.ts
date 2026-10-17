// 配对握手用到的密码学原语，全部走 Scripting 提供的原生实现：
//   crypto.subtle —— HKDF-SHA512 / X25519 / Ed25519
//   crypto.chacha20Poly1305 —— RFC 8439 的 IETF 变体（密文后跟 16 字节标签）

import { concat, toArrayBuffer } from "./bytes";

/** Ed25519 私钥种子的 PKCS#8 外壳（RFC 8410）——raw 格式只支持公钥。 */
const ED25519_PKCS8_PREFIX = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]);

/**
 * HKDF-SHA512。
 *
 * salt 传空数组等价于 RFC 5869 的「不提供 salt」：HMAC 会把密钥补零到块长度，
 * 空密钥与全零密钥的结果相同，所以与 idevice 的 `Hkdf::new(None, ikm)` 一致。
 */
export async function hkdfSha512(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
  length = 32,
): Promise<Uint8Array> {
  const material = await crypto.subtle.importKey("raw", toArrayBuffer(ikm), "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-512", salt: toArrayBuffer(salt), info: toArrayBuffer(info) } as any,
    material,
    length * 8,
  );
  return new Uint8Array(bits);
}

export interface X25519KeyPair {
  privateKey: CryptoKey;
  publicKey: Uint8Array;
}

export async function generateX25519(): Promise<X25519KeyPair> {
  const pair = await crypto.subtle.generateKey("X25519", false, ["deriveBits"]);
  const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return { privateKey: pair.privateKey, publicKey };
}

export async function x25519SharedSecret(
  privateKey: CryptoKey,
  peerPublicKey: Uint8Array,
): Promise<Uint8Array> {
  const peer = await crypto.subtle.importKey("raw", toArrayBuffer(peerPublicKey), "X25519", false, []);
  const bits = await crypto.subtle.deriveBits({ name: "X25519", public: peer } as any, privateKey, 256);
  const secret = new Uint8Array(bits);
  // 全零共享密钥说明对端公钥是低阶点，原生侧本应拒绝，这里兜一道。
  if (secret.every((b) => b === 0)) throw new Error("X25519 协商得到全零密钥");
  return secret;
}

export async function ed25519Sign(seed: Uint8Array, message: Uint8Array): Promise<Uint8Array> {
  if (seed.length !== 32) throw new Error(`Ed25519 私钥种子应为 32 字节，实际 ${seed.length}`);
  const key = await crypto.subtle.importKey(
    "pkcs8",
    toArrayBuffer(concat(ED25519_PKCS8_PREFIX, seed)),
    "Ed25519",
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("Ed25519", key, toArrayBuffer(message));
  return new Uint8Array(signature);
}


export async function chachaSeal(
  key: Uint8Array,
  nonce: Uint8Array,
  plaintext: Uint8Array,
): Promise<Uint8Array> {
  const out = await crypto.chacha20Poly1305.encrypt(
    { key: toArrayBuffer(key), nonce: toArrayBuffer(nonce) },
    toArrayBuffer(plaintext),
  );
  return new Uint8Array(out);
}

export async function chachaOpen(
  key: Uint8Array,
  nonce: Uint8Array,
  ciphertext: Uint8Array,
): Promise<Uint8Array> {
  const out = await crypto.chacha20Poly1305.decrypt(
    { key: toArrayBuffer(key), nonce: toArrayBuffer(nonce) },
    toArrayBuffer(ciphertext),
  );
  return new Uint8Array(out);
}
