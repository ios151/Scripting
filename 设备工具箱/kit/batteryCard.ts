// 电池实时卡片（锁屏 + 灵动岛）的数据：卡片状态怎么拼、几个显示规则。
//
// 界面在 live_activity.tsx（按系统要求注册代码单独成文件），这里只放纯函数，好测。

import type { BatteryReport } from "./services";

export interface BatteryCardState {
  /** 电池端功率（W），正数是充进电池。 */
  powerW: number | null;
  amperageMA: number | null;
  temperatureC: number | null;
  chargePercent: number | null;
  healthPercent: number | null;
  charging: boolean;
  pluggedIn: boolean;
  fullyCharged: boolean;
  /** 充电器标称功率（W）。 */
  adapterW: number | null;
  /** 最近若干个功率点（W），画迷你柱状图。 */
  history: number[];
  /** 开始监测的毫秒时间戳，卡片上的「已监测」计时从这里起算。 */
  startedAt: number;
}

/** 柱状图留几个点。卡片 2 秒级更新，24 个点约等于最近一分钟。 */
export const HISTORY_LIMIT = 24;

/** 两次推卡片之间至少隔多久。卡片更新太密系统会合并，没必要每份报告都推。 */
export const CARD_INTERVAL_MS = 4000;

export function pushHistory(history: number[], value: number | null): number[] {
  if (value === null || !Number.isFinite(value)) return history;
  const next = [...history, value];
  return next.length > HISTORY_LIMIT ? next.slice(next.length - HISTORY_LIMIT) : next;
}

export function cardState(report: BatteryReport, history: number[], startedAt: number): BatteryCardState {
  return {
    powerW: report.powerW,
    amperageMA: report.amperageMA,
    temperatureC: report.temperatureC,
    chargePercent: report.chargePercent,
    healthPercent: report.healthPercent === null ? null : Math.min(report.healthPercent, 100),
    charging: report.isCharging === true,
    pluggedIn: report.externalConnected === true,
    fullyCharged: report.fullyCharged === true,
    adapterW: report.charger?.watts ?? null,
    history,
    startedAt,
  };
}

/** 状态那一句：充电中 / 已充满 / 接着电源但没在充 / 放电中。 */
export function statusText(state: BatteryCardState): string {
  if (state.fullyCharged) return "已充满";
  if (state.charging) return "充电中";
  if (state.pluggedIn) return "已接电源，暂停充电";
  return "放电中";
}

export function powerText(state: BatteryCardState): string {
  return state.powerW === null ? "— W" : `${Math.abs(state.powerW).toFixed(1)} W`;
}

/** 灵动岛收起态右侧，地方只有六十来点宽。 */
export function compactText(state: BatteryCardState): string {
  if (state.powerW !== null && (state.charging || state.pluggedIn)) return powerText(state);
  return state.chargePercent === null ? "—" : `${state.chargePercent}%`;
}

export type CardTone = "charging" | "warm" | "hot" | "idle";

/**
 * 主色的档位。温度优先：电池偏热时系统会放慢充电，这时候温度比功率更值得一眼看到。
 * 38 / 42°C 这两档只是显示用的阈值，不是苹果公布的限流点。
 */
export function cardTone(state: BatteryCardState): CardTone {
  const temperature = state.temperatureC;
  if (temperature !== null && temperature >= 42) return "hot";
  if (temperature !== null && temperature >= 38) return "warm";
  return state.charging || state.pluggedIn ? "charging" : "idle";
}

/**
 * 迷你柱状图每根柱子的高度（0–1），按这一段的最低到最高归一，看的是起伏。
 *
 * 早先按 0 到最大值归一，功率一稳住所有柱子都顶满，真机上被看成了一根进度条。
 * 现在：几乎不变（波动不到 5%）时画成一排齐平的半高柱子；有起伏时最低 0.15、最高 1；
 * 全为 0 时给一条贴底的细线。
 */
export function sparkHeights(history: number[]): number[] {
  const values = history.map((value) => Math.abs(value));
  if (values.length === 0) return [];
  const max = Math.max(...values);
  const min = Math.min(...values);
  if (max <= 0) return values.map(() => 0.05);
  const range = max - min;
  if (range < max * 0.05) return values.map(() => 0.5);
  return values.map((value) => 0.15 + (0.85 * (value - min)) / range);
}

/**
 * 拔掉充电器要不要收卡：只有开卡时插着电（看的是充电）才收；
 * 开卡时就没插电的，本来看的就是放电，拔插都不该打断。
 */
export function shouldEndOnUnplug(startedPluggedIn: boolean, report: BatteryReport): boolean {
  return startedPluggedIn && report.externalConnected === false;
}
