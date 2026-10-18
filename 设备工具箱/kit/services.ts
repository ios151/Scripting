// 设备信息、电池健康、主屏布局，外加电源操作（重启 / 关机 / 睡眠）。
//
// 请求格式一律照 idevice（rev 2bc58aae）：
//   lockdown.rs            GetValue {Label, Request, Key?, Domain?} → Value
//   diagnostics_relay.rs   IORegistry {Request, EntryClass?|EntryName?} → Diagnostics.IORegistry
//                          Restart / Shutdown / Sleep {Request} → Status=Success
//   springboardservices.rs getIconState / setIconState / getIconPNGData / getWallpaperPreviewImage
// 主屏布局的写入只给 Dock 编辑和 AI 整理用，见 kit/homeEdit.ts。

import { PReal, type PlistValue } from "../core/bplist";
import { toHex } from "../core/bytes";
import { debugLog, describeError } from "../core/debug";
import { ymdhm } from "./dates";
import { withWidgetIdentifiers } from "./homeEdit";
import type { PlistClient } from "./lockdown";
import { isPlistDict, type PlistDict } from "./plist";
import type { DeviceSession } from "./session";

export const LOCKDOWN_SERVICE = "com.apple.mobile.lockdown.remote.trusted";
export const DIAGNOSTICS_SERVICE = "com.apple.mobile.diagnostics_relay.shim.remote";
export const SPRINGBOARD_SERVICE = "com.apple.springboardservices.shim.remote";

// ── 通用格式化 ────────────────────────────────────────────────────────────

/** 把协议里出来的任意值变成一行字。 */
/**
 * 这段字节是不是可读的 ASCII 文本。是就还原成文本，不是返回 null。
 *
 * IORegistry / 设备树里大量字段是**定长字段里塞一段 NUL 结尾的 ASCII**，
 * 后面用 0 补满：`model` 是 `iPhone18,2\0`、`region-info` 是 `CH/A\0\0\0…`。
 * 照字节显示就是一串十六进制，完全看不出是什么。
 *
 * 判定从严，宁可退回十六进制也不要把二进制瞎解成乱码：
 *   - 去掉尾部的 0 之后必须非空
 *   - 剩下的每个字节都得是可打印 ASCII 或制表/换行
 *   - 中间允许有 NUL（`compatible` 就是几段串拼在一起），显示成空格分隔
 */
export function printableText(bytes: Uint8Array): string | null {
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) end -= 1;
  if (end === 0) return null;

  const parts: string[] = [];
  let current = "";
  for (let i = 0; i < end; i++) {
    const byte = bytes[i];
    if (byte === 0) {
      if (current) parts.push(current);
      current = "";
      continue;
    }
    const printable = (byte >= 0x20 && byte <= 0x7e) || byte === 0x09 || byte === 0x0a;
    if (!printable) return null;
    current += String.fromCharCode(byte);
  }
  if (current) parts.push(current);
  return parts.length > 0 ? parts.join(" ") : null;
}

export function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  if (typeof value === "boolean") return value ? "是" : "否";
  // 原生解出来的 <date>。放在 Uint8Array 之前判，Date 也是对象。
  if (value instanceof Date) return ymdhm(value);
  if (value instanceof Uint8Array) {
    // 设备树里一大半「二进制」其实是 NUL 结尾的 ASCII，照十六进制显示等于白给
    const text = printableText(value);
    if (text !== null) return text;
    return value.length <= 32 ? toHex(value) : `${toHex(value.subarray(0, 16))}…（${value.length} 字节）`;
  }
  if (typeof value === "object" && "value" in (value as object)) return String((value as { value: unknown }).value);
  try {
    return JSON.stringify(value, (_, item) => (typeof item === "bigint" ? item.toString() : item));
  } catch {
    return String(value);
  }
}

/** 数字字段：number / 安全范围内的十进制字符串 / bigint 都认，其余返回 null。 */
export function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") return Number(value);
  // 二进制 plist 的浮点数和日期都解成 PReal（core/bplist），它本身就是个数
  if (value instanceof PReal && Number.isFinite(value.value)) return value.value;
  if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return null;
}

/**
 * 有符号 64 位整数。IORegistry 里的电流是无符号补码：放电时的 -350 mA 会以
 * 18446744073709551266 出现，照字面显示就是一个天文数字。
 */
