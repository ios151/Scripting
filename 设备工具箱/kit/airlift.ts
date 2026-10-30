// Airlift：把文件写到设备上媒体域之外的地方（例如 /var/mobile/Library/…），或从那里读回来。
//
// AFC 只能看媒体域（根是 /var/mobile/Media），越界靠这条链，一段操作分三步：
//
//   1. 暂存：把「一个符号链接 + 若干载荷」打成带 unix 模式位的 zip，交给
//      com.apple.streaming_zip_conduit 解到 /var/mobile/Media/<source>/；
//   2. 立据：往媒体域写 Books/Sync/Books.plist，把「资产 id → 目的地」的映射告诉设备；
//   3. 同步：跑一轮 AirTraffic（kit/atc.ts），设备照清单搬运。
//
// 关键在符号链接的内容 `../../../<目标目录>`：设备会把它搬成媒体域根下的一条软链，
// 从那里往上三级正好是 `/`，再拼上 `var/mobile/…` 就落到了真实路径。
//
// 五条实测行为，都会决定这一层怎么写：
// - **读一轮只能带一个越界资产**（2026-10-19 真机）：想把两个提示音凑一轮搬完，设备回的
//   AssetManifest 里只列了 link + 第一个文件，第二个被丢掉，于是 `validateManifest` 报
//   「设备没有列进 1 个资产」。写入那轮带 3 个资产（link + 两个载荷）却全中——区别在于
//   写入的资产都指向暂存树里**真实存在**的文件，而读取的是靠 `../../../` 越界的路径。
//   所以读只能一个文件一轮；**写回不受此限**，仍然一轮搬多个。
// - 设备**异步**落盘：读回时要轮询，别读一次就断定失败；
// - 读是**破坏性**的：它把真实文件搬到媒体域再拷出来，读完必须原样写回去。
//   所以读回超时的时候，原路径上那一份**已经没了**，内容就停在媒体域的
//   `airlift-recovered-*` 底下——那是用户仅存的一份，收尾时绝不能顺手删掉
//   （`listAirliftLeftovers` / `readAirliftLeftover` 就是去那儿捞）；
// - 刚写过的那个文件**有时不肯再交出来**：2026-10-19 真机上静音、还原各跑一次，verify 读回都
//   当场通过，再静音一次又超时了。所以这是偶发、不是必然（旧注释说「一两分钟都不给」，多半是
//   旧轮询每轮重借连接、探测太稀造成的误判）。这也是 `verify` **默认关掉**的原因：校验要再跑
//   三轮（每个文件读一轮 + 写回一轮），占掉整个操作四分之三的时间，换来的却是个时灵时不灵的
//   确认，没过的时候纯属白费。要校验的调用方自己传 `{ verify: true }`；
// - Books.plist 是用户的真实数据：动手前备份、收尾还原（参考实现同样这么做）。
//
// 资产 id 相对 `/var/mobile/Media/Airlock/Book` 算，目的地相对 `/var/mobile/Media` 算
// ——这两个基准不对整条链都不动。

import { encodeBplist } from "../core/bplist";
import { concat, randomHex, toBytes, utf8 } from "../core/bytes";
import { describeError } from "../core/debug";
import { BufferedReader, delay, withTimeout, writeAll, type ByteStream } from "../core/stream";
import { writeStoredZip, ZipMode, type ZipEntry } from "../core/zip";
import { runAtcSync, type AtcAsset } from "./atc";
import { decodePlist, isPlistDict } from "./plist";
import { isTunnelDropped, type DeviceSession, type StatusReporter } from "./session";

/** 流式解压服务：把 zip 解到媒体域的某个子目录里。 */
export const ZIP_SERVICE = "com.apple.streaming_zip_conduit.shim.remote";
/** AFC 服务：根对应 /var/mobile/Media。 */
const AFC_SERVICE = "com.apple.afc.shim.remote";

/** 资产 id 的相对基准。 */
const AIRLOCK_ROOT = "/var/mobile/Media/Airlock/Book";
/** 媒体域里设备要求存在的脚手架目录。 */
const SCAFFOLD_DIRS = ["Airlock", "Airlock/Book", "Books", "Books/Sync"];
/** 书名录与同步记录。 */
const BOOKS_PLIST = "Books/Sync/Books.plist";

