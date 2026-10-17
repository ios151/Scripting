// 开发者磁盘镜像（DDI）状态：挂没挂、开发者模式开没开。
//
// 请求格式照 idevice（mobile_image_mounter.rs）：
//   LookupImage {ImageType} → ImageSignature（数组，空或没有就是没挂）
//   QueryDeveloperModeStatus → DeveloperModeStatus（布尔）
// 这里只读不写：上传、挂载、卸载镜像都不做。

import { debugLog, describeError } from "../core/debug";
import { isPlistDict } from "./plist";
import type { DeviceSession } from "./session";

export const IMAGE_MOUNTER_SERVICE = "com.apple.mobile.mobile_image_mounter.shim.remote";

/**
 * 两种镜像类型：老系统用 Developer（DeveloperDiskImage.dmg），
 * iOS 17 起换成个性化镜像 Personalized。两个都查一遍，哪个有就显示哪个。
 */
const IMAGE_TYPES = ["Personalized", "Developer"] as const;

export interface ImageStatus {
  /** 已挂载的镜像类型；都没挂为 null。 */
  mounted: string | null;
  /** 签名长度，仅用来说明「确实拿到了一份签名」。 */
  signatureBytes: number | null;
  /** 开发者模式开没开；查不到为 null（老系统没有这个开关）。 */
  developerMode: boolean | null;
}

function signatureLength(response: unknown): number | null {
  if (!isPlistDict(response as never)) return null;
  const list = (response as Record<string, unknown>).ImageSignature;
  if (!Array.isArray(list) || list.length === 0) return null;
  const first = list[0];
  return first instanceof Uint8Array ? first.length : 0;
}

export async function readImageStatus(session: DeviceSession): Promise<ImageStatus> {
  return session.withService(IMAGE_MOUNTER_SERVICE, async (client) => {
    let mounted: string | null = null;
    let signatureBytes: number | null = null;
    for (const type of IMAGE_TYPES) {
      try {
        const response = await client.request({ Command: "LookupImage", ImageType: type });
        const length = signatureLength(response);
        if (length !== null) {
          mounted = type;
          signatureBytes = length;
          break;
        }
      } catch (error) {
        // 这台系统不认这种镜像类型，换下一种
        debugLog("ddi", `LookupImage ${type} 失败`, describeError(error));
      }
    }
    let developerMode: boolean | null = null;
    try {
      const response = await client.request({ Command: "QueryDeveloperModeStatus" });
      if (typeof response.DeveloperModeStatus === "boolean") developerMode = response.DeveloperModeStatus;
    } catch (error) {
      debugLog("ddi", "QueryDeveloperModeStatus 失败（老系统没有这个开关）", describeError(error));
    }
    debugLog("ddi", `镜像 ${mounted ?? "未挂载"}，开发者模式 ${developerMode ?? "未知"}`);
    return { mounted, signatureBytes, developerMode };
  });
}
