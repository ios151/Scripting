// 配色。颜色只在这里和 core/palette.ts 里写死，别处一律引用。
//
// 写法注意：`Color` 是模板字面量类型，`rgba(...)` 里**不能有空格**，否则类型对不上。

import type { Color, LinearGradient } from "scripting";
import type { Sky } from "../core/condition";
import type { AlertLevel } from "../core/alerts";
import { ALERT_BADGE, TEXT_PRIMARY, TEXT_SECONDARY_ALPHA, skyColors } from "../core/palette";

/** 主文字、图标 */
export const TEXT: Color = TEXT_PRIMARY;
/** 次要文字：天气、最高最低、逐小时的时间、底部的详细数据和提醒。对比度由 core/palette.ts 的自测守着 */
export const TEXT_2: Color = `rgba(255,255,255,${TEXT_SECONDARY_ALPHA})`;
/** 分隔线。半透明白，染色模式下系统会按透明度分层，不会刷成一块纯白 */
export const HAIRLINE: Color = "rgba(255,255,255,0.22)";

/** 空气质量小圆点外面的白边：圆点自己的颜色可能和天空色很近，靠这一圈白边把它托出来 */
export const AQI_RING: Color = "rgba(255,255,255,0.85)";

/** 预警徽章边缘一圈很淡的亮线：同色系的天空上（蓝色预警压在晴天蓝上）也立得住 */
export const ALERT_RIM: Color = "rgba(255,255,255,0.35)";

/** 预警徽章：底色（竖着上浅下深）和里面图案的颜色，按级别挑 */
export function alertBadge(level: AlertLevel): { fill: LinearGradient; glyph: Color } {
  const { top, bottom, glyph } = ALERT_BADGE[level];
  return { fill: { colors: [top, bottom], startPoint: "top", endPoint: "bottom" }, glyph };
}

/** 天空背景：竖着从上端渐变到下端 */
export function skyBackground(sky: Sky, isDay: boolean): LinearGradient {
  const [top, bottom] = skyColors(sky, isDay);
  return { colors: [top, bottom], startPoint: "top", endPoint: "bottom" };
}