const SOURCE_PREFIX = "airlift-src-";
const LINK_PREFIX = "airlift-link-";
const RECOVERED_PREFIX = "airlift-recovered-";

/** 解压回包上限，帧错位后不至于一直读下去。 */
const MAX_ZIP_REPLY = 1024 * 1024;
const ZIP_REPLY_TIMEOUT_MS = 60_000;
/**
 * 等设备把文件搬到位。
 *
 * 参考实现是 80 次 × 250 ms，按的是「一条 AFC 连接上探 80 次」；这里改成按时间卡窗口，
 * 因为借一条 AFC 连接要 connect + adopt + checkin + openAFC 四趟往返，按次数算会把真实
 * 间隔拉成秒级（见 `pollRecovered`）。
 */
const RECOVER_WINDOW_MS = 30_000;
const RECOVER_INTERVAL_MS = 250;
/** 轮询时隔多久报一次进度。 */
const RECOVER_NOTICE_MS = 5000;
/** 同步结束后先留一段时间给设备的异步搬运，再动暂存树。 */
const SETTLE_MS = 3000;
const WRITE_ATTEMPTS = 2;
const WRITE_RETRY_MS = 5000;

export interface AirliftFile {
  /** 目标文件名（写到 `directory` 下）。 */
  name: string;
  data: Uint8Array;
}

/** 这条链某一环失败。 */
export class AirliftError extends Error {
  constructor(readonly stage: string, message: string) {
    super(`${stage}：${message}`);
  }
}

/**
 * 内容写下去了、但没能读回确认。
 * 跟「写入失败」不同：真正的失败会在前面几环抛出；这一种是「写的那几轮都跑了，只是读回时
 * 设备没把文件交出来」。调用方要按「设备上的状态不明」处理。
 */
export class AirliftUnverifiedError extends AirliftError {
  constructor(message: string) {
    super("校验", message);
  }
}

// ── 原生 AFC 适配层 ───────────────────────────────────────────────────────────

/**
 * 把 DeviceServices.AFCClient 包成 airlift 需要的操作集合。
 * AFC 的 upload/download 都走本地临时文件。
 */
interface LocalAfc {
  stat(path: string): Promise<unknown>;
  readDirectory(path: string): Promise<string[]>;
  makeDirectory(path: string): Promise<void>;
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  removePath(path: string): Promise<void>;
}

function makeTmp(): string {
  return `${FileManager.temporaryDirectory}/alft_${Date.now()}_${Math.random().toString(36).slice(2)}.tmp`;
}

function wrapNativeAfc(afc: DeviceServices.AFCClient): LocalAfc {
  return {
    stat: (path) => afc.stat(path),
    readDirectory: (path) => afc.readDirectory(path),
    // 目录可能已存在（前次同步遗留），忽略"已存在"错误。
    makeDirectory: (path) => afc.makeDirectory(path).catch(() => undefined),
    readFile: async (path) => {
      const tmp = makeTmp();
      try {
        await afc.download({ remotePath: path, localPath: tmp }).result;
        return toBytes(FileManager.readAsBytesSync(tmp));
      } finally {
        // download 失败也可能留下半截临时文件，一律收掉。
        await FileManager.remove(tmp).catch(() => undefined);
      }
    },
    // upload 要求目标路径不存在；先 remove 再 upload 实现覆盖写。
    writeFile: async (path, data) => {
      const tmp = makeTmp();
      FileManager.writeAsBytesSync(tmp, data);
      await afc.remove(path).catch(() => undefined);
      await afc.upload({ localPath: tmp, remotePath: path }).result;
      await FileManager.remove(tmp).catch(() => undefined);
    },
    removePath: (path) => afc.remove(path).catch(() => undefined),
  };
}

function withLocalAfc<T>(session: DeviceSession, use: (afc: LocalAfc) => Promise<T>): Promise<T> {
  return session.withAfcService(AFC_SERVICE, (nativeAfc) => use(wrapNativeAfc(nativeAfc)));
}

// ── 辅助 ──────────────────────────────────────────────────────────────────────

