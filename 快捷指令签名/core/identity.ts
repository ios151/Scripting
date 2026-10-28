// 签名身份：一张根证书 + 一张叶证书 + 叶证书的私钥。
//
// **根私钥生成叶证书之后就丢掉**，从不存盘：
//   - 手机里装的是根证书（还要在「证书信任设置」里完全信任它，信任是整机生效的），
//     根私钥要是被人拿到，就能给这台手机签任意网站的证书。丢掉它，这条风险就不存在了。
//   - 叶私钥只能签快捷指令，泄露了顶多是别人能签出你这台手机认的快捷指令。
// 代价是叶证书不能换：想换就得重新生成一整套，手机上重新装、重新信任根证书。

import { bigIntToBytes, bytesToBigInt, fromBase64, fromHex, randomBytes, toBase64, toHex } from "./bytes";
import { encodePoint, generateKeyPair, publicFromPrivate, type AffinePoint, type RandomSource } from "./p256";
import { sha256 } from "./sha256";
import { buildCertificate, type CertName } from "./x509";

export const ORGANIZATION = "Shortcut Signer";
const VALIDITY_DAYS = 3650;
const DAY_MS = 86_400_000;

export interface SigningIdentity {
  /** 叶证书的私钥标量。根私钥不在这里——它生成完叶证书就被丢弃了。 */
  leafPrivateKey: bigint;
  leafPublicKey: AffinePoint;
  /** DER */
  leafCertificate: Uint8Array;
  /** DER */
  rootCertificate: Uint8Array;
  /** 创建时间（毫秒），只用来显示有效期 */
  createdAt: number;
}

export interface CreateIdentityOptions {
  random?: RandomSource;
  now?: Date;
  /**
   * 根证书的名字（证书里的 CN，「证书信任设置」里列的就是它）。不给就用「Shortcut Signer Root」加 4 位随机后缀。
   * 名字是签进证书里的，没法事后改：要改就得用新名字重新生成一整套。
   */
  rootName?: string;
}

const MAX_ROOT_NAME_LENGTH = 40;

/** 根证书名称是否合法：首尾无空白、1 到 40 个字、没有控制字符。合法返回 null，否则返回说明。 */
export function checkRootName(name: string): string | null {
  if (name !== name.trim()) return "名称首尾不能有空格";
  if (name.length === 0) return "名称不能为空";
  if (Array.from(name).length > MAX_ROOT_NAME_LENGTH) return `名称最多 ${MAX_ROOT_NAME_LENGTH} 个字`;
  if (/[\u0000-\u001f\u007f]/.test(name)) return "名称里不能有控制字符";
  return null;
}

/** 63 位随机正整数，和 Apple 的叶证书序列号位数相当。 */
function randomSerial(random: RandomSource): bigint {
  const serial = bytesToBigInt(random(8)) & 0x7fffffffffffffffn;
  return serial === 0n ? 1n : serial;
}

export function createIdentity(options: CreateIdentityOptions = {}): SigningIdentity {
  const random = options.random ?? randomBytes;
  const now = options.now ?? new Date();

  const root = generateKeyPair(random);
  const leaf = generateKeyPair(random);
  const notBefore = new Date(now.getTime() - DAY_MS);
  const notAfter = new Date(now.getTime() + VALIDITY_DAYS * DAY_MS);

  // 默认名带 4 位随机后缀：重新生成身份后，「证书信任设置」里能分清哪个是新的。
  // 用户自己起的名字原样用，不加后缀——想区分新旧，自己在名字里写。
  const customName = options.rootName?.trim() ?? "";
  if (customName !== "") {
    const problem = checkRootName(customName);
    if (problem !== null) throw new Error(problem);
  }
  const rootName: CertName = {
    organization: ORGANIZATION,
    commonName: customName !== "" ? customName : `${ORGANIZATION} Root ${toHex(random(2))}`,
  };
  // 叶的名字照 Apple：每张叶证书的 CN 都是一串 32 位十六进制
  const leafName: CertName = { organization: ORGANIZATION, commonName: toHex(random(16)) };

  const rootCertificate = buildCertificate({
    subject: rootName,
    issuer: rootName,
    subjectKey: root,
    issuerPrivateKey: root.d,
    issuerKey: root,
    serial: randomSerial(random),
    notBefore,
    notAfter,
    isCa: true,
    keyUsage: ["digitalSignature", "keyCertSign", "cRLSign"],
    extendedKeyUsage: false,
  });
  const leafCertificate = buildCertificate({
    subject: leafName,
    issuer: rootName,
    subjectKey: leaf,
    issuerPrivateKey: root.d,
    issuerKey: root,
    serial: randomSerial(random),
    notBefore,
    notAfter,
    isCa: false,
    keyUsage: ["digitalSignature", "keyEncipherment"],
    extendedKeyUsage: true,
  });

  // root.d 到这里就不再被引用，函数返回后随作用域一起回收
  return {
    leafPrivateKey: leaf.d,
    leafPublicKey: { x: leaf.x, y: leaf.y },
    leafCertificate,
    rootCertificate,
    createdAt: now.getTime(),
  };
}

interface StoredIdentity {
  version: 1;
  /** 叶私钥，32 字节十六进制 */
  leafKey: string;
  leafCertificate: string;
  rootCertificate: string;
  createdAt: number;
}

export function serializeIdentity(identity: SigningIdentity): string {
  const stored: StoredIdentity = {
    version: 1,
    leafKey: toHex(bigIntToBytes(identity.leafPrivateKey, 32)),
    leafCertificate: toBase64(identity.leafCertificate),
    rootCertificate: toBase64(identity.rootCertificate),
    createdAt: identity.createdAt,
  };
  return JSON.stringify(stored);
}

function contains(haystack: Uint8Array, needle: Uint8Array): boolean {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

/** 读回存下来的身份。数据不全、或叶私钥和叶证书对不上都抛错——宁可重新生成，也不拿坏身份去签。 */
export function parseIdentity(text: string): SigningIdentity {
  let stored: Partial<StoredIdentity>;
  try {
    stored = JSON.parse(text) as Partial<StoredIdentity>;
  } catch {
    throw new Error("签名身份不是合法的 JSON");
  }
  if (
    stored.version !== 1 ||
    typeof stored.leafKey !== "string" ||
    typeof stored.leafCertificate !== "string" ||
    typeof stored.rootCertificate !== "string" ||
    typeof stored.createdAt !== "number"
  ) {
    throw new Error("签名身份的格式不认识");
  }
  const leafPrivateKey = bytesToBigInt(fromHex(stored.leafKey));
  const leafPublicKey = publicFromPrivate(leafPrivateKey);
  const leafCertificate = fromBase64(stored.leafCertificate);
  const rootCertificate = fromBase64(stored.rootCertificate);
  if (!contains(leafCertificate, encodePoint(leafPublicKey))) {
    throw new Error("签名身份已损坏：叶私钥和叶证书对不上");
  }
  return { leafPrivateKey, leafPublicKey, leafCertificate, rootCertificate, createdAt: stored.createdAt };
}

/** 根证书的 SHA-256 指纹，大写、冒号分隔，和 iOS「证书详情」里显示的写法一致。 */
export function rootFingerprint(identity: SigningIdentity): string {
  return toHex(sha256(identity.rootCertificate))
    .toUpperCase()
    .replace(/(..)(?=.)/g, "$1:");
}

export function identityExpiry(identity: SigningIdentity): Date {
  return new Date(identity.createdAt + VALIDITY_DAYS * DAY_MS);
}
