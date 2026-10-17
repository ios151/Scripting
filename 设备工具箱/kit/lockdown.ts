// lockdown 一族服务的通用客户端：隧道内连上服务端口 → RSDCheckin → 收发 plist。
//
// 帧格式照 idevice 的 `send_plist` / `read_plist_value`：4 字节大端长度 + XML plist。
// RSDCheckin 照 idevice 的 `rsd_checkin`：发一条 Request=RSDCheckin，设备先回
// RSDCheckin、再回 StartService，两条都要读掉，之后才是服务本身的会话。
//
// 适用于 RSD 服务表里名字带 `.shim.remote` 的那些，以及
// `com.apple.mobile.lockdown.remote.trusted`。

import { type PlistValue } from "../core/bplist";
import { debugLog } from "../core/debug";
import { MAX_CHUNK, StreamClosedError, withTimeout } from "../core/stream";
import { decodePlist, encodeXmlPlist, isPlistDict, type PlistDict } from "./plist";

/** 单条消息的上限。壁纸预览图能到几 MB，留足余量；再大就是帧错位了。 */
const MAX_MESSAGE = 32 * 1024 * 1024;
/** 超过这个大小的回包在日志里记耗时。 */
const LARGE_MESSAGE = 1024 * 1024;

/**
 * 按块攒字节的读取器。
 *
 * core/stream 的 BufferedReader 每来一块就整段重拼，读几 MB 的图片会拷贝上百 MB；
 * 这里把块留在数组里，凑够了只拼一次。
 */
class ChunkReader {
  private chunks: Uint8Array[] = [];
  private length = 0;

  constructor(private readonly connection: VPNRSDConnection) {}

  async readExact(count: number): Promise<Uint8Array> {
    while (this.length < count) {
      const chunk = await this.connection.read(MAX_CHUNK);
      if (!chunk || chunk.length === 0) throw new StreamClosedError();
      this.chunks.push(chunk);
      this.length += chunk.length;
    }
    const out = new Uint8Array(count);
    let filled = 0;
    while (filled < count) {
      const head = this.chunks[0];
      const take = Math.min(head.length, count - filled);
      out.set(head.subarray(0, take), filled);
      filled += take;
      if (take === head.length) this.chunks.shift();
      else this.chunks[0] = head.subarray(take);
    }
    this.length -= count;
    return out;
  }
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

export class PlistServiceClient {
  private readonly reader: ChunkReader;
  private closed = false;

  private constructor(
    private readonly connection: VPNRSDConnection,
    readonly serviceName: string,
  ) {
    this.reader = new ChunkReader(connection);
  }

  /** 连上服务端口并完成 RSDCheckin。失败时连接已经关掉。 */
  static async open(tunnel: VPNRSDTunnel, serviceName: string, port: number): Promise<PlistServiceClient> {
    debugLog("shim", `${serviceName} 连接端口 ${port}…`);
    const connecting = tunnel.connect({ port });
    let connection: VPNRSDConnection;
    try {
      connection = await withTimeout(connecting, 10000, `${serviceName} 连接超时`);
    } catch (error) {
      // 超时之后才连上的要收掉，不留半开的连接
      void connecting.then((late) => late.close()).catch(() => undefined);
      throw error;
    }
    const client = new PlistServiceClient(connection, serviceName);
    try {
      await withTimeout(client.checkin(), 10000, `${serviceName} 签到超时`);
      return client;
    } catch (error) {
      await client.close();
      throw error;
    }
  }

  private async checkin(): Promise<void> {
    // Label 照 idevice 的 RSD 服务构造（`Idevice::new(stream, "")`）留空。
    await this.send({ Label: "", ProtocolVersion: "2", Request: "RSDCheckin" });
    const first = await this.receiveDict();
    if (first.Request !== "RSDCheckin") throw new Error(`${this.serviceName} 签到回包不对：${String(first.Request)}`);
    const second = await this.receiveDict();
    if (second.Request !== "StartService") throw new Error(`${this.serviceName} 没有进入服务：${String(second.Request)}`);
    debugLog("shim", `${this.serviceName} 签到完成`);
  }

  async send(message: PlistValue): Promise<void> {
    if (this.closed) throw new Error("服务连接已关闭");
    const body = encodeXmlPlist(message);
    const frame = new Uint8Array(4 + body.length);
    new DataView(frame.buffer).setUint32(0, body.length, false);
    frame.set(body, 4);
    // 隧道连接每次最多写 16384 字节，而且同时只能挂一个写——按块顺序写。
    for (let offset = 0; offset < frame.length; offset += MAX_CHUNK) {
      await this.connection.write(frame.subarray(offset, Math.min(offset + MAX_CHUNK, frame.length)));
    }
  }

  async receive(): Promise<PlistValue> {
    const header = await this.reader.readExact(4);
    const length = new DataView(header.buffer, header.byteOffset, 4).getUint32(0, false);
    if (length === 0 || length > MAX_MESSAGE) throw new Error(`${this.serviceName} 回包长度异常：${length}`);
    const started = Date.now();
    const body = await this.reader.readExact(length);
    const received = Date.now();
    const value = decodePlist(body);
    // 壁纸这类大包记一下耗时：卡在收包还是解析，看日志就知道。
    if (length >= LARGE_MESSAGE) {
      debugLog("shim", `${this.serviceName} 大包 ${length} 字节：收 ${received - started} ms，解析 ${Date.now() - received} ms`);
    }
    return value;
  }

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

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.connection.close().catch(() => undefined);
  }
}
