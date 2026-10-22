// 字幕外观（颜色 / 字号 / 透明度 / 双层 / 位置）的全局状态：所有影片共用一份，存在设置里（kit/settings.ts 的 subtitleStyle）。
// 取值和规整在 core/subtitleStyle.ts；组件里用的 hook 是 pages/useSubtitleLook.ts。
//
// 放在页面外面、让用到它的组件（字幕层、设置面板）各自订阅：滑块拖动时每一格都要改一次，
// 放在详情页的 state 里会让整页跟着重绘；这样只有字幕层和面板在重绘。
// 存盘分两种：开关、选色、拖完位置这类一次性的马上存；滑块一路在变，停下 0.4 秒再存，免得每一格写一次存储。

import { normalizeSubtitleStyle, type SubtitleStyle } from "../core/subtitleStyle";
import { getSettings, updateSettings } from "./settings";

/** 滑块停下多久以后存盘。 */
const PERSIST_DELAY_MS = 400;

let current: SubtitleStyle | undefined;
/** 内存里的比存下来的新。 */
let dirty = false;
let persistTimer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<(look: SubtitleStyle) => void>();

export function getLook(): SubtitleStyle {
  current ??= getSettings().subtitleStyle;
  return current;
}

/** 把还没存的外观存进设置（没有要存的就什么都不做）。 */
export function flushLook(): void {
  if (persistTimer !== undefined) {
    clearTimeout(persistTimer);
    persistTimer = undefined;
  }
  if (!dirty) return;
  dirty = false;
  updateSettings({ subtitleStyle: getLook() });
}

/**
 * 改外观：先改内存里的（订阅的组件马上重绘），再存盘。
 * @param patch 要改的字段，改完会过一遍 normalizeSubtitleStyle（收进范围、取两位小数）
 * @param save "now" 马上存（开关、选色、拖完位置）；"later" 停下一会儿再存（滑块一路在拖）
 */
export function changeLook(patch: Partial<SubtitleStyle>, save: "now" | "later" = "now"): void {
  const next = normalizeSubtitleStyle({ ...getLook(), ...patch });
  current = next;
  dirty = true;
  for (const listener of listeners) listener(next);
  if (save === "now") {
    flushLook();
    return;
  }
  if (persistTimer !== undefined) clearTimeout(persistTimer);
  persistTimer = setTimeout(flushLook, PERSIST_DELAY_MS);
}

/** 订阅外观的变化，返回取消订阅的函数。 */
export function subscribeLook(listener: (look: SubtitleStyle) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
