// 技能入口的路由：check 在技能自己的运行时里本地检查（localCheck.ts），status / sign 才用 Script.run 交给已安装的
// 「快捷指令签名」脚本，结果原样交回。
//
// 为什么 check 不经过脚本：检查器是纯 TS，技能里带了一份逐字节相同的副本（vendor/），这样检查草稿既不依赖脚本装没装、版本新不新，
// 也不依赖 Script.run 这条（没在真机验证过的）调用链。status / sign 只能交给脚本：签名身份（证书和私钥）在脚本自己的
// 钥匙串里，技能的钥匙串是另一个域，读不到；用户装并信任的又恰恰是那一张证书，再造一份只会让他多装一张。
//
// 不 import "scripting"（Script.run 由入口 scripts/sign.ts 包成 runner 传进来），所以 Node 自测里能直接测。
// 永远不抛：所有失败都变成 { ok: false, error: { type, message } }，和脚本那边的格式一致。

import { runLocalCheck } from "./localCheck"

/** 要调用的脚本的名字：必须和「快捷指令签名」脚本在 Scripting 里的名字一致。 */
export const SIGNER_SCRIPT = "快捷指令签名"
/**
 * 经脚本做的事（status / sign）要求的脚本 API 版本（脚本里 kit/api.ts 的 API_VERSION）。脚本比它旧就让用户更新。
 * 1：脚本有了无界面 API（status / sign）。check 在技能里本地跑，不要求脚本的版本。
 */
export const REQUIRED_API_VERSION = 1

type Args = Record<string, any>

/** 包一层 Script.run：入口里换成真的，自测里换成假的。 */
export interface SignerRunner {
  run(request: Args): Promise<unknown>
}

function failure(type: string, message: string): Args {
  return { ok: false, error: { type, message } }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function route(params: Args, runner: SignerRunner): Promise<Args> {
  const operation = String(params.operation ?? "status")
  if (operation !== "status" && operation !== "check" && operation !== "sign") {
    return failure("validation", `未知的 operation：${operation}。可用：status、check、sign`)
  }
  if (operation === "check") return runLocalCheck(params)

  // 只转交脚本认的字段，别的参数一律丢掉
  const request: Args = { action: operation }
  if (operation === "sign") {
    request.paths = params.paths ?? params.path
    if (params.outputDir !== undefined) request.outputDir = params.outputDir
  }

  let result: unknown
  try {
    result = await runner.run(request)
  } catch (error) {
    return failure(
      "launch",
      `没能运行「${SIGNER_SCRIPT}」脚本：${describeError(error)}。确认它已经装在 Scripting 里，名字没有改过`,
    )
  }

  if (result === null || result === undefined || typeof result !== "object") {
    return failure(
      "no_result",
      `「${SIGNER_SCRIPT}」没有返回结果：多半是脚本没装，或者版本太旧、还没有 API 入口（需要 API 版本 ${REQUIRED_API_VERSION} 或更高）。` +
        "让用户更新脚本，或者先手动打开它确认能正常运行",
    )
  }
  const answer = result as Args
  if (typeof answer.apiVersion === "number" && answer.apiVersion < REQUIRED_API_VERSION) {
    return failure(
      "outdated",
      `「${SIGNER_SCRIPT}」的 API 版本是 ${answer.apiVersion}，本技能需要 ${REQUIRED_API_VERSION} 或更高。让用户更新脚本`,
    )
  }
  return answer
}
