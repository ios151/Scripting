// IORegistry：设备的硬件树。
//
// `diagnostics_relay` 的 `IORegistry` 请求按**类名**（EntryClass）或**节点名**（EntryName）
// 取一棵子树。电池那一页早就在用它，只是写死了 IOPMPowerSource——这里把它开成通用的。
//
// MobileGestalt 在 iOS 27 上被停用之后，这是剩下唯一能看到硬件内情的路：
// 屏幕面板、摄像头模组、无线芯片、传感器、存储控制器，都在这棵树上。
//
// **预设的类名是猜的。** IOKit 的类名按芯片代次会变（AppleH13CameraInterface 这种名字里
// 带着芯片代号），所以查不到是常态，不是出错。查到什么以设备返回的为准。
//
// 只读：只发 IORegistry 查询，不写任何东西。

import { debugLog, describeError } from "../core/debug";
import { isNativeParseFailure, type PlistClient } from "./lockdown";
import { isPlistDict, type PlistDict } from "./plist";
import { DIAGNOSTICS_SERVICE, flattenSorted } from "./services";
import type { DeviceSession } from "./session";

export interface RegistryQuery {
  label: string;
  /** 二选一：按类名或按节点名。 */
  entryClass?: string;
  entryName?: string;
}

export interface RegistryGroup {
  title: string;
  entries: RegistryQuery[];
}

/**
 * 想查的那些，分两组。
 *
 * **第一组是 2026-10-18 真机（iPhone18,2 / iOS 27.2）跑出来确实有的。**
 * 第二组是同一轮没命中的那几类，换了别的叫法再试——
 * IOKit 类名按芯片代次变（`AppleH16CameraInterface` 这种名字里就带着代号），
 * 所以猜不中是常态，界面上把「没这个节点」当正常结果显示。
 */
export const IO_PRESETS: RegistryGroup[] = [
  {
    title: "真机验过有的",
    entries: [
      { label: "平台根节点", entryClass: "IOPlatformExpertDevice" },
      { label: "平台设备", entryClass: "IOPlatformDevice" },
      { label: "ARM 设备", entryClass: "AppleARMIODevice" },
      { label: "GPU", entryClass: "AGXAccelerator" },
      { label: "显示控制器", entryClass: "IOMobileFramebuffer" },
      { label: "显示面板", entryClass: "AppleCLCD2" },
      { label: "背光", entryClass: "AppleARMBacklight" },
      { label: "多点触控", entryClass: "AppleMultitouchDevice" },
      { label: "按键", entryClass: "AppleM68Buttons" },
      { label: "电池", entryClass: "IOPMPowerSource" },
      { label: "充电器", entryClass: "AppleSMCCharger" },
      { label: "SMC", entryClass: "AppleSMCInterface" },
      { label: "NFC", entryClass: "AppleStockholmControl" },
      { label: "网络接口", entryClass: "IONetworkInterface" },
      { label: "块设备", entryClass: "IOBlockStorageDevice" },
      { label: "存储驱动", entryClass: "IOBlockStorageDriver" },
      { label: "媒体设备", entryClass: "IOMedia" },
      { label: "协处理器", entryClass: "AppleA7IOPNub" },
      { label: "安全隔区协处理器", entryClass: "AppleSEPManager" },
      { label: "资源", entryClass: "IOResources" },
    ],
  },
  {
    /*
      类名怎么猜都不中的，换**节点名**（EntryName）就通了。
      线索是命中节点的 `IONameMatched`：那里是 `gpu,t8150`、`nfc,primary,gpio`
      这种小写短名，和类名是两套叫法。两条路都试过再下结论。
    */
    title: "按节点名找到的",
    entries: [
      { label: "摄像头 ISP", entryName: "isp" },
      { label: "蓝牙", entryName: "bluetooth" },
      { label: "音频协处理器", entryName: "aop" },
      { label: "Wi-Fi", entryName: "wifi" },
      { label: "麦克风", entryName: "mic" },
      { label: "马达", entryName: "haptic" },
    ],
  },
];

export interface RegistryResult {
  query: RegistryQuery;
  /** 查到的内容摊平。没查到时为空数组。 */
  rows: [string, string][];
  /** 设备明确说没有这个节点。和「出错」要分开。 */
  missing: boolean;
  error: string;
}

/** 请求的键名只能是 IOKit 那种标识符，别让人拿它发奇怪的东西。 */
export function isRegistryKey(name: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name);
}

function queryOf(entry: RegistryQuery): PlistDict {
  return entry.entryClass ? { EntryClass: entry.entryClass } : { EntryName: entry.entryName ?? "" };
}

/** 这一条查的是什么，用来显示和复制。 */
export function queryText(entry: RegistryQuery): string {
  return entry.entryClass ? `EntryClass=${entry.entryClass}` : `EntryName=${entry.entryName}`;
}

/**
 * 查一批节点。**一条连接顺序查**——这是一问一答的服务，复用连接没有并发问题，
 * 而每条都重开会白白多付几十次握手。
 */
