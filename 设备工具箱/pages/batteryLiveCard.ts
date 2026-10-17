// 电池实时卡片的开、推、收。一次「实时刷新」对应一个实例、一张卡。
//
// 三条都是真机上栽过才写成这样的：
// - 开卡前先问 areActivitiesEnabled，没开就明确告诉用户去哪儿开；
// - 开新卡前 endAllActivities：卡片的生命周期独立于脚本，上一轮划掉 App 留下的卡收不掉就会越堆越多；
// - 每次都从工厂拿新实例：一个实例的 start() 一生只许调一次。

import { LiveActivity } from "scripting";
import { debugLog, describeError } from "../core/debug";
import { CARD_INTERVAL_MS, cardState, pushHistory, type BatteryCardState } from "../kit/batteryCard";
import type { BatteryReport } from "../kit/services";
import { BatteryLiveActivity } from "../live_activity";

export class BatteryLiveCard {
  private activity: ReturnType<typeof BatteryLiveActivity> | null = null;
  private history: number[] = [];
  private lastState: BatteryCardState | null = null;
  private lastPushed = 0;
  private readonly startedAt = Date.now();
  /** 开卡时插没插着电；拔线要不要收卡看它（见 shouldEndOnUnplug）。没开起来为 null。 */
  startedPluggedIn: boolean | null = null;

  /** 开卡。返回 null 表示开起来了，否则是给用户看的原因——起不来不影响实时刷新本身。 */
  async start(report: BatteryReport): Promise<string | null> {
    try {
      if (!(await LiveActivity.areActivitiesEnabled())) {
        return "实时活动被关掉了，锁屏卡片不会显示。开关在「设置 → Scripting → 实时活动」。";
      }
      await LiveActivity.endAllActivities({ dismissTimeInterval: 0 }).catch(() => undefined);
      this.history = pushHistory([], report.powerW);
      const state = cardState(report, this.history, this.startedAt);
      const activity = BatteryLiveActivity();
      await activity.start(state);
      this.activity = activity;
      this.lastState = state;
      this.lastPushed = Date.now();
      this.startedPluggedIn = report.externalConnected === true;
      debugLog("liveactivity", "电池卡片已启动");
      return null;
    } catch (error) {
      debugLog("liveactivity", "电池卡片启动失败", describeError(error));
      return `锁屏卡片没开起来：${describeError(error)}`;
    }
  }

  /**
   * 每份报告都记进柱状图，但推卡片有节流（CARD_INTERVAL_MS）；
   * 插拔、开始 / 停止充电这种状态变化立刻推。
   */
  async update(report: BatteryReport): Promise<void> {
    this.history = pushHistory(this.history, report.powerW);
    if (!this.activity) return;
    const now = Date.now();
    const state = cardState(report, this.history, this.startedAt);
    const last = this.lastState;
    const changed = last !== null && (last.pluggedIn !== state.pluggedIn || last.charging !== state.charging);
    if (!changed && now - this.lastPushed < CARD_INTERVAL_MS) return;
    this.lastState = state;
    this.lastPushed = now;
    // 用户在锁屏上把卡片划掉之后再推会失败，忽略即可
    await this.activity.update(state).catch(() => undefined);
  }

  async end(): Promise<void> {
    const activity = this.activity;
    this.activity = null;
    if (!activity || !this.lastState) return;
    await activity.end(this.lastState, { dismissTimeInterval: 0 }).catch(() => undefined);
    debugLog("liveactivity", "电池卡片已收起");
  }
}
