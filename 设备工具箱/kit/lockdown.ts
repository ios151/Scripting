// lockdown 一族服务的通用客户端：隧道内连上服务端口 → RSDCheckin → 收发 plist。
//
// 帧和签到都交给 `DeviceServices`（Scripting 2026-10 更新带来的原生设备服务层）：
// `adopt` 接管隧道连接，之后「4 字节大端长度 + plist」的收发、以及 RSDCheckin、
// StartService 两段握手全在原生侧做，这里只剩值进值出。原先自己拼帧的那套
// （ChunkReader、按 16384 切块写）连同它的注释一起去掉了。
//
// 换过来之后有两处语义变了，调用方要知道：
//  - `<date>` 原生解成 Date 对象。老路子上 XML 的日期是 ISO 字符串、二进制 plist 的
//    日期是 PReal（毫秒数），写回时都会退化成别的类型；现在原样是日期，写回也还是
//    `<date>`，主屏布局的 iconModDate 因此反而更准（见 kit/layoutCheck.ts 开头第 1 条）。
//  - 超过 2^53 的整数：旧版原生只能给 number，精度会掉（老路子读成十进制字符串保住了）；
//    新版类型定义写明这种整数给 bigint。`receive` 统一转成十进制字符串（见 `fromNative`），
//    和裸帧那条路一致，上层的 asNumber / asSigned64 / ECID 解析本来就认字符串。
//    ECID 仍优先从 RSD 握手属性取（那边是 bigint），不依赖这里。
//
// 适用于 RSD 服务表里名字带 `.shim.remote` 的那些，以及
// `com.apple.mobile.lockdown.remote.trusted`。

import { PReal, PUid, type PlistValue } from "../core/bplist";
import { concat } from "../core/bytes";
import { debugLog, describeError } from "../core/debug";
import { BufferedReader, StreamClosedError, withTimeout, writeAll, type ByteStream } from "../core/stream";
import { decodePlist, encodeXmlPlist, isPlistDict, type PlistDict } from "./plist";

/**
 * 原生层单条消息的上限。`maximumFrameBytes` 只认 1 KiB–8 MiB，取顶格：
 * 壁纸预览图和 misagent 的全量描述文件都是 MB 级的。
 * 超过它的回包原生层会拒收（`ERR_DEVICE_PROTOCOL`），只能走裸帧后端。
 */
const MAX_FRAME = 8 * 1024 * 1024;

/**
 * 裸帧后端的单条消息上限。这条路是自己攒包，不受原生那层 8 MiB 的限制。
 * 2026-10-31 一位装了上千个 App 的用户：misagent 的 `CopyAll` 一次回了 17178553 字节
 * （约 16 MiB，上千份描述文件），按 8 MiB 卡会直接报「回包长度异常」。
 * 这里只防长度字段读歪了，给个宽裕的上限。
 */
const RAW_MAX_FRAME = 64 * 1024 * 1024;

/**
 * 裸帧后端读大包时一段读多少。`BufferedReader.readExact` 每收到一块（隧道每次最多 16 KB）
 * 就把已经攒的整份重新拷一遍，16 MB 的帧要拷近 9 GB；一段一段读进预先分配好的缓冲，
 * 每段内部的重拷只有几块，总共几百 MB 以内。电脑上实测 17 MB 的帧：整帧 `readExact` 3 秒，分段读 51 毫秒。
 */
const RAW_READ_SLICE = 128 * 1024;

/** 超过这个毫秒数的回包在日志里记一笔。收包和解析现在是一次原生调用，分不开计。 */
const SLOW_REPLY = 200;

/**
 * 我们的 PlistValue → `DeviceServices` 认的那套。
 *
 * 规则照搬原来的 encodeXmlPlist：null 和 UID 在 XML plist 里写不出去，直接报错；
 * PReal 退成普通数字。结构没变的子树原样返回，避免把整份主屏布局拷一遍。
 */
