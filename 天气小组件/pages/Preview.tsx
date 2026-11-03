// App 页里的卡片预览。内容用的就是小组件那一套（widget/bodies.tsx、widget/frame.tsx），看到的样子就是主屏幕上的样子；
// 区别只有一处：背景用 `background`（App 里没有「染色模式」，不用 `widgetBackground`），再裁成圆角。

import { Text, VStack, ZStack } from "scripting";
import { layoutVariant, metricsFor } from "../core/layout";
import type { Content } from "../core/present";
import { CardBody } from "../widget/bodies";
import { fullFrame } from "../widget/frame";
import { TEXT, TEXT_2, skyBackground } from "../widget/theme";

/** 参考尺寸的宽高比（中号 338×158） */
const MEDIUM_RATIO = 158 / 338;
const CORNER = 22;

export function PreviewCard({ content, width }: { content: Content; width: number }) {
  const height = Math.round(width * MEDIUM_RATIO);
  const m = metricsFor("medium", width, height, layoutVariant("medium", content.kind === "weather" ? content.display : null));
  return (
    <ZStack
      frame={{ width, height }}
      background={skyBackground(content.sky, content.isDay)}
      clipShape={{ type: "rect", cornerRadius: CORNER, style: "continuous" }}
      environments={{ colorScheme: "dark" }}
    >
      {fullFrame(width, height, m.inset, <CardBody layout="medium" content={content} m={m} />)}
    </ZStack>
  );
}

/** 还没取到数据时的占位（同样大小，页面不会跳） */
export function LoadingCard({ width }: { width: number }) {
  const height = Math.round(width * MEDIUM_RATIO);
  return (
    <ZStack
      frame={{ width, height }}
      background={skyBackground("unknown", true)}
      clipShape={{ type: "rect", cornerRadius: CORNER, style: "continuous" }}
      environments={{ colorScheme: "dark" }}
    >
      <VStack spacing={6}>
        <Text font="headline" foregroundStyle={TEXT}>
          正在取天气…
        </Text>
        <Text font="footnote" foregroundStyle={TEXT_2}>
          第一次会问你要不要允许定位
        </Text>
      </VStack>
    </ZStack>
  );
}
