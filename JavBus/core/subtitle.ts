// 字幕：迅雷字幕库的检索与挑选、字幕文件的编码识别与解析、按播放时间取当前这一句。
// 纯逻辑；联网和解码在 kit/subtitle.ts，画到播放器上在 pages/useSubtitles.ts 和 PlayerCard.tsx。
//
// 迅雷的接口 api-shoulei-ssl.xunlei.com/oracle/subtitle?name=… 是按文件名模糊搜的网友上传库。2026-10-22 实测的脾气：
// - 对写法敏感：「SSIS-123」搜得到、「SSIS00123」搜不到；「SSIS-001」搜不到、「SSIS00001」反而搜得到。
//   所以每个番号换几种写法各搜一遍，合并；
// - 结果里混着不相干的（搜「MIDE001」会出来一堆 RunningMan E001），要拿文件名对回番号；
// - 同一份字幕被传了很多遍（同名、时长差几秒），还有「文件名 = 另一份的 gcid」的转存件；
// - 个别链接已经失效（OSS 回一页 NoSuchKey 的 XML）；有的 .ass 里装的其实是 SRT，有的文件是丢了 BOM 的 UTF-16、
//   有的是 GBK。扩展名和接口给的 duration 都不能全信，格式按内容认。

import { pad2 } from "./format";
import { decodeHtml } from "./parse";

export interface SubtitleCue {
  /** 秒 */
  start: number;
  end: number;
  /** 已去掉样式标记，多行用 \n 连接。 */
  text: string;
}

/** 接口里的一条字幕。 */
export interface SubtitleItem {
  url: string;
  name: string;
  /** 小写，不带点 */
  ext: string;
  /** 秒；0 = 接口没给 */
  duration: number;
  /** 接口的 gcid（文件指纹） */
  id: string;
}

/** 候选：同一份字幕被传了几遍的合成一条。 */
export interface SubtitleChoice {
  name: string;
  ext: string;
  duration: number;
  /** 被传了几遍。传得越多，通常越是大家都在用的那一份。 */
  copies: number;
  /** 下载地址，第一条是主链接，打不开依次顶上。 */
  urls: string[];
  /**
   * 字幕猫（core/subtitlecat.ts）的候选：没有这个字段的是迅雷的。urls 是空的——字幕猫的下载地址要进详情页 page 才找得到，
   * 点到这一条时才去读（kit/subtitle.ts 的 loadSubtitle）；origin 是这份字幕原本的语言（站上的英文写法）。
   */
  cat?: { page: string; origin: string };
}

/** 对应 Scripting 里 Data.toRawString 认的名字。 */
export type SubtitleEncoding = "utf-8" | "utf16LittleEndian" | "utf16BigEndian" | "gb18030";

/** 认得的格式，值越大越优先：SRT / VTT 不带样式，ASS / SSA 要剥标记，同等条件下前者更稳。 */
const EXT_RANK = new Map([
  ["srt", 3],
  ["vtt", 3],
  ["ass", 2],
  ["ssa", 2],
]);

/** 同名且时长差不超过这么多秒，算同一份。实测同一份被不同人传，时长相差 1~3 秒。 */
const DUPLICATE_GAP = 3;
const MAX_CHOICES = 12;
/** 结束时间不比开始时间晚（写错了）的那一条，给它留这么长。 */
const FALLBACK_LENGTH = 3;

// ———— 检索 ————

/** 番号拆成「系列 + 数字」：FC2-PPV-1234567 → FC2-PPV / 1234567，259LUXU-001 → 259LUXU / 001；拆不了（082315_001 这种日期式的）返回 null。 */
function splitCode(code: string): { series: string; digits: string } | null {
  const m = /^(.*?[A-Za-z])[\s_-]*(\d+)$/.exec(code.trim());
  return m ? { series: m[1], digits: m[2] } : null;
}

/** 一个番号要搜的几种写法：带横杠、补零到 5 位（DMM 的 cid 写法）、不带横杠不补零。 */
export function subtitleQueries(code: string): string[] {
  const text = code.trim().toUpperCase();
  if (!text) return [];
  const parts = splitCode(text);
  if (!parts) return [...new Set([text, text.replace(/_/g, "-")])];
  const head = parts.series.replace(/[\s_-]+/g, "");
  return [...new Set([`${parts.series}-${parts.digits}`, `${head}${parts.digits.padStart(5, "0")}`, `${head}${parts.digits}`])];
}

