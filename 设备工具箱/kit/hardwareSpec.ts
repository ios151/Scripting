// 硬件规格：把硬件树里那些编码过的数字解成人话。
//
// 原始回包里是 `IOMFBIndicatorNitsCap = 42598400` 这种七位数，看得到读不懂。
// 这里只做两件事：**按通用规则解码**，以及**把散在各节点的同类信息并到一行**。
//
// 三条铁律：
//   1. **解码规则必须通用。** 16.16 定点、mach time 换算、核心掩码计数——
//      这些是 IOKit / 设备树的通行表示法，不是某台机器的特例。
//   2. **字段缺了就不显示这一行**，绝不填默认值或"未知"占位。
//      查不到的原因太多（机型不同、系统版本不同、节点名不一样），
//      与其猜一个，不如让那一行消失。
//   3. **时基从设备自己读**（平台节点的 `clock-frequency`），不写死 24 MHz。
//      换台机器时基不同，写死就全错。

import { isPlistDict, type PlistDict } from "./plist";
import { marketingName } from "./services";

/** 市售名；表里查不到就返回 null（那种情况下「型号标识」那行已经把原始值显示了）。 */
function marketingOf(productType: string | null): string | null {
  const named = marketingName(productType);
  return named && named !== productType ? named : null;
}

/** 16.16 定点数：`65536` 就是 `1.0`。亮度、nits 这类都用它。 */
export function fixed16(raw: number): number {
  return raw / 65536;
}

/**
 * 小端字节转整数。设备树里的数值字段都是这么存的，
 * `clock-frequency = 00366e01` 其实是 0x016e3600 = 24000000。
 */
export function leNumber(bytes: Uint8Array): number | null {
  if (bytes.length === 0 || bytes.length > 8) return null;
  let value = 0;
  for (let i = bytes.length - 1; i >= 0; i--) value = value * 256 + bytes[i];
  return Number.isFinite(value) ? value : null;
}

/**
 * mach 时间间隔换成赫兹。
 *
 * 刷新间隔是以时基的"拍"计的，除以时基得秒，取倒数得频率。
 * 时基必须是从设备读来的那个，不能假定。
 */
export function machToHz(machTicks: number, clockHz: number): number | null {
  if (!(machTicks > 0) || !(clockHz > 0)) return null;
  const hz = clockHz / machTicks;
  return Number.isFinite(hz) && hz > 0 ? hz : null;
}

/** 核心掩码里有几个 1 就是几个核。`[63]` = 0b111111 = 6 核。 */
export function countBits(mask: number): number {
  let count = 0;
  let rest = Math.trunc(mask);
  while (rest > 0) {
    count += rest % 2;
    rest = Math.floor(rest / 2);
  }
  return count;
}

export interface SpecItem {
  label: string;
  value: string;
}

export interface SpecSection {
  title: string;
  items: SpecItem[];
}

/** 一个节点查到的东西：扁平的键值对。查不到就是 undefined。 */
export type NodeData = Record<string, unknown> | undefined;

/** 硬件规格要用到的那几个节点。键名是本模块内部的叫法。 */
export interface SpecSources {
  platform?: NodeData;
  gpu?: NodeData;
  display?: NodeData;
  touch?: NodeData;
  media?: NodeData;
  network?: NodeData;
  bluetooth?: NodeData;
  isp?: NodeData;
  /** lockdown 的 GetValue 那一整份。 */
  lockdown?: NodeData;
}

function str(source: NodeData, key: string): string | null {
  const value = source?.[key];
  if (typeof value === "string" && value.trim()) return value.trim();
  return null;
}