function toNative(value: PlistValue): DeviceServices.PlistValue {
  if (value === null) throw new Error("plist 不能表示 null");
  if (value instanceof PUid) throw new Error("XML plist 不支持 UID");
  if (value instanceof PReal) return value.value;
  if (Array.isArray(value)) {
    let changed = false;
    const items = value.map((item) => {
      const next = toNative(item);
      if (next !== (item as unknown)) changed = true;
      return next;
    });
    return changed ? items : (value as unknown as DeviceServices.PlistValue);
  }
  if (isPlistDict(value)) {
    let changed = false;
    const out: { [key: string]: DeviceServices.PlistValue } = {};
    for (const [key, item] of Object.entries(value)) {
      const next = toNative(item);
      if (next !== (item as unknown)) changed = true;
      out[key] = next;
    }
    return changed ? out : (value as unknown as DeviceServices.PlistValue);
  }
  return value;
}

/**
 * `DeviceServices` 的回包 → 我们的 PlistValue。
 *
 * 新版类型定义写明：超出安全整数范围的 `<integer>` 读成 bigint。我们的 PlistValue 里没有 bigint，
 * 这里统一转成十进制字符串——和裸帧那条路（kit/plist.ts 的 XML 解码）一致，两个后端给上层的是同一种东西。
 * 上层本来就认：asNumber 认数字字符串，asSigned64 要的正是无符号补码的十进制字符串
 * （电流 -350 mA 在 IORegistry 里是 18446744073709551266，经 number 就丢精度、变成 0）。
 * 其余类型原样；没有 bigint 的子树原样返回，不把整份主屏布局拷一遍。
 */
export function fromNative(value: DeviceServices.PlistValue): PlistValue {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) {
    let changed = false;
    const items = value.map((item) => {
      const next = fromNative(item);
      if (next !== (item as unknown)) changed = true;
      return next;
    });
    return changed ? items : (value as unknown as PlistValue);
  }
  if (typeof value === "object" && !(value instanceof Date) && !(value instanceof Uint8Array)) {
    let changed = false;
    const out: { [key: string]: PlistValue } = {};
    for (const [key, item] of Object.entries(value)) {
      const next = fromNative(item);
      if (next !== (item as unknown)) changed = true;
      out[key] = next;
    }
    return changed ? out : (value as unknown as PlistValue);
  }
  return value;
}

/**
 * 原生那层的报错只有一句英文（「Invalid device service argument.」之类），
 * 光看它分不出是接管、签到还是收发出的问题。补上步骤名再往上抛。
 */
function nativeError(what: string, serviceName: string, error: unknown): Error {
  return new Error(`${serviceName} ${what}：${describeError(error)}`);
}

/** 设备在回包里报的错。message 已经拼好了人能看的部分。 */
export class LockdownServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * 服务连接上的 plist 一问一答。
 *
 * 两个后端：`PlistServiceClient` 走原生 `DeviceServices`，`RawPlistClient` 自己拼帧。
 * 原生那层快且稳，但**解析器挑食**——真机上 `IOPMPowerSource` 那棵树的回包它就当场拒收
 * （见 `isNativeParseFailure`）。所以 `session.withService` 默认用原生，翻车了换裸帧重来。
 */
export interface PlistClient {
  readonly serviceName: string;
  /** 这条连接上已经发出去几条。`withService` 靠它判断失败后重来安不安全。 */
  readonly sentMessages: number;
  send(message: PlistValue): Promise<void>;
  receive(): Promise<PlistValue>;
  receiveDict(): Promise<PlistDict>;
  request(message: PlistDict, timeoutMs?: number): Promise<PlistDict>;
  requestValue(message: PlistDict, timeoutMs?: number): Promise<PlistValue>;
  close(): Promise<void>;
}

/**
 * 原生 plist 层**解不动回包**时报的两种错，碰上就换裸帧重来：
 *
 * ① `Invalid device service argument` / `ERR_INVALID_ARG_VALUE`——2026-10-19 真机：电池那棵树
 * （IOPMPowerSource / AppleSmartBattery）一问就抛，签到成功、5 毫秒就抛，设备根本没来得及传数据。
 *
 * ② `Invalid or truncated device service response` / `ERR_DEVICE_PROTOCOL`——2026-10-31 一位
 * 1240 个 App 的 27.0.1 用户：一次 Lookup 的回包超出原生层的上限（单条最多 16384 个节点、
 * 一帧最大 8 MiB，见 DeviceServices 文档），原生层拒收并关掉连接。
 *
 * 两种换成自己拼帧、自己 `decodePlist` 都正常——公开仓库里迁到原生层之前的版本一直是好的。
 */