export async function readRegistry(
  session: DeviceSession,
  entries: RegistryQuery[],
  onProgress?: (done: number, total: number, label: string) => void,
): Promise<RegistryResult[]> {
  const results = await session.withService(DIAGNOSTICS_SERVICE, async (client) => {
    const collected: RegistryResult[] = [];
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      onProgress?.(i, entries.length, entry.label);
      collected.push(await queryOne(client, entry));
    }
    return collected;
  });

  /*
    原生 plist 层解不动的那几条，换**裸帧**连接单独重查一遍（电池那棵树就是这样）。
    `withService` 自己也有退路，但只在第一条请求就翻车时管用——这里是批量查，
    卡住的常常是中间某一条，前面几条已经成功了，整批重跑既浪费也触发不了那条退路。
  */
  const stuck = results.filter((result) => result.error && isNativeParseFailure(result.error));
  if (stuck.length > 0) {
    debugLog("ioregistry", `${stuck.length} 条原生解不动，换裸帧重查：${stuck.map((r) => r.query.label).join("、")}`);
    await session
      .withRawPlistService(DIAGNOSTICS_SERVICE, async (client) => {
        for (const result of stuck) {
          const retried = await queryOne(client, result.query);
          // 原地替换，顺序不变——界面按传进来的顺序列。
          results[results.indexOf(result)] = retried;
        }
      })
      .catch((error) => debugLog("ioregistry", "裸帧重查没跑成", describeError(error)));
  }

  onProgress?.(entries.length, entries.length, "");
  return results;
}

/** 问一条，拿原始字典。设备说没有就是 null；**查出错会抛**，跟「没有」是两回事。 */
async function nodeOf(client: PlistClient, entry: RegistryQuery): Promise<PlistDict | null> {
  const response = await client.request({ Request: "IORegistry", ...queryOf(entry) }, 15000);
  const diagnostics = response.Diagnostics;
  const registry = isPlistDict(diagnostics) ? diagnostics.IORegistry : undefined;
  return response.Status === "Success" && isPlistDict(registry) && Object.keys(registry).length > 0 ? registry : null;
}

/** 问一条并摊平。查不到记 `missing`，出错记 `error`，两者分开——排查时就靠这个区分。 */
async function queryOne(client: PlistClient, entry: RegistryQuery): Promise<RegistryResult> {
  try {
    const found = await nodeOf(client, entry);
    if (!found) return { query: entry, rows: [], missing: true, error: "" };
    return { query: entry, rows: flattenSorted(found), missing: false, error: "" };
  } catch (error) {
    return { query: entry, rows: [], missing: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * 按名字取一批节点的**原始字典**（不摊平）。
 *
 * 规格卡要的是结构——`GPUConfigurationVariable.num_cores` 这种嵌套值，
 * 摊平成 `"GPUConfigurationVariable.num_cores"` 字符串之后就不好取了。
 *
 * 每个名字可以给几个候选，**按顺序试，第一个查到的算数**：
 * IOKit 的类名按机型、系统版本会变，一个名字写死就等着查不到。
 */
export async function readNodes(
  session: DeviceSession,
  wanted: Record<string, RegistryQuery[]>,
  onProgress?: (label: string) => void,
): Promise<Record<string, PlistDict | undefined>> {
  const out: Record<string, PlistDict | undefined> = {};
  /** 原生解不动而跳过的候选。「这个候选不行」和「原生啃不动这个回包」是两回事，后者留着重试。 */
  const stuck: { key: string; entry: RegistryQuery }[] = [];

  await session.withService(DIAGNOSTICS_SERVICE, async (client) => {
    for (const [key, candidates] of Object.entries(wanted)) {
      onProgress?.(key);
      for (const entry of candidates) {
        try {
          const found = await nodeOf(client, entry);
          if (found) {
            out[key] = found;
            break;
          }
        } catch (error) {
          if (isNativeParseFailure(error)) stuck.push({ key, entry });
          // 别的错就是这个候选不行，试下一个
        }
      }
    }
  });

  // 换裸帧把卡住的补上（理由同 readRegistry）。已经靠别的候选查到的就不用再试了。
  const pending = stuck.filter((item) => out[item.key] === undefined);
  if (pending.length === 0) return out;

  debugLog("ioregistry", `${pending.length} 个候选原生解不动，换裸帧重查`);
  await session
    .withRawPlistService(DIAGNOSTICS_SERVICE, async (client) => {
      for (const { key, entry } of pending) {
        if (out[key] !== undefined) continue;
        try {
          const found = await nodeOf(client, entry);
          if (found) out[key] = found;
        } catch (error) {
          debugLog("ioregistry", `${entry.label} 裸帧也不行`, describeError(error));
        }
      }
    })
    .catch((error) => debugLog("ioregistry", "裸帧重查没跑成", describeError(error)));

  return out;
}

export function resultsText(results: RegistryResult[]): string {
  const found = results.filter((item) => item.rows.length > 0);
  const lines = [`硬件树，查了 ${results.length} 个节点，${found.length} 个有内容`, ""];
  for (const item of found) {
    lines.push(`▸ ${item.query.label}（${queryText(item.query)}）${item.rows.length} 项`);
    for (const [key, value] of item.rows) lines.push(`    ${key} = ${value}`);
    lines.push("");
  }
  const missing = results.filter((item) => item.missing).map((item) => item.query.label);
  if (missing.length > 0) lines.push(`没有这些节点：${missing.join("、")}`);
  return lines.join("\n");
}
