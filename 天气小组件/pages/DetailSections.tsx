// App 页里的详细数据：今天的概况（彩云的几句话）、未来几天、详细数据、空气质量、生活指数。
// 都只有彩云来源才有；备用的 Open-Meteo 没有，`detail` 是 null，这几节就都不出现。

import { HStack, Section, Spacer, Text, VStack } from "scripting";
import type { Detail, StatView } from "../core/present";

function Row({ title, value }: { title: string; value: string }) {
  return (
    <HStack>
      <Text>{title}</Text>
      <Spacer />
      <Text foregroundStyle="secondaryLabel" lineLimit={1} minScaleFactor={0.7}>
        {value}
      </Text>
    </HStack>
  );
}

function StatRows({ stats }: { stats: readonly StatView[] }) {
  return (
    <>
      {stats.map((item) => (
        <Row key={item.key} title={item.label} value={item.value} />
      ))}
    </>
  );
}

/** 概况：彩云的几句话——今天怎么样、未来 24 小时、未来两小时有没有降水（读不到的不写） */
export function SummarySection({ detail }: { detail: Detail | null }) {
  if (detail === null) return null;
  const lines = [detail.keypoint, detail.dayOutlook, detail.rainOutlook].filter((line): line is string => line !== null);
  if (lines.length === 0) return null;
  return (
    <Section header={<Text>概况</Text>}>
      {lines.map((line, index) => (
        <Text key={"line-" + index}>{line}</Text>
      ))}
    </Section>
  );
}

export function DetailSection({ detail }: { detail: Detail | null }) {
  if (detail === null || detail.all.length === 0) return null;
  return (
    <Section header={<Text>详细数据</Text>}>
      <StatRows stats={detail.all} />
    </Section>
  );
}

/** 空气质量：国标指数，和各项污染物的浓度 */
export function AirSection({ detail }: { detail: Detail | null }) {
  if (detail === null || detail.air.length === 0) return null;
  return (
    <Section header={<Text>空气质量</Text>}>
      <StatRows stats={detail.air} />
    </Section>
  );
}

export function LifeSection({ detail }: { detail: Detail | null }) {
  if (detail === null || detail.life.length === 0) return null;
  return (
    <Section header={<Text>生活指数</Text>}>
      <StatRows stats={detail.life} />
    </Section>
  );
}

export function WeekSection({ detail }: { detail: Detail | null }) {
  if (detail === null || detail.week.length === 0) return null;
  return (
    <Section header={<Text>未来几天</Text>}>
      {detail.week.map((day) => (
        <VStack key={day.key} alignment="leading" spacing={4}>
          <Row title={day.title} value={day.summary} />
          {day.extra !== null ? (
            <Text font="footnote" foregroundStyle="secondaryLabel">
              {day.extra}
            </Text>
          ) : null}
        </VStack>
      ))}
    </Section>
  );
}
