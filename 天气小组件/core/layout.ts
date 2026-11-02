// 各种尺寸下该用多大的字、多大的图标。全部按实际拿到的宽高按比例算，不写死。
//
// 为什么不写死：小组件的实际点数每台设备都不一样（小号 148~170，中号 321~364 宽，大号 324~382 高），
// 按一台机器写死的版面在别的机器上会被裁掉或空一大块。
// 所以下面每个数都是「参考尺寸（iPhone 15 Pro：小 158×158、中 338×158、大 338×354）上的值」乘一个缩放比。
//
// 内缩（`inset`）也由我们自己说了算，不指望系统给的内容边距：根视图撑成 `Widget.displaySize` 的满尺寸，
// 内容离边缘多远只看 `inset`（见 widget/frame.tsx）。系统有没有另外留边距，版面都一样。

export type Family = "small" | "medium" | "large" | "circular" | "rectangular" | "inline";

/** 系统小组件的参考尺寸（宽、高） */
const REFERENCE: Readonly<Record<"small" | "medium" | "large", readonly [number, number]>> = {
  small: [158, 158],
  medium: [338, 158],
  large: [338, 354],
};

/**
 * 把 `Widget.family` 换成这里的版面。
 * 超大（iPad 的横向超大、iOS 27 的竖向超大）没有单独设计：横的借中号、竖的借大号，按宽高放大。
 */
export function familyOf(widgetFamily: string, width: number, height: number): Family {
  switch (widgetFamily) {
    case "systemSmall":
      return "small";
    case "systemMedium":
      return "medium";
    case "systemLarge":
      return "large";
    case "accessoryCircular":
      return "circular";
    case "accessoryRectangular":
      return "rectangular";
    case "accessoryInline":
      return "inline";
    default:
      return width > height * 1.5 ? "medium" : height > 220 ? "large" : "small";
  }
}

/** 内容离小组件边缘的距离（pt）。取的是 iPhone 上系统默认的内容边距，所以看起来和苹果自己的小组件一样 */
export const CONTENT_MARGIN = 16;

/**
 * 预警徽章的比例，都是相对「徽章旁边文字的字号」或「方块的边长」：
 * 方块边长是字号的 1.5 倍（比一行字略高一点，不另外撑高那一行）；圆角占边长的 30%；
 * 里面的图案占边长的 58%；方块和文字的间距是字号的 0.4 倍。
 */
export const ALERT_BADGE_RATIO = 1.5;
export const ALERT_BADGE_CORNER = 0.3;
export const ALERT_GLYPH_RATIO = 0.58;
export const ALERT_GAP_RATIO = 0.4;

export type Metrics = {
  /** 相对参考尺寸的缩放比 */
  scale: number;
  /** 内容离小组件四边的距离，随缩放比放大缩小 */
  inset: number;
  /** 地名、天气、气温、最高最低这几行之间的间距 */
  gap: number;
  /** 地名（含前面的定位箭头） */
  place: number;
  placeArrow: number;
  /** 当前气温（大号细体） */
  temp: number;
  /** 天气文字、降水概率、最高最低 */
  cond: number;
  rain: number;
  range: number;
  /** 头部的天气图标 */
  icon: number;
  /** 逐小时每格：时间、图标、气温；图标占的高度固定，一行里的数字才对得齐 */
  slotLabel: number;
  slotIcon: number;
  slotIconBox: number;
  slotText: number;
  /** 逐小时每格里三行之间的间距、两排之间的间距 */
  slotGap: number;
  rowGap: number;
  /** 底部一行详细数据（体感、湿度、风、空气）和提醒的字号 */
  stat: number;
  /** 大号里未来几天：每行的字号、图标、行高、行与行的间距、温度条的粗细 */
  day: number;
  dayIcon: number;
  dayRow: number;
  dayGap: number;
  bar: number;
  /** 中号左栏宽度 */
  leftWidth: number;
  /** 内容区的宽度（扣掉左右内缩）：温度条的长度要按它算 */
  contentWidth: number;
};

type Base = Omit<Metrics, "scale" | "inset" | "contentWidth">;

const BASE: Readonly<Record<"small" | "medium" | "large", Base>> = {
  small: {
    gap: 2,
    place: 13,
    placeArrow: 9,
    temp: 42,
    cond: 13,
    rain: 11,
    range: 11,
    icon: 20,
    slotLabel: 11,
    slotIcon: 18,
    slotIconBox: 20,
    slotText: 13,
    slotGap: 3,
    rowGap: 6,
    stat: 0,
    day: 0,
    dayIcon: 0,
    dayRow: 0,
    dayGap: 0,
    bar: 0,
    leftWidth: 0,
  },
  medium: {
    gap: 3,
    place: 14,
    placeArrow: 9,
    temp: 44,
    cond: 13,
    rain: 12,
    range: 11,
    icon: 16,
    slotLabel: 11,
    slotIcon: 18,
    slotIconBox: 20,
    slotText: 13,
    slotGap: 3,
    rowGap: 6,
    stat: 11,
    day: 0,
    dayIcon: 0,
    dayRow: 0,
    dayGap: 0,
    bar: 0,
    leftWidth: 112,
  },
  large: {
    gap: 6,
    place: 20,
    placeArrow: 12,
    temp: 48,
    cond: 16,
    rain: 14,
    range: 13,
    icon: 18,
    slotLabel: 12,
    slotIcon: 22,
    slotIconBox: 26,
    slotText: 15,
    slotGap: 5,
    rowGap: 6,
    stat: 12,
    day: 13,
    dayIcon: 16,
    dayRow: 20,
    dayGap: 3,
    bar: 4,
    leftWidth: 0,
  },
};

/** 字号不低于这个值：再小就是缩成了蚂蚁 */
const MIN_FONT = 8;

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/** 取到半点：小数点后一长串在渲染里没有意义，也让自测好比 */
function half(value: number): number {
  return Math.round(value * 2) / 2;
}

/** 拿到的尺寸不可信（0、负数、NaN）就当参考尺寸，免得把整张卡缩成 0 */
function usable(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function metricsFor(family: "small" | "medium" | "large", width: number, height: number): Metrics {
  const [refWidth, refHeight] = REFERENCE[family];
  const scale = clamp(Math.min(usable(width, refWidth) / refWidth, usable(height, refHeight) / refHeight), 0.7, 2.4);
  const base = BASE[family];
  // 字号不低于 MIN_FONT；值是 0 的（这个尺寸里没有这一项）保持 0
  const fonts: ReadonlyArray<keyof Base> = [
    "place", "placeArrow", "temp", "cond", "rain", "range", "icon", "slotLabel", "slotIcon", "slotText", "stat", "day", "dayIcon",
  ];
  const inset = half(CONTENT_MARGIN * scale);
  const out: Record<string, number> = { scale, inset, contentWidth: half(usable(width, refWidth) - 2 * inset) };
  for (const key of Object.keys(base) as Array<keyof Base>) {
    const scaled = half(base[key] * scale);
    out[key] = fonts.includes(key) && base[key] > 0 ? Math.max(scaled, MIN_FONT) : scaled;
  }
  return out as unknown as Metrics;
}
