// 卡片里共用的小零件：多色图标、地名一行、预警徽章、分隔线、逐小时那一排、一行详细数据、未来几天。
// 小组件和 App 里的预览用的是同一批，所以在 App 里看到的样子就是主屏幕上的样子。
//
// 一律只管画，不碰数据：要说什么话都在 core/present.ts 里算好了。
// 卡片底部不再写「更新时间」和数据署名（嫌不好看）：只有出了状况才有一行提醒（见 bodies.tsx 的 BottomLine）；
// 数据来源的署名都在脚本页的「数据来源」里。

import { Capsule, Circle, HStack, Image, Rectangle, Text, VStack, ZStack } from "scripting";
import { ALERT_BADGE_RATIO, ALERT_GAP_RATIO, type Metrics } from "../core/layout";
import { AQI_COLOR, BAR_FILL, BAR_TRACK, RAIN_TEXT } from "../core/palette";
import type { AlertView, Card, DayView, SlotView, StatView } from "../core/present";
import { AlertBadge } from "./badge";
import { AQI_RING, HAIRLINE, TEXT, TEXT_2 } from "./theme";

/**
 * 多色天气图标（白云、黄太阳、蓝雨点，样子接近系统天气）。
 * 多色模式下云用的是「前景色」，所以要明确写成白色，不然会跟着系统亮暗走。
 */
export function WeatherIcon({ name, size }: { name: string; size: number }) {
  return <Image systemName={name} font={size} symbolRenderingMode="multicolor" foregroundStyle={TEXT} />;
}

/** 地名一行：跟着定位走时前面有个小箭头。名字再长也只占一行，放不下就缩小 */
export function PlaceRow({ card, m }: { card: Card; m: Metrics }) {
  return (
    <HStack spacing={m.gap + 2}>
      {card.followsLocation ? <Image systemName="location.fill" font={m.placeArrow} foregroundStyle={TEXT} /> : null}
      <Text font={m.place} fontWeight="semibold" foregroundStyle={TEXT} lineLimit={1} minScaleFactor={0.7}>
        {card.place}
      </Text>
    </HStack>
  );
}

/**
 * 预警徽章：前面一个按级别上色、里面是预警类型图案的圆角小方块，后面是白字「大风蓝色预警」，还有别的预警就再带个「+1」。
 * 没有底板：方块自己带颜色，文字和卡片上别的字一样是白的，所以在任何天空色上都读得清（天空色对白字的对比度有自测守着）。
 * 方块比旁边的一行字略高一点（见 core/layout.ts 的 ALERT_BADGE_RATIO），不会把那一行撑高。
 */
// prop 不能叫 `alert`：它和视图通用属性 `alert`（弹窗）撞名，类型会变成两者的交叉
export function AlertChip({ alertInfo, size }: { alertInfo: AlertView; size: number }) {
  return (
    <HStack spacing={size * ALERT_GAP_RATIO}>
      <AlertBadge level={alertInfo.level} glyph={alertInfo.symbol} side={size * ALERT_BADGE_RATIO} />
      <Text font={size} fontWeight="semibold" foregroundStyle={TEXT} lineLimit={1} minScaleFactor={0.7}>
        {alertInfo.label}
      </Text>
      {alertInfo.more > 0 ? (
        <Text font={size} foregroundStyle={TEXT_2} lineLimit={1}>
          {"+" + alertInfo.more}
        </Text>
      ) : null}
    </HStack>
  );
}

/** 0.5pt 的细线 */
export function Hairline() {
  return <Rectangle fill={HAIRLINE} frame={{ height: 0.5 }} />;
}

/**
 * 逐小时一排：每格三行（时间、图标、气温或「日落」），平分整行的宽度。
 * `columns` 比格数多时右边留空，两排之间的列才对得齐（大号第二排在夜里可能不满）。
 * 图标占的高度固定，不同图标宽窄、高矮不一样，气温也不会跟着上下晃。
 */
