// 把根证书包成一份配置描述文件（.mobileconfig），让「设置」能一键安装。
//
// iOS 只有在**下载到** MIME 为 application/x-apple-aspen-config 的内容时才把它当描述文件，
// 所以光写成文件放进「文件」App 没用，得由 kit/profileServer.ts 起一个本地 HTTP 服务、
// 用 Safari 去取（设备工具箱当年验证过这一步：系统会接手下载）。
//
// 描述文件本身没有签名，设置里会显示「未签名」，照常能装。装完还有一步系统不让脚本代劳：
// 「设置 → 通用 → 关于本机 → 证书信任设置」里把这张根证书的开关打开。

import { toHex, utf8 } from "./bytes";
import { rootFingerprint, type SigningIdentity } from "./identity";
import { encodeXmlPlist } from "./plist";
import { sha256 } from "./sha256";
import { commonNameOf } from "./x509";

/** 由根证书指纹派生的稳定 UUID：同一张证书反复下载，系统认作同一份描述文件，不会装出一堆重复项。 */
function stableUuid(fingerprintHex: string, purpose: string): string {
  const bytes = sha256(utf8(`shortcut-signer:${fingerprintHex}:${purpose}`)).slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // 版本 5（基于名字的哈希）
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 变体
  const hex = toHex(bytes).toUpperCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function rootProfile(identity: SigningIdentity): Uint8Array {
  const fingerprint = rootFingerprint(identity).replace(/:/g, "").toLowerCase();
  const short = fingerprint.slice(0, 8);
  const commonName = commonNameOf(identity.rootCertificate) ?? "Shortcut Signer Root";
  return encodeXmlPlist({
    PayloadContent: [
      {
        PayloadCertificateFileName: "shortcut-signer-root.cer",
        PayloadContent: identity.rootCertificate,
        PayloadDescription: "让这台 iPhone 认得「快捷指令签名」脚本签出的快捷指令",
        PayloadDisplayName: commonName,
        PayloadIdentifier: `com.ios151.shortcut-signer.root.${short}`,
        PayloadType: "com.apple.security.root",
        PayloadUUID: stableUuid(fingerprint, "root"),
        PayloadVersion: 1,
      },
    ],
    PayloadDescription: "安装后，还要到「设置 → 通用 → 关于本机 → 证书信任设置」里打开对这张证书的完全信任。",
    // 描述文件和里面那张证书用同一个名字：设置里「已下载描述文件」、安装页、证书信任设置，看到的都是它
    PayloadDisplayName: commonName,
    PayloadIdentifier: `com.ios151.shortcut-signer.${short}`,
    PayloadOrganization: "Shortcut Signer",
    PayloadRemovalDisallowed: false,
    PayloadType: "Configuration",
    PayloadUUID: stableUuid(fingerprint, "profile"),
    PayloadVersion: 1,
  });
}