function asSigned64(value: unknown): number | null {
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const big = BigInt(value);
    return Number(big >= BigInt(2) ** BigInt(63) ? big - BigInt(2) ** BigInt(64) : big);
  }
  const plain = asNumber(value);
  if (plain === null) return null;
  return plain > 2 ** 63 ? plain - 2 ** 64 : plain;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

export function formatBytes(bytes: number): string {
  // 和系统「设置 → 通用 → 关于本机」一致，按 1000 进位
  if (bytes >= 1e12) return `${(bytes / 1e12).toFixed(2)} TB`;
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  if (bytes >= 1e3) return `${Math.round(bytes / 1e3)} KB`;
  return `${bytes} B`;
}

// ── 设备信息 ──────────────────────────────────────────────────────────────

/**
 * ProductType → 市售名。
 *
 * **内部编号比市售代数大一代**，别按数字猜：`iPhone17,1` 是 iPhone 16 Pro，
 * `iPhone18,2` 是 iPhone 17 Pro Max。小数点后那位也不按档次排
 * （`iPhone17,1` 是 Pro、`iPhone17,3` 才是标准版）。
 *
 * **只收已经发售的**。传闻中的下一代（`iPhone19,x`）在社区列表里早就有了，但名字还会变，
 * 收进来就是在界面上写一个可能错的型号——查不到的本来就会原样显示标识，不亏。
 *
 * 收到 iPhone18,x（2025 年秋，iPhone 17 系列 + Air）。数据对过两处：adamawolf 那份
 * 机型列表 gist 和 EveryMac，两边一致。
 */
const MARKETING_NAMES: Record<string, string> = {
  "iPhone10,1": "iPhone 8", "iPhone10,4": "iPhone 8", "iPhone10,2": "iPhone 8 Plus", "iPhone10,5": "iPhone 8 Plus",
  "iPhone10,3": "iPhone X", "iPhone10,6": "iPhone X",
  "iPhone11,2": "iPhone XS", "iPhone11,4": "iPhone XS Max", "iPhone11,6": "iPhone XS Max", "iPhone11,8": "iPhone XR",
  "iPhone12,1": "iPhone 11", "iPhone12,3": "iPhone 11 Pro", "iPhone12,5": "iPhone 11 Pro Max", "iPhone12,8": "iPhone SE（第 2 代）",
  "iPhone13,1": "iPhone 12 mini", "iPhone13,2": "iPhone 12", "iPhone13,3": "iPhone 12 Pro", "iPhone13,4": "iPhone 12 Pro Max",
  "iPhone14,4": "iPhone 13 mini", "iPhone14,5": "iPhone 13", "iPhone14,2": "iPhone 13 Pro", "iPhone14,3": "iPhone 13 Pro Max",
  "iPhone14,6": "iPhone SE（第 3 代）", "iPhone14,7": "iPhone 14", "iPhone14,8": "iPhone 14 Plus",
  "iPhone15,2": "iPhone 14 Pro", "iPhone15,3": "iPhone 14 Pro Max", "iPhone15,4": "iPhone 15", "iPhone15,5": "iPhone 15 Plus",
  "iPhone16,1": "iPhone 15 Pro", "iPhone16,2": "iPhone 15 Pro Max",
  "iPhone17,1": "iPhone 16 Pro", "iPhone17,2": "iPhone 16 Pro Max", "iPhone17,3": "iPhone 16", "iPhone17,4": "iPhone 16 Plus",
  "iPhone17,5": "iPhone 16e",
  "iPhone18,1": "iPhone 17 Pro", "iPhone18,2": "iPhone 17 Pro Max", "iPhone18,3": "iPhone 17",
  "iPhone18,4": "iPhone Air", "iPhone18,5": "iPhone 17e",
};

/**
 * ProductType 换成市售名；表里没有就**原样返回标识**。
 *
 * 新机型出来时这张表一定是落后的，那时候显示 `iPhone19,1` 也比显示「未知机型」有用——
 * 至少能搜、能对。
 */
export function marketingName(productType: string | null | undefined): string | undefined {
  const trimmed = productType?.trim();
  if (!trimmed || trimmed === "—") return undefined;
  return MARKETING_NAMES[trimmed] ?? trimmed;
}

export interface InfoItem {
  label: string;
  value: string;
  /** 序列号、UDID、IMEI 这类，界面上默认打码——截图分享时最容易顺手带出去。 */
  sensitive?: boolean;
}

export interface InfoSection {
  title: string;
  items: InfoItem[];
}

