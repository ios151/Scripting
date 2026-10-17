// 实时性能数据：CPU、内存。走 DVT（Instruments 的那条通道）。
//
// 链路：RSD 服务表里的 com.apple.instruments.dtservicehub → 裸 DTX 连接 →
//       在 0 号频道上申请服务频道 → 调方法。协议层在 core/dtx.ts。
//
// 要先挂上开发者磁盘镜像，否则服务表里根本没有 dtservicehub——「底层查询」页能看到状态。
//
// 属性名不写死：先问设备 sysmonProcessAttributes / sysmonSystemAttributes 支持哪些，
// 再从里面挑要的。不同系统版本支持的字段不一样，问出来比猜稳。

import { archivedArg, DtxConnection } from "../core/dtx";
import { archive } from "../core/keyed_archive";
import { debugLog, describeError } from "../core/debug";
import type { PlistValue } from "../core/bplist";
import { isPlistDict } from "./plist";
import { asNumber } from "./services";
import type { DeviceSession } from "./session";

export const DVT_SERVICE = "com.apple.instruments.dtservicehub";
const DEVICE_INFO_CHANNEL = "com.apple.instruments.server.services.deviceinfo";
const SYSMONTAP_CHANNEL = "com.apple.instruments.server.services.sysmontap";

/** 想要的进程字段，按偏好排；设备不支持的会被过滤掉。 */
const WANTED_PROC_ATTRS = ["pid", "cpuUsage", "physFootprint", "memResidentSize", "memVirtualSize"];
/** 想要的系统字段。 */
const WANTED_SYS_ATTRS = ["physMemSize", "vmFreeCount", "vmUsedCount", "vmExtPageCount", "vmPurgeableCount"];

export interface ProcessSample {
  pid: number;
  name: string;
  /** CPU 占用百分比。单核满载是 100，多核可能超过 100。 */
  cpuPercent: number | null;
  /** 物理内存足迹，字节。 */
  memoryBytes: number | null;
}

export interface SystemSample {
  at: number;
  /** 全机 CPU 占用百分比（用户 + 系统）。 */
  cpuPercent: number | null;
  /**
   * 系统内存各项，按字段名存原始值。
   *
   * **单位不统一**：`physMemSize` 是字节，`vm*Count` 是页数。
   * 要给人看就用 `memoryBreakdown` 换算，别直接当字节用。
   */
  memory: Map<string, number>;
  processes: ProcessSample[];
}

/** iOS 的页大小。arm64 现在是 16K，老设备 4K——采样里只有页数，得反推是哪个。 */
const PAGE_SIZES = [16384, 4096];

export interface MemoryBreakdown {
  /** 物理内存总量，字节。 */
  total: number;
  /** 已用，字节。 */
  used: number;
  /** 空闲，字节。 */
  free: number;
  /** 可清除（系统吃紧时能直接回收的缓存），字节。取不到时为 null。 */
  purgeable: number | null;
  /** 算这一份时用的页大小，界面上注明，免得数字对不上时查不出原因。 */
  pageSize: number;
}

/**
 * 页数换成字节。
 *
 * 采样里给的是页数，而页大小没一起给。拿「空闲 + 已用应该铺满物理内存」当标尺，
 * 两个候选里挑误差小的那个；误差超过三成就认输，返回 null（宁可不显示，也不显示错的）。
 */
export function inferPageSize(physMemSize: number, countedPages: number): number | null {
  if (!(physMemSize > 0) || !(countedPages > 0)) return null;
  let best: { size: number; error: number } | null = null;
  for (const size of PAGE_SIZES) {
    const error = Math.abs(countedPages * size - physMemSize) / physMemSize;
    if (!best || error < best.error) best = { size, error };
  }
  return best && best.error <= 0.3 ? best.size : null;
}

