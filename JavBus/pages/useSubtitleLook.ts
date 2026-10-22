// 组件里读字幕外观的 hook：订阅 kit/subtitleLook.ts 的全局状态，别处改了会跟着重绘。

import { useEffect, useState } from "scripting";

import type { SubtitleStyle } from "../core/subtitleStyle";
import { getLook, subscribeLook } from "../kit/subtitleLook";

export function useSubtitleLook(): SubtitleStyle {
  const [look, setLook] = useState<SubtitleStyle>(getLook);
  useEffect(() => {
    const off = subscribeLook(setLook);
    setLook(getLook()); // 挂上之前别处改过的，补上
    return off;
  }, []);
  return look;
}