export function isNativeParseFailure(error: unknown): boolean {
  return /ERR_INVALID_ARG_VALUE|Invalid device service argument|ERR_DEVICE_PROTOCOL|Invalid or truncated device service response/i.test(
    describeError(error),
  );
}

/** `send` / `receive` 之上的那几个组合，两个后端共用，别各写一遍。 */
abstract class BasePlistClient implements PlistClient {
  protected closed = false;
  protected sent = 0;

  constructor(readonly serviceName: string) {}

  get sentMessages(): number {
    return this.sent;
  }

  abstract send(message: PlistValue): Promise<void>;
  abstract receive(): Promise<PlistValue>;
  abstract close(): Promise<void>;

  /**
   * 收一条字典回包，带 `Error` 的照 idevice 的 `read_plist` 转成异常。
   * `Error` 可能是字符串，也可能是整数配 `ErrorString`。
   */
  async receiveDict(): Promise<PlistDict> {
    const value = await this.receive();
    if (!isPlistDict(value)) throw new Error(`${this.serviceName} 回包不是字典`);
    const error = value.Error;
    if (error !== undefined) {
      const code = String(error);
      const detail =
        (typeof value.ErrorString === "string" && value.ErrorString) ||
        (typeof value.ErrorDescription === "string" && value.ErrorDescription) ||
        "";
      throw new LockdownServiceError(code, detail ? `${code}（${detail}）` : code);
    }
    return value;
  }

  /** 一问一答。 */
  async request(message: PlistDict, timeoutMs = 20000): Promise<PlistDict> {
    return withTimeout(
      (async () => {
        await this.send(message);
        return this.receiveDict();
      })(),
      timeoutMs,
      `${this.serviceName} 响应超时`,
    );
  }

  /** 一问一答，但回包可能不是字典（比如主屏布局是数组）。 */
  async requestValue(message: PlistDict, timeoutMs = 20000): Promise<PlistValue> {
    return withTimeout(
      (async () => {
        await this.send(message);
        return this.receive();
      })(),
      timeoutMs,
      `${this.serviceName} 响应超时`,
    );
  }
}

/**
 * 自己拼帧的后端：4 字节大端长度 + XML plist，照 idevice 的 `send_plist` / `read_plist_value`。
 *
 * 只在原生那层解不动时才用（`withService` 自动切）。连接要**先签到过**——拿到的是
 * `rsdCheckinRaw` 之后的字节流。
 */
export class RawPlistClient extends BasePlistClient {
  private readonly reader: BufferedReader;

  constructor(
    private readonly stream: ByteStream,
    serviceName: string,
  ) {
    super(serviceName);
    // reader 跟着连接走：每次新建会把上一条回包读剩的字节丢掉，下一条就从半截帧开始解。
    this.reader = new BufferedReader(stream);
  }

  async send(message: PlistValue): Promise<void> {
    if (this.closed) throw new Error("服务连接已关闭");
    const body = encodeXmlPlist(message);
    const header = new Uint8Array(4);
    new DataView(header.buffer).setUint32(0, body.length, false);
    await writeAll(this.stream, concat(header, body));
    this.sent++;
  }

  async receive(): Promise<PlistValue> {
    if (this.closed) throw new Error("服务连接已关闭");
    const started = Date.now();
    const lengthBytes = await this.reader.readExact(4);
    const length = new DataView(lengthBytes.buffer as ArrayBuffer, lengthBytes.byteOffset, 4).getUint32(0, false);
    if (length <= 0 || length > RAW_MAX_FRAME) throw new Error(`${this.serviceName} 回包长度异常 ${length}`);
    const value = decodePlist(await this.readBody(length));
    const elapsed = Date.now() - started;
    if (elapsed >= SLOW_REPLY) debugLog("shim", `${this.serviceName} 回包 ${length} 字节，用了 ${elapsed} ms（裸帧）`);
    return value;
  }

