// 配对记录：解析、钥匙串存取。
//
// 记录可以是本脚本自己配出来的，也可以是别的工具导出的配对文件
// .mobiledevicepairing（plist，字段 identifier / private_key / public_key / alt_irk）。
// 也可以由脚本自己配对（见 pair_setup.ts）：广播一个可配对主机，用 PIN 走 SRP。

import { fromBase64, fromHex, toHex } from "./bytes";
import { decodeBplist, encodeBplist, isBplist, type PlistValue } from "./bplist";

export interface PairingRecord {
  /** 主机标识，pair-verify 的签名里要原样带上。 */
  identifier: string;
  /** Ed25519 私钥种子，32 字节。 */
  privateKey: Uint8Array;
  /** Ed25519 公钥，32 字节；仅用于界面核对。 */
  publicKey: Uint8Array;
  /** 设备身份解析密钥，用来校验 Bonjour 服务公告里的 authTag 是不是这台设备。 */
  altIrk: Uint8Array;
  /** 本机对外广播用的 IRK。和上面那个是两码事：一个认设备，一个认自己。 */
  hostAltIrk?: Uint8Array;
  deviceName: string;
  deviceUDID: string;
}

interface StoredRecord {
  identifier: string;
  privateKey: string;
  publicKey: string;
  altIrk: string;
  hostAltIrk?: string;
  deviceName: string;
  deviceUDID: string;
}

/*
  Keychain 的键名，**不要改**。

  名字带 wloc 只是历史原因（这套协议层最早写在那个脚本里）。改成别的名字，
  用户钥匙串里已经存好的配对记录就读不到了，等于强制所有人重新配对一次。
  Keychain 本来就按脚本隔离，键名叫什么都不会和别人串台，没有改的必要。
*/
const KEYCHAIN_KEY = "wloc_pairing_record_v3";
/** 更早一版的记录（hex 字段、键名不同），读到后自动迁移。 */
const LEGACY_KEYCHAIN_KEY = "wloc_pairing_record_v2";

export function loadPairing(): PairingRecord | null {
  const current = readFrom(KEYCHAIN_KEY);
  if (current) return current;

  const legacy = readLegacy();
  if (legacy) {
    // 迁移失败就把私钥清零再抛——半截状态下留着明文私钥没有意义。
    try {
      savePairing(legacy);
      return legacy;
    } catch (error) {
      legacy.privateKey.fill(0);
      throw error;
    }
  }
  return null;
}

export function savePairing(record: PairingRecord): void {
  const stored = encodeStored(record);
  // 返回值必须看：写钥匙串会失败（锁屏、权限变更），静默忽略的话用户以为配好了，
  // 下次启动才发现记录不在。
  if (!Keychain.set(KEYCHAIN_KEY, JSON.stringify(stored))) {
    throw new Error("无法保存配对记录，请检查钥匙串访问后重试");
  }
}

export function deletePairing(): void {
  Keychain.remove(KEYCHAIN_KEY);
  Keychain.remove(LEGACY_KEYCHAIN_KEY);
}

function encodeStored(record: PairingRecord): StoredRecord {
  return {
    identifier: record.identifier,
    privateKey: toHex(record.privateKey),
    publicKey: toHex(record.publicKey),
    altIrk: toHex(record.altIrk),
    hostAltIrk: record.hostAltIrk ? toHex(record.hostAltIrk) : undefined,
    deviceName: record.deviceName,
    deviceUDID: record.deviceUDID,
  };
}

/** 存成的那份 JSON 还原成记录。缺关键字段的当没有。 */
function decodeStored(stored: StoredRecord | null | undefined): PairingRecord | null {
  if (!stored || typeof stored !== "object") return null;
  if (!stored.identifier || !stored.privateKey) return null;
  try {
    return {
      identifier: stored.identifier,
      privateKey: fromHex(stored.privateKey),
      publicKey: fromHex(stored.publicKey ?? ""),
      altIrk: fromHex(stored.altIrk ?? ""),
      hostAltIrk: stored.hostAltIrk ? fromHex(stored.hostAltIrk) : undefined,
      deviceName: stored.deviceName ?? "",
      deviceUDID: stored.deviceUDID ?? "",
    };
  } catch {
    return null;
  }
}

function readFrom(key: string): PairingRecord | null {
  try {
    const raw = Keychain.get(key);
    return raw ? decodeStored(JSON.parse(raw) as StoredRecord) : null;
  } catch {
    return null;
  }
}

