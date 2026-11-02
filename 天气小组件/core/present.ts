// 把「取到了什么」整理成界面要说的话。纯函数：界面只管摆，不碰接口的原始数据，也不自己拼文字。
//
// 文字照 RoamControl 的天气卡：「最高 19° 最低 14°」「降水概率：20%」「上次定位处的天气」「刚才没刷新成功，显示的是之前的数据」。
// 说明文字一句一行、简单通俗；没有数据的几种情况各有一句人话，不留一块空白。
// 详细数据（体感、湿度、风、空气质量、未来几天……）只有彩云来源才有；备用的 Open-Meteo 没有，`detail` 就是 null，界面照旧不画。

import { alertSymbol, sortAlerts, type AlertLevel } from "./alerts";
import type { AlertState } from "./alertState";
import { conditionFor, type Condition, type Sky } from "./condition";
import { ALERT_CLOCK_SKEW_MS, ALERT_MAX_AGE_MS } from "./config";
import { aqiBand, aqiName, aqiShortName, windDirectionName, windLevel, type DayForecast, type Extras } from "./extras";
import type { Loaded } from "./load";
import { buildSnapshot, type Slot } from "./snapshot";

export type SlotView = {
  key: string;
  /** 上面那行：「现在」「15时」「17:55」 */
  label: string;
  symbol: string;
  /** 下面那行：气温，或者日出日落那一格的「日落」 */
  text: string;
  isNow: boolean;
};

/** 要在卡片上亮出来的那一条预警（级别最高、同级里发布最晚的）。没有预警或没有可信的预警数据就是 null */
export type AlertView = {
  /** 「大风蓝色预警」 */
  label: string;
  level: AlertLevel;
  /** 除了这一条，还有几条 */
  more: number;
  /** 锁屏单行和矩形里写的字：有更多条时带个「+N」（主屏幕的徽章把「+N」单独画） */
  text: string;
  /** 完整标题（App 页用） */
  title: string;
  /** 徽章里的图案（SF Symbols），按预警类型挑 */
  symbol: string;
};

/** 一项数据：「体感 14°」。`band` 只有空气质量用，界面按它上色（0 优 … 5 严重污染） */
export type StatView = { key: string; label: string; value: string; band: 0 | 1 | 2 | 3 | 4 | 5 | null };

/** 未来几天里的一天 */
export type DayView = {
  key: string;
  /** 「明天」「后天」「周四」 */
  weekday: string;
  symbol: string;
  /** 「20%」；降水概率不到 10% 就不写，免得每行都是「0%」 */
  rain: string | null;
  low: string;
  high: string;
  /** 温度条：这几天的最低到最高之间，这一天落在哪一段（0 ~ 1） */
  from: number;
  to: number;
};

export type Detail = {
  /** 一行放得下的几项：体感、湿度、风、空气（中号底部、大号底部） */
  stats: StatView[];
  /** App 页「详细数据」：体感、湿度、风、云量、露点、气压、能见度、紫外线 */
  all: StatView[];
  /** App 页「空气质量」：国标指数，和 PM2.5、PM10、臭氧、二氧化氮、二氧化硫、一氧化碳的浓度 */
  air: StatView[];
  /** 彩云那句话：「今日多云，气温适宜」 */
  keypoint: string | null;
  /** 未来 24 小时的概括：「未来24小时多云，气温适中」。App 页用 */
  dayOutlook: string | null;
  /** 未来两小时的降水说明，有没有降水都有：「未来2小时无降水」。App 页用 */
  rainOutlook: string | null;
  /** 未来两小时会下雨 / 下雪时的说明；没有降水就是 null。卡片底部用 */
  rainNote: string | null;
  /** 生活指数：穿衣、舒适度、感冒、洗车 */
  life: StatView[];
  /** 明天起的几天（今天的最高最低已经在卡片头上）：小组件里的温度条用 */
  days: DayView[];
  /** 今天起的每一天一句话：「明天  小雨  5° ~ 12°  降水 70%」。App 页用 */
  week: WeekLine[];
};

