// 设备会话：本机隧道 → 配对握手 → pair-verify → RSD 隧道 → 服务表。
//
// 几条用真机换来的规矩，改这个文件前先过一遍：
//   - 配对服务的落点照 Bonjour 公告走，地址和端口一样要紧（蜂窝下尤其）
//   - 隧道监听是一次性的，拿到端口后绝不先做 TCP 探测，探一下端口就废了
//   - `localDevVPN.getState()` 会抛，读不到的地方一律走不中断的版本
//   - 配对连接要留到会话结束，设备的隧道监听挂在它上面
//
// 一个会话持有**整个 App 唯一的那条隧道**（文档：最多一个隧道、四个 TCP 连接）。
// RSD 取完服务表就关，剩下的名额留给各个服务，由这里的信号量分配。

import { debugLog, describeError } from "../core/debug";
import { discoverPairingService } from "../core/bonjour";
import type { PairingRecord } from "../core/pairing";
import { PairVerifyRejected, RemotePairingClient, RpPairingSocket } from "../core/rppairing";
import { delay, withTimeout, type ByteStream } from "../core/stream";
import { connectTCP, probeTCP } from "../core/tcp";
import { PlistServiceClient } from "./lockdown";
import { rsdHandshake } from "./rsd";
import type { ConnectionSettings } from "./settings";

export type StatusReporter = (message: string) => void;

const PORT_RANGE_START = 49152;
const PORT_RANGE_END = 51200;
const PORT_SCAN_BATCH = 64;
const PORT_SCAN_TIMEOUT = 200;
const TARGET_CACHE_KEY = "devicekit_pairing_target_v1";
/** 隧道 4 个连接，RSD 用完即关，再给配对之外的意外留一个余量。 */
const MAX_SERVICE_CONNECTIONS = 3;
const TUNNEL_OPEN_TIMEOUT_MS = 15_000;

// ── 本机隧道 ──────────────────────────────────────────────────────────────

/** 读自身隧道状态，撞上并发变更（「Read again before saving」）就再读一次。 */
async function readLocalDevState(): Promise<VPNLocalDevState> {
  try {
    return await VPN.localDevVPN.getState();
  } catch (error) {
    debugLog("vpn", "读自身隧道状态撞上并发变更，重读一次", describeError(error));
    await delay(600);
    return VPN.localDevVPN.getState();
  }
}

/** 只作记录用：读不到返回 null，绝不中断流程。 */
async function tryReadLocalDevState(): Promise<VPNLocalDevState | null> {
  try {
    return await readLocalDevState();
  } catch (error) {
    debugLog("vpn", "读自身隧道状态失败（不中断）", describeError(error));
    return null;
  }
}

/** VPN 启动要几秒才落定，期间再调会报「already in progress」，并发调用并到同一次上。 */
let builtInStarting: Promise<void> | null = null;

async function startBuiltInTunnel(log: StatusReporter): Promise<void> {
  let state = await readLocalDevState();
  if (state.effectiveStatus === "active") return;
  if (state.effectiveStatus === "unavailable") {
    throw new Error("本机隧道不可用。请确认 Scripting 已获得 VPN 权限，且系统里没有别的 VPN 正在连接。");
  }
  if (!state.enabled) {
    log("启用本机隧道…");
    state = await VPN.localDevVPN.setEnabled(true, { expectedState: state.expectedState });
  }
  if (state.vpnStatus !== "connected") {
    log("启动 VPN（首次会弹系统授权）…");
    try {
      await VPN.start();
    } catch (error) {
      throw new Error(
        `启动 VPN 失败：${error instanceof Error ? error.message : String(error)}\n` +
          "iOS 同时只允许一条 VPN 生效。在用代理工具的话，去「连接设置」把隧道来源切到「代理工具提供」。",
      );
    }
  }
  for (let attempt = 0; attempt < 20; attempt++) {
    await delay(500);
    const polled = await tryReadLocalDevState();
    if (!polled) continue;
    if (polled.effectiveStatus === "active") return;
    if (polled.problem) log(`隧道：${polled.problem}`);
  }
  throw new Error("本机隧道迟迟没有生效。请先断开其他 VPN / 代理，再试一次。");
}

