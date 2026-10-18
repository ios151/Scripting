// com.apple.atc（AirTraffic 同步）客户端。
//
// 这一家的线协议与别的 shim 都不同，几条硬规则（真机实测，见全局记忆
// `atc-airtraffic-over-rsd`）：
//
// - 帧长是 **4 字节小端**（其它 shim 是大端），后面跟二进制 plist；
// - 信封只有三个键：`{Command, Session, Params}`，没有 Type/Id；
// - `HostInfo` 用 session **0**，其余同步消息一律 session **1**——混用会被顶回 SyncFailed；
// - 签到完设备自己就开始推开场消息（Capabilities → InstalledAssets → AssetMetrics →
//   SyncAllowed），不用我们先发什么；
// - `RequestingSync` / `HostInfo` 里必须带 Grappa token，缺了同步会被**静默忽略**
//   （设备只回一个 SyncFailed，然后只有心跳）。token 表是现成的，deviceType=0 那一组。

import { encodeBplist } from "../core/bplist";
import { describeError } from "../core/debug";
import { MAX_CHUNK, delay, writeAll, type ByteStream } from "../core/stream";
import { randomHex } from "../core/bytes";
import { decodePlist, isPlistDict, type PlistDict } from "./plist";
import type { DeviceSession, StatusReporter } from "./session";

export const ATC_SERVICE = "com.apple.atc.shim.remote";

/** HostInfo 用 0，其余同步消息用 1。 */
const SESSION_HOST = 0;
const SESSION_SYNC = 1;

/** 单条消息上限，帧错位后不至于一直读下去。 */
const MAX_FRAME = 16 * 1024 * 1024;
/** 开场等 SyncAllowed 的时间。 */
const WELCOME_TIMEOUT_MS = 20_000;
/** 等 ReadyForSync：设备要转一趟书库，给得宽一点。 */
const READY_TIMEOUT_MS = 60_000;
/** 等 AssetManifest。 */
const MANIFEST_TIMEOUT_MS = 60_000;

/**
 * Grappa token：设备 `Capabilities.GrappaSupportInfo` 报 version=1 / deviceType=0 /
 * protocolVersion=1，对应这一组预生成的客户端 token。
 *
 * 实测**只有第一个能过** `ReadyForSync`，其余九个都停在 SyncFailed；所以这里固定取
 * 第一个，不做逐个试探（十次试探要跑好几分钟）。
 */
const GRAPPA_TOKENS_HEX = [
  "01012ba6a01f2ccf66a02613d5b72e0bc916004058a001a6874d18b5bd7b3395e25d79fa3ffcc67e718106d485c51540b828d1620e9f94f582d3bcc6f97e9088c923095ad8d36ab568fb45df61e286d25354b04c",
  "0101efa33b1586f410087474b2ccaf8cdb4d0040e5aee6017fdcf774a51c1980b4238076e86218af5a5f169470df90b73f4fc893a22da94fb9745c10f23df0620cfe3f19be3f2ab37d2f7590d8597ab51ebcced0",
  "0101aab479a6d8226f3e1d7a57a2501337e50240e54444b5f1d04101205a7a2f3d148d18440e2edef03d37fcdc7423c0bb441b4c4a355169d511d67ae3466fdf8865e69a8aed45867801ea8e1bbb48889ba0b834",
  "010194ab2ece86e05d7313e4075a947ab3be0240c9237c46b3c519d2ec297304413dab741827016e5eb9af8792bc2b3d6f12be25397931f41bffb887d042b97057c03ed8d72a3acb72378d30f7a073e3d7590f62",
  "01018cec0ea2c25446c90133d435eaafb0150240c6c28dd42f62f8907133c462fc8b6def05e543ab2d59952f6eb3b38e382d492cd2881beceaeaea67fc1331f77fca50fde6bed35622009670e6d6e4a36b09c088",
  "0101243b2587f14dd812751c6710730f46d50440fe2e5e9ccfe70200487e14c131412381fd7c214241b182ca04ebe0c1f3cdd54ac17eef31705c06289e02f672fa8c0d9dff167f1c925df876d5814d3265f55b06",
  "01016f8908f8f972bdc8fe99002f7648e86c024011a469c4320bb7e44137756dde3ecfbff08a55081e532c12a06101c6ae5283a014512d977eafad06c34b1f116422f6bf72ef56f8d734d37db287b170be7a3a82",
  "01015c5fcc103d0460f5bbfd48c387806e8e0340e3323ed780fbeccc2908c059d9a81e75976bf058b411f62a9a6e1df7ba307f69226942373f484690799b230bc60e99036f40eae25229aff6bb31ab74820e68a9",
  "0101f3f542aaa17252a8f81b3dc5b007adc304408d2496cee3af54113ffa9fba392b4143d4c38e4d79680e8e9feb554e450c1f89220c02375a9063b3a62bf61f62bd073991ebf215c6c2e28938d1aa53ed580c02",
  "0101fc26f7e89d1635d86b5c886df69f526a0040038b6c33049f6bd5cc526b4ee7ccce614135d2c73f8326d9af6d28399a231510917493d4fdaa395b4d1c1e1b09bdf3fe6fb7e16ad6d5f5cc18b93730874e6f4e",
];

