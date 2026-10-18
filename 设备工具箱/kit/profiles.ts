// 描述文件（Provisioning Profile）：列出、算到期、对上用它的 App、删除。
//
// 请求格式照 idevice（misagent.rs）：
//   CopyAll {MessageType, ProfileType: "Provisioning"} → Payload：每个描述文件一段 data
//   Remove  {MessageType, ProfileID: UUID, ProfileType} → Status 为 0 表示成功
// 每段 data 是 CMS 签名的 DER，里面原样嵌着一份 XML plist。取 `<?xml` 到 `</plist>`
// 这一段解开就行，不用解 CMS。

import { utf8 } from "../core/bytes";
import { debugLog } from "../core/debug";
import type { AppEntry } from "./apps";
import { isoSeconds } from "./dates";
import { decodePlist, isPlistDict, type PlistDict } from "./plist";
import type { PlistValue } from "../core/bplist";
import { asNumber, formatValue } from "./services";
import type { DeviceSession } from "./session";
import { simulatedNow } from "./testClock";
import { parseCertificate, type CertInfo } from "./x509";

export const MISAGENT_SERVICE = "com.apple.misagent.shim.remote";

export type ProfileKind = "development" | "adHoc" | "enterprise" | "appStore";

export const PROFILE_KIND_LABEL: Record<ProfileKind, string> = {
  development: "开发",
  adHoc: "Ad Hoc",
  enterprise: "企业",
  appStore: "App Store",
};

export interface ProfileEntry {
  uuid: string;
  name: string;
  appIdName: string;
  teamName: string;
  teamId: string;
  /** 形如「TEAMID.com.example.app」，或带通配的「TEAMID.*」。 */
  appIdentifier: string;
  /** ISO 时间串（XML plist 的 <date> 原样读出）。 */
  created: string | null;
  expires: string | null;
  kind: ProfileKind;
  /** 限定的设备数。企业描述文件不限设备，为 null。 */
  deviceCount: number | null;
  /** 限定的设备 UDID，全小写方便比对。不限设备时为空数组。 */
  devices: string[];
  /** 描述文件允许的 entitlements 键，用来比对 App 有没有超范围。 */
  entitlementKeys: string[];
  /** 描述文件授权的全部 entitlements，详情页原样展示。 */
  entitlements: PlistDict;
  /** 里面带的证书。证书自己的有效期和描述文件的不是一回事。 */
  certificates: CertInfo[];
}

/** 这份描述文件里最早到期的那张证书。没有证书时为 null。 */
export function earliestCertificate(profile: ProfileEntry): CertInfo | null {
  const dated = profile.certificates.filter((cert) => cert.notAfter !== null);
  if (dated.length === 0) return profile.certificates[0] ?? null;
  return dated.reduce((earliest, cert) => (Date.parse(cert.notAfter!) < Date.parse(earliest.notAfter!) ? cert : earliest));
}

const XML_START = utf8("<?xml");
const PLIST_END = utf8("</plist>");

function indexOfBytes(haystack: Uint8Array, needle: Uint8Array, from = 0): number {
  for (let at = haystack.indexOf(needle[0], from); at !== -1; at = haystack.indexOf(needle[0], at + 1)) {
    let match = true;
    for (let i = 1; i < needle.length && match; i++) match = haystack[at + i] === needle[i];
    if (match) return at;
  }
  return -1;
}

/** 从 CMS 包里取出内嵌的 plist。取不到返回 null。 */
export function extractProfilePlist(blob: Uint8Array): PlistDict | null {
  const start = indexOfBytes(blob, XML_START);
  if (start === -1) return null;
  const end = indexOfBytes(blob, PLIST_END, start);
  if (end === -1) return null;
  try {
    const value = decodePlist(blob.subarray(start, end + PLIST_END.length));
    return isPlistDict(value) ? value : null;
  } catch {
    return null;
  }
}

function text(value: unknown): string {
  // 描述文件里的 ExpirationDate / CreationDate 是 <date>，解出来是 Date；
  // 下游一路按 ISO 串用（Date.parse 比大小、formatDate 显示），这里统一成串。
  if (value instanceof Date) return isoSeconds(value);
  return typeof value === "string" ? value : "";
}

/**
 * 类型的判法和 Xcode 一致：
 * 不限设备（ProvisionsAllDevices）是企业；带 get-task-allow 是开发；
 * 限定了设备但不能调试是 Ad Hoc；都没有是 App Store（一般不会装在手机上）。
 */
