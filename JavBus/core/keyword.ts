// 番号处理：归一化、从剪贴板 / 分享文本里认出番号。
//
// 全部照搬原版 JavBus 9.2 的正则，行为一字不差；唯一的改动是把 `(?<!fc)` 后行断言
// 换成了回看前一个字符——后行断言要 iOS 16.4+ 的 JavaScriptCore 才有。

/** 日文假名 / 汉字：搜演员名、片名这类，不是番号。 */
const CJK = /[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]/;

/**
 * 含假名 / 汉字的原样返回（原版 9.2 起：搜「三上 悠亜」不该被拼成「三上悠亜」）；
 * 其余去空白，并在「字母→数字」「数字→字母」的交界补 `-`：`ssis001` → `ssis-001`。
 * 字母后面跟数字时，如果这个字母前面正好是 `f`、它自己是 `c`（即 `fc`），不补——
 * 这是为了 FC2：`fc2ppv1234567` → `fc2-ppv-1234567`，而不是 `fc-2-…`。
 */
export function normalizeKeyword(text: string): string {
  if (CJK.test(text)) return text;
  return text
    .replace(/\s+/g, "")
    .replace(/([a-zA-Z])(?=\d)/g, (m, letter: string, offset: number, whole: string) => {
      const pair = whole.slice(Math.max(0, offset - 1), offset + 1).toLowerCase();
      return pair === "fc" ? m : `${letter}-`;
    })
    .replace(/(\d)(?=[a-zA-Z])/g, "$1-");
}

/** 原版 reg1：几个最常见的厂牌，优先匹配，免得被通用规则抢先咬到别的词。 */
const KNOWN_STUDIOS = /(?:snis|abp|ipz|sw|jux|miad|mide|midd|pgd|star|ebod|iptd)[\s-]?\d{3}/i;
/** 原版 reg2：通用规则，3~5 个字母 + 3~4 位数字。 */
const GENERIC_CODE = /[a-zA-Z]{3,5}[\s-]?\d{3,4}/g;

export interface Detected {
  mode: "search" | "home";
  keyword: string;
}

/** 从任意文本里抽第一个番号；抽不到就是 home（显示最新列表）。 */
export function detectCode(text: string): Detected {
  const known = text.match(KNOWN_STUDIOS);
  if (known) return { mode: "search", keyword: normalizeKeyword(known[0]) };
  const generic = text.match(GENERIC_CODE);
  if (generic) return { mode: "search", keyword: normalizeKeyword(generic[0]) };
  return { mode: "home", keyword: "" };
}

/**
 * 文本里有没有链接。原版用 `$detector.link`：有链接就不去抠番号，直接显示最新。
 * 磁力链接里满是「字母 + 数字」，不挡住的话会被当成番号乱搜，所以一并算作链接。
 */
export function hasLink(text: string): boolean {
  return /(?:https?:\/\/|www\.|magnet:|ed2k:)\S+/i.test(text);
}

/**
 * `scripting://run/JavBus?code=XXX` 传进来的番号：先走剪贴板同一套识别，
 * 识别不了返回空串；识别出来统一大写，没有 `-` 的话在字母后补一个（原版 main()）。
 */
export function normalizeCodeArg(raw: string): string {
  const keyword = detectCode(raw).keyword;
  if (!keyword) return "";
  let code = keyword.toUpperCase();
  if (!code.includes("-")) code = code.replace(/([A-Z]+)/, "$1-");
  return code;
}

/** 详情页链接 / 路径的最后一段，库里拿它当主键（原版 `favLink.split("/").pop()`）。 */
export function shortCodeOf(link: string): string {
  const clean = link.split(/[?#]/)[0].replace(/\/+$/, "");
  return clean.split("/").pop() ?? "";
}
