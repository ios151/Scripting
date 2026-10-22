// 字幕的外观：颜色（#RRGGBB）、字号倍数、文字和底条的不透明度、双层、位置。纯逻辑；
// 全局状态和存档在 kit/subtitleLook.ts（存进 kit/settings.ts 的 subtitleStyle），画出来在 pages/SubtitleParts.tsx，设置面板在 pages/SubtitlePanel.tsx。
//
// 位置存的是「离默认位置（画面底边居中）的位移」占叠层宽 / 高的比例，不存点数：同一条字幕在小窗里叠层约 360 × 240、
// 在横屏全屏里约 830 × 420，存点数的话竖屏里拖到的位置到了横屏就跑偏（朋友给的参考实现里也是这个结论，存百分比）。
//
// 第一版存的是档位名（颜色 "yellow"、字号 "large"、底色开关 backdrop）：读存档时认得就换成现在的写法，已经调好的外观升级后不丢。

/** 十六进制色值（`#RRGGBB`）：和 Scripting 的 ColorStringHex 同形，直接能当 foregroundStyle 用，core 里又不用 import 运行时的类型。 */
export type HexColor = `#${string}`;

export interface SubtitleStyle {
  /** 字的颜色，`#RRGGBB`（大写）。预设的五个色和自己填的都是这个格式。 */
  color: HexColor;
  /** 字号倍数：1 = 按叠层大小算出来的基准字号（见 core/subtitle.ts 的 subtitleMetrics），范围 0.6~2。 */
  scale: number;
  /** 字的不透明度：1 = 不透明，最低 0.2（再低就看不见了）。 */
  opacity: number;
  /** 底条的不透明度：0.55 是原来的样子，0 = 不要底条（只留一圈黑色阴影托着字）。 */
  backdropOpacity: number;
  /** 双层：一行放不下的长句拆成上下两层，每层一块底条（见 core/subtitleLayers.ts）；关掉就整句一块、让 Text 自己折行。 */
  layers: boolean;
  /** 离默认位置的位移，占叠层宽（x，向右为正）/ 高（y，向下为正，所以往上拖是负的）的比例。 */
  x: number;
  y: number;
}

/** 面板里的五个预设色（点一下就是它）；想要别的颜色自己填色值。 */
export const SUBTITLE_COLORS: { title: string; value: HexColor }[] = [
  { title: "白色", value: "#FFFFFF" },
  { title: "黄色", value: "#FFE14A" },
  { title: "青色", value: "#6FE3FF" },
  { title: "绿色", value: "#7CF29A" },
  { title: "粉色", value: "#FFA8D2" },
];

/** 字号倍数的范围和滑块的步长。 */
export const SCALE_MIN = 0.6;
export const SCALE_MAX = 2;
export const SCALE_STEP = 0.05;
/** 字的不透明度的下限和滑块的步长；底条的不透明度可以拖到 0（= 不要底条）。 */
export const OPACITY_MIN = 0.2;
export const OPACITY_STEP = 0.05;
export const BACKDROP_DEFAULT = 0.55;

export const DEFAULT_SUBTITLE_STYLE: SubtitleStyle = {
  color: "#FFFFFF",
  scale: 1,
  opacity: 1,
  backdropOpacity: BACKDROP_DEFAULT,
  layers: true,
  x: 0,
  y: 0,
};

/** 实际字号（点）的下限和上限：滑块拖到头也不让小屏上的字小得看不清、大屏上的字大得离谱。 */
const MIN_FONT = 10;
const MAX_FONT = 56;
/** 往上拖，字幕最上面一行离顶边至少留这么多行字高：三行的字幕也放得下。 */
const TOP_LINES = 4;
/** 往下拖，字幕最下面离底边至少留这么多点。 */
const BOTTOM_GAP = 6;
/** 往左右拖，字幕中心离左右边至少留这么多点。 */
const SIDE_GAP = 60;

/** 第一版存的档位名。用 Map 不用对象：对象查 "constructor" 这类名字会查到原型上的东西。 */
const LEGACY_COLORS = new Map<string, HexColor>([
  ["white", "#FFFFFF"],
  ["yellow", "#FFE14A"],
  ["cyan", "#6FE3FF"],
  ["green", "#7CF29A"],
  ["pink", "#FFA8D2"],
]);
const LEGACY_SCALES = new Map<string, number>([
  ["small", 0.85],
  ["normal", 1],
  ["large", 1.25],
  ["huge", 1.5],
]);

const clamp = (value: number, low: number, high: number): number => Math.max(low, Math.min(high, value));
/** 取两位小数：滑块每格加 0.05 会积出浮点尾巴，存档和拼 rgba 都不想看到 0.55000000000001。 */
const round2 = (value: number): number => Math.round(value * 100) / 100;
const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** 位移比例：有限数才收，落在 ±1（整个叠层那么宽 / 高）以内。 */
function ratio(value: unknown): number {
  return isNumber(value) ? clamp(value, -1, 1) : 0;
}

