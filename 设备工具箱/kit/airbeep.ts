// 通话录音提示音：把系统的「开始录音 / 结束录音」提示音换成静音，或者还原回原声。
//
// **思路来自 @Waa404**——「用 StreamingZip + AirTraffic 把文件送进媒体域之外」这条路是他趟出来的，
// 这里是在那个基础上重写的实现。相对原作改了这些：读回轮询复用同一条 AFC 连接（每轮重借会把
// 探测间隔拉到秒级，抓不住设备搬过来的那一瞬）、同目录的文件凑一轮写回、读不到时**不删**
// 媒体域里的 `airlift-recovered-*`（那是搬运式读取下用户仅存的一份）、默认不做读回校验。
// 每条改动的来由都写在 kit/airlift.ts 的文件头和各函数注释里。
//
// 协议细节另外参考了 idevice 和 pymobiledevice3 这两个开源实现。
//
// 这两个文件在媒体域之外（/var/mobile/Library/CallServices/Greetings/default/），
// AFC 看不到，读和写都得走 kit/airlift.ts 那条 StreamingZip + AirTraffic 链，
// 一次操作要跑好几轮隧道（每轮十几秒）。所以本模块只做动作，不放进页面加载路径：
// 想知道当前状态得用户明确点「重新检查」。
//
// 两个文件的格式不一样，替换用的静音也跟着不一样：
// - StartDisclosureWithTone.m4a：设备上是 AAC-LC 44.1 kHz 单声道，用等长的 AAC 静音；
// - StopDisclosure.caf：设备上是 Opus，但 CAF 容器里换成 LPCM 一样播得出来，
//   所以现拼一个 LPCM 48 kHz 单声道的静音文件（130 字节头 + 全零样本），
//   不用把 170 KB 常量塞进源码。
//
// 读是破坏性的（设备把文件搬到媒体域再拷出来），而且刚写过的文件有一阵不肯再交回来；
// 所以：只有第一次（还没有本机备份）才去读原声；平时「静音」直接重写一遍静音，不读就不动设备。
// 真的写失败就把原声写回去，不让设备停在「提示音没了」。
//
// **写完不做读回校验。** 校验要再跑三轮（两个文件各读一轮 + 写回一轮），占掉整个操作四分之三
// 的时间，而它本来就时灵时不灵；没过的时候更是白费——照样要重写一遍、状态照样记不准、照样得
// 再查一次。所以写完就算完，想确认由用户点「重新检查设备状态」。

import { fromBase64, toBytes } from "../core/bytes";
import { describeError } from "../core/debug";
import {
  listAirliftLeftovers,
  readAirliftLeftover,
  removeAirliftLeftovers,
  tryReadDeviceFiles,
  writeDeviceFiles,
} from "./airlift";
import { isTunnelDropped, type DeviceSession, type StatusReporter } from "./session";

/** 提示音所在目录（媒体域之外）。 */
export const GREETINGS_DIR = "/var/mobile/Library/CallServices/Greetings/default";

/** 备份落到「文件」App 里的目录名。 */
export const TONE_BACKUP_FOLDER = "通话提示音原声";

/** 设备上当前是哪种提示音。 */
export type ToneMode = "silent" | "original" | "unknown";

export interface ToneFile {
  /** 设备上的文件名，也是备份文件名。 */
  name: string;
  /** 设备上的完整路径。 */
  path: string;
}

export const TONE_FILES: ToneFile[] = [
  { name: "StartDisclosureWithTone.m4a", path: `${GREETINGS_DIR}/StartDisclosureWithTone.m4a` },
  { name: "StopDisclosure.caf", path: `${GREETINGS_DIR}/StopDisclosure.caf` },
];

/** 一次检查的结果。 */
export interface ToneReport {
  mode: ToneMode;
  /** 每个文件一行说明，直接显示给用户。 */
  lines: string[];
}

const MODE_KEY = "devicekit_tone_mode_v1";

/**
 * 开始录音提示音的静音版：AAC-LC 44.1 kHz 单声道 1.84 秒。
 *
 * 由 ffmpeg 生成（`anullsrc` → AAC），和设备上原文件同格式，内嵌进源码。
 */