export interface DeviceInfo {
  sections: InfoSection[];
  /** 全部原始字段，「全部属性」页用。key 前缀标明出处。 */
  raw: [string, string][];
  /** 某些取值失败时的说明，不影响其余内容。 */
  warnings: string[];
}

async function getValue(client: PlistClient, domain?: string): Promise<PlistDict> {
  const request: PlistDict = { Label: "", Request: "GetValue" };
  if (domain) request.Domain = domain;
  const response = await client.request(request);
  return isPlistDict(response.Value) ? response.Value : {};
}

/**
 * ECID 习惯用十六进制写。它常常超过 2^53，所以不能经过 number：
 * XML 那边读成了十进制字符串，XPC 那边是 bigint，统一走 BigInt。
 */
function formatEcid(value: unknown): string | undefined {
  let big: bigint | null = null;
  if (typeof value === "bigint") big = value;
  else if (typeof value === "string" && /^\d+$/.test(value)) big = BigInt(value);
  else if (typeof value === "number" && Number.isSafeInteger(value)) big = BigInt(value);
  if (big === null) return value === undefined ? undefined : formatValue(value);
  return `0x${big.toString(16).toUpperCase()}（${big.toString()}）`;
}

export async function readDeviceInfo(session: DeviceSession): Promise<DeviceInfo> {
  const props = session.properties;
  const warnings: string[] = [];
  let lockdown: PlistDict = {};
  let disk: PlistDict = {};

  if (session.hasService(LOCKDOWN_SERVICE)) {
    await session.withService(LOCKDOWN_SERVICE, async (client) => {
      try {
        lockdown = await getValue(client);
      } catch (error) {
        warnings.push(`基础信息读取失败：${describeError(error)}`);
      }
      try {
        disk = await getValue(client, "com.apple.disk_usage");
      } catch (error) {
        warnings.push(`存储信息读取失败：${describeError(error)}`);
      }
    });
  } else {
    warnings.push("设备没有提供 lockdown 服务，只显示握手时自报的属性。");
  }

  const pick = (...keys: string[]): unknown => {
    for (const key of keys) {
      if (lockdown[key] !== undefined) return lockdown[key];
      if (props[key] !== undefined) return props[key];
    }
    return undefined;
  };
  const item = (label: string, value: unknown, sensitive = false): InfoItem | null =>
    value === undefined || value === "" ? null : { label, value: formatValue(value), sensitive };
  const section = (title: string, items: (InfoItem | null)[]): InfoSection => ({
    title,
    items: items.filter((entry): entry is InfoItem => entry !== null),
  });

  const productType = formatValue(pick("ProductType"));
  const model = [pick("ModelNumber"), pick("RegionInfo")].filter((part) => part !== undefined).map(formatValue).join("");
  /*
    ECID 优先取 RSD 握手属性：那边是 bigint，准。lockdown 的回包现在由原生解 plist，
    超过 2^53 的整数只能落成 number，精度会掉（见 kit/lockdown.ts 开头）。
  */
  const ecidText = formatEcid(typeof props.UniqueChipID === "bigint" ? props.UniqueChipID : pick("UniqueChipID"));

  const total = asNumber(disk.TotalDiskCapacity) ?? asNumber(disk.TotalDataCapacity);
  const available = asNumber(disk.AmountDataAvailable) ?? asNumber(disk.TotalDataAvailable);

  const sections = [
    section("设备", [
      item("名称", pick("DeviceName")),
      item("机型", marketingName(productType)),
      item("型号标识", pick("ProductType")),
      item("型号", model || undefined),
      item("主板", pick("HardwareModel")),
      item("CPU 架构", pick("CPUArchitecture")),
      item("设备类别", pick("DeviceClass")),
    ]),
    section("系统", [
      item("版本", pick("ProductVersion", "OSVersion", "HumanReadableProductVersionString")),
      item("构建号", pick("BuildVersion")),
      item("补充构建号", pick("SupplementalBuildVersion")),
    ]),
    section("存储", [
      item("总容量", total !== null ? formatBytes(total) : undefined),
      item("可用", available !== null ? formatBytes(available) : undefined),
      item(
        "已用",
        total !== null && available !== null ? `${formatBytes(total - available)}（${Math.round(((total - available) / total) * 100)}%）` : undefined,
      ),
    ]),
    section("标识", [
      item("序列号", pick("SerialNumber"), true),
      item("UDID", pick("UniqueDeviceID"), true),
      item("ECID", ecidText, true),
      item("IMEI", pick("InternationalMobileEquipmentIdentity"), true),
      item("IMEI 2", pick("InternationalMobileEquipmentIdentity2"), true),
      item("电话号码", pick("PhoneNumber"), true),
      item("Wi-Fi 地址", pick("WiFiAddress"), true),
      item("蓝牙地址", pick("BluetoothAddress"), true),
    ]),
  ].filter((entry) => entry.items.length > 0);

  const raw: [string, string][] = [
    ...Object.entries(props).map(([key, value]): [string, string] => [`RSD · ${key}`, formatValue(value)]),
    ...Object.entries(lockdown).map(([key, value]): [string, string] => [`lockdown · ${key}`, formatValue(value)]),
    ...Object.entries(disk).map(([key, value]): [string, string] => [`disk_usage · ${key}`, formatValue(value)]),
  ].sort((a, b) => a[0].localeCompare(b[0]));

  return { sections, raw, warnings };
}