/**
 * 解析用户填的色值：`#FFE14A` / `FFE14A` / `#FC0`（三位会展开成 `#FFCC00`），大小写不限、两头空白不管。
 * 不是 3 位或 6 位十六进制就返回 null。
 */
export function parseHexColor(input: string): HexColor | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(input.trim());
  if (!m) return null;
  const digits = m[1].length === 3 ? [...m[1]].map((c) => c + c).join("") : m[1];
  return `#${digits.toUpperCase()}`;
}

/** `#RRGGBB` 拆成三个 0~255 的数。 */
function rgbOf(color: HexColor): [number, number, number] {
  return [parseInt(color.slice(1, 3), 16), parseInt(color.slice(3, 5), 16), parseInt(color.slice(5, 7), 16)];
}

/** 带透明度的颜色，拼成 `rgba(r,g,b,a)`（和 Scripting 的 ColorStringRGBA 同形，直接能当颜色用）。 */
export type RgbaColor = `rgba(${number},${number},${number},${number})`;

export function colorWithAlpha(color: HexColor, alpha: number): RgbaColor {
  const [r, g, b] = rgbOf(color);
  return `rgba(${r},${g},${b},${round2(clamp(alpha, 0, 1))})`;
}

/** 在这个颜色上放字，用黑还是白看得清：亮色用黑、暗色用白（色块上的「#」就靠它）。 */
export function contrastInk(color: HexColor): "black" | "white" {
  const [r, g, b] = rgbOf(color);
  return r * 0.299 + g * 0.587 + b * 0.114 > 150 ? "black" : "white";
}

/**
 * 从存储里读出来的东西不一定可信（旧版本没有这些字段、存的是第一版的档位名、手改过）：
 * 认得的留下，认得档位名的换成现在的写法，其余退回默认值，数值收进各自的范围。
 */
export function normalizeSubtitleStyle(raw: unknown): SubtitleStyle {
  const r = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const color = typeof r.color === "string" ? (parseHexColor(r.color) ?? LEGACY_COLORS.get(r.color)) : undefined;
  const scale = isNumber(r.scale) ? r.scale : typeof r.size === "string" ? LEGACY_SCALES.get(r.size) : undefined;
  const backdropOpacity = isNumber(r.backdropOpacity) ? r.backdropOpacity : r.backdrop === false ? 0 : undefined;
  return {
    color: color ?? DEFAULT_SUBTITLE_STYLE.color,
    scale: round2(clamp(scale ?? DEFAULT_SUBTITLE_STYLE.scale, SCALE_MIN, SCALE_MAX)),
    opacity: round2(clamp(isNumber(r.opacity) ? r.opacity : DEFAULT_SUBTITLE_STYLE.opacity, OPACITY_MIN, 1)),
    backdropOpacity: round2(clamp(backdropOpacity ?? DEFAULT_SUBTITLE_STYLE.backdropOpacity, 0, 1)),
    layers: typeof r.layers === "boolean" ? r.layers : DEFAULT_SUBTITLE_STYLE.layers,
    x: ratio(r.x),
    y: ratio(r.y),
  };
}

/** 按字号倍数放大 / 缩小基准字号，取整，限制在 10~56 点。 */
export function subtitleFontSize(base: number, scale: number): number {
  return Math.round(clamp(base * scale, MIN_FONT, MAX_FONT));
}

/**
 * 字幕位移（点）的可动范围，免得拖到画面外找不回来：往上到离顶边 4 行字高，往下到离底边 6 点，左右各到离边 60 点（字幕居中，一半在画面里就够抓回来）。
 * @param size 叠层的大小
 * @param bottom 默认位置离底边的距离（subtitleMetrics 算的）
 * @param fontSize 实际字号
 */
export function clampSubtitleShift(
  size: { width: number; height: number },
  bottom: number,
  fontSize: number,
  shift: { x: number; y: number },
): { x: number; y: number } {
  const reach = Math.max(0, size.width / 2 - SIDE_GAP);
  const up = Math.min(0, -(size.height - bottom - fontSize * TOP_LINES));
  const down = Math.max(0, bottom - BOTTOM_GAP);
  return { x: clamp(shift.x, -reach, reach), y: clamp(shift.y, up, down) };
}

/** 位移（点）折成占叠层大小的比例；叠层还没量出大小（宽或高是 0）时回到默认位置。 */
export function shiftToRatio(shift: { x: number; y: number }, size: { width: number; height: number }): { x: number; y: number } {
  if (!(size.width > 0 && size.height > 0)) return { x: 0, y: 0 };
  return { x: ratio(shift.x / size.width), y: ratio(shift.y / size.height) };
}