function stripLeadingSlash(path: string): string {
  return path.replace(/^\/+/, "");
}

function joinPath(directory: string, name: string): string {
  return `${directory.replace(/\/+$/, "")}/${name}`;
}

function parentOf(path: string): string {
  return path.slice(0, path.lastIndexOf("/")) || "/";
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/**
 * `path` 相对 `base` 的 POSIX 相对路径。资产 id 全靠它算，算错一级就读写到别的目录去。
 *
 * **切出来的空段要丢掉**：`"…/Book/".split("/")` 末尾会多一个空串，被当成一级目录，
 * 于是多退一个 `..`——目标就从 `/var/mobile/` 滑到 `/var/`。连续斜杠同理。
 * 现在的调用方（常量 `AIRLOCK_ROOT` 和 `parentOf()` 的结果）都不带尾斜杠，碰不到这个，
 * 但这种事不该靠调用方小心。
 */
function posixRel(path: string, base: string): string {
  const segments = (value: string) => stripLeadingSlash(value).split("/").filter((part) => part.length > 0);
  const pathParts = segments(path);
  const baseParts = segments(base);
  let common = 0;
  while (common < pathParts.length && common < baseParts.length && pathParts[common] === baseParts[common]) common++;
  const parts: string[] = [];
  for (let index = 0; index < baseParts.length - common; index++) parts.push("..");
  for (const part of pathParts.slice(common)) parts.push(part);
  return parts.length === 0 ? "." : parts.join("/");
}

function payloadName(index: number): string {
  return `payload_${index}`;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) return false;
  return true;
}

function buildArchive(targetDirectory: string, files: AirliftFile[]): ZipEntry[] {
  const tail = stripLeadingSlash(targetDirectory);
  const entries: ZipEntry[] = [
    { name: "META-INF/", mode: ZipMode.directory },
    { name: "META-INF/com.apple.ZipMetadata.plist", mode: ZipMode.file, data: encodeBplist({ Version: 2 }) },
    { name: "p0/", mode: ZipMode.directory },
    { name: "p0/p1/", mode: ZipMode.directory },
    { name: "p0/p1/p2/", mode: ZipMode.directory },
    { name: "p0/p1/p2/link", mode: ZipMode.symlink, data: utf8(`../../../${tail}`) },
  ];
  let cursor = "";
  for (const component of tail.split("/")) {
    if (component.length === 0) continue;
    cursor += `${component}/`;
    entries.push({ name: cursor, mode: ZipMode.directory });
  }
  files.forEach((file, index) => {
    entries.push({ name: payloadName(index), mode: ZipMode.file, data: file.data });
  });
  return entries;
}

function buildBooksPlist(identifiers: string[]): Uint8Array {
  return encodeBplist({
    Books: identifiers.map((identifier, index) => ({
      "Persistent ID": identifier,
      "Item ID": String(index + 1),
      DSID: "1",
    })),
  });
}

async function readExact(stream: ByteStream, count: number): Promise<Uint8Array> {
  return new BufferedReader(stream).readExact(count);
}

async function stageArchive(session: DeviceSession, subdir: string, entries: ZipEntry[], log: StatusReporter): Promise<void> {
  const archive = writeStoredZip(entries);
  log(`打包 ${entries.length} 个条目（${archive.length} 字节），交给设备解压…`);

  await session.withCheckinRawService(ZIP_SERVICE, async (stream) => {
    const head = encodeBplist({ MediaSubdir: subdir });
    const lengthPrefix = new Uint8Array(4);
    new DataView(lengthPrefix.buffer).setUint32(0, head.length, false);
    await writeAll(stream, concat(lengthPrefix, head));
    await writeAll(stream, archive);

    const header = await withTimeout(readExact(stream, 4), ZIP_REPLY_TIMEOUT_MS, "解压回包超时");
    const replyLength = new DataView(header.buffer as ArrayBuffer, header.byteOffset, 4).getUint32(0, false);
    if (replyLength === 0 || replyLength > MAX_ZIP_REPLY) throw new AirliftError("解压回包", `长度异常 ${replyLength}`);
    const body = await withTimeout(readExact(stream, replyLength), ZIP_REPLY_TIMEOUT_MS, "解压回包超时");
    const reply = decodePlist(body);
    if (isPlistDict(reply) && reply.Error !== undefined) {
      throw new AirliftError("解压回包", `${String(reply.Error)} ${String(reply.ErrorDescription ?? "")}`.trim());
    }
  });
}

