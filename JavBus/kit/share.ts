// 分享相关：分享链接、剪贴板、Quicker 推送。

import { Script } from "scripting";

import { getText } from "./http";
import { getSettings } from "./settings";

/** 本脚本的「打开某番号」链接：`scripting://run/JavBus?code=SSIS-001`，Script.queryParameters.code 接。 */
export function runUrl(code: string): string {
  return Script.createRunURLScheme(Script.name, { code });
}

/**
 * 分享链接。原版是 `https://shadowNicked.github.io/?code=XXX`（一个会跳到 jsbox:// 的中转页）再过 is.gd 缩短，
 * 那个中转页只认 JSBox，Scripting 没有对应的 https 入口，所以默认直接给 scripting:// 链接。
 * 设置里可以填自己的中转页模板（`{code}` 换成番号）：http(s) 开头的会照原版过一遍 is.gd。
 */
export async function buildShareLink(code: string): Promise<string> {
  const template = getSettings().shareTemplate;
  if (!template) return runUrl(code);
  const link = template.replace(/\{code\}/g, encodeURIComponent(code));
  if (!/^https?:\/\//i.test(link)) return link;
  try {
    const { text } = await getText(`https://is.gd/create.php?format=simple&url=${encodeURIComponent(link)}`, {
      timeout: 10,
    });
    const short = text.trim();
    if (/^https?:\/\/is\.gd\//i.test(short)) return short;
  } catch {
    /* 缩短失败就给长链接，总比什么都分享不出去强 */
  }
  return link;
}

export async function copyText(text: string): Promise<void> {
  await Pasteboard.setString(text);
}

export async function shareItems(items: string[]): Promise<void> {
  await ShareSheet.present(items);
}

export interface QuickerResult {
  ok: boolean;
  message: string;
}

/**
 * 把文本推到电脑上的 Quicker（`operation=copy` = 写进电脑剪贴板）。没配置返回 null，调用方就不提示。
 * 原版 `encodeURI(磁链)`：磁链里有 `&` 和 `?`，encodeURI 不转义它们，`dn=…` 会被当成另一个参数，
 * 电脑上收到的是被截断的磁链；这里用 encodeURIComponent。
 */
export async function pushToQuicker(text: string): Promise<QuickerResult | null> {
  const { quickerMail, quickerCode } = getSettings();
  if (!quickerMail || !quickerCode) return null;
  const url =
    `https://push.getquicker.cn/to/quicker?toUser=${encodeURIComponent(quickerMail)}` +
    `&code=${encodeURIComponent(quickerCode)}&operation=copy&data=${encodeURIComponent(text)}`;
  try {
    const { text: body } = await getText(url, { timeout: 10 });
    let errorMessage = "";
    try {
      errorMessage = (JSON.parse(body) as { errorMessage?: string }).errorMessage ?? "";
    } catch {
      /* 不是 JSON 就当成功，和原版一样只认 errorMessage */
    }
    return errorMessage ? { ok: false, message: errorMessage } : { ok: true, message: "发送成功" };
  } catch {
    return { ok: false, message: "Quicker 推送失败，请检查网络" };
  }
}
