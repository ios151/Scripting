// 充电曲线：实时刷新时每来一份电池报告就记一个点，画功率 / 电流 / 温度 / 电量随时间的变化。
//
// 只存在内存里，离开电池页就没了——要的是「这一次充电」的样子，不做历史记录。

import type { BatteryReport } from "./services";

export type CurveMetric = "power" | "current" | "temperature" | "charge";

export interface CurveSample {
  /** 毫秒时间戳。 */
  at: number;
  powerW: number | null;
  amperageMA: number | null;
  temperatureC: number | null;
  chargePercent: number | null;
}

/** 最多留多少个点：2 秒一个，一小时。再多图也看不清，内存也没必要。 */
export const CURVE_LIMIT = 1800;

export const METRIC_INFO: Record<CurveMetric, { title: string; unit: string; digits: number }> = {
  power: { title: "功率", unit: "W", digits: 1 },
  current: { title: "电流", unit: "mA", digits: 0 },
  temperature: { title: "温度", unit: "°C", digits: 1 },
  charge: { title: "电量", unit: "%", digits: 0 },
};

function valueOf(sample: CurveSample, metric: CurveMetric): number | null {
  switch (metric) {
    case "power":
      return sample.powerW;
    case "current":
      return sample.amperageMA;
    case "temperature":
      return sample.temperatureC;
    case "charge":
      return sample.chargePercent;
  }
}

/**
 * 能选哪些指标。有的设备根本不给电池温度（真机 2026-10-17 实测），那就不放「温度」这个选项，
 * 免得点开只有一句「还没有数据」。最新一份报告或已有的点里有温度才算有。
 */
export function availableMetrics(samples: CurveSample[], latestTemperature: number | null): CurveMetric[] {
  const hasTemperature = latestTemperature !== null || samples.some((sample) => sample.temperatureC !== null);
  return (Object.keys(METRIC_INFO) as CurveMetric[]).filter((metric) => metric !== "temperature" || hasTemperature);
}

/** 追加一个点，超过上限丢最早的。返回新数组（给 setState 用）。 */
export function appendSample(samples: CurveSample[], report: BatteryReport, at = Date.now()): CurveSample[] {
  const next = [
    ...samples,
    {
      at,
      powerW: report.powerW,
      amperageMA: report.amperageMA,
      temperatureC: report.temperatureC,
      chargePercent: report.chargePercent,
    },
  ];
  return next.length > CURVE_LIMIT ? next.slice(next.length - CURVE_LIMIT) : next;
}

/** 图表用的点：缺值的跳过。 */
export function curveMarks(samples: CurveSample[], metric: CurveMetric): { label: Date; value: number }[] {
  const marks: { label: Date; value: number }[] = [];
  for (const sample of samples) {
    const value = valueOf(sample, metric);
    if (value !== null && Number.isFinite(value)) marks.push({ label: new Date(sample.at), value });
  }
  return marks;
}

export interface CurveSummary {
  min: number;
  max: number;
  latest: number;
  /** 第一个点到最后一个点的毫秒数。 */
  spanMs: number;
}

export function curveSummary(samples: CurveSample[], metric: CurveMetric): CurveSummary | null {
  const marks = curveMarks(samples, metric);
  if (marks.length === 0) return null;
  let min = Infinity;
  let max = -Infinity;
  for (const mark of marks) {
    min = Math.min(min, mark.value);
    max = Math.max(max, mark.value);
  }
  return {
    min,
    max,
    latest: marks[marks.length - 1].value,
    spanMs: marks[marks.length - 1].label.getTime() - marks[0].label.getTime(),
  };
}

export function formatMetric(value: number, metric: CurveMetric): string {
  const info = METRIC_INFO[metric];
  return `${value.toFixed(info.digits)} ${info.unit}`;
}

/** 「3 分 20 秒」这类说法。 */
export function formatSpan(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes} 分 ${seconds % 60} 秒` : `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}