function readLegacy(): PairingRecord | null {
  try {
    const raw = Keychain.get(LEGACY_KEYCHAIN_KEY);
    if (!raw) return null;
    const legacy = JSON.parse(raw) as Record<string, string>;
    if (!legacy.identifier || !legacy.hostPrivateSeed) return null;
    return {
      identifier: legacy.identifier,
      privateKey: fromHex(legacy.hostPrivateSeed),
      publicKey: fromHex(legacy.hostPublicKey ?? ""),
      altIrk: new Uint8Array(0),
      deviceName: legacy.deviceName ?? "",
      deviceUDID: legacy.deviceUDID ?? "",
    };
  } catch {
    return null;
  }
}

// ── 解析导入的文件 ──────────────────────────────────────────────────────────

/**
 * 从导入的私钥里取出 32 字节种子。
 *
 * 三种形态，**不能一律取末尾**：
 *
 * - 32 字节：本身就是种子。
 * - 64 字节：libsodium / NaCl 的约定是 `种子32 ‖ 公钥32`，要取**前** 32。
 *   取末尾会拿到公钥——拿公钥当私钥去签名必然失败，而报出来的是
 *   「设备拒绝了配对」，根本看不出是解析错了。
 * - 其他 >32（PKCS#8 / DER 外壳，如 `302e...0420` 前缀）：种子在尾部，取末尾。
 */
function seed32(bytes: Uint8Array): Uint8Array {
  if (bytes.length === 32) return bytes;
  if (bytes.length === 64) return bytes.subarray(0, 32);
  if (bytes.length > 32) return bytes.subarray(bytes.length - 32);
  throw new Error(`私钥只有 ${bytes.length} 字节，无法取出 32 字节种子`);
}

function asBytes(value: PlistValue | undefined): Uint8Array | null {
  if (value instanceof Uint8Array) return value;
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text) return null;
  if (/^[0-9a-fA-F]+$/.test(text) && text.length % 2 === 0) return fromHex(text);
  try {
    return fromBase64(text);
  } catch {
    return null;
  }
}

function asString(value: PlistValue | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * XML 实体反转义。
 *
 * 原先读取时不还原，设备名里带 `&` 或 `<` 的记录读回来就是 `A&lt;B`。
 * 别处导出的记录同样会中招——标准的 plist 序列化该转义的都会转义。
 */
function xmlUnescape(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    // &amp; 必须最后换，否则 "&amp;lt;" 会被还原成 "<"
    .replace(/&amp;/g, "&");
}

/** 从扁平 plist XML 里取出 key → 值。`<data>` 保持原文，交给 asBytes 解。 */
function parseXmlPlistDict(xml: string): Record<string, string> {
  const result: Record<string, string> = {};
  const pattern = /<key>([\s\S]*?)<\/key>\s*<(string|data|integer|real)>([\s\S]*?)<\/\2>/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(xml)) !== null) {
    const raw = match[3].trim();
    // base64 里不会有 XML 实体，只对文本字段反转义。
    result[xmlUnescape(match[1].trim())] = match[2] === "data" ? raw : xmlUnescape(raw);
  }
  return result;
}

function pick(dict: Record<string, PlistValue>, keys: string[]): PlistValue | undefined {
  for (const key of keys) {
    if (dict[key] !== undefined) return dict[key];
  }
  return undefined;
}

const IDENTIFIER_KEYS = ["identifier", "HostID", "hostId", "host_id"];
const PRIVATE_KEYS = ["private_key", "hostPrivateSeed", "HostPrivateKey", "privateKey"];
const PUBLIC_KEYS = ["public_key", "hostPublicKey", "HostPublicKey", "publicKey"];
const ALT_IRK_KEYS = ["alt_irk", "altIrk", "AltIRK"];
const NAME_KEYS = ["deviceName", "DeviceName", "device_name", "name"];
const UDID_KEYS = ["deviceUDID", "DeviceUDID", "UDID", "udid"];

function recordFromDict(dict: Record<string, PlistValue>): PairingRecord {
  const identifier = asString(pick(dict, IDENTIFIER_KEYS));
  if (!identifier) {
    throw new Error(`缺少 identifier 字段。文件里的字段：${Object.keys(dict).join("、") || "（空）"}`);
  }

  const privateKey = asBytes(pick(dict, PRIVATE_KEYS));
  if (!privateKey) throw new Error("缺少 private_key 字段，这不是有效的配对文件");

  return {
    identifier,
    privateKey: seed32(privateKey),
    publicKey: asBytes(pick(dict, PUBLIC_KEYS)) ?? new Uint8Array(0),
    altIrk: asBytes(pick(dict, ALT_IRK_KEYS)) ?? new Uint8Array(0),
    deviceName: asString(pick(dict, NAME_KEYS)),
    deviceUDID: asString(pick(dict, UDID_KEYS)),
  };
}

/**
 * 解析配对文件内容。支持二进制 plist、XML plist 与旧版 JSON。
 * 解析不出来时抛错，错误文案直接给用户看。
 */