function num(source: NodeData, key: string): number | null {
  const value = source?.[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") return Number(value);
  if (value instanceof Uint8Array) return leNumber(value);
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return null;
}

/** 嵌套取值：`GPUConfigurationVariable.num_cores` 这种。 */
function nested(source: NodeData, parent: string, key: string): unknown {
  const group = source?.[parent];
  return isPlistDict(group as PlistDict) ? (group as PlistDict)[key] : undefined;
}

function item(label: string, value: string | null): SpecItem | null {
  return value ? { label, value } : null;
}

function section(title: string, items: (SpecItem | null)[]): SpecSection | null {
  const kept = items.filter((entry): entry is SpecItem => entry !== null);
  return kept.length > 0 ? { title, items: kept } : null;
}

/** 这台设备的时基。读不到就返回 null——宁可不显示刷新率，也不按猜的时基算。 */
export function clockHz(platform: NodeData): number | null {
  const raw = platform?.["clock-frequency"];
  if (raw instanceof Uint8Array) return leNumber(raw);
  return num(platform, "clock-frequency");
}

/** 嵌套字段里的数字。取不到返回 null。 */
function nestedNum(source: NodeData, parent: string, key: string): number | null {
  const value = nested(source, parent, key);
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function displayItems(display: NodeData, clock: number | null): (SpecItem | null)[] {
  const items: (SpecItem | null)[] = [];

  // 间隔越短频率越高：Min 间隔对应最高刷新，Max 间隔对应最低刷新
  const minTicks = nestedNum(display, "IOMFBDisplayRefresh", "displayMinRefreshIntervalMachTime");
  const maxTicks = nestedNum(display, "IOMFBDisplayRefresh", "displayMaxRefreshIntervalMachTime");
  if (clock !== null && minTicks !== null && maxTicks !== null) {
    const high = machToHz(minTicks, clock);
    const low = machToHz(maxTicks, clock);
    if (high !== null && low !== null) {
      const sameRate = Math.round(high) === Math.round(low);
      items.push(item("刷新率", sameRate ? `${Math.round(high)} Hz` : `${Math.round(low)}–${Math.round(high)} Hz 自适应`));
    }
  }

  const brightness = num(display, "IOMFBBrightnessLevel");
  if (brightness !== null) items.push(item("当前亮度", `${Math.round(fixed16(brightness) * 100)}%`));

  const nitsCap = num(display, "IOMFBIndicatorNitsCap");
  if (nitsCap !== null) items.push(item("峰值亮度", `${Math.round(fixed16(nitsCap))} nits`));

  return items;
}

function gpuItems(gpu: NodeData): (SpecItem | null)[] {
  const cores = nestedNum(gpu, "GPUConfigurationVariable", "num_cores");
  const gen = nestedNum(gpu, "GPUConfigurationVariable", "gpu_gen");
  const variant = nested(gpu, "GPUConfigurationVariable", "gpu_var");

  const parts: string[] = [];
  if (gen !== null) parts.push(`第 ${gen} 代`);
  if (typeof variant === "string") parts.push(`${variant} 型`);
  if (cores !== null) parts.push(`${cores} 核`);

  return [item("GPU", parts.length > 0 ? parts.join(" · ") : null), item("GPU 驱动", str(gpu, "IOClass"))];
}

/**
 * 把各节点的数据拼成规格表。
 *
 * 每一节、每一行都可能不存在——拼不出来的整节都不会出现。
 * 这样换一台机器、换一个系统版本，显示的是"它确实有的那些"，不会有一片"未知"。
 */
export function buildSpec(sources: SpecSources): SpecSection[] {
  const clock = clockHz(sources.platform);
  const touchRows = num(sources.touch, "Sensor Rows");
  const touchCols = num(sources.touch, "Sensor Columns");
  const diskSize = num(sources.media, "Size");

  return [
    section("机型", [
      // 只在表里查得到时才给这一行：查不到的话 `marketingName` 原样返回标识，
      // 而下面「型号标识」已经把它显示出来了，没必要重复一遍。
      item("机型", marketingOf(str(sources.lockdown, "ProductType") ?? str(sources.platform, "model"))),
      item("型号标识", str(sources.lockdown, "ProductType") ?? str(sources.platform, "model")),
      item("硬件型号", str(sources.lockdown, "HardwareModel") ?? str(sources.platform, "target-sub-type")),
      item("商品型号", str(sources.platform, "model-number")),
      item("监管型号", str(sources.platform, "regulatory-model-number")),
      item("销售地区", str(sources.platform, "region-info")),
    ]),
    section("芯片", [
      item("平台", str(sources.platform, "platform-name")),
      item("架构", str(sources.lockdown, "CPUArchitecture")),
      ...gpuItems(sources.gpu),
      item("时基", clock !== null ? `${clock / 1e6} MHz` : null),
    ]),
    section("屏幕", displayItems(sources.display, clock)),
    section("触控", [
      item("传感器网格", touchRows !== null && touchCols !== null ? `${touchRows} × ${touchCols}` : null),
      item("触控面", (() => {
        const w = num(sources.touch, "Sensor Surface Width");
        const h = num(sources.touch, "Sensor Surface Height");
        return w !== null && h !== null ? `${w} × ${h}` : null;
      })()),
    ]),
    section("存储", [
      item("容量", diskSize !== null ? `${Math.round(diskSize / 1e9)} GB` : null),
      item("块大小", (() => {
        const block = num(sources.media, "Preferred Block Size");
        return block !== null ? `${block} 字节` : null;
      })()),
    ]),
    section("摄像头", [
      item("前置", sources.isp?.["camera-front"] !== undefined ? "有" : null),
      item("后置", sources.isp?.["camera-rear"] !== undefined ? "有" : null),
      item("人脸检测", sources.isp?.["face-detection-support"] !== undefined ? "支持" : null),
    ]),
    section("无线", [
      item("Wi-Fi 地址", str(sources.lockdown, "WiFiAddress")),
      item("蓝牙地址", (() => {
        const mac = sources.bluetooth?.["local-mac-address"];
        if (!(mac instanceof Uint8Array) || mac.length !== 6) return null;
        return [...mac].map((byte) => byte.toString(16).padStart(2, "0")).join(":");
      })()),
      item("主网卡", str(sources.network, "BSD Name")),
      item("基带", str(sources.lockdown, "BasebandVersion")),
    ]),
    section("系统", [
      item("版本", str(sources.lockdown, "ProductVersion")),
      item("构建号", str(sources.lockdown, "BuildVersion")),
      item("固件构建于", str(sources.platform, "time-stamp")),
    ]),
  ].filter((entry): entry is SpecSection => entry !== null);
}

export function specText(sections: SpecSection[]): string {
  const lines: string[] = [];
  for (const part of sections) {
    lines.push(`【${part.title}】`);
    for (const row of part.items) lines.push(`  ${row.label}：${row.value}`);
    lines.push("");
  }
  return lines.join("\n");
}