async function removeArchive(afc: LocalAfc, source: string, entries: ZipEntry[]): Promise<void> {
  for (let index = entries.length - 1; index >= 0; index--) {
    const name = entries[index].name.replace(/\/+$/, "");
    await afc.removePath(joinPath(source, name));
  }
  await afc.removePath(source);
}

/**
 * 这两个都收**现成的连接**而不是 session：借一条 AFC 要 connect + adopt + checkin + openAFC
 * 四趟往返，一轮操作里能合并的都合并（校验暂存和立据合一条，还原和清理合一条）。
 */
async function installBooksManifest(afc: LocalAfc, identifiers: string[], log: StatusReporter): Promise<Uint8Array | null> {
  for (const dir of SCAFFOLD_DIRS) await afc.makeDirectory(dir);
  const original = await afc.readFile(BOOKS_PLIST).catch(() => null);
  await afc.writeFile(BOOKS_PLIST, buildBooksPlist(identifiers));
  log("同步清单已就位");
  return original;
}

/** 收尾还原，本身不抛：它跑在 finally 里，盖掉真正的失败原因就看不出问题出在哪了。 */
async function restoreBooksManifest(afc: LocalAfc, original: Uint8Array | null, log: StatusReporter): Promise<void> {
  try {
    if (original) await afc.writeFile(BOOKS_PLIST, original);
    else await afc.removePath(BOOKS_PLIST);
  } catch (error) {
    log(`还原 Books.plist 失败：${describeError(error)}`);
  }
}

export async function writeDeviceFiles(
  session: DeviceSession,
  directory: string,
  files: AirliftFile[],
  log: StatusReporter = () => {},
  options: { verify?: boolean } = {},
): Promise<void> {
  if (files.length === 0) return;
  // **默认不校验。** 校验要再跑三轮（读每个文件各一轮 + 写回一轮），占掉整个操作四分之三的
  // 时间，而真机上它本来就时灵时不灵（刚写过的文件有一阵不肯再交出来）；没过的时候更是白费——
  // 照样要重写一遍、状态照样记不准、照样得用户自己再查一次。要校验的调用方自己传 true。
  const verify = options.verify ?? false;

  for (let attempt = 1; ; attempt++) {
    try {
      await writeOnce(session, directory, files, log, verify);
      return;
    } catch (error) {
      // 「写下去了、只是没读回确认」**不重试**：内容已经在设备上，重试等于把主写入 + 读 + 写回
      // 那四轮重跑一遍去碰运气（真机实测一次白跑三分钟）。只在调用方显式开了 `verify` 时才会
      // 走到这里，交给它自己决定怎么收尾。
      //
      // 隧道被系统收掉（锁屏、熄屏、切网络）之后这条会话就死了，重试只是拿同一条死隧道
      // 再撞一次——`session` 是传进来的固定对象，这一层换不了新的。直接抛，让调用方重连。
      if (error instanceof AirliftUnverifiedError || isTunnelDropped(error) || attempt >= WRITE_ATTEMPTS) throw error;
      log(`这次写入没成功（第 ${attempt} 次），${WRITE_RETRY_MS / 1000} 秒后重新上传：${describeError(error)}`);
      await delay(WRITE_RETRY_MS);
    }
  }
}