/** App 页「未来几天」里的一天：`summary` 是天气和气温，`extra` 是风、湿度、空气、紫外线（读不到的不写，一项都没有就是 null） */
export type WeekLine = { key: string; title: string; summary: string; extra: string | null };

export type Card = {
  kind: "weather";
  /** 地名；反查不到就是「当前位置」 */
  place: string;
  /** 跟着定位走时，地名前画一个定位箭头 */
  followsLocation: boolean;
  temperature: string;
  condition: Condition;
  sky: Sky;
  isDay: boolean;
  /** 「最高 19° 最低 14°」 */
  range: string;
  /** 「降水概率：20%」，接口没给就是 null */
  rain: string | null;
  /** 「降水 20%」，窄的地方用 */
  rainShort: string | null;
  /** 逐小时那几格 */
  slots: SlotView[];
  /** 逐小时每排几格 */
  columns: number;
  /** 底部提醒；没有就是 null。只有出了状况（没刷新成功、用的是上次的位置）才有，正常时卡片上不写更新时间和署名 */
  note: string | null;
  noteShort: string | null;
  /** 锁屏单行：「多云 18° 14~19°」 */
  inline: string;
  /** 预警；没有（或没开）就是 null */
  alert: AlertView | null;
  /** 详细数据；备用来源没有 */
  detail: Detail | null;
};

export type Empty = {
  kind: "empty";
  symbol: string;
  title: string;
  /** 一句一行 */
  lines: string[];
  sky: Sky;
  isDay: boolean;
};

export type Content = Card | Empty;

export const NO_LOCATION: Empty = {
  kind: "empty",
  symbol: "location.slash.fill",
  title: "还没有位置",
  lines: ["点一下打开", "允许定位，或者选个城市"],
  sky: "unknown",
  isDay: true,
};

export const NO_DATA: Empty = {
  kind: "empty",
  symbol: "exclamationmark.triangle.fill",
  title: "天气暂时取不到",
  lines: ["稍后会自动重试", "点一下打开看看"],
  sky: "unknown",
  isDay: true,
};

export function degrees(value: number): string {
  return value + "°";
}

export function rangeText(high: number, low: number): string {
  return "最高 " + degrees(high) + " 最低 " + degrees(low);
}

function pad2(value: number): string {
  return value < 10 ? "0" + value : String(value);
}

