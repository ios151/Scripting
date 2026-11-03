// 小组件的根视图：按 `Widget.family` 挑版面，套上天空色背景和「点一下打开本脚本」。
//
// 背景用 `widgetBackground` 不用 `background`：iOS 18 的染色模式下它会自动藏起来，
// 用 `background` 的话整块会被系统刷成白的；透明 / 模糊背景的小组件它也会自己跳过。
// 根上把配色方案锁成深色：多色天气图标在深色下是白云，不然云会跟着系统亮暗走，在浅色下发灰。
//
// 根视图撑成 `Widget.displaySize` 的满尺寸、内缩自己留（见 widget/frame.tsx）：
// 不指望系统给的内容边距，这样系统留不留边距、背景画在哪，版面都一样。

import { ZStack } from "scripting";
import { familyOf, layoutVariant, metricsFor } from "../core/layout";
import type { Content } from "../core/present";
import { AccessoryView } from "./accessory";
import { CardBody } from "./bodies";
import { fullFrame } from "./frame";
import { skyBackground } from "./theme";

export function WidgetView({
  family,
  width,
  height,
  content,
  tapURL,
}: {
  family: string;
  width: number;
  height: number;
  content: Content;
  tapURL: string | undefined;
}) {
  const layout = familyOf(family, width, height);

  if (layout === "circular" || layout === "rectangular" || layout === "inline") {
    return <AccessoryView family={layout} content={content} tapURL={tapURL} />;
  }

  // 中号选了「未来几天」或底部的「一句话」时，竖向放不下原来的字号，用紧凑的那套
  const m = metricsFor(layout, width, height, layoutVariant(layout, content.kind === "weather" ? content.display : null));
  return (
    <ZStack
      frame={{ width, height }}
      widgetBackground={skyBackground(content.sky, content.isDay)}
      widgetURL={tapURL}
      environments={{ colorScheme: "dark" }}
    >
      {fullFrame(width, height, m.inset, <CardBody layout={layout} content={content} m={m} />)}
    </ZStack>
  );
}