const SILENT_START_BASE64 = [
  "AAAAHGZ0eXBNNEEgAAACAE00QSBpc29taXNvMgAAAAhmcmVlAAABXW1kYXTeAgBMYXZjNTkuMTguMTAwAAIwQA4BGCAHARggBwEYIAcBGCAHARgg",
  "BwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARgg",
  "BwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARgg",
  "BwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARgg",
  "BwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwAABD9tb292AAAAbG12aGQAAAAAAAAAAAAAAAAAAAPoAAAH",
  "MAABAAABAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAAD",
  "aXRyYWsAAABcdGtoZAAAAAMAAAAAAAAAAAAAAAEAAAAAAAAHMAAAAAAAAAAAAAAAAQEAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAA",
  "AEAAAAAAAAAAAAAAAAAAACRlZHRzAAAAHGVsc3QAAAAAAAAAAQAABzAAAAQAAAEAAAAAAuFtZGlhAAAAIG1kaGQAAAAAAAAAAAAAAAAAAKxEAAFA",
  "+FXEAAAAAAAtaGRscgAAAAAAAAAAc291bgAAAAAAAAAAAAAAAFNvdW5kSGFuZGxlcgAAAAKMbWluZgAAABBzbWhkAAAAAAAAAAAAAAAkZGluZgAA",
  "ABxkcmVmAAAAAAAAAAEAAAAMdXJsIAAAAAEAAAJQc3RibAAAAGpzdHNkAAAAAAAAAAEAAABabXA0YQAAAAAAAAABAAAAAAAAAAAAAgAQAAAAAKxE",
  "AAAAAAA2ZXNkcwAAAAADgICAJQABAASAgIAXQBUAAAAAAfQAAAAFuAWAgIAFEghW5QAGgICAAQIAAAAgc3R0cwAAAAAAAAACAAAAUAAABAAAAAAB",
  "AAAA+AAAABxzdHNjAAAAAAAAAAEAAAABAAAAUQAAAAEAAAFYc3RzegAAAAAAAAAAAAAAUQAAABUAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAE",
  "AAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAE",
  "AAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAE",
  "AAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAE",
  "AAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAABRzdGNvAAAAAAAAAAEAAAAsAAAAGnNncGQBAAAAcm9sbAAAAAIAAAAB",
  "//8AAAAcc2JncAAAAAByb2xsAAAAAQAAAFEAAAABAAAAYnVkdGEAAABabWV0YQAAAAAAAAAhaGRscgAAAAAAAAAAbWRpcmFwcGwAAAAAAAAAAAAA",
  "AAAtaWxzdAAAACWpdG9vAAAAHWRhdGEAAAABAAAAAExhdmY1OS4xNi4xMDA=",
].join("");

/**
 * 结束录音提示音的静音版：CAF 的 130 字节头部（desc / chan / info / data 四个块，
 * 声明 LPCM 48 kHz 单声道、数据区 169924 字节）＋ 全零样本。
 */
const SILENT_STOP_HEADER_BASE64 =
  "Y2FmZgABAABkZXNjAAAAAAAAACBA53AAAAAAAGxwY20AAAACAAAAAgAAAAEAAAABAAAAEGNoYW4AAAAAAAAADABkAAEAAAAAAAAAAGluZm8AAAAAAAAAGgAAAAFlbmNvZGVyAExhdmY1OS4xNi4xMDAAZGF0YQAAAAAAApfEAAAAAA==";

/** 零样本长度：1.77 秒 × 48 kHz × 2 字节。 */
const SILENT_STOP_SAMPLES = 169_920;

let cachedSilentTones: Uint8Array[] | null = null;

/** 两个文件对应的静音内容，顺序与 `TONE_FILES` 一致。 */
export function silentTones(): Uint8Array[] {
  if (!cachedSilentTones) {
    const header = fromBase64(SILENT_STOP_HEADER_BASE64);
    const stop = new Uint8Array(header.length + SILENT_STOP_SAMPLES);
    stop.set(header);
    cachedSilentTones = [fromBase64(SILENT_START_BASE64), stop];
  }
  return cachedSilentTones;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) return false;
  return true;
}

/** 把每个文件的读取结果写成一行说明，返回其中「已经是静音」的个数。 */
function silentLines(current: (Uint8Array | null)[], silent: Uint8Array[], lines: string[]): number {
  let count = 0;
  const backedUp = hasToneBackup();
  TONE_FILES.forEach((file, index) => {
    const bytes = current[index];
    if (!bytes) {
      lines.push(
        backedUp
          ? `${file.name}：读不到（设备上那份可能已经被搬走；点「还原系统原声」会把本机备份写回去）`
          : `${file.name}：读不到，本机也没有备份（点「抢救残留」看看它是不是卡在媒体域里）`,
      );
      return;
    }
    if (sameBytes(bytes, silent[index])) {
      count++;
      lines.push(`${file.name}：已静音（${bytes.length} 字节）`);
    } else {
      lines.push(`${file.name}：系统原声（${bytes.length} 字节）`);
    }
  });
  return count;
}

