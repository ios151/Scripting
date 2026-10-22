// 字幕分层：一句字幕在画面上画成几行，每行一块自己的底条（「双层字幕」）。纯逻辑，画出来在 pages/SubtitleParts.tsx。
//
// 朋友在油猴脚本里做过「过长的字幕分双层显示」，效果不错：一整句挤成一大块底条会盖掉半个画面，拆成上下两条窄的好得多。
// 规则：
// - 原来就分行的（中日双语的两行）一行一层；
// - 单行放不下一行的，在中间附近断成上下两层。断点优先选标点之后、空格处，没有就在字和字之间选离平分点最近的；
//   不让标点、长音、小假名落到行首，也不让开括号、开引号落到行尾；
// - 拉丁字母的词中间不断（只在空格处断）；一整个放不下又没处可断的（长网址之类）原样留着，让 Text 自己折；
// - 总共超过 maxRows 层就不拆了：拆得越多盖得越多，不如保持原样。

/** 一个汉字的宽度算 1，空格、拉丁字母数字和半角标点按下面两个比例折算（比例是目测的，只用来估一行放不放得下）。 */
const LATIN_WIDTH = 0.55;
const SPACE_WIDTH = 0.3;
/** 断开后每层至少这么宽（以汉字宽度计）：免得断出一两个字的小尾巴。 */
const MIN_LAYER = 3;
/** 没处挑标点 / 空格、只能在字间硬断时，相对「恰好平分」的惩罚，占整行宽度的比例。 */
const PLAIN_PENALTY = 0.18;

const WIDE = /^[\u1100-\u115f\u2014-\u2015\u2018-\u2019\u201c-\u201d\u2026\u2e80-\u303e\u3041-\u33ff\u3400-\u4dbf\u4e00-\u9fff\ua000-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]$/u;
/** 断在它后面最自然：句内标点、句末标点、闭括号、闭引号。 */
const BREAK_AFTER = new Set([..."，。！？、；：…）」』”’】》〉"]);
/** 不能落到行首：标点、长音、叠字符号、小假名。 */
const NO_LINE_START = new Set([..."，。！？、；：…）」』”’】》〉,.!?;:)]}ー々〜～ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮ"]);
/** 不能落到行尾：开括号、开引号。 */
const NO_LINE_END = new Set([..."（「『“‘【《〈([{"]);

function unitOf(ch: string): number {
  if (ch === " " || ch === "\t") return SPACE_WIDTH;
  return WIDE.test(ch) ? 1 : LATIN_WIDTH;
}

/** 一段文字大概有几个汉字那么宽。 */
export function textUnits(text: string): number {
  let sum = 0;
  for (const ch of text) sum += unitOf(ch);
  return sum;
}

interface Cut {
  /** 断在第几个字符之前。 */
  at: number;
  /** 断点左边的宽度。 */
  left: number;
  /** 断在标点之后或空格处（比字间硬断自然）。 */
  natural: boolean;
}

/** 一行里所有能断的地方。 */
function cutsOf(chars: string[]): Cut[] {
  const cuts: Cut[] = [];
  let left = 0;
  for (let i = 1; i < chars.length; i++) {
    left += unitOf(chars[i - 1]);
    const prev = chars[i - 1];
    const next = chars[i];
    if (prev === " " || next === " ") {
      cuts.push({ at: i, left, natural: true });
    } else if ((WIDE.test(prev) || WIDE.test(next)) && !NO_LINE_START.has(next) && !NO_LINE_END.has(prev)) {
      cuts.push({ at: i, left, natural: BREAK_AFTER.has(prev) });
    }
  }
  return cuts;
}

/** 一行放不下 capacity 时断成两层；放得下、没处断、断了会出小尾巴就原样返回。 */
function splitLine(line: string, capacity: number): string[] {
  const chars = [...line];
  const total = textUnits(line);
  if (total <= capacity) return [line];
  const cuts = cutsOf(chars).filter((c) => c.left >= MIN_LAYER && total - c.left >= MIN_LAYER);
  if (cuts.length === 0) return [line];

  const middle = total / 2;
  // 两层都放得下的断点优先；一个都没有（整句超过两行）就取最接近平分的
  const fits = cuts.filter((c) => c.left <= capacity && total - c.left <= capacity);
  const pool = fits.length > 0 ? fits : cuts;
  const cost = (c: Cut): number => Math.abs(c.left - middle) + (c.natural || fits.length === 0 ? 0 : total * PLAIN_PENALTY);
  const best = pool.reduce((a, b) => (cost(b) < cost(a) ? b : a));
  return [chars.slice(0, best.at).join("").trim(), chars.slice(best.at).join("").trim()];
}

/**
 * 一句字幕分成几层（从上到下）。
 * @param text 一句字幕，多行用 \n 连接（见 core/subtitle.ts 的 cueTextAt）
 * @param capacity 一层放得下多宽，以汉字宽度计；不是正数时不拆
 * @param maxRows 最多几层；拆完超过就不拆，一行一层、多出的行丢掉
 */
export function splitLayers(text: string, capacity: number, maxRows = 4): string[] {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (!(capacity > 0)) return lines.slice(0, maxRows);
  const rows = lines.flatMap((line) => splitLine(line, capacity));
  return rows.length <= maxRows ? rows : lines.slice(0, maxRows);
}