const squash = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, "");
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * 字幕文件名对不对得上这个番号。
 * 系列前面不能紧跟字母（免得 ABP-123 对上 FABP-123），数字后面不能再跟数字（免得 123 对上 1234）；
 * 数字前允许任意个 0（迅雷库里常见补成 5 位的 ssni00001），系列和数字之间的分隔符不限。
 */
export function matchesCode(name: string, code: string): boolean {
  const parts = splitCode(code);
  if (!parts) {
    const want = squash(code);
    return want.length >= 6 && squash(name).includes(want);
  }
  const number = parts.digits.replace(/^0+(?=\d)/, "");
  const series = parts.series
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map(escapeRegExp)
    .join("[\\s._-]*");
  if (new RegExp(`(^|[^a-z])${series}[\\s._-]*0*${number}(?!\\d)`, "i").test(name)) return true;
  // FC2 一类的长编号，文件名里常常只剩数字
  return parts.digits.length >= 6 && new RegExp(`(^|\\D)${number}(?!\\d)`).test(name);
}

/** 接口返回的 JSON → 条目。字段缺的、地址不是 http(s) 的丢掉；http 一律升到 https。 */
export function parseXunleiItems(json: unknown): SubtitleItem[] {
  const data = (json as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return [];
  const items: SubtitleItem[] = [];
  for (const entry of data) {
    if (!entry || typeof entry !== "object") continue;
    const r = entry as Record<string, unknown>;
    const url = typeof r.url === "string" ? r.url.replace(/^http:/i, "https:") : "";
    const name = typeof r.name === "string" ? r.name : "";
    if (!/^https:\/\//i.test(url) || !name) continue;
    const ext = (typeof r.ext === "string" && r.ext ? r.ext : (/\.([A-Za-z0-9]+)$/.exec(name)?.[1] ?? "")).toLowerCase();
    const ms = typeof r.duration === "number" && Number.isFinite(r.duration) ? r.duration : 0;
    items.push({ url, name, ext, duration: Math.max(0, Math.round(ms / 1000)), id: typeof r.gcid === "string" ? r.gcid : url });
  }
  return items;
}

/** 同名判断用：忽略大小写、空白、扩展名和结尾的「(1)」（重复下载的后缀）。 */
function canonicalName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\.[a-z0-9]{2,4}$/, "")
    .replace(/\s*\(\d+\)\s*$/, "")
    .replace(/\s+/g, "");
}

/**
 * 字幕时长和视频时长对得有多准，0（差得远）到 5（几乎一样）。时长对不上多半是另一个剪辑版本，时间轴整体会错位。
 * 接口没给时长、或视频时长还不知道（播放器没就绪）时给中间值，不加分也不扣分。
 */
export function durationFit(duration: number, video: number): number {
  if (video <= 0 || duration <= 0) return 2;
  const gap = Math.abs(duration - video);
  if (gap <= 3) return 5;
  if (gap <= 15) return 4;
  if (gap <= 60) return 3;
  if (gap <= 300) return 1;
  return 0;
}

/**
 * 从接口返回的条目里挑出候选，最合适的排最前：
 * 先过滤（格式认得、文件名对得上番号），再把重复的并成一条，然后按「时长对得准 > 被传得多 > 格式 > 接口原顺序」排。
 * 视频时长已知时，差五分钟以上的（多半是预告片 / 另一个版本）直接丢掉，除非丢完就一条不剩。
 */
export function buildChoices(items: SubtitleItem[], code: string, videoDuration = 0): SubtitleChoice[] {
  type Member = { item: SubtitleItem; index: number };
  const byName = new Map<string, Member[]>();
  items.forEach((item, index) => {
    if (!EXT_RANK.has(item.ext) || !matchesCode(item.name, code)) return;
    const key = canonicalName(item.name);
    const list = byName.get(key);
    if (list) list.push({ item, index });
    else byName.set(key, [{ item, index }]);
  });

  const groups: Member[][] = [];
  for (const list of byName.values()) {
    const known = list.filter((m) => m.item.duration > 0).sort((a, b) => a.item.duration - b.item.duration);
    let run: Member[] = [];
    for (const m of known) {
      if (run.length > 0 && m.item.duration - run[0].item.duration > DUPLICATE_GAP) {
        groups.push(run);
        run = [];
      }
      run.push(m);
    }
    if (run.length > 0) groups.push(run);
    const unknown = list.filter((m) => m.item.duration <= 0);
    if (unknown.length > 0) groups.push(unknown);
  }

  const ranked = groups.map((members) => {
    members.sort((a, b) => a.index - b.index);
    const head = members[0].item;
    const choice: SubtitleChoice = {
      name: head.name,
      ext: head.ext,
      duration: head.duration,
      copies: members.length,
      urls: [...new Set(members.map((m) => m.item.url))],
    };
    return { choice, fit: durationFit(head.duration, videoDuration), format: EXT_RANK.get(head.ext) ?? 0, first: members[0].index };
  });
  ranked.sort((a, b) => b.fit - a.fit || b.choice.copies - a.choice.copies || b.format - a.format || a.first - b.first);
  const usable = videoDuration > 0 && ranked.some((r) => r.fit > 0) ? ranked.filter((r) => r.fit > 0) : ranked;
  return usable.slice(0, MAX_CHOICES).map((r) => r.choice);
}