/** 把一次采样里的内存字段整理成能直接显示的字节数。算不出来返回 null。 */
export function memoryBreakdown(sample: SystemSample): MemoryBreakdown | null {
  const total = sample.memory.get("physMemSize") ?? null;
  const free = sample.memory.get("vmFreeCount") ?? null;
  const used = sample.memory.get("vmUsedCount") ?? null;
  if (total === null || free === null || used === null) return null;
  const pageSize = inferPageSize(total, free + used);
  if (pageSize === null) return null;
  const purgeable = sample.memory.get("vmPurgeableCount");
  return {
    total,
    used: used * pageSize,
    free: free * pageSize,
    purgeable: purgeable === undefined ? null : purgeable * pageSize,
    pageSize,
  };
}

/** 一条 DTX 消息里可能混着好几种行，按 key 认。 */
function pickRows(payload: unknown): Record<string, PlistValue>[] {
  const rows: Record<string, PlistValue>[] = [];
  const visit = (value: unknown) => {
    if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object") rows.push(value as Record<string, PlistValue>);
  };
  visit(payload);
  return rows;
}

/** SystemCPUUsage 里是 0..1 的比例，乘 100 变成百分比。 */
function cpuOf(row: Record<string, PlistValue> | undefined): number | null {
  if (!row) return null;
  const total = asNumber(row.CPU_TotalLoad);
  if (total !== null) return Math.round(total * 10) / 10;
  const user = asNumber(row.CPU_UserLoad);
  const system = asNumber(row.CPU_SystemLoad);
  if (user === null && system === null) return null;
  return Math.round(((user ?? 0) + (system ?? 0)) * 10) / 10;
}

/**
 * 把一次采样解析成好用的形状。
 * 回包形状按系统版本有差别，所以每一项都「有就取、没有就留 null」，不假设字段一定在。
 */
export function parseSample(
  payload: unknown,
  procAttrs: string[],
  sysAttrs: string[],
  names: Map<number, string>,
  at: number,
): SystemSample | null {
  const rows = pickRows(payload);
  const processRow = rows.find((row) => row.Processes !== undefined);
  const cpuRow = rows.find((row) => row.SystemCPUUsage !== undefined);
  const systemRow = rows.find((row) => row.System !== undefined);
  if (!processRow && !cpuRow && !systemRow) return null;

  const processes: ProcessSample[] = [];
  const table = processRow && isPlistDict(processRow.Processes) ? processRow.Processes : null;
  if (table) {
    const pidIndex = procAttrs.indexOf("pid");
    const cpuIndex = procAttrs.indexOf("cpuUsage");
    const memIndex = procAttrs.indexOf("physFootprint") >= 0 ? procAttrs.indexOf("physFootprint") : procAttrs.indexOf("memResidentSize");
    for (const [key, value] of Object.entries(table)) {
      // 每个进程是一个数组，顺序就是 procAttrs 的顺序
      if (!Array.isArray(value)) continue;
      const pid = pidIndex >= 0 ? (asNumber(value[pidIndex]) ?? Number(key)) : Number(key);
      if (!Number.isFinite(pid)) continue;
      processes.push({
        pid,
        name: names.get(pid) ?? `pid ${pid}`,
        cpuPercent: cpuIndex >= 0 ? (() => { const v = asNumber(value[cpuIndex]); return v === null ? null : Math.round(v * 10) / 10; })() : null,
        memoryBytes: memIndex >= 0 ? asNumber(value[memIndex]) : null,
      });
    }
  }

  const memory = new Map<string, number>();
  const systemValues = systemRow?.System;
  if (Array.isArray(systemValues)) {
    // System 是按 sysAttrs 顺序排的数组，名字得靠协商时拿到的那份对上
    systemValues.forEach((value, index) => {
      const name = sysAttrs[index];
      const amount = asNumber(value);
      if (name && amount !== null) memory.set(name, amount);
    });
  }

  return {
    at,
    cpuPercent: cpuOf(cpuRow && isPlistDict(cpuRow.SystemCPUUsage) ? cpuRow.SystemCPUUsage : undefined),
    memory,
    processes: processes.sort((a, b) => (b.cpuPercent ?? -1) - (a.cpuPercent ?? -1)),
  };
}