/** 设备当地的「12:30」 */
function clock(date: Date): string {
  return pad2(date.getHours()) + ":" + pad2(date.getMinutes());
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** 「12:30」；不是今天就带上「昨天」或日期，免得旧的看着像刚刚的 */
export function whenText(at: number, now: number): string {
  const moment = new Date(at);
  const today = new Date(now);
  if (sameDay(moment, today)) return clock(moment);
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (sameDay(moment, yesterday)) return "昨天 " + clock(moment);
  return pad2(moment.getMonth() + 1) + "-" + pad2(moment.getDate()) + " " + clock(moment);
}

/** 「12:30 更新」 */
export function updatedText(fetchedAt: number, now: number): string {
  return whenText(fetchedAt, now) + " 更新";
}

function slotView(slot: Slot): SlotView {
  return {
    key: slot.kind + "-" + slot.date,
    label: slot.label,
    symbol: slot.condition.symbol,
    text: slot.temperature !== null ? degrees(slot.temperature) : (slot.caption ?? ""),
    isNow: slot.kind === "now",
  };
}

// ---------------------------------------------------------------- 详细数据

/** 「南风 3 级」「无风」 */
export function windText(kmh: number, direction: number): string {
  const level = windLevel(kmh);
  return level === 0 ? "无风" : windDirectionName(direction) + "风 " + level + "级";
}

/** 能见度：十公里以上不要小数 */
export function visibilityText(km: number): string {
  return (km >= 10 ? String(Math.round(km)) : km.toFixed(1)) + " km";
}

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/** 「2026-11-04」是周几 */
export function weekdayOf(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  return WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
}

/** 「2026-11-04」距「2026-11-02」几天 */
function daysApart(from: string, to: string): number {
  const [fromYear, fromMonth, fromDay] = from.split("-").map(Number);
  const [toYear, toMonth, toDay] = to.split("-").map(Number);
  return Math.round((Date.UTC(toYear, toMonth - 1, toDay) - Date.UTC(fromYear, fromMonth - 1, fromDay)) / 86_400_000);
}

/** 「今天」「明天」「后天」，再往后是星期几。按日期算、不按第几项：中间缺了一天，后面的也不会错位 */
function dayTitle(date: string, today: string): string {
  const gap = daysApart(today, date);
  return gap === 0 ? "今天" : gap === 1 ? "明天" : gap === 2 ? "后天" : weekdayOf(date);
}

/**
 * 大号里「明天起的几天」最多画几天：竖向只放得下这么多（接口给 5 天，多的不画）。
 * 改它要看自测里的竖向预算（weather-widget.test.ts）还过不过；App 页的「未来几天」不受它限制，有几天写几天。
 */
export const LARGE_DAYS = 4;

function stat(key: string, label: string, value: string | null, band: StatView["band"] = null): StatView[] {
  return value === null ? [] : [{ key, label, value, band }];
}

/** 一天里的风、湿度、空气、紫外线连成一行：「西南风 3级 · 湿度 26% · 空气 良 35 · 紫外线 低」；读不到的不写 */
function dayExtra(day: DayForecast): string | null {
  const parts = [
    day.wind === null ? null : windText(day.wind.kmh, day.wind.direction),
    day.humidity === null ? null : "湿度 " + day.humidity + "%",
    day.aqi === null ? null : "空气 " + aqiName(day.aqi) + " " + day.aqi,
    day.uv === null ? null : "紫外线 " + day.uv,
  ].filter((part): part is string => part !== null);
  return parts.length === 0 ? null : parts.join(" · ");
}

/** 一项都没有的详细数据也算详细数据（界面上只是没东西可画），所以备用来源和彩云来源用 `detail === null` 区分 */
export function detailOf(extras: Extras): Detail {
  const apparent = extras.apparent === null ? null : degrees(extras.apparent);
  const humidity = extras.humidity === null ? null : extras.humidity + "%";
  const wind = extras.wind === null ? null : windText(extras.wind.kmh, extras.wind.direction);
  // 空气质量：App 页写接口给的全名（「轻度污染 120」）；卡片底部四项平分一行，写两个字的短名（「轻度 120」）
  const air = extras.aqi === null ? null : extras.aqi.text + " " + extras.aqi.value;
  const airShort = extras.aqi === null ? null : aqiShortName(extras.aqi.value) + " " + extras.aqi.value;
  const band = extras.aqi === null ? null : aqiBand(extras.aqi.value);
  const uv = extras.uv === null ? null : extras.uv.text;
  const visibility = extras.visibility === null ? null : visibilityText(extras.visibility);
  const pressure = extras.pressure === null ? null : extras.pressure + " hPa";
  const cloud = extras.cloud === null ? null : extras.cloud + "%";
  const dewpoint = extras.dewpoint === null ? null : degrees(extras.dewpoint);

  const stats = [...stat("apparent", "体感", apparent), ...stat("humidity", "湿度", humidity), ...stat("wind", "风", wind), ...stat("air", "空气", airShort, band)];
  const all = [
    ...stat("apparent", "体感", apparent),
    ...stat("humidity", "湿度", humidity),
    ...stat("wind", "风", wind),
    ...stat("cloud", "云量", cloud),
    ...stat("dewpoint", "露点", dewpoint),
    ...stat("pressure", "气压", pressure),
    ...stat("visibility", "能见度", visibility),
    ...stat("uv", "紫外线", uv),
  ];
  const pollutants = extras.pollutants;
  const amount = (value: number | null, unit: string): string | null => (value === null ? null : value + " " + unit);
  const airRows = [
    ...stat("aqi", "空气质量", air, band),
    ...(pollutants === null
      ? []
      : [
          ...stat("pm25", "PM2.5", amount(pollutants.pm25, "μg/m³")),
          ...stat("pm10", "PM10", amount(pollutants.pm10, "μg/m³")),
          ...stat("o3", "臭氧", amount(pollutants.o3, "μg/m³")),
          ...stat("no2", "二氧化氮", amount(pollutants.no2, "μg/m³")),
          ...stat("so2", "二氧化硫", amount(pollutants.so2, "μg/m³")),
          ...stat("co", "一氧化碳", amount(pollutants.co, "mg/m³")),
        ]),
  ];
  const life = extras.life === null
    ? []
    : [
        ...stat("dressing", "穿衣", extras.life.dressing),
        ...stat("comfort", "舒适度", extras.life.comfort),
        ...stat("coldRisk", "感冒", extras.life.coldRisk),
        ...stat("carWashing", "洗车", extras.life.carWashing),
      ];

  // 明天起的几天（只取画得下的）；温度条按这几天的最低到最高铺开。第一项是今天，没有的话下面两处都不会走到
  const today = extras.days.length === 0 ? "" : extras.days[0].date;
  const coming = extras.days.slice(1, 1 + LARGE_DAYS);
  const lowest = coming.length === 0 ? 0 : Math.min(...coming.map((day) => day.low));
  const highest = coming.length === 0 ? 0 : Math.max(...coming.map((day) => day.high));
  const span = highest - lowest;
  const days: DayView[] = coming.map((day) => ({
    key: day.date,
    weekday: dayTitle(day.date, today),
    symbol: conditionFor(day.code === null ? -1 : day.code, true).symbol,
    rain: day.rainChance !== null && day.rainChance >= 10 ? day.rainChance + "%" : null,
    low: degrees(day.low),
    high: degrees(day.high),
    from: span > 0 ? (day.low - lowest) / span : 0,
    to: span > 0 ? (day.high - lowest) / span : 1,
  }));

  const week: WeekLine[] = extras.days.map((day) => {
    const condition = conditionFor(day.code === null ? -1 : day.code, true);
    const rain = day.rainChance !== null && day.rainChance >= 10 ? "  降水 " + day.rainChance + "%" : "";
    return {
      key: day.date,
      title: dayTitle(day.date, today),
      summary: condition.text + "  " + degrees(day.low) + " ~ " + degrees(day.high) + rain,
      extra: dayExtra(day),
    };
  });

  return { stats, all, air: airRows, keypoint: extras.keypoint, dayOutlook: extras.dayOutlook, rainOutlook: extras.rainOutlook, rainNote: extras.rainNote, life, days, week };
}

// ---------------------------------------------------------------- 预警

/**
 * 预警要不要亮出来：数据是可信的（`ok`：刚取到的，或者缓存里还够新的）、不是空的、取到的时刻不太久也不在未来。
 * 联网失败退回缓存时同样要过「最长显示时间」这一关——几个小时前的预警随时可能已经解除。
 * 「在未来」留一点余地：取到数据的那一刻和画出来的这一刻是两次读时钟，差个几秒不算错（别因此把刚取到的预警藏起来）。
 */
export function alertView(state: AlertState, now: number): AlertView | null {
  if (state.kind !== "ok" || state.items.length === 0) return null;
  const age = now - state.fetchedAt;
  if (!(age > -ALERT_CLOCK_SKEW_MS && age < ALERT_MAX_AGE_MS)) return null;
  const top = sortAlerts(state.items)[0];
  const more = state.items.length - 1;
  return {
    label: top.label,
    level: top.level,
    more,
    text: more > 0 ? top.label + " +" + more : top.label,
    title: top.title,
    symbol: alertSymbol(top.label, top.code),
  };
}

const NO_ALERTS: AlertState = { kind: "off" };

/** App 页「预警」那一节的状态行。备用来源说一声没有，取不到时说原因，别把「没取到」说成「没有预警」 */
export function alertStatusText(state: AlertState | null, enabled: boolean, now: number, demoUntil: number = 0): string {
  if (demoUntil > now) return "正在预览示例预警（到 " + whenText(demoUntil, now) + "）";
  if (!enabled) return "备用来源没有预警";
  if (state === null) return "正在取…";
  if (state.kind === "off") return "没有位置，查不了";
  if (state.kind === "failed") return state.failure.message;
  const when = whenText(state.fetchedAt, now);
  if (state.failure !== null) return "用的是 " + when + " 的数据，这次没取成功：" + state.failure.message;
  return state.items.length === 0 ? "现在没有预警（" + when + " 更新）" : state.items.length + " 条预警（" + when + " 更新）";
}

/** App 页「天气来源」那一节的状态行：取到了就说什么时候，没取成功说原因 */
export function sourceStatusText(loaded: Loaded | null, now: number): string {
  if (loaded === null) return "正在取…";
  if (loaded.kind === "noLocation") return "没拿到位置";
  if (loaded.kind === "noData") return loaded.failure === null ? "天气暂时取不到" : loaded.failure.message;
  if (loaded.refreshFailed) return "这次没刷新成功：" + (loaded.failure === null ? "联网失败" : loaded.failure.message);
  return updatedText(loaded.fetchedAt, now);
}

/** 填完自己的地址和 token、点「保存并测试」之后弹的那句话：天气取到了没有，预警取到了没有 */
export function sourceTestMessage(weather: Loaded, alerts: AlertState): string {
  if (weather.kind === "noLocation") return "没有位置，没法查\n先允许定位，或者选一个固定城市";
  if (weather.kind === "noData") return "没取成功\n" + (weather.failure === null ? "联网失败" : weather.failure.message);
  if (weather.refreshFailed) return "这次没取成功\n" + (weather.failure === null ? "联网失败" : weather.failure.message);
  if (alerts.kind === "failed") return "天气取到了，预警没取成功\n" + alerts.failure.message;
  if (alerts.kind === "ok") return alerts.items.length === 0 ? "接口可用\n当前位置现在没有预警" : "接口可用\n当前位置有 " + alerts.items.length + " 条预警";
  return "接口可用";
}

// ---------------------------------------------------------------- 整张卡

/** 逐小时那一行的格数：小号 / 中号 5 格；大号有详细数据时一排 6 格（后面接未来几天），没有时两排共 10 格 */
export const COMPACT_SLOTS = 5;
export const LARGE_DETAILED_SLOTS = 6;
export const LARGE_PLAIN_SLOTS = 10;

export type CardSize = "compact" | "large";

export function present(loaded: Loaded, now: number, size: CardSize, alerts: AlertState = NO_ALERTS): Content {
  if (loaded.kind === "noLocation") return NO_LOCATION;
  if (loaded.kind === "noData") return NO_DATA;

  const detail = loaded.extras === null ? null : detailOf(loaded.extras);
  const slotCount = size === "compact" ? COMPACT_SLOTS : detail === null ? LARGE_PLAIN_SLOTS : LARGE_DETAILED_SLOTS;
  const snapshot = buildSnapshot(loaded.forecast, loaded.fetchedAt, slotCount);
  if (snapshot === null) return NO_DATA;

  // 底部提醒的先后照 RoamControl：先说是不是上次定位处，再说刷新有没有成功
  let note: string | null = null;
  let noteShort: string | null = null;
  if (loaded.source === "stored") {
    note = "上次定位处的天气";
    noteShort = note;
  } else if (loaded.refreshFailed) {
    note = "刚才没刷新成功，显示的是之前的数据";
    noteShort = "没刷新成功，显示旧数据";
  }

  const rain = snapshot.rainChance;
  return {
    kind: "weather",
    place: loaded.place ?? "当前位置",
    followsLocation: loaded.source === "live" || loaded.source === "stored",
    temperature: degrees(snapshot.temperature),
    condition: snapshot.condition,
    sky: snapshot.condition.sky,
    isDay: snapshot.isDay,
    range: rangeText(snapshot.high, snapshot.low),
    rain: rain === null ? null : "降水概率：" + rain + "%",
    rainShort: rain === null ? null : "降水 " + rain + "%",
    slots: snapshot.slots.map(slotView),
    columns: size === "large" && detail === null ? 5 : slotCount,
    note,
    noteShort,
    inline: snapshot.condition.text + " " + degrees(snapshot.temperature) + " " + snapshot.low + "~" + degrees(snapshot.high),
    alert: alertView(alerts, now),
    detail,
  };
}
