// 写回主屏布局后的小组件核对（只进日志）。起因：用户反馈写回主屏布局后，小组件的设置（比如 Scripting 小组件选的脚本、参数）被抹掉了。
//
// 两种可能，靠日志分辨：
// 1. 写回时类型变了。8 字节整数超过 2^53 会丢精度。
//    日期这一条已经不成立了：布局改由原生 DeviceServices 解（kit/lockdown.ts），
//    每个条目都带的 iconModDate 现在是 Date 对象，写回去还是 <date>。
//    下面对 PReal 的判断留着兜底——那是自己解二进制 plist 时日期的样子。
// 2. setIconState 本身会重建小组件实例，换了标识，配置跟着没了——那就和类型无关。
// 写入后重读时，把两份布局里的小组件逐个比对、把可疑的值列出来，就能看出是哪一种。
//
// 用户导出的真机布局给了第三条线索：单独摆放的小组件没有 uniqueIdentifier（叠放里的都有），
// 被抹掉设置的正是它。v0.10.2 写回前补上了（homeEdit.withWidgetIdentifiers），
// 真机（2026-10-17）验证：写入后 6 个小组件字段全都没变，Scripting 小组件的参数还在——是第三条。
// 日志留着防回归：哪天又有人说设置丢了，先看重读后的比对有没有「第 x 个变了」。

import { PReal, type PlistValue } from "../core/bplist";
import { debugLog } from "../core/debug";
import { isPlistDict, type PlistDict } from "./plist";
import { formatValue } from "./services";

/** 和 services.classify 的判法一致：format 2 里小组件带 gridSize / elementType，或 iconType 为 custom。 */
function isWidget(value: PlistDict): boolean {
  return value.iconType === "custom" || value.gridSize !== undefined || value.elementType !== undefined;
}

/** 按出现顺序列出所有小组件条目（含叠放里的）。 */
export function widgetEntries(raw: PlistValue): PlistDict[] {
  const found: PlistDict[] = [];
  const walk = (value: PlistValue) => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (isPlistDict(value)) {
      if (isWidget(value)) found.push(value);
      for (const item of Object.values(value)) walk(item);
    }
  };
  walk(raw);
  return found;
}

/** 写回时可能变样的值：像毫秒时间戳的浮点数（原本多半是 <date>）、超出安全范围的整数。 */
export function suspiciousValues(raw: PlistValue, limit = 12): string[] {
  const found: string[] = [];
  const walk = (value: PlistValue, path: string) => {
    if (found.length >= limit) return;
    if (value instanceof PReal) {
      if (Math.abs(value.value) > 1e11) found.push(`${path}=${value.value}（像毫秒时间戳，原本可能是日期）`);
    } else if (typeof value === "number") {
      if (!Number.isSafeInteger(value)) found.push(`${path}=${value}（超出安全整数）`);
    } else if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, `${path}[${index}]`));
    } else if (isPlistDict(value)) {
      for (const [key, item] of Object.entries(value)) walk(item, path ? `${path}.${key}` : key);
    }
  };
  walk(raw, "");
  return found;
}

function short(value: PlistValue | undefined): string {
  if (value === undefined) return "（无）";
  const text = formatValue(value);
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}

/** 写入前后小组件逐个比对：个数、哪些字段变了。 */
export function widgetDiff(before: PlistValue, after: PlistValue): string[] {
  const a = widgetEntries(before);
  const b = widgetEntries(after);
  const lines = [`小组件 ${a.length} → ${b.length} 个`];
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const keys = new Set([...Object.keys(a[i]), ...Object.keys(b[i])]);
    const changed = [...keys].filter((key) => short(a[i][key]) !== short(b[i][key]));
    if (changed.length > 0) {
      lines.push(`第 ${i + 1} 个变了：${changed.map((key) => `${key}: ${short(a[i][key])} → ${short(b[i][key])}`).join("；")}`);
    }
  }
  return lines;
}

/** 写入、重读之后调一次，结果只进日志。 */
export function logWidgetCheck(expected: PlistValue, actual: PlistValue): void {
  const first = widgetEntries(expected)[0];
  if (first) {
    debugLog("layout", `第 1 个小组件的字段：${Object.entries(first).map(([key, value]) => `${key}=${short(value)}`).join("，")}`);
  }
  const suspicious = suspiciousValues(expected);
  debugLog("layout", `可能在写回时变样的值：${suspicious.join("；") || "没有"}`);
  for (const line of widgetDiff(expected, actual)) debugLog("layout", line);
}