// ── 电池 ──────────────────────────────────────────────────────────────────

export interface ChargerInfo {
  /** 充电器标称功率。 */
  watts: number | null;
  name: string | null;
  isWireless: boolean | null;
}

export interface BatteryReport {
  /** 健康度：优先用满充 ÷ 设计算；算不出来时退用系统给的百分比。 */
  healthPercent: number | null;
  healthSource: "computed" | "system" | null;
  /** 系统自己算的最大容量百分比（有的机型才给）。 */
  systemHealthPercent: number | null;
  cycleCount: number | null;
  designCapacity: number | null;
  /** 当前满充容量（mAh），算健康度用的那个。 */
  fullChargeCapacity: number | null;
  /** 满充容量取自哪个字段，界面上注明出处。 */
  fullChargeSource: string | null;
  /** 两个常见的满充字段分别是多少（有的才给），两个都有时都列出来。 */
  nominalChargeCapacity: number | null;
  rawMaxCapacity: number | null;
  /** 当前剩余（mAh）。 */
  remainingCapacity: number | null;
  chargePercent: number | null;
  temperatureC: number | null;
  voltageV: number | null;
  /** 正数是充进电池，负数是放电。 */
  amperageMA: number | null;
  /** 电池端功率 = 电压 × 电流，正负同电流。 */
  powerW: number | null;
  isCharging: boolean | null;
  externalConnected: boolean | null;
  fullyCharged: boolean | null;
  serial: string | null;
  charger: ChargerInfo | null;
  /** 健康度算不出来时，把所有像是容量的字段摊出来，方便照着补解析。 */
  capacityFields: [string, string][];
  raw: [string, string][];
}

/** 嵌套字典摊成「a.b.c → 值」的行。深度到头的整块用 formatValue 显示。 */
export function flatten(prefix: string, value: PlistValue, out: [string, string][], depth = 0): void {
  if (isPlistDict(value) && depth < 3) {
    for (const [key, item] of Object.entries(value)) flatten(prefix ? `${prefix}.${key}` : key, item, out, depth + 1);
  } else {
    out.push([prefix, formatValue(value)]);
  }
}

/** 摊平并按键名排好，给 RawListPage 用。 */
export function flattenSorted(value: PlistValue): [string, string][] {
  const rows: [string, string][] = [];
  flatten("", value, rows);
  rows.sort((a, b) => a[0].localeCompare(b[0]));
  return rows;
}

async function ioRegistry(client: PlistClient, query: PlistDict): Promise<PlistDict | null> {
  const response = await client.request({ Request: "IORegistry", ...query });
  if (response.Status !== "Success") return null;
  const diagnostics = response.Diagnostics;
  const registry = isPlistDict(diagnostics) ? diagnostics.IORegistry : undefined;
  return isPlistDict(registry) && Object.keys(registry).length > 0 ? registry : null;
}

/**
 * pymobiledevice3 / idevice 的用法都是按类名查 IOPMPowerSource；查不到再按节点名退一步
 * （两个名字指的是同一棵树）。
 *
 * **这里有意不 try/catch**：原生 plist 层解不动这棵树的回包时会直接抛（真机实测），
 * 而那个异常正是 `session.withService` 换裸帧重来的信号——在这儿吞掉，退路就永远走不到了。
 * 查不到返回 null 和查出错抛异常是两件事，别混。
 */
async function queryBatteryRegistry(client: PlistClient): Promise<PlistDict | null> {
  const byClass = await ioRegistry(client, { EntryClass: "IOPMPowerSource" });
  if (byClass) return byClass;
  return ioRegistry(client, { EntryName: "AppleSmartBattery" });
}