/** 备份目录：Documents/通话提示音原声。 */
export function toneBackupDirectory(): string {
  return `${FileManager.documentsDirectory.replace(/\/+$/, "")}/${TONE_BACKUP_FOLDER}`;
}

/** 备份文件路径（不一定存在）。 */
export function toneBackupPath(file: ToneFile): string {
  return `${toneBackupDirectory()}/${file.name}`;
}

/** 两个原声都在才算有备份。 */
export function hasToneBackup(): boolean {
  return TONE_FILES.every((file) => FileManager.existsSync(toneBackupPath(file)));
}

/** 上次操作记下的状态；没操作过就是 unknown。 */
export function loadToneMode(): ToneMode {
  const stored = Storage.get<{ mode?: string }>(MODE_KEY);
  return stored?.mode === "silent" || stored?.mode === "original" ? stored.mode : "unknown";
}

export function saveToneMode(mode: ToneMode): void {
  Storage.set(MODE_KEY, { mode });
}

/**
 * 把设备上的提示音读回来。
 *
 * `restore` 为真时读完原样写回（只检查，不改设备）；为假时不还回去——调用方要么
 * 紧接着写新的，要么自己负责把读走的内容塞回去。单个文件读不到记 `null`，不中断整批。
 * 返回 `errors`：每个读取失败的完整错误字符串，供上层展示。
 */
async function readTones(
  session: DeviceSession,
  log: StatusReporter,
  restore: boolean,
): Promise<{ data: (Uint8Array | null)[]; errors: string[] }> {
  const errors: string[] = [];
  try {
    // 两个文件在**同一个目录**，一轮 ATC 就能搬完。一个一个读是两轮握手，白搭几十秒。
    const paths = TONE_FILES.map((file) => file.path);
    const data = await tryReadDeviceFiles(session, paths, log, { restore });
    TONE_FILES.forEach((file, index) => {
      if (data[index]) return;
      const msg = `${file.name}：设备没把它交到媒体域（可能这会儿不肯交，也可能已经不在了）`;
      log(`读不到 ${msg}`);
      errors.push(msg);
    });
    return { data, errors };
  } catch (error) {
    // 整轮就没跑起来（隧道断了、暂存没成…）：两个都算没读到。
    const msg = describeError(error);
    log(`读取失败：${msg}`);
    return { data: TONE_FILES.map(() => null), errors: [msg] };
  }
}

/** 单个文件的本机备份内容；没有（或读不出来）就是 `null`。 */
function readToneBackupBytes(file: ToneFile): Uint8Array | null {
  const path = toneBackupPath(file);
  if (!FileManager.existsSync(path)) return null;
  try {
    return toBytes(FileManager.readAsBytesSync(path));
  } catch {
    return null;
  }
}

/** 本机备份里的两份原声，按 `TONE_FILES` 对齐；缺哪个就是 `null`。 */
function readToneBackup(): (Uint8Array | null)[] {
  return TONE_FILES.map(readToneBackupBytes);
}

/** 两份备份内容，按 `TONE_FILES` 对齐；缺一份就抛错（「还原」专用）。 */
function toneBackupContents(): Uint8Array[] {
  const contents: Uint8Array[] = [];
  const missing: string[] = [];
  TONE_FILES.forEach((file) => {
    const bytes = readToneBackupBytes(file);
    if (bytes) contents.push(bytes);
    else missing.push(file.name);
  });
  if (missing.length > 0) throw new Error(`本机没有 ${missing.join("、")} 的备份，没法还原`);
  return contents;
}

/**
 * 把读到的原声落盘备份；已有的那份不动（保留最早），返回这次存下几个。
 *
 * 跟静音版一字不差的内容不存：那是上一轮自己写下去的，存成「原声」就再也还原不回去了。
 */
