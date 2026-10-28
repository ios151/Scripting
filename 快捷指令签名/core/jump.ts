// 「证书设置跳转」快捷指令：让快捷指令去打开「设置」里的深链页。
//
// 脚本自己调 prefs: 链接会被系统拒绝（iOS 27.2 实测，WLOC 的 utils/appSettings.ts 记着），
// 而快捷指令是系统应用，「打开 URL」动作理论上放行——真实样本里也有别人用它开 prefs:（9 处）。
// 但这两条具体的链接在用户这台 iOS 上通不通**没验证过**：证书页把它做成「实验」，
// 照实告诉用户可能出现的几种结果。
//
// 外壳（名字以外的所有键）逐字取自真机验证过的「签名测试」（core/sample.ts），只换名字和动作；
// 动作的写法来自真实样本：菜单的三种模式、打开 URL 的 WFInput 直接放字符串。

import { parsePlist, encodeXmlPlist, type PlistDict, type PlistValue } from "./plist";
import { SAMPLE_SHORTCUT_XML } from "./sample";

/** 导入后在「快捷指令」里的名字。它同时是文件名和 run-shortcut 链接里的名字，三处必须一致（自测核对）。 */
export const JUMP_SHORTCUT_NAME = "证书设置跳转";

export interface JumpTarget {
  /** 菜单里显示的字 */
  title: string;
  /** 交给「打开 URL」的链接 */
  url: string;
}

/** 菜单里的两项：装完描述文件要去哪里装 / 删，装完证书要去哪里信任。 */
export const JUMP_TARGETS: readonly JumpTarget[] = [
  { title: "描述文件（安装 / 删除）", url: "prefs:root=General&path=ManagedConfigurationList" },
  { title: "证书信任设置", url: "prefs:root=General&path=About/CERT_TRUST_SETTINGS" },
];

const MENU_PROMPT = "要打开哪一页？";
const MENU_GROUP = "E5555555-5555-4555-8555-555555555555";

/** 让「快捷指令」App 运行指定名字的快捷指令的链接（苹果文档里的 run-shortcut）。 */
export function runShortcutUrl(name: string): string {
  return `shortcuts://run-shortcut?name=${encodeURIComponent(name)}`;
}

const menuAction = (parameters: { [key: string]: PlistValue }): PlistValue => ({
  WFWorkflowActionIdentifier: "is.workflow.actions.choosefrommenu",
  WFWorkflowActionParameters: { ...parameters, GroupingIdentifier: MENU_GROUP },
});

function jumpActions(): PlistValue[] {
  const actions: PlistValue[] = [
    menuAction({ WFControlFlowMode: 0, WFMenuItems: JUMP_TARGETS.map((target) => target.title), WFMenuPrompt: MENU_PROMPT }),
  ];
  for (const target of JUMP_TARGETS) {
    actions.push(
      menuAction({ WFControlFlowMode: 1, WFMenuItemTitle: target.title }),
      { WFWorkflowActionIdentifier: "is.workflow.actions.openurl", WFWorkflowActionParameters: { WFInput: target.url } },
    );
  }
  actions.push(menuAction({ WFControlFlowMode: 2 }));
  return actions;
}

/** 未签名的 XML plist，交给 signChecked 签。 */
export function jumpShortcut(): Uint8Array {
  const shell = parsePlist(new TextEncoder().encode(SAMPLE_SHORTCUT_XML)) as PlistDict;
  shell.set("WFWorkflowName", JUMP_SHORTCUT_NAME);
  shell.set("WFWorkflowActions", jumpActions());
  return encodeXmlPlist(shell);
}
