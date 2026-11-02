// 天气预警：彩云天气接口返回的 `result.alert` 怎么读、怎么排、怎么起短名字。纯函数，不碰系统。
//
// 彩云的预警没有独立接口，任意天气接口加 `alert=true` 就带上；`result.alert.content[]` 里每条有
// 标题 / 代码 / 描述 / 发布时间戳 / 来源 / 地点 / 状态（见彩云文档的 alert 数据结构）。
//
// 预警代码：文档没给代码表，只有一个例子（`0501` 对应「大风蓝色预警」）。这里按国内预警信号的通行编码来读——
// 前两位是类型、后两位是级别（01 蓝、02 黄、03 橙、04 红）。代码表是我按通行编码补的，不是彩云文档里的，
// 所以名字和颜色都优先看标题里写的「某某蓝色预警」，标题读不出来才用代码；两边都读不出来就用标题原文。

export type AlertLevel = "blue" | "yellow" | "orange" | "red" | "white" | "unknown";

export type AlertItem = {
  /** 预警 ID；接口没给就用代码 + 时间 + 标题拼一个 */
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly code: string;
  readonly level: AlertLevel;
  /** 放在小徽章里的短名字：「大风蓝色预警」 */
  readonly label: string;
  readonly source: string;
  /** 「北京市海淀区」 */
  readonly location: string;
  /** 发布时间（UTC 毫秒）；接口没给或读不出来就是 null */
  readonly publishedAt: number | null;
};

/**
 * 级别越高越靠前。白色（台风白色预警）排在蓝色后面。
 * 读不出级别的按黄色算（徽章上画的也是黄色三角）：宁可排得高一点，也别让一条读不出级别的预警被蓝色的盖住。
 */
const RANK: Readonly<Record<AlertLevel, number>> = { red: 4, orange: 3, yellow: 2, blue: 1, white: 0, unknown: 2 };

const LEVEL_BY_CODE: Readonly<Record<string, AlertLevel>> = { "01": "blue", "02": "yellow", "03": "orange", "04": "red", "05": "white" };

const COLOR_WORD: Readonly<Record<AlertLevel, string>> = {
  blue: "蓝",
  yellow: "黄",
  orange: "橙",
  red: "红",
  white: "白",
  unknown: "",
};

const LEVEL_BY_WORD: Readonly<Record<string, AlertLevel>> = { 蓝: "blue", 黄: "yellow", 橙: "orange", 红: "red", 白: "white" };

/** 类型：通行的国内预警信号编码（不是彩云文档里的，见文件头） */
const TYPE_BY_CODE: Readonly<Record<string, string>> = {
  "01": "台风",
  "02": "暴雨",
  "03": "暴雪",
  "04": "寒潮",
  "05": "大风",
  "06": "沙尘暴",
  "07": "高温",
  "08": "干旱",
  "09": "雷电",
  "10": "冰雹",
  "11": "霜冻",
  "12": "大雾",
  "13": "霾",
  "14": "道路结冰",
  "15": "森林火险",
  "16": "雷雨大风",
};

const CODE = /^\d{4}$/;

export function rankOf(level: AlertLevel): number {
  return RANK[level];
}

export function levelFromCode(code: string): AlertLevel {
  return CODE.test(code) ? (LEVEL_BY_CODE[code.slice(2)] ?? "unknown") : "unknown";
}

/** 标题里写的「蓝色预警」「红色预警信号」。一条标题里写了不止一个（「…黄色预警升级为…橙色预警」）就取最后一个，那是现在的 */
export function levelFromTitle(title: string): AlertLevel {
  let level: AlertLevel = "unknown";
  for (const match of title.matchAll(/(蓝|黄|橙|红|白)色预警/g)) level = LEVEL_BY_WORD[match[1]] ?? level;
  return level;
}

const VERBS = ["继续发布", "升级为", "降级为", "更新为", "变更为", "发布", "更新"];

/**
 * 「海淀区气象台发布大风蓝色预警[IV/一般]」→「大风蓝色预警」。读不出来返回 null。
 * 一条标题里有不止一处「X色预警」（升级时会写成「…将暴雨黄色预警升级为暴雨橙色预警」）就取最后一处读得出来的。
 */