async function writeOnce(
  session: DeviceSession,
  directory: string,
  files: AirliftFile[],
  log: StatusReporter,
  verify: boolean,
): Promise<void> {
  const token = randomHex(10);
  const source = `${SOURCE_PREFIX}${token}`;
  const linkDestination = `${LINK_PREFIX}${token}`;
  const entries = buildArchive(directory, files);
  const identifiers = [`../../${source}/p0/p1/p2/link`, ...files.map((_, index) => `../../${source}/${payloadName(index)}`)];
  const destinations = [linkDestination, ...files.map((file) => joinPath(linkDestination, file.name))];
  const assets: AtcAsset[] = identifiers.map((identifier, index) => ({ identifier, destination: destinations[index] }));

  await stageArchive(session, source, entries, log);

  // 校验暂存 + 立据合用一条连接。
  const original = await withLocalAfc(session, async (afc) => {
    for (const path of [source, `${source}/p0/p1/p2/link`, ...files.map((_, index) => `${source}/${payloadName(index)}`)]) {
      try {
        await afc.stat(path);
      } catch (error) {
        await removeArchive(afc, source, entries);
        throw new AirliftError("校验暂存", `${path} 没解出来（${describeError(error)}）`);
      }
    }
    log("暂存文件已在媒体域里就位");
    return installBooksManifest(afc, identifiers, log);
  });

  try {
    log(`交给 AirTraffic 同步 ${assets.length} 个资产…`);
    await runAtcSync(session, assets, log);
    await delay(SETTLE_MS);

    if (verify) {
      const paths = files.map((file) => joinPath(directory, file.name));
      let back: Uint8Array[];
      try {
        back = await readDeviceFiles(session, paths, log, { restore: true });
      } catch (error) {
        throw new AirliftUnverifiedError(`写完之后没能读回确认（${describeError(error)}）`);
      }
      files.forEach((file, index) => {
        if (!bytesEqual(back[index], file.data)) {
          throw new AirliftError("校验", `${file.name} 写下去的和读回来的不一致（${file.data.length} / ${back[index].length} 字节）`);
        }
      });
      log("读回校验通过");
    }
  } finally {
    await withLocalAfc(session, async (afc) => {
      await restoreBooksManifest(afc, original, log);
      await afc.removePath(linkDestination);
      await removeArchive(afc, source, entries);
    }).catch(() => undefined);
  }
}

/**
 * 批量读，**读到几个算几个**：没交出来的位置留 null，不抛。
 *
 * 「检查设备状态」这类场景要的就是这个——一个文件没读到，不该让另一个也白读一轮。
 * 写入后的校验要的是另一种语义，见 `readDeviceFiles`。
 */
export async function tryReadDeviceFiles(
  session: DeviceSession,
  paths: string[],
  log: StatusReporter = () => {},
  options: { restore?: boolean } = {},
): Promise<(Uint8Array | null)[]> {
  if (paths.length === 0) return [];
  const restore = options.restore ?? true;
  const bytesOf = new Map<string, Uint8Array>();

  // 读**一个文件一轮**——不是没试过合并：真机实测设备一轮只收一个越界资产（见文件头第五条）。
  for (const path of paths) {
    const [bytes] = await readGroup(session, parentOf(path), [path], log);
    if (bytes) bytesOf.set(path, bytes);
  }

  if (restore) {
    // 写回**不受那条限制**：资产指向的是暂存树里真实存在的文件，跟主写入同构，一轮能带多个。
    // 读完原位就空了，所以取到几个写回几个，按目录凑成一轮。
    const groups = new Map<string, string[]>();
    for (const path of paths) {
      if (!bytesOf.has(path)) continue;
      const directory = parentOf(path);
      const group = groups.get(directory);
      if (group) group.push(path);
      else groups.set(directory, [path]);
    }

    for (const [directory, group] of groups) {
      const files = group.map((path) => ({ name: baseName(path), data: bytesOf.get(path) as Uint8Array }));
      try {
        await writeDeviceFiles(session, directory, files, log, { verify: false });
      } catch (error) {
        throw new AirliftError(
          "写回文件",
          `${directory} 下的 ${files.length} 个文件已读出、写回失败：${describeError(error)}（内容还在内存里，别离开这一页）`,
        );
      }
    }
  }

  return paths.map((path) => bytesOf.get(path) ?? null);
}

/** 批量读，**少一个都算失败**。写入后的校验要的是这个语义：缺了就不能算校验通过。 */
export async function readDeviceFiles(
  session: DeviceSession,
  paths: string[],
  log: StatusReporter = () => {},
  options: { restore?: boolean } = {},
): Promise<Uint8Array[]> {
  const data = await tryReadDeviceFiles(session, paths, log, options);
  const lost = paths.filter((_, index) => data[index] === null);
  if (lost.length > 0) {
    throw new AirliftError(
      "读回文件",
      `设备没有把 ${lost.join("、")} 交到媒体域：可能这一会儿不肯交，也可能那些文件已经不在了。` +
        `这条链的读是搬运式的，没取走的那几份会留在媒体域不动，晚一步搬过来还能捞回去（见「抢救残留」）`,
    );
  }
  return data.filter((bytes): bytes is Uint8Array => bytes !== null);
}