export function parsePairingFile(bytes: Uint8Array): PairingRecord {
  if (isBplist(bytes)) {
    const { root } = decodeBplist(bytes);
    if (typeof root !== "object" || root === null || Array.isArray(root)) {
      throw new Error("二进制 plist 的顶层不是字典");
    }
    return recordFromDict(root as Record<string, PlistValue>);
  }

  const text = new TextDecoder().decode(bytes).trim();
  if (!text) throw new Error("文件内容为空");

  if (text.startsWith("{")) {
    const json = JSON.parse(text) as Record<string, PlistValue>;
    return recordFromDict(json);
  }

  if (text.includes("<plist") || text.includes("<dict>")) {
    const dict = parseXmlPlistDict(text);
    if (Object.keys(dict).length === 0) throw new Error("XML plist 里没有解析到任何字段");
    return recordFromDict(dict as Record<string, PlistValue>);
  }

  throw new Error(`无法识别的格式，文件开头：${text.slice(0, 60).replace(/\s+/g, " ")}`);
}

// ── 导出 ───────────────────────────────────────────────────────────
//
// 三种格式都能被本脚本的 `parsePairingFile` 读回来；XML plist 和二进制 plist
// 字段名是跨工具通用的那一套，刻意保持不变，这样导出的文件别的工具也读得回去。
// 既给文件，也给一份纯文本，后者配合「从剪贴板粘贴」迁移更省事。

/** 配对记录可导出的格式。 */
export type PairingExportFormat = "xml" | "binary" | "json";

export const PAIRING_EXPORT_FORMATS: {
  id: PairingExportFormat;
  label: string;
  detail: string;
  /** 建议的文件扩展名 */
  extension: string;
  /** 是不是纯文本——纯文本才能直接往剪贴板放 */
  text: boolean;
}[] = [
  {
    id: "xml",
    label: "XML plist",
    detail: "纯文本，认这套字段名的工具都能读。迁移用这个最稳。",
    extension: "mobiledevicepairing",
    text: true,
  },
  {
    id: "binary",
    label: "二进制 plist",
    detail: "体积小，和设备自己生成的格式一致。",
    extension: "mobiledevicepairing",
    text: false,
  },
  {
    id: "json",
    label: "JSON",
    detail: "十六进制字段，便于人工核对。只有本脚本能读。",
    extension: "json",
    text: true,
  },
];

/** plist 的 data 字段要 base64。 */
function base64Of(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * XML plist。
 *
 * 字段名照 `.mobiledevicepairing` 那套，所以和别的工具可以互导。
 * `alt_irk` 为空时不写——有些记录本来就没有这一项，写个空 data 反而容易被误读。
 */
export function exportPairingAsXml(record: PairingRecord): string {
  const entries: string[] = [
    `  <key>identifier</key>\n  <string>${xmlEscape(record.identifier)}</string>`,
    `  <key>private_key</key>\n  <data>${base64Of(record.privateKey)}</data>`,
  ];
  if (record.publicKey.length > 0) {
    entries.push(`  <key>public_key</key>\n  <data>${base64Of(record.publicKey)}</data>`);
  }
  if (record.altIrk.length > 0) {
    entries.push(`  <key>alt_irk</key>\n  <data>${base64Of(record.altIrk)}</data>`);
  }
  if (record.deviceName) {
    entries.push(`  <key>device_name</key>\n  <string>${xmlEscape(record.deviceName)}</string>`);
  }
  if (record.deviceUDID) {
    entries.push(`  <key>device_udid</key>\n  <string>${xmlEscape(record.deviceUDID)}</string>`);
  }

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    entries.join("\n"),
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

/** 二进制 plist，和设备自己生成的格式一致。 */
export function exportPairingAsBinary(record: PairingRecord): Uint8Array {
  const dict: Record<string, PlistValue> = {
    identifier: record.identifier,
    private_key: record.privateKey,
  };
  if (record.publicKey.length > 0) dict.public_key = record.publicKey;
  if (record.altIrk.length > 0) dict.alt_irk = record.altIrk;
  if (record.deviceName) dict.device_name = record.deviceName;
  if (record.deviceUDID) dict.device_udid = record.deviceUDID;
  return encodeBplist(dict);
}

/** JSON，十六进制字段，便于人工核对。 */
export function exportPairingAsJson(record: PairingRecord): string {
  return JSON.stringify(
    {
      identifier: record.identifier,
      privateKey: toHex(record.privateKey),
      publicKey: toHex(record.publicKey),
      altIrk: toHex(record.altIrk),
      deviceName: record.deviceName,
      deviceUDID: record.deviceUDID,
    },
    null,
    2,
  );
}
