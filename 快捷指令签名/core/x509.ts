// 生成 X.509 证书：一张自签的根证书 + 一张它签发的叶证书。
//
// 证书的形状用的是已经在真机上验证过、能被快捷指令接受的那一套：
//   - 都是 P-256 + ecdsa-with-SHA256，有效期 10 年
//   - 根：CA:TRUE，KeyUsage = digitalSignature + keyCertSign + cRLSign
//   - 叶：CA:FALSE，KeyUsage = digitalSignature + keyEncipherment，EKU = serverAuth + clientAuth
//   - 两张都带 OID 1.2.840.113635.100.18.1
//
// 那个 OID 是整件事的关键：快捷指令校验「iCloud 风格」签名（授权数据里是 SigningCertificateChain）时，
// 除了证书链要能验到受信任的根，就只看链首证书有没有这个扩展。Apple 自己签的叶证书里它的值是 DER 的
// NULL；这里用一个 UTF8String（值本身不参与判断，只看扩展在不在）。
//
// 证书里没有 CRL / OCSP 地址：快捷指令的吊销检查是「有就查，没有就算过」。

import { fromHex } from "./bytes";
import { bitString, boolean, explicit, implicitPrimitive, integer, octetString, oid, sequence, set, time, utf8String } from "./der";
import { ecdsaSign, encodeDerSignature, encodePoint, type AffinePoint } from "./p256";
import { sha256 } from "./sha256";

export const OID_SHORTCUT_SIGNING = "1.2.840.113635.100.18.1";
const OID_ECDSA_SHA256 = "1.2.840.10045.4.3.2";
const OID_EC_PUBLIC_KEY = "1.2.840.10045.2.1";
const OID_PRIME256V1 = "1.2.840.10045.3.1.7";
const OID_COMMON_NAME = "2.5.4.3";
const OID_ORGANIZATION = "2.5.4.10";
const OID_KEY_USAGE = "2.5.29.15";
const OID_SUBJECT_KEY_ID = "2.5.29.14";
const OID_BASIC_CONSTRAINTS = "2.5.29.19";
const OID_AUTHORITY_KEY_ID = "2.5.29.35";
const OID_EXT_KEY_USAGE = "2.5.29.37";
const OID_SERVER_AUTH = "1.3.6.1.5.5.7.3.1";
const OID_CLIENT_AUTH = "1.3.6.1.5.5.7.3.2";

/** KeyUsage 命名比特的编号（RFC 5280 4.2.1.3）。 */
const KEY_USAGE = { digitalSignature: 0, keyEncipherment: 2, keyCertSign: 5, cRLSign: 6 } as const;
type KeyUsageName = keyof typeof KEY_USAGE;

/** 证书里的名字：O + CN 两项。 */
export interface CertName {
  organization: string;
  commonName: string;
}

export interface CertificateSpec {
  subject: CertName;
  issuer: CertName;
  subjectKey: AffinePoint;
  /** 签发者的私钥标量；自签时就是 subject 自己的 */
  issuerPrivateKey: bigint;
  /** 签发者的公钥，用来算 AuthorityKeyIdentifier */
  issuerKey: AffinePoint;
  serial: bigint;
  notBefore: Date;
  notAfter: Date;
  isCa: boolean;
  keyUsage: KeyUsageName[];
  /** 只有叶证书带 serverAuth + clientAuth */
  extendedKeyUsage: boolean;
}

function name(value: CertName): Uint8Array {
  const attribute = (type: string, text: string): Uint8Array => set(sequence(oid(type), utf8String(text)));
  return sequence(attribute(OID_ORGANIZATION, value.organization), attribute(OID_COMMON_NAME, value.commonName));
}

function extension(type: string, critical: boolean, value: Uint8Array): Uint8Array {
  return sequence(oid(type), ...(critical ? [boolean(true)] : []), octetString(value));
}

/** 密钥标识：公钥点 SHA-256 的前 20 字节（RFC 7093 的做法之一，不依赖 SHA-1）。 */
export function keyIdentifier(key: AffinePoint): Uint8Array {
  return sha256(encodePoint(key)).subarray(0, 20);
}

