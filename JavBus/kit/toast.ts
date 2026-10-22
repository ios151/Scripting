// 全局轻提示：任何地方调 showToast("…")，由最上层的「宿主」负责显示，页面不用各自接状态。
//
// 宿主 = 挂了 `toast` 属性的根视图。App 的 TabView 是一个；设置页、文案页这些用
// Navigation.present 弹出来的整页会盖住 TabView，提示显示在被盖住的那一层看不见，
// 所以它们各自再登记一个。登记是一摞：提示交给最后登记的那个，它卸载后上一个自动接回来。
//
// 原版的 `$ui.toast / $ui.error` 对应这里；错误也走轻提示，只是前面加个 ❌，并配一下触感。

type Listener = (message: string) => void;

const hosts: Listener[] = [];

export function showToast(message: string): void {
  hosts[hosts.length - 1]?.(message);
}

/** 失败提示：带触感，文案前缀 ❌（原版 `$ui.error` 的红叉）。 */
export function showError(message: string): void {
  HapticFeedback.notificationError();
  showToast(`❌ ${message}`);
}

/** 宿主挂载时登记；返回取消登记的函数。 */
export function onToast(next: Listener): () => void {
  hosts.push(next);
  return () => {
    const i = hosts.lastIndexOf(next);
    if (i >= 0) hosts.splice(i, 1);
  };
}
