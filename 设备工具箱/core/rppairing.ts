// RemotePairing 协议（对应 idevice 的 remote_pairing）。
//
// 线路格式：b"RPPairing" + 2 字节大端长度 + JSON 信封。
// 信封分明文与流加密两种：
//   {"message":{"plain":{"_0":…}},"originatedBy":"host","sequenceNumber":n}
//   {"message":{"streamEncrypted":{"_0":"<base64>"}},"originatedBy":"host","sequenceNumber":n}
// 字节字段在 JSON 里一律 base64。
//
// 握手顺序：attemptPairVerify → pair-verify(M1..M4) → createListener 取隧道端口。

import {
  concat,
  fromBase64,
  fromUtf8,
  readU16BE,
  toBase64,
  u16be,
  u64le,
  utf8,
} from "./bytes";
import {
  chachaOpen,
  chachaSeal,
  ed25519Sign,
  generateX25519,
  hkdfSha512,
  x25519SharedSecret,
} from "./crypto_utils";
import { debugLog } from "./debug";
import type { PairingRecord } from "./pairing";
import { BufferedReader, writeAll, type ByteStream } from "./stream";
import { decodeTLV8, encodeTLV8, errorCode, hasError, TLV8Type } from "./tlv8";

const FRAME_MAGIC = utf8("RPPairing");
/** 与 idevice 的 WIRE_PROTOCOL_VERSION 保持一致。 */
const WIRE_PROTOCOL_VERSION = 19;
const PAIR_VERIFY_SALT = utf8("Pair-Verify-Encrypt-Salt");
const PAIR_VERIFY_INFO = utf8("Pair-Verify-Encrypt-Info");
const CLIENT_ENCRYPT_INFO = utf8("ClientEncrypt-main");
const SERVER_ENCRYPT_INFO = utf8("ServerEncrypt-main");
const EMPTY = new Uint8Array(0);

/** pair-verify 各步的固定 nonce：4 个零字节 + "PV-MsgNN"。 */
function pairVerifyNonce(step: number): Uint8Array {
  const nonce = new Uint8Array(12);
  nonce.set(utf8(`PV-Msg0${step}`), 4);
  return nonce;
}

/** 流加密的 nonce：8 字节小端序号 + 4 个零字节。 */
function streamNonce(sequence: number): Uint8Array {
  const nonce = new Uint8Array(12);
  nonce.set(u64le(sequence), 0);
  return nonce;
}

export class PairVerifyRejected extends Error {
  constructor(readonly code: number | null, message: string) {
    super(message);
  }
}

export interface PairConsentResult {
  kind: "rejected" | "ready";
  message?: string;
  salt?: Uint8Array;
  publicKey?: Uint8Array;
}

export class RpPairingSocket {
  private sequence = 0;
  private readonly reader: BufferedReader;

  constructor(
    private readonly stream: ByteStream,
    private readonly originatedBy: "host" | "device" = "host",
  ) {
    this.reader = new BufferedReader(stream);
  }

  private async sendFrame(value: unknown): Promise<void> {
    const body = utf8(JSON.stringify(value));
    if (body.length > 0xffff) throw new Error("RPPairing 帧超过 65535 字节");
    await writeAll(this.stream, concat(FRAME_MAGIC, u16be(body.length), body));
  }

  async sendPlain(value: unknown): Promise<void> {
    await this.sendFrame({
      message: { plain: { _0: value } },
      originatedBy: this.originatedBy,
      sequenceNumber: this.sequence,
    });
    this.sequence += 1;
  }

  async sendEncrypted(ciphertext: Uint8Array): Promise<void> {
    await this.sendFrame({
      message: { streamEncrypted: { _0: toBase64(ciphertext) } },
      originatedBy: this.originatedBy,
      sequenceNumber: this.sequence,
    });
    this.sequence += 1;
  }

  /** 明文信封返回其 `_0`，加密信封返回整个 message 字典。 */
  async receive(): Promise<any> {
    const magic = await this.reader.readExact(FRAME_MAGIC.length);
    for (let i = 0; i < FRAME_MAGIC.length; i++) {
      if (magic[i] !== FRAME_MAGIC[i]) {
        throw new Error(`不是 RemotePairing 服务（帧头为 ${fromUtf8(magic).replace(/[^\x20-\x7e]/g, ".")}）`);
      }
    }

    const length = readU16BE(await this.reader.readExact(2), 0);
    const body = await this.reader.readExact(length);
    const json = JSON.parse(fromUtf8(body));
    const plain = json?.message?.plain?._0;
    return plain !== undefined ? plain : json?.message;
  }

  close(): Promise<void> {
    return this.stream.close();
  }
}