function saveToneBackup(current: (Uint8Array | null)[], log: StatusReporter): number {
  const directory = toneBackupDirectory();
  const silent = silentTones();
  let saved = 0;
  let skipped = 0;
  TONE_FILES.forEach((file, index) => {
    const bytes = current[index];
    const path = toneBackupPath(file);
    if (!bytes || FileManager.existsSync(path)) return;
    if (sameBytes(bytes, silent[index])) {
      skipped += 1;
      return;
    }
    if (!FileManager.existsSync(directory)) FileManager.createDirectorySync(directory, true);
    FileManager.writeAsBytesSync(path, bytes);
    saved += 1;
  });
  if (saved > 0) log(`原声已备份到「文件」App ▸ Scripting ▸ ${TONE_BACKUP_FOLDER}`);
  else if (skipped > 0) log("设备上现在是静音版，没有可备份的原声。");
  return saved;
}

/**
 * 把手上这两份内容写回设备。
 *
 * 用在出错流程里：失败只记日志、不再抛，返回「到底有没有写下去」。
 */
async function writeQuietly(
  session: DeviceSession,
  log: StatusReporter,
  bytes: (Uint8Array | null)[],
): Promise<boolean> {
  const files = TONE_FILES.map((file, index) => ({ name: file.name, data: bytes[index] })).filter(
    (item): item is { name: string; data: Uint8Array } => item.data !== null,
  );
  if (files.length === 0) {
    log("手头没有可写回的内容；点「还原系统原声」或「静音录音提示音」能把文件重写上去。");
    return false;
  }
  try {
    await writeDeviceFiles(session, GREETINGS_DIR, files, log, { verify: false });
    return true;
  } catch (error) {
    log(
      isTunnelDropped(error)
        ? "连接断开了，这一份没写回去。重新连上之后点「还原系统原声」补一次。"
        : `写回失败：${describeError(error)}（本机备份还在，可以点「还原」重试）`,
    );
    return false;
  }
}

/** 检查设备上的真实状态（读回来跟静音资源比对）。慢：两个文件各要跑两轮隧道。 */
export async function inspectTones(session: DeviceSession, log: StatusReporter = () => {}): Promise<ToneReport> {
  // restore=false：读出来的字节先落本机备份，再由这里统一写回设备。
  // 交给 airlift 自己 restore 的话，写回那一步失败时读出来的内容会跟着异常一起丢掉，
  // 而设备上那一份已经被搬走——一次「只是看看」的检查就足以把原声弄没。
  const { data: current, errors } = await readTones(session, log, false);
  const silent = silentTones();
  const lines: string[] = [];
  const failed = current.filter((bytes) => bytes === null).length;

  saveToneBackup(current, log);
  if (failed < TONE_FILES.length) {
    log("把读出来的内容写回设备…");
    if (!(await writeQuietly(session, log, current))) {
      lines.push("读出来了但没写回设备；内容已存进本机备份，点「还原系统原声」能补上。");
    }
  }
  const silentCount = silentLines(current, silent, lines);

  const mode: ToneMode =
    failed === TONE_FILES.length
      ? "unknown"
      : silentCount === TONE_FILES.length
        ? "silent"
        : silentCount === 0
          ? "original"
          : "unknown";
  if (mode === "unknown") {
    lines.push("状态不确定：两个文件没读全，或者一个静音一个原声；先「静音」再「还原」，让它们对齐。");
    for (const err of errors) lines.push(`↳ ${err}`);
  } else {
    saveToneMode(mode);
  }
  return { mode, lines };
}

/**
 * 静音提示音：第一次先把设备上的原声读到本机备份，再把两个提示音换成静音。
 */
export async function applySilentTones(session: DeviceSession, log: StatusReporter = () => {}): Promise<void> {
  const silent = silentTones();
  const files = TONE_FILES.map((file, index) => ({ name: file.name, data: silent[index] }));
  let originals = readToneBackup();

  if (originals.every((bytes) => bytes !== null)) {
    log("本机已有原声备份，这次不去读设备上的文件。");
  } else {
    log("还没有原声备份，先把设备上的原声读出来…");
    const { data: current } = await readTones(session, log, false);
    if (current.every((bytes) => bytes === null)) {
      throw new Error(`两个提示音都读不到，确认一下设备和系统版本（${GREETINGS_DIR}）`);
    }
    saveToneBackup(current, log);
    originals = readToneBackup();
  }

  try {
    log("写入静音提示音…");
    await writeDeviceFiles(session, GREETINGS_DIR, files, log);
  } catch (error) {
    log("写入没成功，把设备恢复成系统原声…");
    const restored = await writeQuietly(session, log, originals);
    saveToneMode(restored ? "original" : "unknown");
    throw error;
  }

  saveToneMode("silent");
  log("已换成静音提示音。");
}

