// 极简 HTTP/2 客户端，仅够跑 RemoteXPC。
//
// 设备的 RSD 服务在隧道内用 HTTP/2 承载 XPC：HEADERS 只用来开流（空帧、
// 带 END_HEADERS），负载全在 DATA 帧里，不需要 HPACK。
// 本实现只发 SETTINGS / WINDOW_UPDATE / HEADERS / DATA，收到的 SETTINGS 不回 ACK
// ——设备不以此为前提，idevice 同样忽略。

import { utf8 } from "./bytes";
import { BufferedReader, writeAll, type ByteStream } from "./stream";

const PREFACE = utf8("PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n");
const FRAME_HEADER_LEN = 9;
const MAX_FRAME_SIZE = 16384;

const FrameType = {
  Data: 0x00,
  Headers: 0x01,
  RstStream: 0x03,
  Settings: 0x04,
  GoAway: 0x07,
  WindowUpdate: 0x08,
} as const;

export const Setting = {
  MaxConcurrentStreams: 0x03,
  InitialWindowSize: 0x04,
} as const;

function u24(value: number): number[] {
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

function u32(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

function frame(type: number, flags: number, streamId: number, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(FRAME_HEADER_LEN + body.length);
  out.set([...u24(body.length), type, flags, ...u32(streamId)]);
  out.set(body, FRAME_HEADER_LEN);
  return out;
}

export class Http2Client {
  private readonly reader: BufferedReader;
  private readonly pending = new Map<number, Uint8Array[]>();

  private constructor(private readonly stream: ByteStream) {
    this.reader = new BufferedReader(stream);
  }

  static async create(stream: ByteStream): Promise<Http2Client> {
    const client = new Http2Client(stream);
    await writeAll(stream, PREFACE);
    return client;
  }

  async sendSettings(settings: [number, number][]): Promise<void> {
    const body = new Uint8Array(settings.length * 6);
    settings.forEach(([id, value], index) => {
      body.set([(id >> 8) & 0xff, id & 0xff, ...u32(value)], index * 6);
    });
    await writeAll(this.stream, frame(FrameType.Settings, 0, 0, body));
  }

  async sendWindowUpdate(increment: number, streamId: number): Promise<void> {
    await writeAll(this.stream, frame(FrameType.WindowUpdate, 0, streamId, new Uint8Array(u32(increment))));
  }

  /** 开流：空 HEADERS + END_HEADERS。 */
  async openStream(streamId: number): Promise<void> {
    this.pending.set(streamId, this.pending.get(streamId) ?? []);
    await writeAll(this.stream, frame(FrameType.Headers, 0x04, streamId, new Uint8Array(0)));
  }

  async sendData(payload: Uint8Array, streamId: number): Promise<void> {
    if (payload.length === 0) {
      await writeAll(this.stream, frame(FrameType.Data, 0, streamId, payload));
      return;
    }
    for (let offset = 0; offset < payload.length; offset += MAX_FRAME_SIZE) {
      const chunk = payload.subarray(offset, Math.min(offset + MAX_FRAME_SIZE, payload.length));
      await writeAll(this.stream, frame(FrameType.Data, 0, streamId, chunk));
    }
  }

  /** 收下一帧并归档；只关心 DATA，其余帧按需处理或忽略。 */
  private async pump(): Promise<void> {
    const header = await this.reader.readExact(FRAME_HEADER_LEN);
    const length = (header[0] << 16) | (header[1] << 8) | header[2];
    const type = header[3];
    const streamId = ((header[5] << 24) | (header[6] << 16) | (header[7] << 8) | header[8]) & 0x7fffffff;
    if (length > 1048576) throw new Error("HTTP/2 帧过大");
    const body = length > 0 ? await this.reader.readExact(length) : new Uint8Array(0);

    if (type === FrameType.Data) {
      const list = this.pending.get(streamId);
      if (!list) return;
      if (list.reduce((size, value) => size + value.length, 0) + body.length > 4 * 1024 * 1024) throw new Error("HTTP/2 缓冲过大");
      list.push(body);
      this.pending.set(streamId, list);
      return;
    }

    if (type === FrameType.GoAway) {
      const reason = body.length > 8 ? new TextDecoder().decode(body.subarray(8)) : "";
      throw new Error(`设备关闭了 HTTP/2 连接${reason ? `：${reason}` : ""}`);
    }

    if (type === FrameType.RstStream) {
      throw new Error(`设备重置了流 ${streamId}`);
    }
  }

  /** 取指定流上的下一块 DATA 负载。 */
  async readData(streamId: number): Promise<Uint8Array> {
    for (;;) {
      const list = this.pending.get(streamId);
      if (list && list.length > 0) return list.shift()!;
      await this.pump();
    }
  }
}