async function ensureTunnelReady(settings: ConnectionSettings, log: StatusReporter): Promise<void> {
  if (settings.source === "proxyApp") {
    /*
      代理模式：回环由代理工具提供，**不碰 Scripting 自己的 VPN**——启用它会把
      代理顶掉。只打开 LocalDevVPN 这个功能开关（openRSDTunnel 的前提之一）。
      状态读不到就不碰开关：setEnabled 要 expectedState 做并发校验。
    */
    const state = await tryReadLocalDevState();
    if (state && !state.enabled) {
      try {
        await VPN.localDevVPN.setEnabled(true, { expectedState: state.expectedState });
      } catch (error) {
        debugLog("vpn", "代理模式下打开 LocalDevVPN 失败，仍继续", describeError(error));
      }
    }
    return;
  }
  if (!builtInStarting) {
    builtInStarting = startBuiltInTunnel(log).finally(() => {
      builtInStarting = null;
    });
  }
  return builtInStarting;
}

// ── 找配对服务 ────────────────────────────────────────────────────────────

interface Target {
  host: string;
  port: number;
}

function pushTarget(list: Target[], target: Target): void {
  if (!list.some((item) => item.host === target.host && item.port === target.port)) list.push(target);
}

function isLoopback(host: string): boolean {
  return host === "::1" || host.startsWith("127.");
}

async function scanPorts(host: string): Promise<number[]> {
  const open: number[] = [];
  for (let base = PORT_RANGE_START; base <= PORT_RANGE_END; base += PORT_SCAN_BATCH) {
    const batch: Promise<number | null>[] = [];
    for (let port = base; port < base + PORT_SCAN_BATCH && port <= PORT_RANGE_END; port++) {
      batch.push(probeTCP(host, port, PORT_SCAN_TIMEOUT).then((ok) => (ok ? port : null)));
    }
    for (const port of await Promise.all(batch)) if (port !== null) open.push(port);
  }
  debugLog("scan", `${host} 开放端口：${open.join(", ") || "无"}`);
  return open;
}

interface PairingConnection {
  stream: ByteStream;
  client: RemotePairingClient;
  /** 实际握上手的地址。隧道必须连回这里，不能再用设置里的对端。 */
  host: string;
}

async function tryTargets(targets: Target[], log: StatusReporter): Promise<{ hit: PairingConnection | null; lastError: unknown }> {
  let lastError: unknown = null;
  for (const target of targets) {
    let stream: ByteStream | null = null;
    try {
      stream = await connectTCP(target.host, target.port, 4000);
      const client = new RemotePairingClient(new RpPairingSocket(stream));
      await withTimeout(client.attemptPairVerify(), 6000, `${target.host}:${target.port} 握手超时`);
      log(`配对服务：${target.port}`);
      Storage.set(TARGET_CACHE_KEY, target);
      return { hit: { stream, client, host: target.host }, lastError: null };
    } catch (error) {
      lastError = error;
      debugLog("pair", `${target.host}:${target.port} 不是配对服务`, describeError(error));
      await stream?.close().catch(() => undefined);
    }
  }
  return { hit: null, lastError };
}

function describeFailure(settings: ConnectionSettings, error: unknown): string {
  const code = (error as { code?: string } | null)?.code ?? "";
  const message = error instanceof Error ? error.message : String(error);
  if (code === "ECONNREFUSED") {
    return (
      `${settings.host} 拒绝了连接——流量到了本机，但没有找到配对服务。\n\n` +
      "用蜂窝数据时多半是这个原因：控制中心开一次飞行模式，等几秒再关掉，回来重试。\n" +
      "用 WiFi 还这样的话：确认开发者模式开着、隧道已连接。"
    );
  }
  if (code === "ENETUNREACH" || code === "EHOSTUNREACH") {
    return `连不到 ${settings.host}，这条路由不存在。飞行模式开着吗？关掉之后再试。`;
  }
  if (message.includes("握手超时")) {
    return "扫到了开放端口，但没有一个是配对服务。用蜂窝数据的话，开关一次飞行模式再试。";
  }
  return `没能连上配对服务：${message}`;
}

