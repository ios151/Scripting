// 技能入口的路由：check 在技能自己的运行时里本地检查（localCheck.ts），status / sign 才用 Script.run 交给已安装的
// 「快捷指令签名」脚本，结果原样交回。
//
// 为什么 check 不经过脚本：检查器是纯 TS，技能里带了一份逐字节相同的副本（vendor/），这样检查草稿既不依赖脚本装没装、版本新不新，
// 也不依赖 Script.run 这条（没在真机验证过的）调用链。status / sign 只能交给脚本：签名身份（证书和私钥）在脚本自己的
// 钥匙串里，技能的钥匙串是另一个域，读不到；用户装并信任的又恰恰是那一张证书，再造一份只会让他多装一张。
//
// status 的「就绪」答案技能自己记着（见 CertificateCache）：证书确认就绪之后再问，直接答「就绪」，不去启动脚本。
// 用户反馈过：每次查证书状态都会弹出一个页面，配置好之后也一样；这个答案在证书重新生成 / 取消勾选之前不会变，没必要每次都问。
//
// 不 import "scripting"（Script.run 和 Storage 由入口 scripts/sign.ts 包成 runner / cache 传进来），所以 Node 自测里能直接测。
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

/**
 * 技能自己记的「证书已就绪」，存取在入口 sign.ts 里接 Storage（技能自己的私有域，和脚本的互不相干）。
 *
 * 只记「就绪」这一种答案：没就绪的状态每次都问脚本（用户随时可能刚做完），所以不会出现「缓存说没就绪、其实早好了」；
 * 反过来「缓存说就绪、其实用户又重新生成了证书」是可能的，由两样东西兜底：sign 的结果里总带最新的 certificate（见 remember，
 * 同时刷新缓存），还有 status 的 refresh 参数强制重问。脚本自己的「就绪」本来也只是用户在证书页打的勾，不是系统检测的结果。
 */
export interface CertificateCache {
  read(): unknown
  /** 传 null = 清掉 */
  write(value: Args | null): void
}

function failure(type: string, message: string): Args {
  return { ok: false, error: { type, message } }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null
}

/** status 带了 refresh（布尔 true 或字符串 "true"）：别用记下的答案，重新问一次脚本。 */
function wantsRefresh(params: Args): boolean {
  return params.refresh === true || params.refresh === "true"
}

/**
 * 脚本的 status / sign 答完之后调一下：certificate.usable 为 true 就记下来，不是 true 就清掉。
 * 失败的结果、没有 certificate 的结果不碰缓存（没问出新情况，不该把记着的好答案清了）。写不进去不影响这次的结果。
 */
function remember(cache: CertificateCache | undefined, answer: Args): void {
  if (cache === undefined || answer.ok !== true) return
  const certificate = answer.certificate
  if (typeof certificate !== "object" || certificate === null) return
  try {
    if (certificate.usable === true) {
      cache.write({
        apiVersion: typeof answer.apiVersion === "number" ? answer.apiVersion : REQUIRED_API_VERSION,
        certificate: {
          generated: true,
          confirmedInstalled: true,
          usable: true,
          name: stringOrNull(certificate.name),
          fingerprint: stringOrNull(certificate.fingerprint),
          expires: stringOrNull(certificate.expires),
        },
        checkedAt: new Date().toISOString(),
      })
    } else {
      cache.write(null)
    }
  } catch {
    // 下次多问一次脚本而已
  }
}

/** 记着「就绪」就拼出 status 的答案（带 cached 和 checkedAt）；没记、格式不对、读不出来、证书已过期，都当没有。 */
function recall(cache: CertificateCache | undefined): Args | null {
  if (cache === undefined) return null
  try {
    const value = cache.read() as Args | null | undefined
    if (typeof value !== "object" || value === null) return null
    const certificate = value.certificate
    if (typeof certificate !== "object" || certificate === null || certificate.usable !== true) return null
    if (typeof value.apiVersion !== "number" || typeof value.checkedAt !== "string") return null
    const expires = stringOrNull(certificate.expires)
    // yyyy-mm-dd 的字符串可以直接比大小
    if (expires !== null && expires < new Date().toISOString().slice(0, 10)) return null
    return {
      ok: true,
      action: "status",
      apiVersion: value.apiVersion,
      certificate: {
        generated: true,
        confirmedInstalled: true,
        usable: true,
        name: stringOrNull(certificate.name),
        fingerprint: stringOrNull(certificate.fingerprint),
        expires,
      },
      nextStep: null,
      cached: true,
      checkedAt: value.checkedAt,
    }
  } catch {
    return null
  }
}

export async function route(params: Args, runner: SignerRunner, cache?: CertificateCache): Promise<Args> {
  const operation = String(params.operation ?? "status")
  if (operation !== "status" && operation !== "check" && operation !== "sign") {
    return failure("validation", `未知的 operation：${operation}。可用：status、check、sign`)
  }
  if (operation === "check") return runLocalCheck(params)

  // 证书已经确认就绪的，直接答「就绪」，不去启动脚本；要重新问一次就带 refresh
  if (operation === "status" && !wantsRefresh(params)) {
    const known = recall(cache)
    if (known !== null) return known
  }

  // 只转交脚本认的字段，别的参数一律丢掉（refresh 也是技能自己的，脚本不认）
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
  remember(cache, answer)
  return answer
}
