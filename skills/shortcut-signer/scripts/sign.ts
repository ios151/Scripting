// 调用入口：AI 经 `scripting-ts run` 跑这个文件，结果用 Script.exit 交回（一行 JSON）。
//
// 路由在 router.ts：check 在技能自己的运行时里本地检查（vendor/ 里带了一份检查器）；status / sign 用 Script.run 去调
// 已安装的「快捷指令签名」脚本（签名身份在脚本自己的钥匙串里，技能读不到）。这里只接线，所以保持很薄。
//
// 这个文件从不抛：所有失败都变成 { ok: false, error: { type, message } }，和脚本那边的格式一致。

import { Script } from "scripting"
import { route, SIGNER_SCRIPT } from "./router"

type Args = Record<string, any>

function exit(payload: Args): void {
  Script.exit(JSON.stringify(payload))
}

route((Script.queryParameters ?? {}) as Args, {
  run: (queryParameters) => Script.run<Args>({ name: SIGNER_SCRIPT, queryParameters }),
}).then(exit, (error) => exit({ ok: false, error: { type: "internal", message: error instanceof Error ? error.message : String(error) } }))