async function openPairing(settings: ConnectionSettings, record: PairingRecord, log: StatusReporter): Promise<PairingConnection> {
  log("查找配对服务…");
  const first: Target[] = [];
  const cached = Storage.get<Target>(TARGET_CACHE_KEY);
  if (cached && typeof cached.host === "string" && Number(cached.port) > 0) {
    pushTarget(first, { host: cached.host, port: Number(cached.port) });
  }
  let announced: string[] = [];
  if (record.altIrk.length === 16) {
    try {
      const advert = await discoverPairingService(record.altIrk);
      if (advert) {
        announced = advert.addresses;
        debugLog("scan", `Bonjour 公告端口 ${advert.port}，地址 ${announced.join(", ") || "未提供"}`);
        // 隧道对端排第一：WiFi 下它一直是对的。
        pushTarget(first, { host: settings.host, port: advert.port });
        for (const host of announced) pushTarget(first, { host, port: advert.port });
      }
    } catch (error) {
      debugLog("scan", "Bonjour 发现失败，退回端口扫描", describeError(error));
    }
  }

  const firstTry = await tryTargets(first, log);
  if (firstTry.hit) return firstTry.hit;

  /*
    公告地址全是回环 = 可以确诊：配对服务这会儿没绑任何网络接口（蜂窝下就是这样），
    而设备不接受从回环直连。扫多少端口都没用，直接给结论。
  */
  if (announced.length > 0 && announced.every(isLoopback)) {
    throw new Error(
      "配对服务这会儿只绑在回环地址上，没绑任何网络接口。\n\n" +
        "用蜂窝数据时就是这样：控制中心开一次飞行模式，等几秒再关掉，回来重试。实在不行改连 WiFi。",
    );
  }

  Storage.remove(TARGET_CACHE_KEY);
  log("公告的端口连不上，扫一遍…");
  const ports = await scanPorts(settings.host);
  const second = await tryTargets(
    ports.map((port) => ({ host: settings.host, port })),
    log,
  );
  if (second.hit) return second.hit;
  throw new Error(describeFailure(settings, second.lastError ?? firstTry.lastError));
}

/**
 * 隧道被收掉了（不是程序出错）。
 *
 * 锁屏、熄屏、切网络时系统会把隧道关掉，挂在上面的长连接会以
 * `RSD_NETWORK_FAILURE` / `networkErrorCode=53`（连接被中止）报错。
 * 对实时监听那几页来说这是常事，不该当成红色报错吓人。
 */
export function isTunnelDropped(error: unknown): boolean {
  return /RSD_NETWORK_FAILURE|networkErrorCode=5[34]|transport-read|连接已关闭|已关闭的流/i.test(describeError(error));
}

// ── 会话 ──────────────────────────────────────────────────────────────────

/** 日志里用的短名：com.apple.mobile.installation_proxy.shim.remote → mobile.installation_proxy */
function shortServiceName(name: string): string {
  return name.replace(/^com\.apple\./, "").replace(/\.shim\.remote$/, "");
}

export class DeviceSession {
  private activeServices = 0;
  private readonly waiting: (() => void)[] = [];
  private statePending: Promise<boolean> | null = null;
  private closed = false;

  private constructor(
    private readonly tunnel: VPNRSDTunnel,
    private readonly pairing: PairingConnection,
    /** 服务名 → 端口。 */
    readonly services: Map<string, number>,
    /** RSD 握手里设备自报的属性：型号、系统、序列号等。 */
    readonly properties: Record<string, unknown>,
  ) {}

  /**
   * 建立会话。任一步失败都会把已经建立的连接收干净再抛错，不留半开的隧道。
   */
  static async open(record: PairingRecord, settings: ConnectionSettings, log: StatusReporter = () => {}): Promise<DeviceSession> {
    await ensureTunnelReady(settings, log);
    const pairing = await openPairing(settings, record, log);

    let port: number;
    let preSharedKey: Uint8Array;
    try {
      log("校验配对记录…");
      await withTimeout(pairing.client.validatePairing(record), 20000, "pair-verify 超时");
      log("申请隧道端口…");
      port = await withTimeout(pairing.client.createTcpListener({ peerConnectionsInfo: false }), 15000, "申请隧道端口超时");
      preSharedKey = pairing.client.preSharedKey;
      debugLog("pair", `隧道端口 ${port}，PSK ${preSharedKey.length} 字节`);
    } catch (error) {
      await pairing.client.close().catch(() => undefined);
      if (error instanceof PairVerifyRejected) {
        throw new Error("设备不认这份配对记录。系统更新后需要重新配对：去「配对」里重新配一次。");
      }
      throw error;
    }

    log("建立加密隧道…");
    let tunnel: VPNRSDTunnel;
    try {
      tunnel = await VPN.localDevVPN.openRSDTunnel({
        host: pairing.host,
        port,
        preSharedKey,
        timeout: TUNNEL_OPEN_TIMEOUT_MS,
      });
    } catch (error) {
      // 那次「正在打开」可能还挂在原生侧，主动收掉，免得下次重试撞上它。
      await VPN.localDevVPN.cancelRSDTunnelOpening().catch(() => undefined);
      await pairing.client.close().catch(() => undefined);
      throw new Error(`建立加密隧道失败：${error instanceof Error ? error.message : String(error)}`);
    }

    try {
      const state = await tunnel.getState();
      log("查询设备服务…");
      const rsd = await tunnel.connect({ port: state.rsdPort });
      try {
        const handshake = await withTimeout(
          rsdHandshake({
            read: (max: number) => rsd.read(max),
            write: (data: Uint8Array) => rsd.write(data),
            close: () => rsd.close(),
          }),
          20000,
          "查询服务列表超时",
        );
        debugLog("rsd", `服务表 ${handshake.services.size} 项`);
        return new DeviceSession(tunnel, pairing, handshake.services, handshake.properties);
      } finally {
        await rsd.close().catch(() => undefined);
      }
    } catch (error) {
      await tunnel.close().catch(() => undefined);
      await pairing.client.close().catch(() => undefined);
      throw error;
    }
  }