/** 按键名优先级、在顶层和 BatteryData 里依次找，取第一个合格的数字。 */
function firstNumber(sources: PlistDict[], keys: string[], accept: (value: number) => boolean = () => true): number | null {
  for (const key of keys) {
    for (const source of sources) {
      const parsed = asNumber(source[key]);
      if (parsed !== null && accept(parsed)) return parsed;
    }
  }
  return null;
}

const CAPACITY_HINT = /capacity|fcc|qmax|health|nominal|soc/i;

export function parseBattery(registry: PlistDict): BatteryReport {
  const data = isPlistDict(registry.BatteryData) ? registry.BatteryData : {};
  const sources = [registry, data];

  const design = firstNumber(sources, ["DesignCapacity"]);
  /*
    MaxCapacity 在新系统上是百分比（固定 100），在老系统上是 mAh。
    不能直接拿它当满充容量，否则新机型的健康度会算成 100 ÷ 设计容量 ≈ 3%。
    所以当 mAh 用的字段一律要求 > 100。
  */
  const isMah = (value: number) => value > 100;
  /*
    满充容量优先用 NominalChargeCapacity（标称满充），其次才是 AppleRawMaxCapacity（原始值）。

    原始值是电量计直接测的，新电池常常比设计容量还高一截，拿它算健康度会出现
    102% 这种数（真机实测：设计 4768，原始 4884）。标称值是系统平滑过的，
    第三方电池工具一般拿它和设计容量比，更接近系统设置里看到的「最大容量」。
  */
  const nominal = firstNumber(sources, ["NominalChargeCapacity"], isMah);
  const rawMax = firstNumber(sources, ["AppleRawMaxCapacity"], isMah);
  let fullCharge: number | null = null;
  let fullChargeSource: string | null = null;
  for (const key of ["NominalChargeCapacity", "AppleRawMaxCapacity", "FullChargeCapacity", "MaxCapacity"]) {
    const value = firstNumber(sources, [key], isMah);
    if (value !== null) {
      fullCharge = value;
      fullChargeSource = key;
      break;
    }
  }
  const remaining = firstNumber(sources, ["AppleRawCurrentCapacity", "RemainingCapacity", "CurrentCapacity"], isMah);

  const maxCapacityRaw = asNumber(registry.MaxCapacity);
  const currentRaw = asNumber(registry.CurrentCapacity);
  const chargePercent =
    maxCapacityRaw !== null && maxCapacityRaw <= 100 && currentRaw !== null
      ? currentRaw
      : remaining !== null && fullCharge
        ? Math.round((remaining / fullCharge) * 100)
        : null;

  const systemHealth = firstNumber(sources, ["MaximumCapacityPercent"]);
  const computedHealth = fullCharge !== null && design ? Math.round((fullCharge / design) * 1000) / 10 : null;

  /*
    新系统顶层可能没有 Temperature，退到 VirtualTemperature / BatteryData 里找。
    也可能哪儿都没有：真机（2026-10-17）上按类名、按节点名 AppleSmartBattery、GasGauge 三路都查过，
    只剩 DeadBatteryBootData 里两个恒为 0 的开机记录，不是当前温度。这时温度为 null，界面写「设备未提供」。
  */
  const temperature = firstNumber(sources, ["Temperature", "VirtualTemperature"]);
  const voltage = firstNumber(sources, ["Voltage", "AppleRawBatteryVoltage"]);
  const amperage = asSigned64(registry.InstantAmperage ?? registry.Amperage);

  const adapter = isPlistDict(registry.AdapterDetails) ? registry.AdapterDetails : null;
  const charger: ChargerInfo | null = adapter
    ? {
        watts: asNumber(adapter.Watts),
        name:
          (typeof adapter.Name === "string" && adapter.Name) ||
          (typeof adapter.Description === "string" && adapter.Description) ||
          null,
        isWireless: asBoolean(adapter.IsWireless),
      }
    : null;

  const raw: [string, string][] = [];
  flatten("", registry, raw);
  raw.sort((a, b) => a[0].localeCompare(b[0]));

  return {
    healthPercent: computedHealth ?? systemHealth,
    healthSource: computedHealth !== null ? "computed" : systemHealth !== null ? "system" : null,
    systemHealthPercent: systemHealth,
    cycleCount: firstNumber(sources, ["CycleCount"]),
    designCapacity: design,
    fullChargeCapacity: fullCharge,
    fullChargeSource,
    nominalChargeCapacity: nominal,
    rawMaxCapacity: rawMax,
    remainingCapacity: remaining,
    chargePercent,
    temperatureC: temperature !== null ? temperature / 100 : null,
    voltageV: voltage !== null ? voltage / 1000 : null,
    amperageMA: amperage,
    // mV × mA = μW，换成 W 保留一位小数
    powerW: voltage !== null && amperage !== null ? Math.round((voltage * amperage) / 1e5) / 10 : null,
    isCharging: asBoolean(registry.IsCharging),
    externalConnected: asBoolean(registry.ExternalConnected),
    fullyCharged: asBoolean(registry.FullyCharged),
    serial: typeof registry.Serial === "string" ? registry.Serial : null,
    charger,
    capacityFields: computedHealth === null ? raw.filter(([key]) => CAPACITY_HINT.test(key)) : [],
    raw,
  };
}