export function labelFromTitle(title: string): string | null {
  let found: string | null = null;
  for (const match of title.matchAll(/([一-龥]{0,12})(蓝|黄|橙|红|白)色预警/g)) {
    let head = match[1];
    for (const verb of VERBS) {
      const at = head.lastIndexOf(verb);
      if (at >= 0) {
        head = head.slice(at + verb.length);
        break;
      }
    }
    // 类型名最长四个字（道路结冰、森林火险、雷雨大风）；比这长多半是没把前面的单位名切干净
    if (head !== "" && head.length <= 5) found = head + match[2] + "色预警";
  }
  return found;
}

export function labelFromCode(code: string): string | null {
  if (!CODE.test(code)) return null;
  const type = TYPE_BY_CODE[code.slice(0, 2)];
  const level = LEVEL_BY_CODE[code.slice(2)];
  if (type === undefined || level === undefined) return null;
  return type + COLOR_WORD[level] + "色预警";
}

const MAX_FALLBACK_LABEL = 10;

/** 短名字：标题里读得出就用标题的，其次代码，再不行就是标题原文截短 */
export function shortLabel(title: string, code: string): string {
  const text = title.trim();
  return labelFromTitle(text) ?? labelFromCode(code) ?? (text.length > MAX_FALLBACK_LABEL ? text.slice(0, MAX_FALLBACK_LABEL) + "…" : text);
}

/** 认不出是哪一类预警时用的通用图案 */
export const GENERIC_SYMBOL = "exclamationmark.circle.fill";

/**
 * 预警类型 → 图案（SF Symbols）。徽章照国内预警信号的样子画：底色表示级别，里面的图案表示是哪一类。
 * 顺序有讲究，说得更具体的排前面：「雷雨大风」要在「雷电」「大风」前面，「台风」要在「大风」前面。
 * 大风只认「大风 / 阵风」，不认单个「风」字：「地质灾害气象风险」里也有个「风」。
 */
const SYMBOL_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/雷雨大风/, "cloud.bolt.rain.fill"],
  [/台风|飓风|热带风暴/, "hurricane"],
  [/龙卷/, "tornado"],
  [/暴雨|大雨|洪水|山洪/, "cloud.heavyrain.fill"],
  [/暴雪|大雪|雪灾/, "cloud.snow.fill"],
  [/结冰|冰雪|冻雨|霜冻/, "snowflake"],
  [/寒潮|低温|降温/, "thermometer.snowflake"],
  [/高温|热浪/, "thermometer.sun.fill"],
  [/冰雹/, "cloud.hail.fill"],
  [/雷电|雷暴/, "cloud.bolt.fill"],
  [/雾/, "cloud.fog.fill"],
  [/霾|污染/, "smoke.fill"],
  [/沙尘|扬沙|浮尘/, "sun.dust.fill"],
  [/大风|阵风/, "wind"],
  [/旱/, "sun.max.fill"],
  [/火险|火灾/, "flame.fill"],
];

function symbolOfText(text: string): string | null {
  for (const [pattern, symbol] of SYMBOL_RULES) if (pattern.test(text)) return symbol;
  return null;
}

/** 图案：先看名字（「暴雨橙色预警」），名字里认不出再看代码前两位对应的类型，都不行就用通用的 */
export function alertSymbol(label: string, code: string): string {
  const byLabel = symbolOfText(label);
  if (byLabel !== null) return byLabel;
  const type = CODE.test(code) ? TYPE_BY_CODE[code.slice(0, 2)] : undefined;
  return (type !== undefined ? symbolOfText(type) : null) ?? GENERIC_SYMBOL;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** 发布时间戳：接口写的是 Unix 秒（文档示例 1640733900），个别环境可能给毫秒或带引号的数字，都收 */
function timestamp(value: unknown): number | null {
  const number = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof number !== "number" || !Number.isFinite(number) || number <= 0) return null;
  return number < 1e12 ? number * 1000 : number;
}

/** 已经解除 / 取消的不要。状态文档里只给了「预警中」一个例子，其余值拿不准，所以只挡明确说解除、取消的 */
function isWithdrawn(status: string): boolean {
  return /解除|取消/.test(status);
}

