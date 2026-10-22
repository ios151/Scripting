// 外部播放器：打开、复制链接。拼地址的纯逻辑在 core/player.ts。

import {
  EXTERNAL_PLAYERS,
  PLAYER_TEMPLATE_EXAMPLE,
  hasPlaceholder,
  launchUrl,
  type ExternalPlayerId,
} from "../core/player";
import { PLAYER_TEMPLATE_PROMPT } from "../core/texts";
import { copyText } from "./share";
import { getSettings, updateSettings } from "./settings";
import { showError, showToast } from "./toast";

/**
 * 交给这个播放器播。没装这个 App、或者模板不对，`Safari.openURL` 返回 false，提示出来。
 * 选「自定义」而模板还没填：就地弹输入框，填好直接用（也存进设置，下次不用再填）。
 * subtitle：外挂字幕的地址，接了外挂字幕的播放器（EXTERNAL_PLAYERS 里标了 subtitle 的）才会带上。
 */
export async function openInPlayer(id: ExternalPlayerId, media: string, subtitle = ""): Promise<void> {
  let template = getSettings().playerTemplate;
  if (id === "custom" && !hasPlaceholder(template)) {
    const next = await Dialog.prompt({
      title: "自定义播放器的链接模板",
      message: PLAYER_TEMPLATE_PROMPT,
      placeholder: PLAYER_TEMPLATE_EXAMPLE,
      defaultValue: template,
      confirmLabel: "保存并打开",
      cancelLabel: "取消",
      keyboardType: "URL",
    });
    if (next === null) return;
    template = updateSettings({ playerTemplate: next }).playerTemplate;
  }
  const url = launchUrl(id, media, template, subtitle);
  if (!url) {
    showError("链接模板里要有 {url} 或 {raw}，到「设置 → 外部播放器」里改");
    return;
  }
  const title = EXTERNAL_PLAYERS.find((p) => p.id === id)?.title ?? id;
  if (!(await Safari.openURL(url))) showError(`打不开 ${title}：没装这个 App，或者链接格式不对`);
}

/** 把视频直链复制到剪贴板，方便贴到任何别的播放器里。 */
export async function copyVideoLink(media: string): Promise<void> {
  await copyText(media);
  HapticFeedback.lightImpact();
  showToast("已复制视频链接");
}