/**
 * 温度相关的键名。「Temp」要区分大小写、后面不能再跟小写字母：
 * 不然 SystemPowerIn 里的「temP」也会被当成温度字段（真机日志里抓到过）。
 */
const TEMPERATURE_HINT = /[Tt]emperature|[Tt]hermal|Temp(?![a-z])/;

/**
 * 排查用：一行算出来的关键值，一行所有温度相关的原始字段。
 * 温度取值顺序是 Temperature → VirtualTemperature（各自先顶层、后 BatteryData），再 ÷100。
 * 只记数值，不记序列号。
 */
function logBattery(tag: string, report: BatteryReport): void {
  const show = (value: number | boolean | null) => (value === null ? "?" : String(value));
  debugLog(
    "battery",
    `${tag}：电量 ${show(report.chargePercent)}% · 电压 ${show(report.voltageV)} V · 电流 ${show(report.amperageMA)} mA · ` +
      `功率 ${show(report.powerW)} W · 温度 ${show(report.temperatureC)}°C · 充电中 ${show(report.isCharging)} · 接电 ${show(report.externalConnected)}`,
  );
  const fields = report.raw.filter(([key]) => TEMPERATURE_HINT.test(key)).map(([key, value]) => `${key}=${value}`);
  debugLog("battery", `温度相关原始字段：${fields.join("，") || "（没有）"}`);
}

export async function readBattery(session: DeviceSession): Promise<BatteryReport> {
  const registry = await session.withService(DIAGNOSTICS_SERVICE, async (client) => {
    const found = await queryBatteryRegistry(client);
    await client.send({ Request: "Goodbye" }).catch((error) => debugLog("battery", "Goodbye 没发出去", describeError(error)));
    return found;
  });
  if (!registry) {
    throw new Error("两条查法都没取回电池数据：按类名 IOPMPowerSource、按节点名 AppleSmartBattery 都试过了。");
  }
  const report = parseBattery(registry);
  logBattery("读取", report);
  return report;
}

/**
 * 实时刷新：占着一条诊断连接反复查，省掉每次重新连接、签到的开销。
 *
 * `shouldStop()` 返回 true 就收工。单次查询失败直接抛出去，由调用方决定要不要重来
 * （多半是隧道断了，重来时 hub 会重建会话）。
 */
export async function monitorBattery(
  session: DeviceSession,
  onReport: (report: BatteryReport) => void,
  shouldStop: () => boolean,
  intervalMs = 2000,
): Promise<void> {
  await session.withService(DIAGNOSTICS_SERVICE, async (client) => {
    while (!shouldStop()) {
      const registry = await queryBatteryRegistry(client);
      if (!registry) throw new Error("设备没有返回电池数据");
      const report = parseBattery(registry);
      logBattery("实时", report);
      onReport(report);
      // 分小段睡，点停止时不用干等满一个间隔
      for (let waited = 0; waited < intervalMs && !shouldStop(); waited += 250) {
        await new Promise<void>((resolve) => setTimeout(resolve, 250));
      }
    }
    await client.send({ Request: "Goodbye" }).catch(() => undefined);
  });
}

/** 本机 UDID，全小写（描述文件里的设备列表也转成小写再比）。读不到返回 null。 */
export async function readDeviceUdid(session: DeviceSession): Promise<string | null> {
  const value = await session.withService(LOCKDOWN_SERVICE, async (client) => {
    const response = await client.request({ Label: "", Request: "GetValue", Key: "UniqueDeviceID" });
    return response.Value;
  });
  return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : null;
}