  private async acquireSlot(): Promise<void> {
    if (this.activeServices < MAX_SERVICE_CONNECTIONS) {
      this.activeServices++;
      return;
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
  }

  private releaseSlot(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.activeServices--;
  }

  hasService(name: string): boolean {
    return this.services.has(name);
  }

  /**
   * 借一条服务连接用完即还。连接按名额排队，签到（RSDCheckin）在这里做掉。
   */
  async withService<T>(name: string, use: (client: PlistServiceClient) => Promise<T>): Promise<T> {
    if (this.closed) throw new Error("会话已结束，请重新连接");
    const port = this.services.get(name);
    if (!port) throw new Error(`设备没有提供 ${name}。确认开发者模式开着。`);
    const label = shortServiceName(name);
    const queued = Date.now();
    if (this.activeServices >= MAX_SERVICE_CONNECTIONS) {
      debugLog("session", `${label} 等空闲连接（占用 ${this.activeServices}/${MAX_SERVICE_CONNECTIONS}，前面排着 ${this.waiting.length} 个）`);
    }
    await this.acquireSlot();
    const started = Date.now();
    if (started - queued > 100) debugLog("session", `${label} 排队 ${started - queued} ms 后拿到连接`);
    let client: PlistServiceClient | null = null;
    try {
      client = await PlistServiceClient.open(this.tunnel, name, port);
      debugLog("session", `${label} 连接 + 签到 ${Date.now() - started} ms`);
      return await use(client);
    } finally {
      await client?.close();
      this.releaseSlot();
      debugLog("session", `${label} 用完归还，共 ${Date.now() - started} ms`);
    }
  }

  /**
   * 借一条**裸**连接。DVT（dtservicehub）走的是 DTX 二进制协议，不是
   * 「RSDCheckin + plist」那一套，所以不能用 withService，得直接拿字节流。
   * 名额和超时的规矩与 withService 一致。
   */
  async withRawService<T>(name: string, use: (stream: ByteStream) => Promise<T>): Promise<T> {
    if (this.closed) throw new Error("会话已结束，请重新连接");
    const port = this.services.get(name);
    if (!port) throw new Error(`设备没有提供 ${name}。确认开发者模式开着、开发者磁盘镜像已挂载。`);
    const label = shortServiceName(name);
    await this.acquireSlot();
    const started = Date.now();
    let connection: VPNRSDConnection | null = null;
    try {
      connection = await withTimeout(this.tunnel.connect({ port }), 10000, `${label} 连接超时`);
      debugLog("session", `${label} 裸连接 ${Date.now() - started} ms`);
      const stream: ByteStream = {
        read: (max: number) => connection!.read(max),
        write: (data: Uint8Array) => connection!.write(data),
        close: () => connection!.close(),
      };
      return await use(stream);
    } finally {
      await connection?.close().catch(() => undefined);
      this.releaseSlot();
      debugLog("session", `${label} 用完归还，共 ${Date.now() - started} ms`);
    }
  }

  /** 隧道还通不通。锁屏、断网之后它会被系统收掉。同类查询只挂一个。 */
  isAlive(): Promise<boolean> {
    if (this.closed) return Promise.resolve(false);
    if (!this.statePending) {
      this.statePending = this.tunnel
        .getState()
        .then((state) => state.state === "open")
        .catch(() => false)
        .finally(() => {
          this.statePending = null;
        });
    }
    return this.statePending;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.tunnel.close().catch(() => undefined);
    // client.close() 先把共享密钥和流密钥清零，再关底下的配对连接。
    await this.pairing.client.close().catch(() => undefined);
  }
}
