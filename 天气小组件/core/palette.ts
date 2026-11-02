// 背景的天空色：按天气和昼夜选一对「上端 → 下端」的颜色，文字一律白色。
//
// 每一对都按对比度算过（自测里会重算一遍）：白字 100% 压在两端和中间都 ≥ 4.5:1，
// 80% 的白（次要文字）压在中间和下端 ≥ 4.5:1，70% 的白（底部小字）压在下端 ≥ 4.5:1。
// 白天的蓝因此比苹果天气的「天蓝」深一些；想要更亮的天空，先看自测里的对比度会掉到多少。
//
// 白天上端浅、下端深（下面放的小字多）；夜里反过来，像地平线微亮。

import type { Sky } from "./condition";

/** `#RRGGBB`。写成模板字面量类型，传给 Scripting 的颜色参数时不用再转 */
export type Hex = `#${string}`;

export type SkyPair = readonly [top: Hex, bottom: Hex];

export const SKY: Readonly<Record<Sky, { day: SkyPair; night: SkyPair }>> = {
  clear: { day: ["#1A75D5", "#124F91"], night: ["#101D46", "#1B3074"] },
  partly: { day: ["#426EA9", "#2F4F79"], night: ["#1D2944", "#2C3F68"] },
  overcast: { day: ["#626F84", "#485261"], night: ["#272C35", "#3A4250"] },
  fog: { day: ["#64707D", "#4B545D"], night: ["#2C3035", "#40474F"] },
  rain: { day: ["#4A6796", "#34496A"], night: ["#1C2536", "#2D3C58"] },
  snow: { day: ["#4F7092", "#3B546D"], night: ["#243142", "#364963"] },
  storm: { day: ["#584F92", "#38325D"], night: ["#2A2650", "#3B3566"] },
  unknown: { day: ["#626F84", "#485261"], night: ["#272C35", "#3A4250"] },
};

export function skyColors(sky: Sky, isDay: boolean): SkyPair {
  const pair = SKY[sky];
  return isDay ? pair.day : pair.night;
}

/**
 * 预警徽章：照国内预警信号的样子画——一个圆角小方块，底色表示级别（蓝黄橙红），里面的图案表示是哪一类（暴雨、大风……），
 * 旁边是白字写的名字。不再用三角形：它是通用的警告符号，看不出是什么预警，也不好看。
 * 底色是竖着的一点渐变（上浅下深）。图案的颜色按底色选：红底用白色，其余用近黑色。
 * 蓝色预警用浅蓝：晴天的天空本来就是蓝的，深蓝的方块会融进去；浅蓝上放深色图案，两头都看得清。
 * 图案压在底色两端都 ≥ 3:1（图形元素的最低要求），自测里重算。
 */
export type BadgeLevel = "blue" | "yellow" | "orange" | "red" | "white" | "unknown";
export type BadgeStyle = { readonly top: Hex; readonly bottom: Hex; readonly glyph: Hex };

/** 深色图案的颜色（系统的近黑色） */
export const ALERT_INK: Hex = "#1C1C1E";

const YELLOW: BadgeStyle = { top: "#FFE766", bottom: "#FFCC00", glyph: ALERT_INK };

export const ALERT_BADGE: Readonly<Record<BadgeLevel, BadgeStyle>> = {
  blue: { top: "#9ACFFF", bottom: "#62B0FF", glyph: ALERT_INK },
  yellow: YELLOW,
  orange: { top: "#FFB840", bottom: "#FF9500", glyph: ALERT_INK },
  red: { top: "#F9544A", bottom: "#E5352B", glyph: "#FFFFFF" },
  white: { top: "#FFFFFF", bottom: "#E5E5EA", glyph: ALERT_INK },
  unknown: YELLOW,
};

/**
 * 空气质量分级的小圆点颜色（国标 AQI 的通行配色：优绿、良黄、轻度橙、中度红、重度紫、严重褐红）。
 * 只用在一个小圆点上，文字还是白的。圆点外面描一圈半透明的白边（见 widget/theme.ts 的 AQI_RING），
 * 所以不管压在哪一套天空色上（紫色的重度污染压在雷暴的紫色天空上）都立得住，不靠圆点自己的颜色去对比。
 */
export const AQI_COLOR: readonly Hex[] = ["#4CD964", "#FFD60A", "#FF9F0A", "#FF6259", "#C77DFF", "#D6455D"];

/** 未来几天的温度条：整条的底（半透明白）和这一天的最低到最高那一段 */
export const BAR_TRACK = "rgba(255,255,255,0.22)";
export const BAR_FILL = "rgba(255,255,255,0.92)";

/**
 * 未来几天里降水概率的字：淡淡的蓝，和气温的白字稍微区分一下；压在各套天空色上都 ≥ 4.5:1（自测里重算）。
 * 再深一点的蓝（#8EC9FF）压在晴天的蓝上只有 3.5:1，看不清。
 */
export const RAIN_TEXT: Hex = "#CFE8FF";

/** 文字：主 / 次。次要用半透明白，染色模式下系统会按透明度分层 */
export const TEXT_PRIMARY: Hex = "#FFFFFF";
export const TEXT_SECONDARY_ALPHA = 0.8;