// ———— 编码 ————

/** 严格的 UTF-8 校验（拒绝过长编码、代理区、超出 U+10FFFF）。末尾被截断的半个字符放过，免得文件尾巴被截坏就整个判成 GBK。 */
export function isValidUtf8(bytes: Uint8Array): boolean {
  const n = bytes.length;
  let i = 0;
  while (i < n) {
    const b = bytes[i];
    if (b < 0x80) {
      i++;
      continue;
    }
    let extra = 0;
    let low = 0x80; // 第二个字节允许的范围
    let high = 0xbf;
    if (b >= 0xc2 && b <= 0xdf) extra = 1;
    else if (b === 0xe0) {
      extra = 2;
      low = 0xa0;
    } else if (b === 0xed) {
      extra = 2;
      high = 0x9f;
    } else if (b >= 0xe1 && b <= 0xef) extra = 2;
    else if (b === 0xf0) {
      extra = 3;
      low = 0x90;
    } else if (b === 0xf4) {
      extra = 3;
      high = 0x8f;
    } else if (b >= 0xf1 && b <= 0xf3) extra = 3;
    else return false;
    if (i + extra >= n) return true;
    if (bytes[i + 1] < low || bytes[i + 1] > high) return false;
    for (let k = 2; k <= extra; k++) {
      if (bytes[i + k] < 0x80 || bytes[i + k] > 0xbf) return false;
    }
    i += extra + 1;
  }
  return true;
}

/** 没有 BOM 的 UTF-16：字节流里每隔一个字节是 0（时间轴、序号都是 ASCII）。 */
function sniffWide(bytes: Uint8Array): { encoding: SubtitleEncoding; skip: number } | null {
  const n = Math.min(bytes.length, 4096);
  let evenNul = 0;
  let oddNul = 0;
  for (let i = 0; i < n; i++) {
    if (bytes[i] === 0) {
      if (i % 2 === 0) evenNul++;
      else oddNul++;
    }
  }
  if ((evenNul + oddNul) * 5 < n) return null; // 0 不到两成，不是 UTF-16
  const little = oddNul >= evenNul;
  // 开头可能有几个垃圾字节（实测有文件的 BOM 被转码弄成了 EF BF BD EF BF BD）：从第一个「可打印 ASCII + 00」处开始解
  for (let i = 0; i + 1 < n; i++) {
    const a = bytes[i];
    const b = bytes[i + 1];
    const ascii = little ? a >= 0x20 && a < 0x7f && b === 0 : a === 0 && b >= 0x20 && b < 0x7f;
    if (ascii) return { encoding: little ? "utf16LittleEndian" : "utf16BigEndian", skip: i };
  }
  return null;
}

/** 这份字节该按什么编码解、开头要跳过几个字节：BOM → 无 BOM 的 UTF-16 → 合法 UTF-8 → 都不是就当 GB18030（GBK 的超集）。 */
export function sniffEncoding(bytes: Uint8Array): { encoding: SubtitleEncoding; skip: number } {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return { encoding: "utf-8", skip: 3 };
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return { encoding: "utf16LittleEndian", skip: 2 };
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return { encoding: "utf16BigEndian", skip: 2 };
  const wide = sniffWide(bytes);
  if (wide) return wide;
  return { encoding: isValidUtf8(bytes) ? "utf-8" : "gb18030", skip: 0 };
}

/**
 * UTF-16 → 文本，宽松：落单的代理项照样放进字符串、末尾多出的半个单元丢掉，从不失败。
 * 不用系统的 Data.toRawString：实测有 UTF-16 的字幕文件中间被转码弄坏了一截，系统的严格解码会整个返回 null，
 * 而坏的只是几个字，305 条字幕本来都是好的。
 */
export function decodeUtf16(bytes: Uint8Array, littleEndian: boolean): string {
  let out = "";
  const units: number[] = [];
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    units.push(littleEndian ? bytes[i] | (bytes[i + 1] << 8) : (bytes[i] << 8) | bytes[i + 1]);
    if (units.length === 4096) {
      out += String.fromCharCode(...units);
      units.length = 0;
    }
  }
  return out + String.fromCharCode(...units);
}

