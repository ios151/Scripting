// 只写不压缩的 ZIP（stored），够 StreamingZip 那条安装链用。
//
// 为什么自己写：设备的 streaming_zip_conduit 认的不是「普通 zip」这一件事——
// 每个条目都要带上 unix 模式位，而且模式还要额外写进 Apple 私有的 0x5A53 扩展字段
// （照参考实现 `zip_opts()`：external attributes = mode << 16，扩展字段里再放一份 u16 小端）。
// 现成的打包器不会同时给这两样，干脆按需生成。
//
// 不做的事：压缩（deflate）、zip64、加密、注释、多盘。条目少、体积小，够用。

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_END = 0x06054b50;

/** 没有压缩、没有数据描述符（长度都提前知道）。 */
const FLAGS = 0;
const METHOD_STORED = 0;
/** 20 = 2.0，支持目录项与 stored。 */
const VERSION = 20;
/** 3 = unix，写在「version made by」的高字节，设备靠它解释 external attributes。 */
const PLATFORM_UNIX = 3;
/** Apple 私有的扩展字段 id（小端写出来是 53 5A），内容是模式的 u16 小端。 */
const EXTRA_MODE_ID = 0x5a53;

/** 条目要用的 unix 模式位（含文件类型）。 */
export const ZipMode = {
  directory: 0o040755,
  file: 0o100600,
  symlink: 0o120777,
} as const;

export interface ZipEntry {
  /** 条目名。目录要以 `/` 结尾。 */
  name: string;
  /** 内容。目录不写。 */
  data?: Uint8Array;
  /** unix 模式位，见 `ZipMode`。 */
  mode: number;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let value = 0xffffffff;
  for (let index = 0; index < data.length; index++) {
    value = CRC_TABLE[(value ^ data[index]) & 0xff] ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

/** 按段攒字节，最后拼一次。 */
class ByteWriter {
  private readonly parts: Uint8Array[] = [];
  private length = 0;

  get offset(): number {
    return this.length;
  }

  push(bytes: Uint8Array): void {
    this.parts.push(bytes);
    this.length += bytes.length;
  }

  u16(value: number): void {
    const out = new Uint8Array(2);
    new DataView(out.buffer).setUint16(0, value & 0xffff, true);
    this.push(out);
  }

  u32(value: number): void {
    const out = new Uint8Array(4);
    new DataView(out.buffer).setUint32(0, value >>> 0, true);
    this.push(out);
  }

  toBytes(): Uint8Array {
    const out = new Uint8Array(this.length);
    let offset = 0;
    for (const part of this.parts) {
      out.set(part, offset);
      offset += part.length;
    }
    return out;
  }
}

function utf8Bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** MS-DOS 的日期时间字段（秒只有 2 秒精度）。 */
function dosStamp(date: Date): { time: number; date: number } {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const day = Math.max(0, date.getFullYear() - 1980);
  return { time: time & 0xffff, date: ((day << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) & 0xffff };
}

/** 模式位：外部属性放高 16 位，Apple 私有字段里再放一份 u16 小端。 */
function modeExtra(mode: number): Uint8Array {
  return new Uint8Array([EXTRA_MODE_ID & 0xff, (EXTRA_MODE_ID >>> 8) & 0xff, 0x02, 0x00, mode & 0xff, (mode >>> 8) & 0xff]);
}

interface Prepared {
  entry: ZipEntry;
  name: Uint8Array;
  data: Uint8Array;
  crc: number;
  extra: Uint8Array;
  offset: number;
}

/**
 * 打一个 stored 的 zip。目录条目即使没有内容也会写一条记录——
 * 设备是照着条目里的模式位建目录的，缺了就不会有那个目录。
 */
export function writeStoredZip(entries: ZipEntry[], now: Date = new Date()): Uint8Array {
  const stamp = dosStamp(now);
  const body = new ByteWriter();
  const prepared: Prepared[] = [];

  for (const entry of entries) {
    const name = utf8Bytes(entry.name);
    const data = entry.data ?? new Uint8Array(0);
    const extra = modeExtra(entry.mode);
    const crc = crc32(data);
    const offset = body.offset;

    body.u32(SIG_LOCAL);
    body.u16(VERSION);
    body.u16(FLAGS);
    body.u16(METHOD_STORED);
    body.u16(stamp.time);
    body.u16(stamp.date);
    body.u32(crc);
    body.u32(data.length);
    body.u32(data.length);
    body.u16(name.length);
    body.u16(extra.length);
    body.push(name);
    body.push(extra);
    body.push(data);

    prepared.push({ entry, name, data, crc, extra, offset });
  }

  const central = new ByteWriter();
  for (const item of prepared) {
    central.u32(SIG_CENTRAL);
    central.u16((PLATFORM_UNIX << 8) | VERSION);
    central.u16(VERSION);
    central.u16(FLAGS);
    central.u16(METHOD_STORED);
    central.u16(stamp.time);
    central.u16(stamp.date);
    central.u32(item.crc);
    central.u32(item.data.length);
    central.u32(item.data.length);
    central.u16(item.name.length);
    central.u16(item.extra.length);
    central.u16(0); // 注释长度
    central.u16(0); // 起始盘号
    central.u16(0); // 内部属性
    central.u32((item.entry.mode & 0xffff) << 16); // 外部属性 = 模式位
    central.u32(item.offset);
    central.push(item.name);
    central.push(item.extra);
  }

  const centralBytes = central.toBytes();
  const head = body.toBytes();
  const end = new ByteWriter();
  end.u32(SIG_END);
  end.u16(0);
  end.u16(0);
  end.u16(prepared.length);
  end.u16(prepared.length);
  end.u32(centralBytes.length);
  end.u32(head.length);
  end.u16(0);

  const endBytes = end.toBytes();
  const out = new Uint8Array(head.length + centralBytes.length + endBytes.length);
  out.set(head, 0);
  out.set(centralBytes, head.length);
  out.set(endBytes, head.length + centralBytes.length);
  return out;
}
