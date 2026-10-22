// 轻提示宿主：返回要塞给根视图 `toast` 属性的对象。
//
// 挂了它的视图就是一个宿主（见 kit/toast.ts）：App 的 TabView 用一份，
// 用 Navigation.present 弹出来的整页（设置、文案）各用一份。

import { useEffect, useState } from "scripting";

import { onToast } from "../kit/toast";

export function useToastHost() {
  const [state, setState] = useState({ message: "", shown: false });
  useEffect(() => onToast((message) => setState({ message, shown: true })), []);
  return {
    message: state.message,
    isPresented: state.shown,
    onChanged: (shown: boolean) => setState((s) => ({ ...s, shown })),
    duration: 2,
    position: "bottom" as const,
  };
}