// ———— 解析 ————

const TIME = String.raw`(?:(\d{1,3}):)?(\d{1,2}):(\d{2})[.,](\d{1,3})`;
/** SRT 与 WebVTT 的时间轴行。毫秒分隔符逗号 / 句点都有（实测同一个库里两种都有），VTT 的小时可省，行尾可跟定位设置。 */
const TIMING = new RegExp(`${TIME}\\s*-->\\s*${TIME}`);

function clock(hours: string | undefined, minutes: string, seconds: string, fraction: string): number {
  return Number(hours ?? 0) * 3600 + Number(minutes) * 60 + Number(seconds) + Number(`0.${fraction}`);
}

/** 去掉样式标记（{\an8}、<i>、<font …>）和控制字符（坏文件里会残留 NUL），解 HTML 实体，每行去空白、丢空行。 */
function cleanText(raw: string): string {
  return decodeHtml(raw.replace(/\{\\[^}]*\}/g, "").replace(/<[^>\n]*>/g, ""))
    .replace(/\t/g, " ")
    .replace(/[\u0000-\u0008\u000b-\u001f]/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .join("\n");
}

function parseTimed(lines: string[]): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  let i = 0;
  while (i < lines.length) {
    const m = TIMING.exec(lines[i]);
    if (!m) {
      i++;
      continue;
    }
    const start = clock(m[1], m[2], m[3], m[4]);
    let end = clock(m[5], m[6], m[7], m[8]);
    const body: string[] = [];
    i++;
    while (i < lines.length && lines[i].trim() !== "" && !TIMING.test(lines[i])) {
      body.push(lines[i]);
      i++;
    }
    // 两条之间没有空行时，下一条的序号行会被当成这一条的最后一行：它后面紧跟着下一条的时间轴行
    if (i < lines.length && lines[i].trim() !== "" && body.length > 0 && /^\s*\d+\s*$/.test(body[body.length - 1])) body.pop();
    if (end <= start) end = start + FALLBACK_LENGTH;
    const text = cleanText(body.join("\n"));
    if (text) cues.push({ start, end, text });
  }
  return cues;
}

const DEFAULT_ASS_COLUMNS = ["layer", "start", "end", "style", "name", "marginl", "marginr", "marginv", "effect", "text"];

/** 最多切成 n 段，多出来的逗号留在最后一段（ASS 的文本字段里会有逗号）。 */
function splitLimit(text: string, n: number): string[] {
  const parts: string[] = [];
  let rest = text;
  while (parts.length < n - 1) {
    const comma = rest.indexOf(",");
    if (comma < 0) break;
    parts.push(rest.slice(0, comma));
    rest = rest.slice(comma + 1);
  }
  parts.push(rest);
  return parts;
}

function assTime(text: string | undefined): number {
  const m = /^\s*(\d+):(\d{1,2}):(\d{1,2})[.,](\d{1,3})\s*$/.exec(text ?? "");
  return m ? clock(m[1], m[2], m[3], m[4]) : Number.NaN;
}

/**
 * 不看 [Events] 段头：实测有文件（PopSub 生成的，中间被转码弄坏了一截）段头和 Format 行都丢了，305 条 Dialogue 却都在，照样要能解。
 * 样式段里也有 Format 行（Name, Fontname…），所以只认同时带 Start 和 End 的那一行。
 */
function parseAss(lines: string[]): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  let columns = DEFAULT_ASS_COLUMNS;
  for (const line of lines) {
    const t = line.trim();
    const format = /^format\s*:(.*)$/i.exec(t);
    if (format) {
      const names = format[1].split(",").map((c) => c.trim().toLowerCase());
      if (names.includes("start") && names.includes("end")) columns = names;
      continue;
    }
    const dialogue = /^dialogue\s*:(.*)$/i.exec(t);
    if (!dialogue) continue;
    const fields = splitLimit(dialogue[1], columns.length);
    const start = assTime(fields[columns.indexOf("start")]);
    const end = assTime(fields[columns.indexOf("end")]);
    if (Number.isNaN(start) || Number.isNaN(end)) continue;
    const textAt = columns.indexOf("text");
    const raw = (textAt >= 0 ? fields[textAt] : fields[fields.length - 1]) ?? "";
    if (/\{[^}]*\\p[1-9]/.test(raw)) continue; // 矢量绘图，不是文字
    const text = cleanText(raw.replace(/\{[^}]*\}/g, "").replace(/\\[Nn]/g, "\n").replace(/\\h/g, " "));
    if (text) cues.push({ start, end: end > start ? end : start + FALLBACK_LENGTH, text });
  }
  return cues;
}