export function Strip({ slots, columns, m }: { slots: readonly SlotView[]; columns: number; m: Metrics }) {
  const cells: Array<SlotView | null> = [];
  for (let index = 0; index < columns; index++) cells.push(index < slots.length ? slots[index] : null);
  return (
    <HStack alignment="top" spacing={0}>
      {cells.map((slot, index) =>
        slot === null ? (
          // 空的格子不放 Spacer：它会在竖向上也撑开，把整排顶得很高
          <VStack key={"blank-" + index} frame={{ maxWidth: "infinity" }} />
        ) : (
          <VStack key={slot.key} spacing={m.slotGap} frame={{ maxWidth: "infinity" }}>
            <Text
              font={m.slotLabel}
              fontWeight={slot.isNow ? "bold" : "regular"}
              foregroundStyle={slot.isNow ? TEXT : TEXT_2}
              lineLimit={1}
              minScaleFactor={0.7}
            >
              {slot.label}
            </Text>
            <ZStack frame={{ height: m.slotIconBox }}>
              <WeatherIcon name={slot.symbol} size={m.slotIcon} />
            </ZStack>
            <Text
              font={m.slotText}
              fontWeight="semibold"
              monospacedDigit
              foregroundStyle={TEXT}
              lineLimit={1}
              minScaleFactor={0.7}
            >
              {slot.text}
            </Text>
          </VStack>
        ),
      )}
    </HStack>
  );
}

/**
 * 一行详细数据：几项平分整行的宽度，每项是「标签 值」（「体感 14°」「风 南风 1级」），
 * 空气质量前面带个按分级上色的小圆点（绿 / 黄 / 橙 / 红 / 紫）。
 */
export function StatsRow({ stats, size }: { stats: readonly StatView[]; size: number }) {
  return (
    <HStack spacing={0}>
      {stats.map((item) => (
        <HStack key={item.key} spacing={size * 0.3} frame={{ maxWidth: "infinity", alignment: "leading" }}>
          {item.band !== null ? (
            <ZStack frame={{ width: size * 0.7, height: size * 0.7 }}>
              <Circle fill={AQI_COLOR[item.band]} />
              <Circle stroke={{ shapeStyle: AQI_RING, strokeStyle: { lineWidth: 0.75 } }} />
            </ZStack>
          ) : null}
          <Text font={size} foregroundStyle={TEXT_2} lineLimit={1}>
            {item.label}
          </Text>
          <Text font={size} fontWeight="semibold" foregroundStyle={TEXT} lineLimit={1} minScaleFactor={0.7}>
            {item.value}
          </Text>
        </HStack>
      ))}
    </HStack>
  );
}

/** 底部的一句话：出了状况的提醒，或者未来两小时要下雨的说明 */
export function NoteLine({ text, size }: { text: string; size: number }) {
  return (
    <Text font={size} foregroundStyle={TEXT_2} lineLimit={1} minScaleFactor={0.7}>
      {text}
    </Text>
  );
}

/**
 * 大号里「明天起的几天」：星期、图标、降水概率、最低、温度条、最高。
 * 温度条的长度是我们自己按内容宽度算的（各列的宽度都写死了，剩下的就是条），不靠系统量。
 */
export function DayRows({ days, m }: { days: readonly DayView[]; m: Metrics }) {
  const spacing = m.day * 0.5;
  const weekday = m.day * 3;
  const icon = m.dayIcon + 4;
  const rain = m.day * 2.4;
  const temp = m.day * 2.6;
  const bar = Math.max(m.contentWidth - weekday - icon - rain - temp * 2 - spacing * 5, m.bar * 4);
  return (
    <VStack spacing={m.dayGap}>
      {days.map((day) => {
        const length = Math.min(Math.max((day.to - day.from) * bar, m.bar * 2), bar);
        const start = Math.min(day.from * bar, bar - length);
        return (
          <HStack key={day.key} spacing={spacing} frame={{ height: m.dayRow }}>
            <Text font={m.day} fontWeight="medium" foregroundStyle={TEXT} lineLimit={1} frame={{ width: weekday, alignment: "leading" }}>
              {day.weekday}
            </Text>
            <ZStack frame={{ width: icon }}>
              <WeatherIcon name={day.symbol} size={m.dayIcon} />
            </ZStack>
            <Text font={m.day - 2} foregroundStyle={RAIN_TEXT} lineLimit={1} frame={{ width: rain, alignment: "leading" }}>
              {day.rain ?? ""}
            </Text>
            <Text font={m.day} monospacedDigit foregroundStyle={TEXT_2} lineLimit={1} frame={{ width: temp, alignment: "trailing" }}>
              {day.low}
            </Text>
            <ZStack alignment="leading" frame={{ width: bar, height: m.bar }}>
              <Capsule fill={BAR_TRACK} />
              <Capsule fill={BAR_FILL} frame={{ width: length, height: m.bar }} offset={{ x: start, y: 0 }} />
            </ZStack>
            <Text font={m.day} fontWeight="semibold" monospacedDigit foregroundStyle={TEXT} lineLimit={1} frame={{ width: temp, alignment: "trailing" }}>
              {day.high}
            </Text>
          </HStack>
        );
      })}
    </VStack>
  );
}
