// DTX（Developer Tools eXchange）二进制协议。
//
// 一条消息 = 32 字节消息头 + 16 字节负载头 + 辅助参数区 + 负载。
// 负载（方法名）与 0x02 类型的参数都是 NSKeyedArchiver 归档后的 plist，
// 直接发裸字符串设备不认。
//
// 消息头里 header_len 恒为 32，真正的正文长度在偏移 12——这两个字段容易写反。

import { concat, f64le, readI32LE, readU16LE, readU32LE, u32le, i32le, utf8 } from "./bytes";
import { archiveString, describeArchivedError, unarchive } from "./keyed_archive";
import { BufferedReader, withTimeout, writeAll, type ByteStream } from "./stream";

const MESSAGE_MAGIC = 0x1f3d5b79;
const MESSAGE_HEADER_LEN = 32;
const PAYLOAD_HEADER_LEN = 16;
/** 单条消息的上限。字节全部来自设备，没有上限的话一个畸形长度就能把内存吃光。 */
const MAX_MESSAGE_SIZE = 4 * 1024 * 1024;
/** 负载头 msg_type：2 = 方法调用。 */
const MSG_TYPE_METHOD_INVOCATION = 2;
/** 辅助参数区头部的 buffer_size 提示值，与 idevice 保持一致。 */
const AUX_BUFFER_SIZE = 496;

export type DtxArgument =
  | { kind: "u32"; value: number }
  | { kind: "i64"; value: number }
  | { kind: "double"; value: number }
  | { kind: "string"; value: string }
  | { kind: "bytes"; value: Uint8Array };

export function u32Arg(value: number): DtxArgument {
  return { kind: "u32", value };
}

/** 归档后的对象参数——经纬度一类的值走这条路。 */
export function archivedArg(value: Uint8Array): DtxArgument {
  return { kind: "bytes", value };
}

function encodeArgument(argument: DtxArgument): Uint8Array {
  switch (argument.kind) {
    case "u32":
      return concat(u32le(0x03), u32le(argument.value));
    case "i64": {
      const out = new Uint8Array(8);
      new DataView(out.buffer).setBigInt64(0, BigInt(Math.trunc(argument.value)), true);
      return concat(u32le(0x06), out);
    }
    case "double":
      return concat(u32le(0x09), f64le(argument.value));
    case "string": {
      const text = utf8(argument.value);
      return concat(u32le(0x01), u32le(text.length), text);
    }
    case "bytes":
      return concat(u32le(0x02), u32le(argument.value.length), argument.value);
  }
}

/** 每个参数前都要先写一个 PNULL(0x0a)。 */
function encodeAux(args: DtxArgument[]): Uint8Array {
  if (args.length === 0) return new Uint8Array(0);
  const values = concat(...args.map((arg) => concat(u32le(0x0a), encodeArgument(arg))));
  return concat(u32le(AUX_BUFFER_SIZE), u32le(0), u32le(values.length), u32le(0), values);
}

export interface DtxMessage {
  identifier: number;
  conversationIndex: number;
  channel: number;
  expectsReply: boolean;
  /** 解档后的负载；无负载时为 undefined。 */
  payload?: unknown;
}

export class DtxConnection {
  private readonly reader: BufferedReader;
  private nextIdentifier = 1;
  private nextChannel = 1;

  constructor(private readonly stream: ByteStream) {
    this.reader = new BufferedReader(stream);
  }

  private buildMessage(
    identifier: number,
    channel: number,
    selector: string | null,
    args: DtxArgument[],
    expectsReply: boolean,
  ): Uint8Array {
    const aux = encodeAux(args);
    const data = selector === null ? new Uint8Array(0) : archiveString(selector);

    const payloadHeader = concat(
      new Uint8Array([MSG_TYPE_METHOD_INVOCATION, 0, 0, 0]),
      u32le(aux.length),
      u32le(aux.length + data.length),
      u32le(0),
    );

    const header = concat(
      u32le(MESSAGE_MAGIC),
      u32le(MESSAGE_HEADER_LEN),
      new Uint8Array([0, 0, 1, 0]), // fragmentId = 0, fragmentCount = 1
      u32le(payloadHeader.length + aux.length + data.length),
      u32le(identifier),
      u32le(0), // conversationIndex
      i32le(channel),
      u32le(expectsReply ? 1 : 0),
    );

    return concat(header, payloadHeader, aux, data);
  }

  /** 发一次方法调用，返回本次消息的 identifier。 */
  async callMethod(
    channel: number,
    selector: string,
    args: DtxArgument[] = [],
    expectsReply = true,
  ): Promise<number> {
    const identifier = this.nextIdentifier++;
    await writeAll(this.stream, this.buildMessage(identifier, channel, selector, args, expectsReply));
    return identifier;
  }

