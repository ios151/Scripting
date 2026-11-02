// 请系统什么时候再来重画一次。取成功了隔 20 分钟；没取成功（没网、没位置、数据坏了）早一点再来。
// WidgetKit 只当它是提示、按预算给，所以这里说的是「最早」，不是「准点」。

import { RELOAD_AFTER_MS, RELOAD_RETRY_MS } from "./config";
import type { Loaded } from "./load";

export function nextReloadAt(loaded: Loaded, now: number): number {
  const healthy = loaded.kind === "ok" && !loaded.refreshFailed;
  return now + (healthy ? RELOAD_AFTER_MS : RELOAD_RETRY_MS);
}