/** 问设备支持哪些字段，再和想要的取交集。问不到就用想要的那一份。 */
async function negotiateAttrs(dtx: DtxConnection, channel: number, selector: string, wanted: string[]): Promise<string[]> {
  try {
    const id = await dtx.callMethod(channel, selector, [], true);
    const reply = await dtx.waitForReply(id);
    const supported = Array.isArray(reply.payload) ? reply.payload.filter((item): item is string => typeof item === "string") : [];
    if (supported.length === 0) return wanted;
    const picked = wanted.filter((name) => supported.includes(name));
    debugLog("dvt", `${selector}：设备支持 ${supported.length} 个，用上 ${picked.length} 个`);
    return picked.length > 0 ? picked : wanted;
  } catch (error) {
    debugLog("dvt", `${selector} 问不到，用默认字段`, describeError(error));
    return wanted;
  }
}

/** pid → 进程名。从 deviceinfo 的 runningProcesses 拿，用来把采样里的 pid 变成人能看的名字。 */
async function processNames(dtx: DtxConnection, channel: number): Promise<Map<number, string>> {
  const names = new Map<number, string>();
  try {
    const id = await dtx.callMethod(channel, "runningProcesses", [], true);
    const reply = await dtx.waitForReply(id);
    if (!Array.isArray(reply.payload)) return names;
    for (const item of reply.payload) {
      if (!item || typeof item !== "object") continue;
      const record = item as Record<string, unknown>;
      const pid = asNumber(record.pid);
      const name = typeof record.name === "string" ? record.name : "";
      if (pid !== null && name) names.set(pid, name);
    }
    debugLog("dvt", `进程名表 ${names.size} 项`);
  } catch (error) {
    debugLog("dvt", "取进程名失败，采样里只显示 pid", describeError(error));
  }
  return names;
}

export interface SysmonOptions {
  intervalMs?: number;
  /** 收到一次采样调一次。字段名已经对进 sample.memory，调用方不用再管顺序。 */
  onSample: (sample: SystemSample) => void;
  /** 返回 true 就收工。 */
  shouldStop: () => boolean;
}

/**
 * 开一条 DVT 连接，持续采样直到 shouldStop 为 true。
 * 整个过程占一条裸连接，结束时一并收掉。
 */
export async function monitorSystem(session: DeviceSession, options: SysmonOptions): Promise<void> {
  const intervalMs = options.intervalMs ?? 1000;
  await session.withRawService(DVT_SERVICE, async (stream) => {
    const dtx = new DtxConnection(stream);
    const infoChannel = await dtx.makeChannel(DEVICE_INFO_CHANNEL);
    const procAttrs = await negotiateAttrs(dtx, infoChannel, "sysmonProcessAttributes", WANTED_PROC_ATTRS);
    const sysAttrs = await negotiateAttrs(dtx, infoChannel, "sysmonSystemAttributes", WANTED_SYS_ATTRS);
    const names = await processNames(dtx, infoChannel);

    const channel = await dtx.makeChannel(SYSMONTAP_CHANNEL);
    const config: PlistValue = {
      ur: intervalMs,
      bm: 0,
      procAttrs,
      sysAttrs,
      cpuUsage: true,
      physFootprint: true,
      sampleInterval: intervalMs * 1_000_000,
    };
    await dtx.callMethod(channel, "setConfig:", [archivedArg(archive(config))], false);
    await dtx.callMethod(channel, "start", [], false);
    debugLog("dvt", `sysmontap 已开始，间隔 ${intervalMs} ms`);

    try {
      while (!options.shouldStop()) {
        const message = await dtx.readMessage();
        if (message.payload === undefined) continue;
        const sample = parseSample(message.payload, procAttrs, sysAttrs, names, Date.now());
        if (sample) options.onSample(sample);
      }
    } finally {
      // 不停的话设备会一直往回推，白耗电
      await dtx.callMethod(channel, "stop", [], false).catch(() => undefined);
      debugLog("dvt", "sysmontap 已停止");
    }
  });
}
