// X.509 证书的最小解析：只取主体、颁发者和有效期。
//
// 描述文件的 DeveloperCertificates 里是一串 DER 编码的证书。签名工具最关心的是
// **证书自己的有效期**——它和描述文件的有效期是两回事：免费账号的证书 7 天，
// 企业证书一年，描述文件还没过期而证书先过期是常见情况。
//
// 不做签名验证、不建信任链，只读几个字段，所以不需要完整的 ASN.1 实现。
// 结构（RFC 5280）：
//   Certificate ::= SEQUENCE { tbsCertificate, signatureAlgorithm, signatureValue }
//   TBSCertificate ::= SEQUENCE { [0] version?, serialNumber, signature,
//                                 issuer, validity, subject, ... }
//   Validity ::= SEQUENCE { notBefore Time, notAfter Time }
//   Name ::= SEQUENCE OF SET OF SEQUENCE { type OID, value }

const TAG_UTF8_STRING = 0x0c;
const TAG_SEQUENCE = 0x30;
const TAG_SET = 0x31;
const TAG_OID = 0x06;
const TAG_UTC_TIME = 0x17;
const TAG_GENERALIZED_TIME = 0x18;
const TAG_CONTEXT_0 = 0xa0;
/** 这些都是「一串字符」的编码，取值方式一样。 */
const STRING_TAGS = new Set([TAG_UTF8_STRING, 0x13, 0x16, 0x14, 0x1e, 0x013]);

/** 常用属性的 OID，按内容字节比对。 */
const OID_COMMON_NAME = "550403";
const OID_ORGANIZATION = "55040a";
const OID_ORG_UNIT = "55040b";

interface Node {
  tag: number;
  /** 内容（不含标签和长度）的范围。 */
  start: number;
  end: number;
  /** 下一个节点的起点。 */
  next: number;
}

/** 读一个 TLV。DER 不用不定长，所以长度一定是确定的。 */
function readNode(bytes: Uint8Array, offset: number): Node {
  if (offset + 2 > bytes.length) throw new Error("证书数据不完整");
  const tag = bytes[offset];
  let cursor = offset + 1;
  let length = bytes[cursor++];
  if (length & 0x80) {
    const count = length & 0x7f;
    // 长度本身超过 4 字节的证书不存在，多半是数据坏了
    if (count === 0 || count > 4 || cursor + count > bytes.length) throw new Error("证书长度字段无效");
    length = 0;
    for (let i = 0; i < count; i++) length = length * 256 + bytes[cursor++];
  }
  const end = cursor + length;
  if (end > bytes.length) throw new Error("证书数据被截断");
  return { tag, start: cursor, end, next: end };
}

function children(bytes: Uint8Array, node: Node): Node[] {
  const out: Node[] = [];
  let offset = node.start;
  while (offset < node.end) {
    const child = readNode(bytes, offset);
    out.push(child);
    offset = child.next;
  }
  return out;
}

function hex(bytes: Uint8Array, node: Node): string {
  let out = "";
  for (let i = node.start; i < node.end; i++) out += bytes[i].toString(16).padStart(2, "0");
  return out;
}

function text(bytes: Uint8Array, node: Node): string {
  return new TextDecoder().decode(bytes.subarray(node.start, node.end));
}

/**
 * 证书时间：UTCTime 是两位年（YYMMDDHHMMSSZ，≥50 算 19xx），
 * GeneralizedTime 是四位年。都按 UTC 算，返回 ISO 字符串。
 */
export function parseCertTime(tag: number, value: string): string | null {
  const digits = value.replace(/[^0-9]/g, "");
  let year: number;
  let rest: string;
  if (tag === TAG_UTC_TIME) {
    if (digits.length < 10) return null;
    const short = Number(digits.slice(0, 2));
    year = short >= 50 ? 1900 + short : 2000 + short;
    rest = digits.slice(2);
  } else if (tag === TAG_GENERALIZED_TIME) {
    if (digits.length < 12) return null;
    year = Number(digits.slice(0, 4));
    rest = digits.slice(4);
  } else {
    return null;
  }
  const part = (at: number) => Number(rest.slice(at, at + 2) || "0");
  const at = Date.UTC(year, part(0) - 1, part(2), part(4), part(6), part(8));
  return Number.isNaN(at) ? null : new Date(at).toISOString();
}

/** 从 Name 里取某个属性。同名的取第一个。 */
function attribute(bytes: Uint8Array, name: Node, oid: string): string {
  for (const rdn of children(bytes, name)) {
    if (rdn.tag !== TAG_SET) continue;
    for (const pair of children(bytes, rdn)) {
      const parts = children(bytes, pair);
      if (parts.length < 2 || parts[0].tag !== TAG_OID) continue;
      if (hex(bytes, parts[0]) === oid && STRING_TAGS.has(parts[1].tag)) return text(bytes, parts[1]);
    }
  }
  return "";
}

export interface CertInfo {
  /** 主体通用名，比如「Apple Development: 某某 (ABC123XYZ)」。 */
  subject: string;
  /** 主体所属组织（公司名）。 */
  organization: string;
  /** 颁发者通用名，比如「Apple Worldwide Developer Relations Certification Authority」。 */
  issuer: string;
  /** ISO 时间串。 */
  notBefore: string | null;
  notAfter: string | null;
}

/**
 * 解析一份 DER 证书。只取用得上的几个字段；拿不到的留空，不抛错，
 * 因为一份描述文件里常带好几张证书，一张读不出来不该拖垮整页。
 */
export function parseCertificate(der: Uint8Array): CertInfo | null {
  try {
    const root = readNode(der, 0);
    if (root.tag !== TAG_SEQUENCE) return null;
    const tbs = children(der, root)[0];
    if (!tbs || tbs.tag !== TAG_SEQUENCE) return null;
    const fields = children(der, tbs);
    // 有 [0] 显式 version 时各字段后移一位
    let index = fields[0]?.tag === TAG_CONTEXT_0 ? 1 : 0;
    index++; // serialNumber
    if (fields[index]?.tag !== TAG_SEQUENCE) return null;
    index++; // signature algorithm
    const issuer = fields[index++];
    const validity = fields[index++];
    const subject = fields[index];
    if (!issuer || !validity || !subject) return null;

    const times = children(der, validity);
    return {
      subject: attribute(der, subject, OID_COMMON_NAME),
      organization: attribute(der, subject, OID_ORGANIZATION) || attribute(der, subject, OID_ORG_UNIT),
      issuer: attribute(der, issuer, OID_COMMON_NAME),
      notBefore: times[0] ? parseCertTime(times[0].tag, text(der, times[0])) : null,
      notAfter: times[1] ? parseCertTime(times[1].tag, text(der, times[1])) : null,
    };
  } catch {
    return null;
  }
}
