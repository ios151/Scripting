// 小号 / 中号 / 大号三种卡片的内容，外加没有数据时的样子。
//
// 版式的出处是 RoamControl 的天气卡：地名独占一行；下面左边是天气和降水概率、右边是细体大号气温和最高最低；
// 一条细线；逐小时一排；小组件的尺寸比那张卡窄得多，所以各尺寸取舍如下：
//   · 小号：左上地名、右上多色图标，中间大号气温，下面天气和最高最低。放不下逐小时。
//   · 中号：左栏地名、气温、最高最低；右栏天气（和预警）、细线、逐小时一排 5 格；底部一行详细数据（体感、湿度、风、空气）。
//     右上那一行、中间那一排、底部那一行可以按「显示样式」换（core/display.ts）：风和湿度 / 未来几天 / 一句话 + 日落 + 空气。
//   · 大号：地名（和预警）、天气和大号气温、逐小时一排、明天起的几天（带温度条）、底部一行详细数据（底部那一行也能换）。
//     没有详细数据（备用来源）时退回老样子：两排逐小时共 10 格，没有未来几天和详细数据。
// 底部不写更新时间和数据署名（嫌不好看）；只有出了状况（没刷新成功、用的是上次的位置）才有一行提醒，
// 其次是「未来两小时要下雨」的说明，平时是那一行详细数据（选了「一句话」就是一句话 + 日落 + 空气，选了「不显示」就没有）。
// 有预警时，徽章占一个现成的位置，不另外加一行（竖向都留了余量，但不多）：
//   · 小号：换掉最高最低那一行；  · 中号：换掉天气文字后面的降水概率；  · 大号：放在地名那一行的右边。
// 只管内容，不管背景和点击：那是 view.tsx（小组件）和 pages/Preview.tsx（App 里的预览）各自的事。

import { HStack, Image, Spacer, Text, VStack } from "scripting";
import type { Family, Metrics } from "../core/layout";
import type { Card, Content, Empty } from "../core/present";
import { AlertChip, DayRows, DayStrip, Hairline, HeadlineRow, NoteLine, PlaceRow, StatsRow, Strip, TopLine, WeatherIcon } from "./parts";
import { TEXT, TEXT_2 } from "./theme";

function Temperature({ card, size }: { card: Card; size: number }) {
  return (
    <Text font={size} fontWeight="thin" monospacedDigit foregroundStyle={TEXT} lineLimit={1} minScaleFactor={0.6}>
      {card.temperature}
    </Text>
  );
}

/** 底部那一行画什么：出了状况的提醒、未来两小时有雨的说明、一句话 + 日落 + 空气、几项详细数据、什么都不画 */
export type BottomKind = "note" | "rain" | "headline" | "stats" | "none";

/**
 * 出了状况的提醒永远先说（选了「不显示」也一样：用的是旧数据 / 旧位置，得让人知道）；
 * 其次看选的显示样式：不显示就没有；一句话就画那一行；默认的是「有雨先说雨，没有雨就是几项详细数据」。
 * 备用来源没有详细数据，就什么都不画。
 */
export function bottomKind(card: Card): BottomKind {
  if (card.note !== null && card.noteShort !== null) return "note";
  if (card.display.bottom === "none") return "none";
  if (card.display.bottom === "headline" && card.headline !== null) return "headline";
  if (card.detail !== null && card.detail.rainNote !== null) return "rain";
  if (card.bottomStats.length > 0) return "stats";
  return "none";
}

/** 底部那一行。不写更新时间和数据署名 */
function BottomLine({ card, m, narrow }: { card: Card; m: Metrics; narrow: boolean }) {
  switch (bottomKind(card)) {
    case "note": {
      // 中号窄，提醒用短的那句；大号用完整的
      const text = narrow ? card.noteShort : card.note;
      return text === null ? null : <NoteLine text={text} size={m.stat} />;
    }
    case "rain":
      return card.detail === null || card.detail.rainNote === null ? null : <NoteLine text={card.detail.rainNote} size={m.stat} />;
    case "headline":
      return card.headline === null ? null : <HeadlineRow headline={card.headline} m={m} />;
    case "stats":
      return <StatsRow stats={card.bottomStats} size={m.stat} />;
    default:
      return null;
  }
}