/**
 * 握手响应里设备自报的能力。
 *
 * 实测 iOS 27 的响应只有协议版本与开关，没有设备名/型号——设备名要另外问
 * CoreDevice 的服务，这里拿不到，界面上就用配对记录里的名字。
 * 形如：
 * ```json
 * { "wireProtocolVersion": 26, "minimumSupportedWireProtocolVersion": 8,
 *   "deviceOptions": { "allowsIncomingTunnelConnections": true, … } }
 * ```
 */
export interface PeerHandshakeInfo {
  wireProtocolVersion?: number;
  minimumWireProtocolVersion?: number;
  /** 为 false 时设备不接受隧道连接，再往下走也没用。 */
  allowsIncomingTunnelConnections?: boolean;
  /** 为 false 时设备多半不接受在本机直接发起 pair-setup。 */
  allowsPairSetup?: boolean;
}

export class RemotePairingClient {
  private encryptedSequence = 0;
  private clientKey: Uint8Array = EMPTY;
  private serverKey: Uint8Array = EMPTY;
  private sharedSecret: Uint8Array = EMPTY;

  constructor(private readonly socket: RpPairingSocket) {}

  /**
   * 关闭连接。
   *
   * 先把密钥材料清零再关：这几个数组里是 pair-verify 协商出的共享密钥和
   * 两个方向的流密钥，会话结束后没有任何理由继续留在内存里。
   */
  async close(): Promise<void> {
    this.clientKey.fill(0);
    this.serverKey.fill(0);
    this.sharedSecret.fill(0);
    await this.socket.close();
  }

  /** pair-verify 协商出的原始共享密钥，同时也是隧道的 TLS-PSK。 */
  get preSharedKey(): Uint8Array {
    if (this.sharedSecret.length === 0) throw new Error("尚未完成 pair-verify");
    return this.sharedSecret;
  }

  /** 第一步握手，顺带拿到设备自报的名称与型号。 */
  async attemptPairVerify(): Promise<PeerHandshakeInfo> {
    await this.socket.sendPlain({
      request: {
        _0: {
          handshake: {
            _0: {
              hostOptions: { attemptPairVerify: true },
              wireProtocolVersion: WIRE_PROTOCOL_VERSION,
            },
          },
        },
      },
    });

    const response = await this.socket.receive();
    const handshake = response?.response?._1?.handshake?._0;
    if (!handshake) throw new Error("设备未返回握手响应");

    debugLog("pair", "握手响应原文", JSON.stringify(handshake).slice(0, 600));

    const options = handshake.deviceOptions ?? {};
    const info: PeerHandshakeInfo = {
      wireProtocolVersion: handshake.wireProtocolVersion,
      minimumWireProtocolVersion: handshake.minimumSupportedWireProtocolVersion,
      allowsIncomingTunnelConnections: options.allowsIncomingTunnelConnections,
      allowsPairSetup: options.allowsPairSetup,
    };

    if (info.allowsIncomingTunnelConnections === false) {
      throw new Error("设备声明不接受隧道连接（allowsIncomingTunnelConnections=false），无法建立定位会话。");
    }

    return info;
  }

