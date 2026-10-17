// 首页 Tab 入口。
//
// Scripting 的「设置 → 主页 → 选择脚本」只列出带这个文件的脚本，文件名和位置都是
// 约定死的：必须叫 `home_screen_default_ui.tsx`、与 index.tsx 同级、默认导出一个
// 函数组件。少任何一条，脚本就不会出现在那个列表里。
//
// 这里只做一件事：把 index.tsx 里那个 App 原样挂上去。界面不为 Tab 另写一份，
// 差异都收在 index.tsx 的 `IS_HOME_TAB` 分支里（不 present、不 exit、不画退出键）。
//
// 几条和「运行一次」不同的规矩，改这个文件前先知道：
//   - **不要** `Navigation.present`：宿主已经把组件挂到 Tab 上了，再弹一层是多余的。
//   - **不要** `Script.exit()`：退出会终止实例，Tab 上会留一个不再响应的界面。
//   - 组件**常驻**：切到别的 Tab 再回来状态还在，顶层代码只在首次构建时跑一次。
//     改完代码不会热更新，要长按 tab bar 上的主页图标点 Reload。
//
// 常驻对这个脚本是好事：连一次设备就一直连着，不用每次进来重新握手等十几秒；
// 图标和占用空间的缓存也还在。切回来时会核对隧道是否还活着（index.tsx 的
// `onHomeTabEvent`），收掉了就显示「未连接」。

import { App } from "./index";

export default function HomeScreenView() {
  return <App />;
}