const GRAPPA_TOKEN = (() => {
  const hex = GRAPPA_TOKENS_HEX[0];
  const out = new Uint8Array(hex.length / 2);
  for (let index = 0; index < out.length; index++) out[index] = parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  return out;
})();

/** ATC 这一侧的失败。 */
export class AtcError extends Error {
  constructor(
    /** 走到哪一步失败的（开场 / HostInfo / ReadyForSync…）。 */
    readonly stage: string,
    message: string,
  ) {
    super(`${stage}：${message}`);
  }
}

/** 一条同步资产：设备把 `identifier` 的内容送到 `destination`。 */
export interface AtcAsset {
  /** 相对 `/var/mobile/Media/Airlock/Book` 的路径。 */
  identifier: string;
  /** 相对 `/var/mobile/Media` 的路径。 */
  destination: string;
}

/** 同步过程中关心的消息名。 */
interface AtcMessage {
  name: string;
  params: PlistDict;
}

function messageName(frame: PlistDict): string {
  const command = frame.Command;
  return typeof command === "string" ? command : "";
}

function paramsOf(frame: PlistDict): PlistDict {
  const params = frame.Params;
  return isPlistDict(params) ? params : {};
}

/**
 * 帧读写。
 *
 * 只挂**一条**常驻读循环，消费端从队列里取——RSD 连接的 `read` 是单飞的，用
 * `Promise.race` 给它套超时会留下一个悬空读，之后这条连接全报 RSD_BUSY
 * （全局记忆 `rsd-connection-read-single-flight`）。
 */
class AtcConnection {
  private readonly frames: PlistDict[] = [];
  private readonly pending: number[] = [];
  private waiter: (() => void) | null = null;
  private failure: string | null = null;
  private done = false;

  constructor(
    private readonly stream: ByteStream,
    private readonly log: StatusReporter,
  ) {
    void this.pump();
  }

  private wake(): void {
    const waiter = this.waiter;
    this.waiter = null;
    waiter?.();
  }

  private async pump(): Promise<void> {
    try {
      for (;;) {
        const chunk = await this.stream.read(MAX_CHUNK);
        if (!chunk || chunk.length === 0) break;
        for (const byte of chunk) this.pending.push(byte);
        this.drain();
      }
    } catch (error) {
      this.failure = describeError(error);
    }
    this.done = true;
    this.wake();
  }

  /** 按小端长度切帧。 */
  private drain(): void {
    for (;;) {
      if (this.pending.length < 4) return;
      const length = this.pending[0] | (this.pending[1] << 8) | (this.pending[2] << 16) | (this.pending[3] << 24);
      if (length <= 0 || length > MAX_FRAME) {
        this.failure = `帧长度异常 ${length}`;
        this.done = true;
        this.wake();
        return;
      }
      if (this.pending.length < 4 + length) return;
      const body = new Uint8Array(this.pending.splice(0, 4 + length).slice(4));
      try {
        const value = decodePlist(body);
        if (isPlistDict(value)) {
          const name = messageName(value);
          if (name) this.log(`ATC ← ${name}`);
          this.frames.push(value);
        } else {
          this.log(`ATC 收到非字典消息，忽略（${body.length} 字节）`);
        }
      } catch (error) {
        this.failure = `解 plist 失败：${describeError(error)}`;
      }
      this.wake();
    }
  }