/**
 * 字幕文本 → 按开始时间排好的字幕条。格式按内容认（扩展名不可信）：有 [Script Info] / [Events] / Dialogue: 的当 ASS / SSA，
 * 其余当 SRT / WebVTT。解析不出东西返回空数组，由调用方当成「文件不对」。
 */
export function parseSubtitle(raw: string): SubtitleCue[] {
  const text = raw.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const lines = text.split("\n");
  const cues = /^\s*(?:\[script info\]|\[events\]|dialogue\s*:)/im.test(text) ? parseAss(lines) : parseTimed(lines);
  return cues.sort((a, b) => a.start - b.start);
}

// ———— 播放时取字幕 ————

/**
 * 这一刻该显示的字幕。cues 要按开始时间排好；同一刻有几条重叠的（ASS 里中日双语常见）按开始先后叠成多行。
 * 二分找到最后一条已开始的，再往前看几条有没有还没结束的。
 */
export function cueTextAt(cues: SubtitleCue[], time: number): string {
  let lo = 0;
  let hi = cues.length - 1;
  let last = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cues[mid].start <= time) {
      last = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  const lines: string[] = [];
  for (let i = last; i >= 0 && i > last - 8; i--) {
    if (cues[i].end > time) lines.unshift(cues[i].text);
  }
  return lines.join("\n");
}

/** 字幕是什么语言，只用来给用户看一眼（挑到日文 / 英文的好换一条）。样本太少返回空串。 */
export function detectLanguage(cues: SubtitleCue[]): string {
  let han = 0;
  let kana = 0;
  let latin = 0;
  for (const cue of cues.length > 400 ? cues.slice(0, 400) : cues) {
    for (const ch of cue.text) {
      const c = ch.codePointAt(0) ?? 0;
      if (c >= 0x3040 && c <= 0x30ff) kana++;
      else if ((c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3400 && c <= 0x4dbf)) han++;
      else if ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)) latin++;
    }
  }
  if (han + kana + latin < 30) return "";
  if (kana >= 20 && kana * 10 >= han + kana) return "日文"; // 假名占汉字加假名的一成以上
  if (han * 5 >= han + kana + latin) return "中文"; // 汉字占两成以上（中英双语也算中文）
  return latin > 0 ? "英文" : "";
}

// ———— 显示用 ————

/**
 * 字幕的字号和离底边的距离，跟着叠层的实际大小走（叠层在小窗里和在全屏里大小差很多）：
 * 小窗 361×242 约 14 / 44，横屏全屏 832×419 约 25 / 59，竖屏铺满 393×852 约 15 / 64。
 * 字号取「宽 / 26」和「高 / 17」里小的那个，免得横屏时（宽很大、高有限）字大到占满半屏；离底边至少 44，留出系统控制条的位置。
 */
export function subtitleMetrics(width: number, height: number): { fontSize: number; bottom: number } {
  const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
  return {
    fontSize: Math.round(clamp(Math.min(width / 26, height / 17), 13, 28)),
    bottom: Math.round(clamp(height * 0.14, 44, 64)),
  };
}

/** 3725 → 1:02:05，605 → 10:05。 */
export function formatClock(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${pad2(m)}:${pad2(s)}` : `${pad2(m)}:${pad2(s)}`;
}

/** 同步偏移的说法：正数 = 字幕提前出现，负数 = 延后。 */
export function offsetLabel(offset: number): string {
  const v = Math.round(Math.abs(offset) * 10) / 10;
  if (v === 0) return "无偏移";
  return `${offset > 0 ? "提前" : "延后"} ${v} 秒`;
}

/** 偏移加一档，按 0.1 秒取整（免得连加 0.5 积出浮点尾巴），限制在 ±10 分钟内。 */
export function shiftOffset(current: number, delta: number): number {
  const next = Math.round((current + delta) * 10) / 10;
  return Math.max(-600, Math.min(600, next));
}

/** 字幕时长对视频时长的说法，两边有一边不知道就返回空串。 */
export function durationGapLabel(duration: number, video: number): string {
  if (duration <= 0 || video <= 0) return "";
  const gap = Math.round(duration - video);
  if (Math.abs(gap) <= 3) return "时长吻合";
  const size = Math.abs(gap) >= 60 ? `${Math.round(Math.abs(gap) / 60)} 分钟` : `${Math.abs(gap)} 秒`;
  return `时长${gap > 0 ? "长" : "短"} ${size}`;
}