function SmallBody({ card, m }: { card: Card; m: Metrics }) {
  return (
    <VStack alignment="leading" spacing={m.gap}>
      <HStack>
        <PlaceRow card={card} m={m} />
        <Spacer />
        <WeatherIcon name={card.condition.symbol} size={m.icon} />
      </HStack>
      <Spacer />
      <Temperature card={card} size={m.temp} />
      <Text font={m.cond} fontWeight="medium" foregroundStyle={TEXT} lineLimit={1} minScaleFactor={0.7}>
        {card.condition.text}
      </Text>
      {card.alert !== null ? (
        <AlertChip alertInfo={card.alert} size={m.range} />
      ) : (
        <Text font={m.range} foregroundStyle={TEXT_2} lineLimit={1} minScaleFactor={0.7}>
          {card.range}
        </Text>
      )}
    </VStack>
  );
}

function MediumBody({ card, m }: { card: Card; m: Metrics }) {
  const bottom = bottomKind(card) !== "none";
  // 右上那一行选了「风和湿度」：天气图标挪到气温旁边（右上那一行没有地方写天气了）
  const iconBesideTemperature = card.display.top === "windHumidity";
  return (
    <VStack alignment="leading" spacing={m.gap}>
      {/* 底下没有那一行时，两栏摆在正中间；有的话两栏靠上、那一行靠下 */}
      {bottom ? null : <Spacer />}
      <HStack alignment="top" spacing={m.gap * 4}>
        <VStack alignment="leading" spacing={m.gap} frame={{ width: m.leftWidth, alignment: "leading" }}>
          <PlaceRow card={card} m={m} />
          {iconBesideTemperature ? (
            <HStack spacing={m.gap * 2}>
              <Temperature card={card} size={m.temp} />
              <WeatherIcon name={card.condition.symbol} size={m.bigIcon} />
            </HStack>
          ) : (
            <Temperature card={card} size={m.temp} />
          )}
          <Text font={m.range} foregroundStyle={TEXT_2} lineLimit={1} minScaleFactor={0.7}>
            {card.range}
          </Text>
        </VStack>
        <VStack alignment="leading" spacing={m.gap * 2} frame={{ maxWidth: "infinity", alignment: "leading" }}>
          <TopLine card={card} m={m} />
          <Hairline />
          {card.display.strip === "daily" ? <DayStrip days={card.dayColumns} columns={card.columns} m={m} /> : <Strip slots={card.slots} columns={card.columns} m={m} />}
        </VStack>
      </HStack>
      <Spacer />
      {bottom ? <BottomLine card={card} m={m} narrow /> : null}
    </VStack>
  );
}

/** 大号有详细数据时的样子：地名（和预警）、天气和气温、逐小时一排、明天起的几天、底部一行 */
function LargeDetailedBody({ card, m }: { card: Card; m: Metrics }) {
  const days = card.detail === null ? [] : card.detail.days;
  return (
    <VStack alignment="leading" spacing={m.rowGap}>
      <HStack spacing={m.gap * 2}>
        <PlaceRow card={card} m={m} />
        <Spacer />
        {card.alert !== null ? <AlertChip alertInfo={card.alert} size={m.rain} /> : null}
      </HStack>
      <HStack alignment="top" spacing={m.gap * 2}>
        <VStack alignment="leading" spacing={m.gap}>
          <HStack spacing={m.gap + 2}>
            <WeatherIcon name={card.condition.symbol} size={m.icon} />
            <Text font={m.cond} fontWeight="medium" foregroundStyle={TEXT} lineLimit={1} minScaleFactor={0.7}>
              {card.condition.text}
            </Text>
          </HStack>
          <Text font={m.range} foregroundStyle={TEXT_2} lineLimit={1} minScaleFactor={0.7}>
            {card.range}
          </Text>
        </VStack>
        <Spacer />
        <Temperature card={card} size={m.temp} />
      </HStack>
      <Hairline />
      <Strip slots={card.slots} columns={card.columns} m={m} />
      {days.length > 0 ? <Hairline /> : null}
      {days.length > 0 ? <DayRows days={days} m={m} /> : null}
      <Spacer />
      {bottomKind(card) !== "none" ? <BottomLine card={card} m={m} narrow={false} /> : null}
    </VStack>
  );
}