function keyUsageValue(names: KeyUsageName[]): Uint8Array {
  let byte = 0;
  let lastBit = 0;
  for (const usage of names) {
    const bit = KEY_USAGE[usage];
    byte |= 0x80 >> bit;
    lastBit = Math.max(lastBit, bit);
  }
  // DER 要求去掉命名比特列表末尾的零，所以「不用的比特数」按最后一个置位的比特算
  return bitString(Uint8Array.of(byte), 7 - lastBit);
}

function subjectPublicKeyInfo(key: AffinePoint): Uint8Array {
  return sequence(sequence(oid(OID_EC_PUBLIC_KEY), oid(OID_PRIME256V1)), bitString(encodePoint(key)));
}

/** P-256 公钥的 SubjectPublicKeyInfo 开头：算法标识 + BIT STRING 头（后面紧跟 65 字节未压缩点）。 */
const P256_SPKI_PREFIX = fromHex("3059301306072a8648ce3d020106082a8648ce3d030107034200");

/**
 * 从证书 DER 里取出 P-256 公钥（65 字节未压缩点），找不到返回 null。
 * 不做完整的 X.509 解析：证书里 SubjectPublicKeyInfo 的开头是固定的 26 字节，直接按它定位。
 * 链首证书的公钥就是 iCloud 风格 AEA 的签名公钥，自检和对拍 Apple 样本要用。
 */
export function publicKeyFromCertificate(der: Uint8Array): Uint8Array | null {
  outer: for (let i = 0; i + P256_SPKI_PREFIX.length + 65 <= der.length; i++) {
    for (let j = 0; j < P256_SPKI_PREFIX.length; j++) if (der[i + j] !== P256_SPKI_PREFIX[j]) continue outer;
    const start = i + P256_SPKI_PREFIX.length;
    return der[start] === 0x04 ? der.slice(start, start + 65) : null;
  }
  return null;
}

/**
 * 证书里第一个 commonName（UTF8String）。自签根证书的 issuer 和 subject 是同一个名字，
 * 第一个出现的就是它。只用来给描述文件起显示名，找不到返回 null，不做完整解析。
 */
export function commonNameOf(der: Uint8Array): string | null {
  for (let i = 0; i + 6 < der.length; i++) {
    // OID 2.5.4.3 之后紧跟 UTF8String（0x0c）+ 单字节长度
    if (der[i] === 0x06 && der[i + 1] === 0x03 && der[i + 2] === 0x55 && der[i + 3] === 0x04 && der[i + 4] === 0x03 && der[i + 5] === 0x0c) {
      const length = der[i + 6];
      if (length < 0x80 && i + 7 + length <= der.length) return new TextDecoder().decode(der.subarray(i + 7, i + 7 + length));
    }
  }
  return null;
}

export function buildCertificate(spec: CertificateSpec): Uint8Array {
  const signatureAlgorithm = sequence(oid(OID_ECDSA_SHA256));
  const extensions: Uint8Array[] = [
    extension(OID_BASIC_CONSTRAINTS, true, sequence(...(spec.isCa ? [boolean(true)] : []))),
    extension(OID_KEY_USAGE, true, keyUsageValue(spec.keyUsage)),
  ];
  if (spec.extendedKeyUsage) {
    extensions.push(extension(OID_EXT_KEY_USAGE, false, sequence(oid(OID_SERVER_AUTH), oid(OID_CLIENT_AUTH))));
  }
  extensions.push(
    extension(OID_SUBJECT_KEY_ID, false, octetString(keyIdentifier(spec.subjectKey))),
    extension(OID_AUTHORITY_KEY_ID, false, sequence(implicitPrimitive(0, keyIdentifier(spec.issuerKey)))),
    extension(OID_SHORTCUT_SIGNING, false, utf8String("ShortcutSigner")),
  );

  const tbs = sequence(
    explicit(0, integer(2)), // version: v3
    integer(spec.serial),
    signatureAlgorithm,
    name(spec.issuer),
    sequence(time(spec.notBefore), time(spec.notAfter)),
    name(spec.subject),
    subjectPublicKeyInfo(spec.subjectKey),
    explicit(3, sequence(...extensions)),
  );
  const { r, s } = ecdsaSign(spec.issuerPrivateKey, sha256(tbs));
  return sequence(tbs, signatureAlgorithm, bitString(encodeDerSignature(r, s)));
}
