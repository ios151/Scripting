// 分享表单 / 快捷指令入口：把选中的文字（或链接）里的番号交给首页去搜。
//
// 对应原版的分享扩展（`$context.textItems`）。script.json 里 intentInputTypes 声明了 Text 和 URLs，
// runInApp 为 true，所以是在 Scripting 主程序里弹出完整界面，不受分享扩展的内存上限限制。

import { Intent, Script } from "scripting";

import { runApp } from "./pages/App";

function sharedText(): string | undefined {
  const param = Intent.shortcutParameter;
  return (
    Intent.textsParameter?.[0] ??
    Intent.urlsParameter?.[0] ??
    (param && param.type === "text" ? param.value : undefined)
  );
}

(async () => {
  await runApp({ text: sharedText() });
  Script.exit();
})();
