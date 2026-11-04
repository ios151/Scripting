// App 页里的详细数据：今天的概况（彩云的几句话）、未来几天、详细数据、空气质量、生活指数。
// 都只有彩云来源才有；备用的 Open-Meteo 没有，`detail` 是 null，这几节就都不出现。
// 每一节都是一个可展开 / 收起的组（见 Fold.tsx）。

import { HStack, Spacer, Text, VStack } from "scripting";
import type { Detail, StatView } from "../core/present";
import { Fold, type FoldState } from "./Fold";

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

/** 概况那几句：彩云的几句话——今天怎么样、未来 24 小时、未来两小时有没有降水（读不到的不写） */
function summaryLines(detail: Detail): string[] {
  return [detail.keypoint, detail.dayOutlook, detail.rainOutlook].filter((line): line is string => line !== null);
}

/** 这几节里有没有哪一节有内容（备用来源没有详细数据，一节都没有，那一类连标题都不用画） */
export function hasDetail(detail: Detail | null): boolean {
  return detail !== null && (summaryLines(detail).length > 0 || detail.week.length > 0 || detail.all.length > 0 || detail.air.length > 0 || detail.life.length > 0);
}

export function SummarySection({ detail, fold }: { detail: Detail | null; fold: FoldState }) {
  if (detail === null) return null;
  const lines = summaryLines(detail);
  if (lines.length === 0) return null;
  return (
    <Fold title="概况" fold={fold}>
      {lines.map((line, index) => (
        <Text key={"line-" + index}>{line}</Text>
      ))}
    </Fold>
  );
}

export function DetailSection({ detail, fold }: { detail: Detail | null; fold: FoldState }) {
  if (detail === null || detail.all.length === 0) return null;
  return (
    <Fold title="详细数据" fold={fold}>
      <StatRows stats={detail.all} />
    </Fold>
  );
}

/** 空气质量：国标指数，和各项污染物的浓度 */
export function AirSection({ detail, fold }: { detail: Detail | null; fold: FoldState }) {
  if (detail === null || detail.air.length === 0) return null;
  return (
    <Fold title="空气质量" fold={fold}>
      <StatRows stats={detail.air} />
    </Fold>
  );
}

export function LifeSection({ detail, fold }: { detail: Detail | null; fold: FoldState }) {
  if (detail === null || detail.life.length === 0) return null;
  return (
    <Fold title="生活指数" fold={fold}>
      <StatRows stats={detail.life} />
    </Fold>
  );
}

export function WeekSection({ detail, fold }: { detail: Detail | null; fold: FoldState }) {
  if (detail === null || detail.week.length === 0) return null;
  return (
    <Fold title="未来几天" fold={fold}>
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
    </Fold>
  );
}