/**
 * 等设备把这一组文件搬到媒体域，到一个收一个。没等到的那几位留 null。
 *
 * 整个等待过程**复用一条 AFC 连接**：借一条要 connect + adopt + checkin + openAFC 四趟
 * 往返，每轮都重借的话真实间隔会被拉到秒级，而设备搬过来的那一份随时可能又被系统收走——
 * 探测得够密才抓得住。连接自己断了才重借，窗口没到就接着等。
 *
 * 先 `stat` 再 `readFile`：下载要落一遍本地临时文件，拿它当「在不在」的探针太贵。
 * 几个落点不是同时到的，所以每一轮把**还缺的**挨个探一遍，谁到了先收谁。
 */
async function pollRecovered(
  session: DeviceSession,
  names: string[],
  log: StatusReporter,
): Promise<(Uint8Array | null)[]> {
  const out: (Uint8Array | null)[] = names.map(() => null);
  const stillMissing = () => out.some((bytes) => bytes === null);
  const started = Date.now();
  const deadline = started + RECOVER_WINDOW_MS;
  let nextNotice = started + RECOVER_NOTICE_MS;

  while (Date.now() < deadline && stillMissing()) {
    try {
      await withLocalAfc(session, async (afc) => {
        while (Date.now() < deadline && stillMissing()) {
          for (let index = 0; index < names.length; index++) {
            if (out[index]) continue;
            try {
              await afc.stat(names[index]);
              out[index] = await afc.readFile(names[index]);
            } catch {
              // 这一个还没落下来，看下一个。
            }
          }
          if (!stillMissing()) return;
          if (Date.now() >= nextNotice) {
            const got = out.filter((bytes) => bytes !== null).length;
            log(`等设备落盘…（${Math.round((Date.now() - started) / 1000)} 秒，到了 ${got}/${names.length}）`);
            nextNotice = Date.now() + RECOVER_NOTICE_MS;
          }
          await delay(RECOVER_INTERVAL_MS);
        }
      });
    } catch (error) {
      // 整条隧道没了就别耗着：再借也是白借，这个循环会以 250 ms 的节奏空转到窗口耗尽。
      if (isTunnelDropped(error)) throw error;
      // 只是这一条 AFC 连接断了（服务槽被抢、隧道抖动）：重借一条接着等，不算这一轮失败。
      log(`AFC 连接断了，重连接着等：${describeError(error)}`);
      await delay(RECOVER_INTERVAL_MS);
    }
  }
  return out;
}

/**
 * 一轮 ATC 把同一个目录下的若干文件搬到媒体域再取回来。**没取到的位置留 null，不抛。**
 *
 * 写成多文件的样子，但**调用方现在只传一个**：设备一轮只收一个越界资产（文件头第一条）。
 * 签名留着多文件的形状是因为这个限制是实测出来的、也许跟系统版本有关；真要改回去，
 * 这里和 `pollRecovered` 都不用动，只改调用方分组。
 *
 * 只负责「取出来」；读完原位就空了，写回是上一层的事——放在那里才能把同目录的几个
 * 文件凑成一轮写回。缺了算不算失败也由上一层定（`readDeviceFiles` 严格、
 * `tryReadDeviceFiles` 宽容）。
 */
