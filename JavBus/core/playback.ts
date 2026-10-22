// 详情页大「播放」按钮：当前探测到的片源里挑哪个、副标题写什么。纯逻辑，页面只负责按它的结果去播。

import type { JableSearch } from "./parse";

export interface Previews {
  /** undefined = 还在探测；null = 探测过、没有。 */
  missav: string | null | undefined;
  jable: JableSearch | null | undefined;
  jableHls: string | null | undefined;
  missavFull: string | null | undefined;
}

export interface PickedSource {
  url: string;
  /** 来源名（MissAV 完整视频 / Jable 预览…）：播放器左上角和按钮副标题都用它。 */
  label: string;
  /** 是完整视频（不是预览）：只有完整视频才有字幕按钮。 */
  full?: boolean;
}

/** 完整视频优先于预览；同一类里 MissAV 在前（原版自动播放也是 Missav 预览优先）。 */
export function pickBestSource(p: Previews): PickedSource | null {
  if (p.missavFull) return { url: p.missavFull, label: "MissAV 完整视频", full: true };
  if (p.jableHls) return { url: p.jableHls, label: "Jable 完整视频", full: true };
  if (p.missav) return { url: p.missav, label: "MissAV 预览" };
  if (p.jable?.preview) return { url: p.jable.preview, label: "Jable 预览" };
  return null;
}

/**
 * 预览探测有没有跑完：两路预览（fourhoi / Jable 搜索），加上 Jable 命中后去播放页取完整视频地址那一步。
 * 不看 MissAV 完整视频：它可以在设置里关掉预取，「undefined」可能永远不变；
 * Jable 没命中时也不会去取播放页，jableHls 同理，所以只在 Jable 命中的前提下才等它。
 */
export function isProbing(p: Previews): boolean {
  if (p.missav === undefined || p.jable === undefined) return true;
  return p.jable !== null && p.jableHls === undefined;
}

/** 「播放」按钮的第二行字：正在放什么 / 点下去会放什么 / 还在找 / 什么都没找到时的退路。 */
export function playSubline(p: Previews, playing: string | null): string {
  if (playing) return `正在播放 · ${playing}`;
  const best = pickBestSource(p);
  if (best) return best.label;
  return isProbing(p) ? "正在探测片源…" : "试试 Fanza 预告";
}