function toItem(entry: unknown): AlertItem | null {
  if (!isRecord(entry)) return null;
  const title = text(entry.title);
  const description = text(entry.description);
  if (title === "" && description === "") return null;
  if (isWithdrawn(text(entry.status))) return null;

  const code = text(entry.code);
  const level = levelFromCode(code) !== "unknown" ? levelFromCode(code) : levelFromTitle(title);
  const publishedAt = timestamp(entry.pubtimestamp);
  const fallbackTitle = title !== "" ? title : description.slice(0, 40);
  const id = text(entry.alertId) !== "" ? text(entry.alertId) : `${code}-${publishedAt ?? 0}-${fallbackTitle}`;
  return {
    id,
    title: fallbackTitle,
    description,
    code,
    level,
    label: shortLabel(fallbackTitle, code),
    source: text(entry.source),
    location: text(entry.location),
    publishedAt,
  };
}

/** 级别高的在前，同级别发布得晚的在前 */
export function sortAlerts(items: readonly AlertItem[]): AlertItem[] {
  return items.slice().sort((a, b) => RANK[b.level] - RANK[a.level] || (b.publishedAt ?? 0) - (a.publishedAt ?? 0));
}

/**
 * 读彩云的返回。`null` 表示这不是一份读得懂的返回（状态不是 ok、没有 result.alert.content）；
 * 空数组表示读懂了、现在没有预警。两种情况界面上要分开说：没读懂不能当成「没有预警」。
 */
export function parseAlertResponse(raw: unknown): AlertItem[] | null {
  if (!isRecord(raw) || raw.status !== "ok") return null;
  const result = raw.result;
  if (!isRecord(result)) return null;
  const alert = result.alert;
  if (!isRecord(alert) || !Array.isArray(alert.content)) return null;

  const seen = new Set<string>();
  const items: AlertItem[] = [];
  for (const entry of alert.content) {
    const item = toItem(entry);
    if (item === null || seen.has(item.id)) continue;
    seen.add(item.id);
    items.push(item);
  }
  return sortAlerts(items);
}

/**
 * 返回是读得懂的（状态 ok、有 result），只是 `result` 里没有 `alert`。
 * 文档说 `alert=true` 时一定有；没有，多半是那个接口没开预警、或者没把 `alert=true` 转给彩云。
 * 这时候不知道有没有预警，界面上要单独说，不能当成「现在没有预警」。
 */
export function alertFieldMissing(raw: unknown): boolean {
  if (!isRecord(raw) || raw.status !== "ok" || !isRecord(raw.result)) return false;
  return raw.result.alert === undefined || raw.result.alert === null;
}

/** 缓存里存的东西读回来：每一项都重新验一遍，坏的丢掉 */
export function parseStoredAlerts(raw: unknown): AlertItem[] | null {
  if (!Array.isArray(raw)) return null;
  const items: AlertItem[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const title = text(entry.title);
    const id = text(entry.id);
    if (title === "" || id === "") continue;
    const code = text(entry.code);
    const level = (["blue", "yellow", "orange", "red", "white", "unknown"] as const).find((value) => value === entry.level) ?? "unknown";
    items.push({
      id,
      title,
      description: text(entry.description),
      code,
      level,
      label: text(entry.label) !== "" ? text(entry.label) : shortLabel(title, code),
      source: text(entry.source),
      location: text(entry.location),
      publishedAt: typeof entry.publishedAt === "number" && Number.isFinite(entry.publishedAt) ? entry.publishedAt : null,
    });
  }
  return items;
}

/**
 * 预览用的示例预警（App 页「预览预警样式」）：真的预警难得遇上，没法在真机上看徽章长什么样，
 * 所以放两条假的，名字前面写着「示例」、来源写着「示例数据」，不会和真的搞混；10 分钟后自己消失。
 * 第二条用来看「另外还有 N 条」的写法，名字也故意取得长一点，看长名字在小号里怎么缩。
 */
export const DEMO_ALERTS: readonly AlertItem[] = [
  {
    id: "demo-orange",
    title: "示例：北京市气象台发布暴雨橙色预警",
    description: "这是用来预览样式的示例，不是真的预警。",
    code: "0203",
    level: "orange",
    label: "示例·暴雨橙色预警",
    source: "示例数据",
    location: "",
    publishedAt: null,
  },
  {
    id: "demo-blue",
    title: "示例：海淀区气象台发布大风蓝色预警",
    description: "这是用来预览样式的示例，不是真的预警。",
    code: "0501",
    level: "blue",
    label: "示例·大风蓝色预警",
    source: "示例数据",
    location: "",
    publishedAt: null,
  },
];
