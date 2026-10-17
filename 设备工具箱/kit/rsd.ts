// RSD 握手：服务表 + 设备属性。
//
// 握手照 idevice 的 RemoteXpcClient：根流 1、回复流 3，先互发几个空消息，
// 再发设备握手字典。
// 回包里 Services 和 Properties 都要：型号、系统版本、序列号这些在 Properties 里，
// 「设备信息」页的一大半就靠它。
// 握手时声明了 SensitivePropertiesVisible，序列号、UDID 才会出现。

import { Http2Client, Setting } from "../core/http2";
import type { ByteStream } from "../core/stream";
import { decodeXpcMessage, encodeXpcMessage, XpcFlag, XpcUInt64, XpcUuid, type XpcValue } from "../core/xpc";

const ROOT_CHANNEL = 1;
const REPLY_CHANNEL = 3;
const ROOT_MESSAGE_ID = 1;
/** idevice 里的 REMOTE_XPC_VERSION_FLAGS。 */
const REMOTE_XPC_VERSION_FLAGS = BigInt("0x0100000000000006");

export interface RsdHandshake {
  /** 服务名 → 端口。端口在回包里是字符串，这里已经转成数字。 */
  services: Map<string, number>;
  properties: Record<string, unknown>;
}

function isEmptyDict(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Uint8Array) &&
    Object.keys(value as Record<string, unknown>).length === 0
  );
}

/** 读到第一条带非空字典的消息为止——空字典是对端的心跳/占位。 */
async function receiveBody(client: Http2Client): Promise<unknown> {
  let buffer: Uint8Array = new Uint8Array(0);
  for (;;) {
    const decoded = buffer.length > 0 ? decodeXpcMessage(buffer) : null;
    if (decoded) {
      buffer = buffer.subarray(decoded.consumed);
      const body = decoded.message.body;
      if (body !== undefined && !isEmptyDict(body)) return body;
      continue;
    }
    const chunk = await client.readData(ROOT_CHANNEL);
    if (buffer.length + chunk.length > 4 * 1024 * 1024) throw new Error("RSD 消息过大");
    const merged = new Uint8Array(buffer.length + chunk.length);
    merged.set(buffer);
    merged.set(chunk, buffer.length);
    buffer = merged;
  }
}

export async function rsdHandshake(stream: ByteStream): Promise<RsdHandshake> {
  const client = await Http2Client.create(stream);

  await client.sendSettings([
    [Setting.MaxConcurrentStreams, 100],
    [Setting.InitialWindowSize, 1048576],
  ]);
  await client.sendWindowUpdate(983041, 0);

  await client.openStream(ROOT_CHANNEL);
  await client.sendData(encodeXpcMessage(XpcFlag.AlwaysSet, ROOT_MESSAGE_ID, {}), ROOT_CHANNEL);

  await client.openStream(REPLY_CHANNEL);
  await client.sendData(encodeXpcMessage(XpcFlag.InitHandshake | XpcFlag.AlwaysSet, ROOT_MESSAGE_ID), REPLY_CHANNEL);

  await client.sendData(encodeXpcMessage(0x201, ROOT_MESSAGE_ID), ROOT_CHANNEL);

  const handshake: XpcValue = {
    MessageType: "Handshake",
    MessagingProtocolVersion: new XpcUInt64(BigInt(7)),
    UUID: XpcUuid.random(),
    Properties: {
      RemoteXPCVersionFlags: new XpcUInt64(REMOTE_XPC_VERSION_FLAGS),
      SensitivePropertiesVisible: true,
    },
    Services: {},
  };
  await client.sendData(
    encodeXpcMessage(XpcFlag.DataFlag | XpcFlag.AlwaysSet, ROOT_MESSAGE_ID, handshake),
    ROOT_CHANNEL,
  );

  const body = (await receiveBody(client)) as Record<string, unknown> | null;
  const rawServices = body?.["Services"];
  if (!rawServices || typeof rawServices !== "object") throw new Error("设备没有返回服务列表");

  const services = new Map<string, number>();
  for (const [name, entry] of Object.entries(rawServices as Record<string, unknown>)) {
    const port = Number((entry as Record<string, unknown> | null)?.Port);
    if (Number.isInteger(port) && port > 0 && port <= 65535) services.set(name, port);
  }
  if (services.size === 0) throw new Error("服务列表为空");

  const rawProperties = body?.["Properties"];
  const properties =
    rawProperties && typeof rawProperties === "object" ? (rawProperties as Record<string, unknown>) : {};
  return { services, properties };
}