  /** 读 `length` 字节的帧体。大包一段一段读进预先分配好的缓冲，别让 `readExact` 一次攒几十 MB（见 `RAW_READ_SLICE`）。 */
  private async readBody(length: number): Promise<Uint8Array> {
    if (length <= RAW_READ_SLICE) return this.reader.readExact(length);
    const body = new Uint8Array(length);
    for (let offset = 0; offset < length; offset += RAW_READ_SLICE) {
      body.set(await this.reader.readExact(Math.min(RAW_READ_SLICE, length - offset)), offset);
    }
    return body;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.stream.close().catch(() => undefined);
  }
}

export class PlistServiceClient extends BasePlistClient {
  private constructor(
    private readonly connection: DeviceServices.Connection,
    serviceName: string,
  ) {
    super(serviceName);
  }

  /** 连上服务端口并完成 RSDCheckin。失败时连接已经关掉。 */
  static async open(tunnel: VPNRSDTunnel, serviceName: string, port: number): Promise<PlistServiceClient> {
    debugLog("shim", `${serviceName} 连接端口 ${port}…`);
    const connecting = tunnel.connect({ port });
    let raw: VPNRSDConnection;
    try {
      raw = await withTimeout(connecting, 10000, `${serviceName} 连接超时`);
    } catch (error) {
      // 超时之后才连上的要收掉，不留半开的连接
      void connecting.then((late) => late.close()).catch(() => undefined);
      throw error;
    }

    // adopt 之后这条隧道连接归原生侧独占，不能再自己读写；关也只关 plist 这一头。
    let adopted: DeviceServices.Connection;
    try {
      adopted = DeviceServices.adopt(raw, { maximumFrameBytes: MAX_FRAME });
    } catch (first) {
      /*
        帧上限被拒就退回原生默认的 1 MiB。大回包（misagent 的全量描述文件能到 2 MB）
        会因此失败，但总比整条路走不通强，而且日志里留了痕，一看就知道是上限的事。
      */
      debugLog("shim", `${serviceName} 按 ${MAX_FRAME} 字节接管被拒，改用默认帧上限：${describeError(first)}`);
      try {
        adopted = DeviceServices.adopt(raw);
      } catch (second) {
        await raw.close().catch(() => undefined);
        throw nativeError("接管连接失败", serviceName, second);
      }
    }
    const client = new PlistServiceClient(adopted, serviceName);

    try {
      /*
        原生的 checkin 自己发 RSDCheckin，再把 RSDCheckin 和 StartService 两条回包读掉。
        不传 label：老路子照 idevice 的 `Idevice::new(stream, "")` 留空字符串，
        但空串在原生那边未必算合法参数，交给它自己的默认值。
      */
      await withTimeout(client.connection.checkin(), 10000, `${serviceName} 签到超时`);
      debugLog("shim", `${serviceName} 签到完成`);
      return client;
    } catch (error) {
      await client.close();
      const detail = describeError(error);
      throw detail.includes("签到") ? new Error(detail) : nativeError("签到失败", serviceName, error);
    }
  }

  async send(message: PlistValue): Promise<void> {
    if (this.closed) throw new Error("服务连接已关闭");
    // 照 idevice 发 XML：设备两种都认，但只有 XML 是验过的那条路。
    const body = toNative(message);
    try {
      await this.connection.writePlist(body, { format: "xml" });
    } catch (error) {
      throw nativeError("发送失败", this.serviceName, error);
    }
    this.sent++;
  }

  async receive(): Promise<PlistValue> {
    if (this.closed) throw new Error("服务连接已关闭");
    const started = Date.now();
    let value: DeviceServices.PlistValue | null;
    try {
      value = await this.connection.readPlist();
    } catch (error) {
      throw nativeError("接收失败", this.serviceName, error);
    }
    // readPlist 只在下一条消息的帧头之前遇到 EOF 时返回 null
    if (value === null) throw new StreamClosedError();
    const elapsed = Date.now() - started;
    // 壁纸、misagent 这类大包记一下耗时：卡在这里的话日志上看得见。
    if (elapsed >= SLOW_REPLY) debugLog("shim", `${this.serviceName} 回包用了 ${elapsed} ms`);
    return fromNative(value);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.connection.close().catch(() => undefined);
  }
}