// ── 抢救残留 ──────────────────────────────────────────────────────────────────

function matchesAt(bytes: Uint8Array, offset: number, text: string): boolean {
  if (bytes.length < offset + text.length) return false;
  for (let index = 0; index < text.length; index++) if (bytes[offset + index] !== text.charCodeAt(index)) return false;
  return true;
}

/**
 * 按文件头认一下这段字节是哪一个提示音；认不出返回 -1。
 *
 * 残留的名字是随机 token，跟原文件名对不上，只能看内容：
 * CAF 开头就是 `caff`，M4A 在第 4 字节起是 `ftyp`。
 */
function matchToneFile(bytes: Uint8Array): number {
  if (matchesAt(bytes, 0, "caff")) return TONE_FILES.findIndex((file) => file.name.endsWith(".caf"));
  if (matchesAt(bytes, 4, "ftyp")) return TONE_FILES.findIndex((file) => file.name.endsWith(".m4a"));
  return -1;
}

export interface RescueReport {
  lines: string[];
  /** 救回来并写回设备的个数。 */
  recovered: number;
}

/**
 * 抢救卡在媒体域里的提示音。
 *
 * 读是搬运式的：读回超时的时候设备上的原件已经搬走，内容就停在媒体域的
 * `airlift-recovered-*` 底下。把它认出来、存本机、写回原路径，再清掉残留。
 * 「两个文件都读不到」时先走这一步——原声很可能就在那儿。
 */
export async function rescueTones(session: DeviceSession, log: StatusReporter = () => {}): Promise<RescueReport> {
  const leftovers = await listAirliftLeftovers(session);
  const lines: string[] = [];
  if (leftovers.length === 0) {
    lines.push("媒体域里没有 airlift 残留：设备上的文件没有卡在这条链半路。");
    return { lines, recovered: 0 };
  }

  const stale = leftovers.filter((item) => !item.recovered).map((item) => item.name);
  const pending = leftovers.filter((item) => item.recovered);
  log(`媒体域里有 ${leftovers.length} 条残留，其中 ${pending.length} 条是搬出来没取走的文件`);

  const silent = silentTones();
  const found: (Uint8Array | null)[] = TONE_FILES.map(() => null);
  const taken: string[] = [];

  for (const item of pending) {
    let bytes: Uint8Array;
    try {
      bytes = await readAirliftLeftover(session, item.name);
    } catch (error) {
      lines.push(`${item.name}：取不出来（${describeError(error)}），先留着`);
      continue;
    }
    const index = matchToneFile(bytes);
    if (index < 0) {
      lines.push(`${item.name}：${bytes.length} 字节，不是这两个提示音，没动它`);
      continue;
    }
    const kind = sameBytes(bytes, silent[index]) ? "静音版" : "原声";
    lines.push(`${item.name} → ${TONE_FILES[index].name}（${kind}，${bytes.length} 字节）`);
    found[index] = bytes;
    taken.push(item.name);
  }

  // 先落本机，再写回设备：写回失败也不至于两头都没有。
  saveToneBackup(found, log);

  let recovered = 0;
  if (taken.length > 0) {
    if (await writeQuietly(session, log, found)) {
      recovered = taken.length;
      lines.push("已把救回来的内容写回设备原路径。");
      await removeAirliftLeftovers(session, taken, log).catch(() => undefined);
    } else {
      lines.push("写回设备没成功，残留先留着没删，下次还能再试。");
    }
  }

  if (stale.length > 0) {
    await removeAirliftLeftovers(session, stale, log).catch(() => undefined);
    lines.push(`顺手清掉 ${stale.length} 条暂存残留。`);
  }

  saveToneMode("unknown");
  lines.push("点「重新检查设备状态」确认一遍。");
  return { lines, recovered };
}

/** 还原系统原声：把本机备份写回设备。 */
export async function restoreOriginalTones(session: DeviceSession, log: StatusReporter = () => {}): Promise<void> {
  const backups = toneBackupContents();
  const files = TONE_FILES.map((file, index) => ({ name: file.name, data: backups[index] }));

  log("写回系统原声…");
  try {
    await writeDeviceFiles(session, GREETINGS_DIR, files, log);
  } catch (error) {
    log("写回没成功，再写一遍原声…");
    await writeQuietly(session, log, backups);
    saveToneMode("unknown");
    throw error;
  }

  saveToneMode("original");
  log("已还原系统原声。");
}
