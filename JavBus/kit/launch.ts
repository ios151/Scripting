// 跨页面的「去首页做某件事」请求。
//
// 原版所有页面共用一个全局输入框和全局状态，推荐页敲回车、女优页点「欧美」都是直接改全局变量再
// 切到首页。这里各页面互不可见，改成发请求：谁发都行，首页挂载时或收到通知时取走执行，
// App 根视图听到通知把选中的 Tab 切到首页。
//
// 请求只存一份：首页还没挂载时（懒创建的 Tab）先放着，挂载后第一件事就是取。

import type { SiteKind } from "../core/types";

export type LaunchRequest =
  | { type: "search"; keyword: string }
  | { type: "movie"; code: string }
  | { type: "kind"; kind: SiteKind };

let pending: LaunchRequest | null = null;
const listeners = new Set<() => void>();

export function requestLaunch(request: LaunchRequest): void {
  pending = request;
  for (const l of listeners) l();
}

export function takeLaunch(): LaunchRequest | null {
  const request = pending;
  pending = null;
  return request;
}

export function onLaunchRequest(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