/** 大号没有详细数据（备用来源）时：老样子，两排逐小时共 10 格 */
function LargePlainBody({ card, m }: { card: Card; m: Metrics }) {
  const second = card.slots.slice(card.columns);
  return (
    <VStack alignment="leading" spacing={m.rowGap}>
      <VStack alignment="leading" spacing={m.gap}>
        <HStack spacing={m.gap * 2}>
          <PlaceRow card={card} m={m} />
          <Spacer />
          {card.alert !== null ? <AlertChip alertInfo={card.alert} size={m.rain} /> : null}
        </HStack>
        <HStack alignment="top" spacing={m.gap * 2}>
          <VStack alignment="leading" spacing={m.gap}>
            <HStack spacing={m.gap + 2}>
              <WeatherIcon name={card.condition.symbol} size={m.icon} />
              <Text font={m.cond} foregroundStyle={TEXT} lineLimit={1} minScaleFactor={0.7}>
                {card.condition.text}
              </Text>
            </HStack>
            {card.rain !== null ? (
              <Text font={m.rain} foregroundStyle={TEXT_2} lineLimit={1} minScaleFactor={0.7}>
                {card.rain}
              </Text>
            ) : null}
          </VStack>
          <Spacer />
          {/* 右栏按内容定宽、不许折行：气温和最高最低永远完整显示（RoamControl 真机上踩过「22°」折成两行） */}
          <VStack alignment="trailing" spacing={2} fixedSize={{ horizontal: true, vertical: false }}>
            <Temperature card={card} size={m.temp} />
            <Text font={m.range} fontWeight="medium" foregroundStyle={TEXT} lineLimit={1}>
              {card.range}
            </Text>
          </VStack>
        </HStack>
      </VStack>
      <Hairline />
      <Strip slots={card.slots.slice(0, card.columns)} columns={card.columns} m={m} />
      {second.length > 0 ? <Strip slots={second} columns={card.columns} m={m} /> : null}
      <Spacer />
      {card.note !== null ? <NoteLine text={card.note} size={m.stat} /> : null}
    </VStack>
  );
}

function LargeBody({ card, m }: { card: Card; m: Metrics }) {
  return card.detail === null ? <LargePlainBody card={card} m={m} /> : <LargeDetailedBody card={card} m={m} />;
}

/** 没有位置 / 没有数据：一个图标、一个标题、两句人话，居中。点一下打开 App（由外层的 widgetURL 管） */
function EmptyBody({ empty, m }: { empty: Empty; m: Metrics }) {
  return (
    <VStack spacing={m.gap * 2}>
      <Spacer />
      <Image systemName={empty.symbol} font={m.icon * 1.5} foregroundStyle={TEXT} />
      <Text font={m.cond} fontWeight="semibold" foregroundStyle={TEXT} lineLimit={1} minScaleFactor={0.7}>
        {empty.title}
      </Text>
      {empty.lines.map((line, index) => (
        <Text key={"line-" + index} font={m.range} foregroundStyle={TEXT_2} lineLimit={1} minScaleFactor={0.7}>
          {line}
        </Text>
      ))}
      <Spacer />
    </VStack>
  );
}

/** 三种卡片的内容，按版面和有没有数据挑一个 */
export function CardBody({ layout, content, m }: { layout: Extract<Family, "small" | "medium" | "large">; content: Content; m: Metrics }) {
  if (content.kind === "empty") return <EmptyBody empty={content} m={m} />;
  if (layout === "medium") return <MediumBody card={content} m={m} />;
  if (layout === "large") return <LargeBody card={content} m={m} />;
  return <SmallBody card={content} m={m} />;
}