/**
 * 设备属性：lockdown 的 `GetValue`，不带 Key 就一把全给。
 *
 * **这是 MobileGestalt 停用之后的替代。** iOS 27 起 diagnostics_relay 上的
 * MobileGestalt 查询恒返回 `MobileGestaltDeprecated`，而这条路照常能用，
 * 内容也覆盖得上：ProductType、ProductVersion、BuildVersion、BasebandVersion、
 * HardwareModel、CPUArchitecture、WiFiAddress 都在里面。
 */
export async function readDeviceValues(session: DeviceSession): Promise<PlistDict> {
  return session.withService(LOCKDOWN_SERVICE, (client) => getValue(client));
}

// ── 电源 ──────────────────────────────────────────────────────────────────

export type PowerAction = "Restart" | "Shutdown" | "Sleep";

/** 设备先回 Success 再执行。重启、关机之后隧道就没了，由调用方断开会话。 */
export async function powerAction(session: DeviceSession, action: PowerAction): Promise<void> {
  const response = await session.withService(DIAGNOSTICS_SERVICE, (client) => client.request({ Request: action }));
  if (response.Status !== "Success") throw new Error(`设备没有执行（Status ${formatValue(response.Status)}）`);
}

// ── 主屏布局 ──────────────────────────────────────────────────────────────

export type HomeItemKind = "app" | "folder" | "widget" | "webclip" | "other";

export interface HomeItem {
  kind: HomeItemKind;
  name: string;
  /** App 的 bundle ID；取图标用。 */
  bundleId?: string;
  /** 文件夹的各页内容。 */
  pages?: HomeItem[][];
}

export interface HomeLayout {
  dock: HomeItem[];
  pages: HomeItem[][];
  /** 设备原样返回的布局，备份就存它。 */
  raw: PlistValue;
}

function classify(value: PlistValue): HomeItem | null {
  if (!isPlistDict(value)) return null;
  const name = typeof value.displayName === "string" ? value.displayName : "";
  if (value.listType === "folder") {
    const lists = Array.isArray(value.iconLists) ? value.iconLists : [];
    return {
      kind: "folder",
      name: name || "文件夹",
      pages: lists.map((page) => (Array.isArray(page) ? page.map(classify).filter((item): item is HomeItem => item !== null) : [])),
    };
  }
  const bundleId =
    (typeof value.bundleIdentifier === "string" && value.bundleIdentifier) ||
    (typeof value.displayIdentifier === "string" && value.displayIdentifier) ||
    "";
  if (typeof value.webClipIdentifier === "string" || value.iconType === "webClip") {
    return { kind: "webclip", name: name || "网页快捷方式" };
  }
  // 小组件：format 2 里带 gridSize / elementType，或者 iconType 为 custom
  if (value.iconType === "custom" || value.gridSize !== undefined || value.elementType !== undefined) {
    return { kind: "widget", name: name || "小组件", bundleId: bundleId || undefined };
  }
  if (bundleId) return { kind: "app", name: name || bundleId, bundleId };
  return { kind: "other", name: name || "未知项目" };
}

/**
 * 解析原始布局。每一项都保留（认不出的记作 other），**下标和原始数组一一对应**——
 * 编辑时按下标去挪原始数组里的元素，对不上就会挪错东西。
 */
export function parseHomeLayout(raw: PlistValue): HomeLayout {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error("设备返回的布局格式不认识");
  const toItems = (page: PlistValue): HomeItem[] =>
    Array.isArray(page) ? page.map((value) => classify(value) ?? { kind: "other", name: "未知项目" }) : [];
  // 第一项是 Dock，其后每项一页
  return { dock: toItems(raw[0]), pages: raw.slice(1).map(toItems), raw };
}

export async function readHomeLayout(session: DeviceSession): Promise<HomeLayout> {
  const raw = await session.withService(SPRINGBOARD_SERVICE, (client) =>
    // formatVersion 2 才带小组件；老系统不认的话设备会忽略它。
    client.requestValue({ command: "getIconState", formatVersion: "2" }, 30000),
  );
  if (isPlistDict(raw) && (raw.error !== undefined || raw.Error !== undefined)) {
    throw new Error(`设备拒绝了布局请求：${formatValue(raw.error ?? raw.Error)}`);
  }
  return parseHomeLayout(raw);
}

/**
 * 把整份布局写回设备（setIconState）。
 *
 * 设备**不回包**——idevice 的 set_icon_state 也是只发不读。所以成没成只能靠
 * 调用方事后重读布局来核对。写完稍等一下再关连接，别让 FIN 赶在设备处理之前。
 * formatVersion 必须和读的时候一致（2），否则小组件可能被丢掉。
 */
