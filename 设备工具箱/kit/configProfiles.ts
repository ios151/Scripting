// 配置描述文件：系统设置 →「VPN 与设备管理」里的那些。
//
// 和「签名到期」看的**不是一回事**：那边是打包签名用的 provisioning profile（misagent），
// 这边是 VPN 配置、Wi-Fi、根证书、MDM、Web Clip（MCInstall）。
//
// 协议：`com.apple.mobile.MCInstall.shim.remote`，请求字段叫 **`RequestType`**，
// 不是别处那个 `Request`——2026-10-18 真机实测，发 `{Request: "QueryType"}` 回的是
// `Status = CommandFormatError`，换成 `{RequestType: "GetProfileList"}` 才通。
//
// 回包形状：
//   OrderedIdentifiers        [id, …]            显示顺序
//   ProfileManifest.<id>      {Description, IsActive}
//   ProfileMetadata.<id>      {PayloadDisplayName, PayloadDescription, PayloadOrganization,
//                              PayloadUUID, PayloadVersion, PayloadRemovalDisallowed}
//   Status                    Acknowledged
//
// 删除走 `RemoveProfile`，细节写在 `removeConfigProfile` 上面。

import { encodeBplist } from "../core/bplist";
import { isPlistDict, type PlistDict } from "./plist";
import type { DeviceSession } from "./session";

export const MCINSTALL_SERVICE = "com.apple.mobile.MCInstall.shim.remote";

export interface ConfigProfile {
  /** 设备给的标识。证书类的是一长串十六进制，带 bundle 味的是装它的 App 自己起的。 */
  identifier: string;
  /** 设置里显示的名字。 */
  name: string;
  /** 装的时候那一大段说明文字。很多推广类的描述文件全靠这段忽悠人。 */
  description: string;
  /** 签发组织。 */
  organization: string;
  /** 现在生效中。 */
  active: boolean;
  /** 装上就删不掉（MDM 下发的会这样）。 */
  locked: boolean;
  uuid: string;
  /** 删除时要原样带回去。 */
  version: number;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function dictAt(parent: PlistDict, key: string, id: string): PlistDict {
  const group = parent[key];
  if (!isPlistDict(group)) return {};
  const entry = group[id];
  return isPlistDict(entry) ? entry : {};
}

/**
 * 把回包整理成列表。
 *
 * 以 `OrderedIdentifiers` 为准：那是设备给的顺序。它缺了就退回按 manifest 的键来，
 * 顺序会乱但总比一条都不显示强。
 */
export function parseProfiles(reply: unknown): ConfigProfile[] {
  if (!isPlistDict(reply)) return [];
  const ordered = Array.isArray(reply.OrderedIdentifiers)
    ? reply.OrderedIdentifiers.filter((item): item is string => typeof item === "string")
    : isPlistDict(reply.ProfileManifest)
      ? Object.keys(reply.ProfileManifest)
      : [];

  return ordered.map((identifier) => {
    const manifest = dictAt(reply, "ProfileManifest", identifier);
    const metadata = dictAt(reply, "ProfileMetadata", identifier);
    return {
      identifier,
      // 两处都可能有名字，metadata 那个更正式
      name: text(metadata.PayloadDisplayName) || text(manifest.Description) || identifier,
      description: text(metadata.PayloadDescription),
      organization: text(metadata.PayloadOrganization),
      active: manifest.IsActive === true,
      locked: metadata.PayloadRemovalDisallowed === true,
      uuid: text(metadata.PayloadUUID),
      version: typeof metadata.PayloadVersion === "number" ? metadata.PayloadVersion : 1,
    };
  });
}

/** 看名字猜个类别，纯粹为了分组好看。猜不出就归「其他」。 */
export type ProfileKind = "proxyCa" | "webClip" | "udid" | "other";

export const KIND_LABEL: Record<ProfileKind, string> = {
  proxyCa: "代理工具的根证书",
  webClip: "桌面图标（Web Clip）",
  udid: "UDID 获取",
  other: "其他",
};

/**
 * 分类只看名字和组织里的关键词。
 *
 * **纯启发式**，不是从描述文件内容里读出来的——真要准得解析 PayloadContent，
 * 而 GetProfileList 根本不返回那个。分错了无非是分组不好看，不影响看内容。
 */
export function classifyProfile(profile: ConfigProfile): ProfileKind {
  const haystack = `${profile.name} ${profile.organization}`.toLowerCase();
  if (/\bca\b|certificate|证书/.test(haystack)) return "proxyCa";
  if (/udid/.test(haystack)) return "udid";
  if (/轻量|入口|桌面|web ?clip/.test(haystack)) return "webClip";
  return "other";
}

export async function readConfigProfiles(session: DeviceSession): Promise<ConfigProfile[]> {
  const reply = await session.withService(MCINSTALL_SERVICE, (client) =>
    client.request({ RequestType: "GetProfileList" }, 20000),
  );
  return parseProfiles(reply);
}

/**
 * 删掉一份配置描述文件。**没有撤销。**
 *
 * `ProfileIdentifier` 不是一个字符串，是一份**二进制 plist 的字节**：
 * `{PayloadType: "Configuration", PayloadIdentifier, PayloadUUID, PayloadVersion}`。
 * 这是 MCInstall 的老规矩（libimobiledevice / pymobiledevice3 都这么发），
 * 直接塞标识字符串设备不认。
 *
 * 几件要知道的：
 *   - `PayloadRemovalDisallowed` 为真的删不掉，调用方该提前拦下，别等设备拒绝。
 *   - **系统可能要求输设备密码**，或者直接静默拒绝。回包的 `Status` 是唯一依据，
 *     不是「没报错就等于删掉了」——所以删完要重新列一遍核对。
 *   - 删掉代理工具的根证书，那个工具就解不了 HTTPS 了，得回去重新生成安装。
 */
export async function removeConfigProfile(session: DeviceSession, profile: ConfigProfile): Promise<void> {
  if (profile.locked) throw new Error("这一份标了不允许删除（PayloadRemovalDisallowed），设备不会接受。");
  const stub = encodeBplist({
    PayloadType: "Configuration",
    PayloadIdentifier: profile.identifier,
    PayloadUUID: profile.uuid,
    PayloadVersion: profile.version,
  });
  const reply = await session.withService(MCINSTALL_SERVICE, (client) =>
    client.request({ RequestType: "RemoveProfile", ProfileIdentifier: stub }, 30000),
  );
  const status = text(reply.Status);
  if (status !== "Acknowledged") {
    throw new Error(`设备没有删掉：${status || "回包里没有 Status"}`);
  }
}

export function profilesText(profiles: ConfigProfile[]): string {
  const lines = [`配置描述文件，共 ${profiles.length} 份`, ""];
  for (const profile of profiles) {
    lines.push(`▸ ${profile.name}`);
    if (profile.organization) lines.push(`    组织：${profile.organization}`);
    lines.push(`    ${profile.active ? "生效中" : "未生效"}${profile.locked ? " · 不可删除" : ""}`);
    lines.push(`    ${profile.identifier}`);
    lines.push("");
  }
  return lines.join("\n");
}