  async readMessage(): Promise<DtxMessage> {
    let body: Uint8Array = new Uint8Array(0);
    let header: Uint8Array;
    let nextFragment = 0;
    let expectedFragments = 0;

    // 分片消息：第 0 片只有头，正文在后续片里，拼到最后一片为止。
    for (;;) {
      header = await this.reader.readExact(MESSAGE_HEADER_LEN);
      const magic = readU32LE(header, 0);
      if (magic !== MESSAGE_MAGIC) {
        throw new Error(`DTX 消息魔数不对：0x${magic.toString(16)}`);
      }

      const fragmentId = readU16LE(header, 8);
      const fragmentCount = readU16LE(header, 10);
      const length = readU32LE(header, 12);
      // 分片序号必须严格递增、片数前后一致，否则就是乱序或伪造的帧。
      if (readU32LE(header, 4) !== MESSAGE_HEADER_LEN || fragmentCount === 0
          || fragmentCount > 4096 || fragmentId !== nextFragment++
          || (expectedFragments !== 0 && fragmentCount !== expectedFragments)
          || length > MAX_MESSAGE_SIZE - body.length) {
        throw new Error("DTX 消息头或长度无效");
      }
      expectedFragments = fragmentCount;

      if (fragmentCount > 1 && fragmentId === 0) continue;

      if (length > 0) body = concat(body, await this.reader.readExact(length));
      if (fragmentId === fragmentCount - 1) break;
    }

    const identifier = readU32LE(header, 16);
    const conversationIndex = readU32LE(header, 20);
    const wireChannel = readI32LE(header, 24);
    const expectsReply = readU32LE(header, 28) === 1;

    let payload: unknown;
    if (body.length < PAYLOAD_HEADER_LEN) throw new Error("DTX 负载头不完整");
    {
      const auxLength = readU32LE(body, 4);
      const totalLength = readU32LE(body, 8);
      const dataStart = PAYLOAD_HEADER_LEN + auxLength;
      if (totalLength < auxLength || PAYLOAD_HEADER_LEN + totalLength !== body.length) {
        throw new Error("DTX 负载长度无效");
      }
      const dataLength = totalLength - auxLength;
      if (dataLength > 0) {
        payload = unarchive(body.subarray(dataStart, dataStart + dataLength));
      }
    }

    return {
      identifier,
      conversationIndex,
      channel: conversationIndex % 2 === 0 ? -wireChannel : wireChannel,
      expectsReply,
      payload,
    };
  }

  /**
   * 读到指定 identifier 的回包为止。
   *
   * 还要求 conversationIndex ≥ 1：回包的该字段是「来包的值 + 1」，而设备主动发起的
   * 广播（如连上就推的 `_notifyOfPublishedCapabilities:`）是 0。两者的 identifier
   * 都可能是 1，只看 identifier 会把广播当成回包。
   */
  async waitForReply(identifier: number, timeoutMs = 15000): Promise<DtxMessage> {
    /*
      「设备回了错误包」和「没读到回复」是两码事，只有后者必须关连接。

      用对象存标志而不是裸 let：裸的会被 TypeScript 的控制流分析窄化成字面量
      false（赋值发生在嵌套的 async 闭包里），catch 里的判断就恒真了。
    */
    const replied = { withDeviceError: false };
    try { return await withTimeout(
      (async () => {
        for (;;) {
          const message = await this.readMessage();
          if (message.identifier !== identifier || message.conversationIndex < 1) continue;

          const error = describeArchivedError(message.payload);
          if (error) {
            replied.withDeviceError = true;
            throw new Error(`设备返回错误：${error}`);
          }
          return message;
        }
      })(),
      timeoutMs,
      "等待设备回应超时",
    ); } catch (error) {
      /*
        读超时或读失败时必须关：读者已经错位，下一次调用会读到这一次的回包。

        但设备**明确回了一个 NSError** 时不能关——那说明链路好好的，只是这次
        调用被拒了（坐标越界之类）。以前一律关掉，后果是：心跳只要撞上一次
        错误包，之后每一拍都必然失败，`KEEPALIVE_MAX_MISSES` 那 4 拍宽限
        形同虚设，会话必被拆掉。idevice 的 remote_server.rs 也只在读失败时关。
      */
      if (!replied.withDeviceError) {
        await this.close().catch(() => undefined);
      }
      throw error;
    }
  }

  /** 在 0 号频道上申请一条服务频道，返回频道号。 */
  async makeChannel(serviceIdentifier: string): Promise<number> {
    const code = this.nextChannel++;
    const identifier = await this.callMethod(
      0,
      "_requestChannelWithCode:identifier:",
      [u32Arg(code), archivedArg(archiveString(serviceIdentifier))],
      true,
    );
    await this.waitForReply(identifier);
    return code;
  }

  close(): Promise<void> {
    return this.stream.close();
  }
}