  async send(command: string, session: number, params: PlistDict | null): Promise<void> {
    const message: PlistDict = { Command: command, Session: session };
    if (params) message.Params = params;
    const body = encodeBplist(message);
    const frame = new Uint8Array(4 + body.length);
    new DataView(frame.buffer).setUint32(0, body.length, true);
    frame.set(body, 4);
    await writeAll(this.stream, frame);
  }

  /** 收一条消息，最多等 `timeoutMs`（超时只作用于取队列，不再发起新的读）。 */
  async next(timeoutMs: number): Promise<AtcMessage | null> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const frame = this.frames.shift();
      if (frame) return { name: messageName(frame), params: paramsOf(frame) };
      if (this.failure) throw new AtcError("收消息", this.failure);
      if (this.done) return null;
      const left = deadline - Date.now();
      if (left <= 0) return null;
      await new Promise<void>((resolve) => {
        this.waiter = resolve;
        const timer = setTimeout(resolve, left);
        void timer;
      });
    }
  }

  /**
   * 等到 `wanted` 里的任意一条消息，途中收到的其它消息记进日志；
   * `Ping` 随手回 `Pong`（不回的话设备会认为这头掉了）；
   * `tolerate` 里的消息记一笔就放过（`SyncFailed` 大多是上一轮的陈旧取消，非致命）。
   */
  private async waitFor(
    wanted: string[],
    timeoutMs: number,
    stage: string,
    tolerate: string[] = [],
  ): Promise<AtcMessage | null> {
    const deadline = Date.now() + timeoutMs;
    const seen: string[] = [];
    for (;;) {
      const left = deadline - Date.now();
      if (left <= 0) {
        this.log(
          `${stage}：等了 ${Math.round(timeoutMs / 1000)} 秒没等到 ${wanted.join(" / ")}${seen.length > 0 ? `（收到：${seen.join("、")}）` : ""}`,
        );
        return null;
      }
      const message = await this.next(left);
      if (!message) return null;
      if (message.name === "Ping") {
        await this.send("Pong", SESSION_SYNC, null);
        continue;
      }
      if (wanted.includes(message.name)) return message;
      if (tolerate.includes(message.name)) {
        this.log(`${stage}：${message.name}（不致命，继续等）：${describeSyncFailure(message)}`);
        continue;
      }
      seen.push(message.name);
      this.log(`${stage}：收到 ${message.name}`);
    }
  }

  /**
   * 走完一轮同步。
   *
   * 顺序照参考实现：开场等 SyncAllowed → HostInfo(session 0) → RequestingSync(session 1)
   * → ReadyForSync → FinishedSyncingMetadata → AssetManifest → 逐个 FileComplete。
   * `SyncFailed` 一路上都可能冒出来，一律记一笔继续。
   */
  async sync(assets: AtcAsset[], gapMs = FILE_COMPLETE_GAP_MS): Promise<void> {
    // 1. 开场话：设备一签到就自己开始推，SyncAllowed 是最后一条。
    const allowed = await this.waitFor(["SyncAllowed"], WELCOME_TIMEOUT_MS, "开场");
    if (!allowed) this.log("ATC 没有等到 SyncAllowed，照参考实现继续（设备可能已经就绪）");

    // 2. HostInfo —— 固定的 session 0，Params 还要多包一层 HostInfo。
    const hostInfo: PlistDict = {
      Type: "iTunes",
      Version: "13.7.0.161",
      MacOSVersion: "15.0",
      SyncHostName: "设备工具箱",
      LibraryID: randomLibraryID(),
      SyncedDataclasses: ["Book"],
      SyncedAssetTypes: ["Book"],
      Wakeable: false,
      Grappa: GRAPPA_TOKEN,
    };
    await this.send("HostInfo", SESSION_HOST, { HostInfo: hostInfo, LocalCloudSupport: false });
    await delay(200);

    // 3. RequestingSync —— Grappa 必须带，缺了设备会静默忽略整场同步。
    await this.send("RequestingSync", SESSION_SYNC, {
      Dataclasses: ["Book"],
      DataclassAnchors: {},
      HostInfo: hostInfo,
      Grappa: GRAPPA_TOKEN,
    });

    // 4. 等 ReadyForSync。带 Grappa 时这一步才会到；不带就只有 SyncFailed。
    const ready = await this.waitFor(["ReadyForSync", "AssetManifest"], READY_TIMEOUT_MS, "等 ReadyForSync", ["SyncFailed"]);
    if (!ready) {
      throw new AtcError("等 ReadyForSync", "设备没有进入同步状态（系统里要装着「图书」App）");
    }
    this.log(`ATC ${ready.name}`);

    // 5. 元数据同步完成回执，换来资产清单。
    if (ready.name !== "AssetManifest") {
      await this.send("FinishedSyncingMetadata", SESSION_SYNC, { SyncTypes: { Book: 1 }, DataclassAnchors: {} });
      const manifest = await this.waitFor(["AssetManifest", "SyncFinished"], MANIFEST_TIMEOUT_MS, "等 AssetManifest", [
        "SyncFailed",
      ]);
      if (!manifest || manifest.name !== "AssetManifest") {
        throw new AtcError("等 AssetManifest", "设备没有回资产清单");
      }
      this.log("ATC AssetManifest");
      // 设备只搬运自己清单里列过的资产：不在这里面的话，后面发 FileComplete 也是白搭。
      validateManifest(manifest.params, assets, this.log);
    }

    // 6. 逐个报完成，设备收到才会真的把资产搬到目的地。
    for (let index = 0; index < assets.length; index++) {
      await this.send("FileComplete", SESSION_SYNC, {
        AssetID: assets[index].identifier,
        Dataclass: "Book",
        AssetPath: assets[index].destination,
      });
      if (index + 1 < assets.length) await delay(gapMs);
    }
    // 留一点时间让设备把文件落完再断连接。
    await delay(2000);
  }
}

