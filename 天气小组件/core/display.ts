// 显示样式：中号、大号上画哪些数据。用户在脚本页「显示样式」里选，存在 Storage 里（store.ts），脚本页和小组件共用。纯函数。
//
// 默认就是原来的样子。可以换的有三处，都只影响中号和大号（小号、锁屏不变）：
//   · 中间那一排（中号）：逐小时，或者明天起的几天（每天带最高最低）；
//   · 右上那一行（中号）：天气和降水概率，或者风和湿度（天气图标挪到气温旁边）；
//   · 底部那一行（中号、大号）：体感 / 湿度 / 风 / 空气，或者「一句话 + 日落 + 空气」，或者不画。
// 备用来源（Open-Meteo）没有详细数据，选了也画不出来，一律按默认的样子画（见 present.ts 的 `effectiveDisplay`）。

/** 中号中间那一排：hourly 逐小时；daily 明天起的几天 */
export type StripMode = "hourly" | "daily";

/** 中号右栏最上面那一行：condition 天气和降水概率；windHumidity 风和湿度 */
export type TopMode = "condition" | "windHumidity";

/** 中号、大号的底部那一行：stats 体感 / 湿度 / 风 / 空气；headline 一句话 + 日落 + 空气；none 不画 */
export type BottomMode = "stats" | "headline" | "none";

/** 底部是 headline 时，那句话写什么：auto 看情况挑；keypoint 彩云的一句话；change 明天比今天冷了还是暖了 */
export type HeadlineMode = "auto" | "keypoint" | "change";

export type Display = {
  strip: StripMode;
  top: TopMode;
  bottom: BottomMode;
  headline: HeadlineMode;
};

export function defaultDisplay(): Display {
  return { strip: "hourly", top: "condition", bottom: "stats", headline: "auto" };
}

const STRIPS: readonly StripMode[] = ["hourly", "daily"];
const TOPS: readonly TopMode[] = ["condition", "windHumidity"];
const BOTTOMS: readonly BottomMode[] = ["stats", "headline", "none"];
const HEADLINES: readonly HeadlineMode[] = ["auto", "keypoint", "change"];

function pick<T extends string>(values: readonly T[], value: unknown, fallback: T): T {
  return values.find((candidate) => candidate === value) ?? fallback;
}

/** 存下来的显示样式读回来：每一项单独验，读不懂的那一项用默认的，别的项照用 */
export function parseDisplay(raw: unknown): Display {
  const fallback = defaultDisplay();
  if (typeof raw !== "object" || raw === null) return fallback;
  const record = raw as Record<string, unknown>;
  return {
    strip: pick(STRIPS, record.strip, fallback.strip),
    top: pick(TOPS, record.top, fallback.top),
    bottom: pick(BOTTOMS, record.bottom, fallback.bottom),
    headline: pick(HEADLINES, record.headline, fallback.headline),
  };
}

/** 两份显示样式一样吗（脚本页里决定要不要显示「恢复默认」） */
export function sameDisplay(a: Display, b: Display): boolean {
  return a.strip === b.strip && a.top === b.top && a.bottom === b.bottom && a.headline === b.headline;
}