  /**
   * pair-verify M1–M4。
   *
   * 与 idevice 的 validate_pairing 一致：不校验 M2 里设备的 Ed25519 签名
   * （配对文件本来就不含设备公钥），身份由 M3 的签名被设备接受来证明。
   */
  async validatePairing(record: PairingRecord): Promise<void> {
    const ephemeral = await generateX25519();

    // M1：带上本机临时公钥
    await this.sendPairingData({
      data: toBase64(
        encodeTLV8([
          { type: TLV8Type.State, data: new Uint8Array([0x01]) },
          { type: TLV8Type.PublicKey, data: ephemeral.publicKey },
        ]),
      ),
      kind: "verifyManualPairing",
      startNewSession: true,
    });

    // M2：设备回临时公钥
    const m2 = decodeTLV8(await this.receivePairingData());
    if (hasError(m2)) {
      throw new PairVerifyRejected(errorCode(m2), "设备拒绝了这次 pair-verify");
    }
    // 除了看有没有 error，还要确认设备确实走到了 M2 这一步——
    // 状态对不上说明双方的状态机已经错位，继续谈下去只会得到难懂的错误。
    const m2State = m2.get(TLV8Type.State);
    if (m2State?.length !== 1 || m2State[0] !== 2) throw new Error("pair-verify M2 状态无效");
    const devicePublicKey = m2.get(TLV8Type.PublicKey);
    if (!devicePublicKey || devicePublicKey.length !== 32) {
      throw new Error("设备未返回有效的临时公钥");
    }

    this.sharedSecret = await x25519SharedSecret(ephemeral.privateKey, devicePublicKey);
    const sessionKey = await hkdfSha512(this.sharedSecret, PAIR_VERIFY_SALT, PAIR_VERIFY_INFO);

    // M3：用配对记录里的私钥签 clientPub ‖ identifier ‖ devicePub
    const identifier = utf8(record.identifier);
    const signature = await ed25519Sign(
      record.privateKey,
      concat(ephemeral.publicKey, identifier, devicePublicKey),
    );
    const inner = encodeTLV8([
      { type: TLV8Type.Identifier, data: identifier },
      { type: TLV8Type.Signature, data: signature },
    ]);
    const encrypted = await chachaSeal(sessionKey, pairVerifyNonce(3), inner);

    await this.sendPairingData({
      data: toBase64(
        encodeTLV8([
          { type: TLV8Type.State, data: new Uint8Array([0x03]) },
          { type: TLV8Type.EncryptedData, data: encrypted },
        ]),
      ),
      kind: "verifyManualPairing",
      startNewSession: false,
    });

    // M4：设备确认
    const m4 = decodeTLV8(await this.receivePairingData());
    if (hasError(m4)) {
      await this.sendPairVerifyFailed();
      throw new PairVerifyRejected(
        errorCode(m4),
        "设备不认这份配对记录。请用「配对这台设备」重新配对，或重新导入一份本机的配对记录。",
      );
    }

    const m4State = m4.get(TLV8Type.State);
    if (m4State?.length !== 1 || m4State[0] !== 4) throw new Error("pair-verify M4 状态无效");

    this.clientKey = await hkdfSha512(this.sharedSecret, EMPTY, CLIENT_ENCRYPT_INFO);
    this.serverKey = await hkdfSha512(this.sharedSecret, EMPTY, SERVER_ENCRYPT_INFO);
  }


  /**
   * 请设备开一条 TCP 隧道监听，返回端口。此请求必须加密发送。
   *
   * 监听是一次性的：谁先连上就归谁，所以拿到端口后不要做任何「探一下通不通」
   * 之类的动作，那会把它消费掉。
   *
   * `peerConnectionsInfo` 是 pymobiledevice3 会带、idevice 不带的字段，
   * 用于告诉设备这条连接归哪个进程。两种都试过才知道 iOS 27 认不认。
   */
  async createTcpListener(options: { peerConnectionsInfo?: boolean } = {}): Promise<number> {
    const listener: Record<string, unknown> = {
      key: toBase64(this.preSharedKey),
      transportProtocolType: "tcp",
    };
    if (options.peerConnectionsInfo) {
      listener.peerConnectionsInfo = [{ owningPID: 1, owningProcessName: "CoreDeviceService" }];
    }

    const response = await this.sendEncryptedRequest({ request: { _0: { createListener: listener } } });

    const port = response?.createListener?.port;
    if (typeof port !== "number" || port <= 0) throw new Error("设备未返回隧道端口");
    return port;
  }

  private async sendPairingData(payload: Record<string, unknown>): Promise<void> {
    await this.socket.sendPlain({ event: { _0: { pairingData: { _0: payload } } } });
  }

  private async receivePairingData(): Promise<Uint8Array> {
    const response = await this.socket.receive();
    const event = response?.event?._0 ?? response;
    const data = event?.pairingData?._0?.data ?? event?.pairingData?.data;
    if (typeof data !== "string") {
      throw new Error(`设备返回了意外的配对响应：${JSON.stringify(response).slice(0, 160)}`);
    }
    return fromBase64(data);
  }

  private async sendPairVerifyFailed(): Promise<void> {
    try {
      await this.socket.sendPlain({ event: { _0: { pairVerifyFailed: {} } } });
    } catch {
      // 失败通知本身发不出去也无所谓，调用方已经要报错了。
    }
  }

  /** 加密请求与其响应共用同一个 nonce，一问一答后序号才加一。 */
  private async sendEncryptedRequest(request: unknown): Promise<any> {
    if (this.clientKey.length === 0) throw new Error("尚未完成 pair-verify");

    const nonce = streamNonce(this.encryptedSequence);
    const ciphertext = await chachaSeal(this.clientKey, nonce, utf8(JSON.stringify(request)));
    await this.socket.sendEncrypted(ciphertext);

    const message = await this.socket.receive();
    const encoded = message?.streamEncrypted?._0;
    if (typeof encoded !== "string") throw new Error("设备未返回加密响应");

    const plaintext = await chachaOpen(this.serverKey, nonce, fromBase64(encoded));
    this.encryptedSequence += 1;

    const value = JSON.parse(fromUtf8(plaintext));
    const result = value?.response?._1;
    if (result === undefined) throw new Error("加密响应缺少 response._1");
    return result;
  }
}
