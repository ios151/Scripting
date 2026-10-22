// 各 Tab 根页面共用的导航栏：左边「关闭」退出脚本，右边「更多」里放设置、作者声明、更新说明。
//
// 整个 App 是 fullScreen 弹出的（Navigation.present），没有系统的返回出口，所以每个根页面都要自带「关闭」。

import { Button, Menu, Navigation, type VirtualNode } from "scripting";

import { SettingsPage } from "./SettingsPage";
import { showDeclaration, showReleaseNotes } from "./TextSheet";

export function openSettings(): void {
  void Navigation.present({ element: <SettingsPage /> });
}

/** extra：放在「更多」左边的额外按钮（推荐页的高分榜）。 */
export function rootToolbar(dismiss: () => void, extra: VirtualNode[] = []) {
  return {
    topBarLeading: [<Button key="close" title="关闭" action={() => dismiss()} />],
    topBarTrailing: [
      ...extra,
      <Menu key="more" title="更多" systemImage="ellipsis.circle">
        <Button title="设置" systemImage="gearshape" action={openSettings} />
        <Button title="作者声明" systemImage="doc.text" action={showDeclaration} />
        <Button title="更新说明" systemImage="sparkles" action={showReleaseNotes} />
      </Menu>,
    ],
  };
}