export async function writeHomeLayout(session: DeviceSession, raw: PlistValue): Promise<void> {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error("布局格式不对，拒绝写入");
  // 单独摆放的小组件补上实例 ID，不然写回后它的设置会被重置（见 withWidgetIdentifiers）
  const { layout, patched } = withWidgetIdentifiers(raw);
  if (patched > 0) debugLog("layout", `写回前给 ${patched} 个单独摆放的小组件补了 uniqueIdentifier`);
  await session.withService(SPRINGBOARD_SERVICE, async (client) => {
    await client.send({ command: "setIconState", iconState: layout, formatVersion: "2" });
    await new Promise<void>((resolve) => setTimeout(resolve, 800));
  });
}

/** 把布局里所有 App 的 bundle ID 摊平（含文件夹内的），去重。 */
export function collectBundleIds(layout: HomeLayout): string[] {
  const ids = new Set<string>();
  const walk = (items: HomeItem[]) => {
    for (const item of items) {
      if (item.kind === "app" && item.bundleId) ids.add(item.bundleId);
      item.pages?.forEach(walk);
    }
  };
  walk(layout.dock);
  layout.pages.forEach(walk);
  return [...ids];
}

/** 攒够这么多张就先交出去显示一批。太小会让界面一直重画，太大又回到「全载完才显示」。 */
const ICON_BATCH = 8;

/**
 * 逐个取 App 图标。同一条连接顺序请求——一条连接同时只能挂一个读。
 * 单个失败不影响其余（系统 App、已卸载占位都可能取不到）。
 *
 * `onBatch` 每攒够一批就回调一次，调用方可以边取边显示：三百多个 App 全取完要
 * 十几秒，等到最后一张才铺上去，前面那十几秒列表就是一片灰方块。
 * 请求顺序就是传进来的顺序，所以调用方按列表显示顺序传，屏幕上那几个先出来。
 */
export async function readIcons(
  session: DeviceSession,
  bundleIds: string[],
  onProgress?: (done: number, total: number) => void,
  onBatch?: (batch: Map<string, Uint8Array>) => void,
): Promise<Map<string, Uint8Array>> {
  const icons = new Map<string, Uint8Array>();
  let pending = new Map<string, Uint8Array>();
  let index = 0;

  const flush = () => {
    if (pending.size === 0) return;
    onBatch?.(pending);
    pending = new Map();
  };
  /*
    一条连接同时只能挂一个读。某次请求超时的话，那个读还挂在连接上，后面的请求
    全会失败——所以超时就换一条新连接接着取，而不是在同一条上硬撑。
  */
  while (index < bundleIds.length) {
    await session.withService(SPRINGBOARD_SERVICE, async (client) => {
      while (index < bundleIds.length) {
        const bundleId = bundleIds[index++];
        let timedOut = false;
        try {
          const response = await client.request({ command: "getIconPNGData", bundleId }, 10000);
          if (response.pngData instanceof Uint8Array && response.pngData.length > 0) {
            icons.set(bundleId, response.pngData);
            pending.set(bundleId, response.pngData);
          }
        } catch (error) {
          // 系统 App、已卸载的占位都可能取不到，单个失败不影响其余
          debugLog("springboard", `${bundleId} 图标取不到`, describeError(error));
          timedOut = error instanceof Error && error.message.includes("超时");
        }
        onProgress?.(index, bundleIds.length);
        if (pending.size >= ICON_BATCH) flush();
        // 换连接之前先把手上这批交出去，别让它压在超时后面
        if (timedOut) return flush();
      }
    });
  }
  flush();
  return icons;
}

export async function readWallpapers(session: DeviceSession): Promise<{ home: Uint8Array | null; lock: Uint8Array | null }> {
  return session.withService(SPRINGBOARD_SERVICE, async (client) => {
    const fetchOne = async (wallpaperName: string): Promise<Uint8Array | null> => {
      try {
        const response = await client.request({ command: "getWallpaperPreviewImage", wallpaperName }, 30000);
        return response.pngData instanceof Uint8Array && response.pngData.length > 0 ? response.pngData : null;
      } catch (error) {
        debugLog("springboard", `${wallpaperName} 壁纸取不到`, describeError(error));
        return null;
      }
    };
    return { home: await fetchOne("homescreen"), lock: await fetchOne("lockscreen") };
  });
}
