// 预警现在是什么状态：从这次取天气的结果里推出来。
//
// 预警和天气是同一次请求（彩云的 `alert=true`）一起带回来的，所以不再有单独的联网和单独的缓存：
// 取到了就跟着天气一起存，没取成功就退回缓存里那份，天气和预警总是同一个时刻的数据。
//
// 原则不变：宁可少显示，不能显示过期的、更不能把「没取到」说成「没有预警」。
//   · 备用来源（Open-Meteo）没有预警：off，界面上不出现预警相关的任何东西；
//   · 没位置、没数据：off；
//   · 读懂了（哪怕是空的）：ok；联网没成功、用的是缓存里的，带上「这次没取成功」，太久的预警由 present.ts 的 `alertView` 挡掉；
//   · 接口没给预警字段、或者读不懂：failed，界面上写原因，徽章不显示；
//   · 例外：App 页「预览预警样式」开着的 10 分钟里，不管来源是什么，给两条写着「示例」的假预警，好在真机上看徽章长什么样。

import { DEMO_ALERTS, type AlertItem } from "./alerts";
import { FetchError, describeFailure, type Failure } from "./failure";
import type { Loaded } from "./load";

export type AlertState =
  /** 没有预警这回事：用的是备用来源，或者没位置、没数据。界面上什么都不出现 */
  | { kind: "off" }
  /** 有一份可信的预警（可能是空的：确实没有）。`failure` 不为空表示这次想刷新、没成功，用的是缓存 */
  | { kind: "ok"; items: AlertItem[]; fetchedAt: number; failure: Failure | null }
  /** 没有可用的预警数据：接口没给、读不懂 */
  | { kind: "failed"; failure: Failure };

export function alertStateOf(loaded: Loaded, now: number, demoUntil: number): AlertState {
  if (demoUntil > now) return { kind: "ok", items: DEMO_ALERTS.slice(), fetchedAt: now, failure: null };
  if (loaded.kind !== "ok" || loaded.provider !== "caiyun" || loaded.alerts === null) return { kind: "off" };

  const { items, failure } = loaded.alerts;
  if (items !== null) {
    // 这次没取成功、用的是缓存里的：把真正的原因带上（token 失效、额度用完……），没记原因的才当联网失败
    const failedNow = loaded.refreshFailed ? (loaded.failure ?? describeFailure(new FetchError("network"))) : null;
    return { kind: "ok", items, fetchedAt: loaded.fetchedAt, failure: failedNow };
  }
  return { kind: "failed", failure: failure === null ? describeFailure(new FetchError("format")) : { reason: failure.reason, message: failure.message } };
}
