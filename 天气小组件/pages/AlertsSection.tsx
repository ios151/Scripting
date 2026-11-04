// App 页里的「天气预警」一节：现在的状态、每条预警的全文、预览预警样式的按钮。
//
// 预警和天气是同一次请求带回来的（彩云的 `alert=true`），来源在上面的「天气来源」里选；用备用的 Open-Meteo 就没有预警。
// 说明文字一句一行。最要紧的两句放在最后：预警仅供参考；没看到预警不等于没有预警。

import { Button, HStack, Spacer, Text, VStack } from "scripting";
import { alertSymbol, type AlertItem } from "../core/alerts";
import type { AlertState } from "../core/alertState";
import type { Provider } from "../core/dataSource";
import { alertStatusText, whenText } from "../core/present";
import { AlertBadge } from "../widget/badge";
import { Fold, type FoldState } from "./Fold";

function metaLine(item: AlertItem, now: number): string {
  const parts: string[] = [];
  if (item.publishedAt !== null) parts.push(whenText(item.publishedAt, now) + " 发布");
  if (item.source !== "") parts.push(item.source);
  if (item.location !== "") parts.push(item.location);
  return parts.join(" · ");
}

function AlertRow({ item, now }: { item: AlertItem; now: number }) {
  const meta = metaLine(item, now);
  return (
    <HStack alignment="top" spacing={10}>
      <AlertBadge level={item.level} glyph={alertSymbol(item.label, item.code)} side={30} />
      <VStack alignment="leading" spacing={4}>
        <Text font="subheadline" fontWeight="semibold">
          {item.title}
        </Text>
        {item.description !== "" ? (
          <Text font="footnote" foregroundStyle="secondaryLabel">
            {item.description}
          </Text>
        ) : null}
        {meta !== "" ? (
          <Text font="caption" foregroundStyle="tertiaryLabel">
            {meta}
          </Text>
        ) : null}
      </VStack>
    </HStack>
  );
}

const FOOTER =
  "预览预警样式：有天气的小组件上会出现两条写着「示例」的假预警，10 分钟后自己消失\n\n" +
  "预警仅供参考，以官方发布为准\n没看到预警，不等于没有预警：联网出问题、接口没返回预警数据时也不会显示";

export function AlertsSection({
  alertState,
  provider,
  now,
  demoUntil,
  startDemo,
  stopDemo,
  fold,
}: {
  /** null 表示还没取过 */
  alertState: AlertState | null;
  /** 现在用的来源：备用的 Open-Meteo 没有预警 */
  provider: Provider;
  now: number;
  /** 「预览预警样式」开到什么时候；没开是 0 */
  demoUntil: number;
  startDemo: () => void;
  stopDemo: () => void;
  fold: FoldState;
}) {
  const items = alertState !== null && alertState.kind === "ok" ? alertState.items : [];
  const demoOn = demoUntil > now;
  return (
    <Fold title="天气预警" note={items.length > 0 ? items.length + " 条" : demoOn ? "预览中" : undefined} fold={fold} footer={FOOTER}>
      <HStack>
        <Text>状态</Text>
        <Spacer />
        <Text foregroundStyle="secondaryLabel" multilineTextAlignment="trailing">
          {alertStatusText(alertState, provider === "caiyun", now, demoUntil)}
        </Text>
      </HStack>
      {items.map((item) => (
        <AlertRow key={item.id} item={item} now={now} />
      ))}
      <Button action={demoOn ? stopDemo : startDemo}>
        <Text foregroundStyle="systemBlue">{demoOn ? "结束预览" : "预览预警样式（10 分钟）"}</Text>
      </Button>
    </Fold>
  );
}