/** 设备说「不行」时附带的错误码，只用于日志。 */
function describeSyncFailure(message: AtcMessage): string {
  const code = message.params.ErrorCode;
  const required = message.params.RequiredVersion;
  return `ErrorCode ${String(code ?? "?")}${required ? `，要求版本 ${String(required)}` : ""}`;
}

/**
 * 设备回的资产清单里有没有我们要的那个。
 *
 * 设备只搬运**自己清单里列过**的资产（`IsDownload` 为真才算数），不在清单里的资产
 * 发了 FileComplete 也不会动——判法照 PoC 的 `ManifestContains`。
 */
function manifestContains(manifest: PlistDict, identifier: string): boolean {
  const books = manifest.Book;
  if (!Array.isArray(books)) return false;
  return books.some((entry) => isPlistDict(entry) && entry.AssetID === identifier && entry.IsDownload === true);
}

/** 核对资产清单；缺了就是白跑一场，不如当场报出来。 */
function validateManifest(params: PlistDict, assets: AtcAsset[], log: StatusReporter): void {
  const manifest = isPlistDict(params.AssetManifest) ? params.AssetManifest : {};
  const listed = Array.isArray(manifest.Book) ? manifest.Book.filter(isPlistDict) : [];
  const summary = listed
    .slice(0, 8)
    .map((entry) => `${String(entry.AssetID)}(${entry.IsDownload === true ? "下载" : "上传"})`)
    .join("、");
  log(`清单里有 ${listed.length} 条书资产：${summary}${listed.length > 8 ? " …" : ""}`);
  const missing = assets.filter((asset) => !manifestContains(manifest, asset.identifier));
  if (missing.length > 0) {
    throw new AtcError("资产清单", `设备没有列进 ${missing.length} 个资产（例如 ${missing[0].identifier}）——Books.plist 没被采信`);
  }
}

/** 造一个 iTunes 风格的 LibraryID（设备只当作一个名字看）。 */
function randomLibraryID(): string {
  return `${randomHex(4)}-${randomHex(2)}-${randomHex(2)}-${randomHex(2)}-${randomHex(6)}`.toUpperCase();
}

/** 两份资产之间留的间隔，照参考实现。 */
const FILE_COMPLETE_GAP_MS = 900;

/**
 * 跑一轮 AirTraffic 同步，把 `assets` 里的每个资产送到它的目的地。
 *
 * 资产要事先准备好：要写文件就先经 streaming_zip_conduit 落进媒体域，
 * 那是 `kit/airlift.ts` 的事。
 */
export async function runAtcSync(
  session: DeviceSession,
  assets: AtcAsset[],
  log: StatusReporter,
  options: { gapMs?: number } = {},
): Promise<void> {
  if (assets.length === 0) return;
  return session.withCheckinRawService(ATC_SERVICE, async (stream) => {
    const atc = new AtcConnection(stream, log);
    await atc.sync(assets, options.gapMs ?? FILE_COMPLETE_GAP_MS);
  });
}