export function parseProfile(dict: PlistDict): ProfileEntry {
  const entitlements = isPlistDict(dict.Entitlements) ? dict.Entitlements : {};
  const teams = Array.isArray(dict.TeamIdentifier) ? dict.TeamIdentifier : [];
  const provisioned = Array.isArray(dict.ProvisionedDevices) ? dict.ProvisionedDevices : null;
  const deviceCount = provisioned ? provisioned.length : null;
  // UDID 大小写在不同来源里不统一，一律转小写再比
  const devices = (provisioned ?? []).filter((id): id is string => typeof id === "string").map((id) => id.toLowerCase());
  const kind: ProfileKind =
    dict.ProvisionsAllDevices === true
      ? "enterprise"
      : entitlements["get-task-allow"] === true
        ? "development"
        : deviceCount !== null
          ? "adHoc"
          : "appStore";
  return {
    uuid: text(dict.UUID),
    name: text(dict.Name) || "（未命名）",
    appIdName: text(dict.AppIDName),
    teamName: text(dict.TeamName),
    teamId: text(teams[0]),
    appIdentifier: text(entitlements["application-identifier"]),
    created: text(dict.CreationDate) || null,
    expires: text(dict.ExpirationDate) || null,
    kind,
    deviceCount,
    devices,
    entitlementKeys: Object.keys(entitlements).sort(),
    entitlements,
    certificates: parseCertificates(dict.DeveloperCertificates),
  };
}

/** DeveloperCertificates 是一串 DER 证书。读不出来的那张跳过，不拖垮整份。 */
function parseCertificates(value: PlistValue | undefined): CertInfo[] {
  if (!Array.isArray(value)) return [];
  const certs: CertInfo[] = [];
  for (const der of value) {
    if (!(der instanceof Uint8Array)) continue;
    const parsed = parseCertificate(der);
    if (parsed) certs.push(parsed);
    else debugLog("misagent", `有一张证书解不开（${der.length} 字节）`);
  }
  return certs;
}

const DAY = 86400000;
/** 少于这么多天算「快到期」：自签的免费证书只有 7 天。 */
export const SOON_DAYS = 7;

export interface ExpiryState {
  level: "expired" | "soon" | "ok" | "unknown";
  text: string;
  msLeft: number | null;
}

export function expiryState(expires: string | null, now = simulatedNow()): ExpiryState {
  const at = expires ? Date.parse(expires) : NaN;
  if (Number.isNaN(at)) return { level: "unknown", text: "到期时间未知", msLeft: null };
  const msLeft = at - now;
  if (msLeft <= 0) {
    const days = Math.floor(-msLeft / DAY);
    return { level: "expired", text: days === 0 ? "今天已过期" : `已过期 ${days} 天`, msLeft };
  }
  const days = Math.floor(msLeft / DAY);
  const label = days === 0 ? `${Math.max(1, Math.floor(msLeft / 3600000))} 小时后到期` : `还剩 ${days} 天`;
  return { level: days < SOON_DAYS ? "soon" : "ok", text: label, msLeft };
}

/** 按到期时间从早到晚；没有到期时间的放最后。 */
export function sortProfiles(profiles: ProfileEntry[]): ProfileEntry[] {
  const key = (profile: ProfileEntry) => {
    const at = profile.expires ? Date.parse(profile.expires) : NaN;
    return Number.isNaN(at) ? Infinity : at;
  };
  return [...profiles].sort((a, b) => key(a) - key(b));
}

/**
 * 用这个描述文件的 App：application-identifier 完全一致，或者描述文件带通配时前缀一致。
 * App Store / TestFlight 的包由 Apple 重签，不靠手机上的描述文件，排除掉。
 */
export function appsForProfile(profile: ProfileEntry, apps: AppEntry[]): AppEntry[] {
  const id = profile.appIdentifier;
  if (!id) return [];
  const candidates = apps.filter((app) => app.source !== "appStore" && app.source !== "testFlight");
  if (id.endsWith("*")) {
    const prefix = id.slice(0, -1);
    return candidates.filter((app) => app.appIdentifier.startsWith(prefix));
  }
  return candidates.filter((app) => app.appIdentifier === id);
}

export async function readProfiles(session: DeviceSession): Promise<ProfileEntry[]> {
  const response = await session.withService(MISAGENT_SERVICE, (client) =>
    client.request({ MessageType: "CopyAll", ProfileType: "Provisioning" }, 30000),
  );
  const payload = response.Payload;
  if (!Array.isArray(payload)) throw new Error("设备没有返回描述文件列表");
  const profiles: ProfileEntry[] = [];
  for (const blob of payload) {
    const dict = blob instanceof Uint8Array ? extractProfilePlist(blob) : null;
    if (dict) profiles.push(parseProfile(dict));
    else debugLog("misagent", `有一个描述文件解不开（${blob instanceof Uint8Array ? `${blob.length} 字节` : typeof blob}）`);
  }
  return sortProfiles(profiles);
}

/** 删除。用它签名的 App 之后会打不开——确认放在界面上做。 */
export async function removeProfile(session: DeviceSession, uuid: string): Promise<void> {
  const response = await session.withService(MISAGENT_SERVICE, (client) =>
    client.request({ MessageType: "Remove", ProfileID: uuid, ProfileType: "Provisioning" }),
  );
  if (asNumber(response.Status) !== 0) throw new Error(`设备没有删掉（Status ${formatValue(response.Status)}）`);
}
