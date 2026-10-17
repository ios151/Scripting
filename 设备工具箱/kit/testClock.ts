// 模拟时间：把「现在」往后拨，用来测到期提醒的各种显示。
//
// 证书和描述文件的到期时间改不了（签在里面，改一个字节签名就废了），
// 但判断用的「现在」是我们自己给的。所有算到期的地方默认都读这里，
// 拨一下就能看到「还剩 3 天」「已过期」长什么样，不用等真证书过期。
//
// **只放在内存里，不写进 Storage**：测完重启脚本就恢复真实时间。
// 持久化的话，哪天忘了开着，看到「已过期」会以为真过期了——
// 这种误导比每次重开要重设一次麻烦得多。

import { ymd } from "./dates";

/** 偏移的毫秒数，0 表示用真实时间。 */
let offsetMs = 0;

const DAY = 86400000;

/** 算到期时用的「现在」。拨过就是拨过之后的时间。 */
export function simulatedNow(): number {
  return Date.now() + offsetMs;
}

export function clockOffsetDays(): number {
  return Math.round(offsetMs / DAY);
}

export function isClockShifted(): boolean {
  return offsetMs !== 0;
}

/** 往后拨几天。负数往前拨，0 恢复真实时间。 */
export function shiftClock(days: number): void {
  offsetMs = Math.round(days) * DAY;
}

export function resetClock(): void {
  offsetMs = 0;
}

/** 「模拟时间：2026-11-18（+31 天）」。没拨时返回空串。 */
export function clockLabel(): string {
  if (offsetMs === 0) return "";
  const days = clockOffsetDays();
  return `模拟时间：${ymd(simulatedNow())}（${days > 0 ? "+" : ""}${days} 天）`;
}
