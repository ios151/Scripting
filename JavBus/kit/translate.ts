// 标题翻译：谷歌翻译网页版接口（原版同一个地址，client=it）。

import { getText } from "./http";

const BASE =
  "https://translate.google.hk/translate_a/single?client=it&dt=t&dt=rmt&dt=bd&dt=rms&dt=qca&dt=ss&dt=md&dt=ld&dt=ex&otf=3&dj=1&hl=zh_CN&ie=UTF-8&oe=UTF-8&sl=auto&tl=zh-CN&q=";

/** 原版给这个接口配的 UA，照用。 */
const TRANSLATE_UA = "GoogleTranslate/5.8.58002 (iPhone; iOS 10.3; zh_CN; iPhone8,1)";

/**
 * 译成简体中文。响应里 `sentences` 是分句数组，最后一项通常只带音译字段没有 `trans`；
 * 原版靠「丢掉最后一项」，这里改成只拼带 `trans` 的，哪一项在最后都对。
 */
export async function translateToChinese(text: string): Promise<string> {
  const { text: body, status } = await getText(`${BASE}${encodeURIComponent(text)}`, {
    headers: { "User-Agent": TRANSLATE_UA },
    timeout: 10,
  });
  if (status !== 200) throw new Error(`翻译服务返回 ${status}`);
  const json = JSON.parse(body) as { sentences?: { trans?: string }[] };
  const result = (json.sentences ?? [])
    .map((s) => s.trans ?? "")
    .join("")
    .trim();
  if (!result) throw new Error("翻译结果为空");
  return result;
}
