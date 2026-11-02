// 预警徽章里的那个圆角小方块：底色表示级别（蓝黄橙红），里面的图案表示是哪一类预警（暴雨、大风……），
// 照国内预警信号的样子画。小组件里的徽章和 App 页里每条预警前面的，用的是同一个。
//
// 只管画，不碰数据：底色和图案的颜色在 core/palette.ts，比例在 core/layout.ts，图案按类型挑在 core/alerts.ts。
// 底色用的是 `fill`（不是 `widgetBackground`），染色模式下系统只会把它调成单色，不会像 `widgetBackground` 那样被藏起来。

import { Image, RoundedRectangle, ZStack } from "scripting";
import type { AlertLevel } from "../core/alerts";
import { ALERT_BADGE_CORNER, ALERT_GLYPH_RATIO } from "../core/layout";
import { ALERT_RIM, alertBadge } from "./theme";

export function AlertBadge({ level, glyph, side }: { level: AlertLevel; glyph: string; side: number }) {
  const style = alertBadge(level);
  const radius = side * ALERT_BADGE_CORNER;
  return (
    <ZStack frame={{ width: side, height: side }}>
      <RoundedRectangle cornerRadius={radius} fill={style.fill} />
      <RoundedRectangle cornerRadius={radius} stroke={{ shapeStyle: ALERT_RIM, strokeStyle: { lineWidth: 0.5 } }} />
      <Image systemName={glyph} font={side * ALERT_GLYPH_RATIO} symbolRenderingMode="monochrome" foregroundStyle={style.glyph} />
    </ZStack>
  );
}