async function readGroup(
  session: DeviceSession,
  directory: string,
  paths: string[],
  log: StatusReporter,
): Promise<(Uint8Array | null)[]> {
  const token = randomHex(10);
  const source = `${SOURCE_PREFIX}${token}`;
  const linkDestination = `${LINK_PREFIX}${token}`;
  const recovered = paths.map((_, index) => `${RECOVERED_PREFIX}${token}-${index}`);

  const entries = buildArchive(directory, [{ name: payloadName(0), data: utf8("airlift-read-probe") }]);
  const identifiers = [`../../${source}/p0/p1/p2/link`, ...paths.map((path) => posixRel(path, AIRLOCK_ROOT))];
  // 第 0 个是那条符号链接，其余按顺序各自落到自己的 recovered 名下。
  const assets: AtcAsset[] = identifiers.map((identifier, index) => ({
    identifier,
    destination: index === 0 ? linkDestination : recovered[index - 1],
  }));

  await stageArchive(session, source, entries, log);
  const original = await withLocalAfc(session, (afc) => installBooksManifest(afc, identifiers, log));

  const data: (Uint8Array | null)[] = paths.map(() => null);
  try {
    log(`请设备把 ${paths.map(baseName).join("、")} 搬到媒体域…`);
    await runAtcSync(session, assets, log);

    const got = await pollRecovered(session, recovered, log);
    got.forEach((bytes, index) => {
      data[index] = bytes;
    });
  } finally {
    await withLocalAfc(session, async (afc) => {
      await restoreBooksManifest(afc, original, log);
      await afc.removePath(linkDestination);
      await removeArchive(afc, source, entries);
      // 只删**已经取到**的那几个。没取到的名字下随时可能落下设备晚一步搬过来的那一份，
      // 而原路径上的文件已经被搬走了——这里删掉就再也找不回来。留着它等「抢救残留」。
      for (let index = 0; index < recovered.length; index++) {
        if (data[index]) await afc.removePath(recovered[index]);
      }
    }).catch(() => undefined);
  }

  log(`读回 ${paths.length} 个文件：${data.map((bytes) => bytes?.length ?? 0).join(" / ")} 字节`);
  return data;
}

// ── 残留 ──────────────────────────────────────────────────────────────────────

/** 媒体域根下的一条 airlift 残留。 */
export interface AirliftLeftover {
  /** 相对 `/var/mobile/Media` 的名字。 */
  name: string;
  /** 真实数据（读回搬出来、没来得及取走的那一份），还是只是暂存。 */
  recovered: boolean;
}

/** AFC 根（`/var/mobile/Media`）下的条目名；两种写法都试一下。 */
async function rootEntries(afc: LocalAfc): Promise<string[]> {
  for (const root of ["/", "."]) {
    const names = await afc.readDirectory(root).catch(() => null);
    if (names) return names;
  }
  return [];
}

/**
 * 列出媒体域根下的 airlift 残留。
 *
 * `airlift-recovered-*` 要当**真实数据**看：读回超时时设备上的原件已经被搬走，那一份就是它，
 * 取回来之前别删。`airlift-src-*` / `airlift-link-*` 只是暂存树，删了无妨。
 */
export async function listAirliftLeftovers(session: DeviceSession): Promise<AirliftLeftover[]> {
  return withLocalAfc(session, async (afc) => {
    const names = await rootEntries(afc);
    return names
      .filter(
        (name) => name.startsWith(RECOVERED_PREFIX) || name.startsWith(SOURCE_PREFIX) || name.startsWith(LINK_PREFIX),
      )
      .map((name) => ({ name, recovered: name.startsWith(RECOVERED_PREFIX) }));
  });
}

/** 取回一条残留的内容（不删，取完由调用方决定）。 */
export async function readAirliftLeftover(session: DeviceSession, name: string): Promise<Uint8Array> {
  return withLocalAfc(session, (afc) => afc.readFile(name));
}

/** 递归删：AFC 的 remove 只收得掉空目录，暂存树得从叶子往上删。 */
async function removeTree(afc: LocalAfc, path: string): Promise<void> {
  const children = await afc.readDirectory(path).catch(() => null);
  if (children) {
    for (const child of children) {
      if (child === "." || child === "..") continue;
      await removeTree(afc, joinPath(path, child));
    }
  }
  await afc.removePath(path);
}

/** 删掉指定的残留。调用方自己确认 `airlift-recovered-*` 里的内容已经取走。 */
export async function removeAirliftLeftovers(session: DeviceSession, names: string[], log: StatusReporter = () => {}): Promise<void> {
  if (names.length === 0) return;
  await withLocalAfc(session, async (afc) => {
    for (const name of names) await removeTree(afc, name);
  });
  log(`清掉 ${names.length} 条残留`);
}
