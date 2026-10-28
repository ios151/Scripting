// 技能里的本地检查：不经过「快捷指令签名」脚本，在技能自己的运行时里直接查。
//
// 检查器、读 plist、结果整形、读文件都是 vendor/ 里的副本（和脚本里同名文件逐字节相同，自测会比对），
// 所以结果和脚本的 check 一个样，只有两点不同：
//   1. 没有 apiVersion：它不经过脚本，不属于脚本的接口版本；
//   2. 不收已签名的 .shortcut：拆已签名的文件要解归档、原生解压，那是脚本的活。已签名的文件本来就不必先 check
//      （见 SKILL.md），要换成本机签名直接 sign。
//
// 不 import "scripting"，用全局的 FileManager（vendor/kit/sources.ts 里），所以 Node 自测里塞个假的就能测。

import { readPlainWorkflow } from "../vendor/core/read"
import { checkedItem, requestedPaths, summarizeChecks, unreadableItem, type CheckItem } from "../vendor/core/report"
import { isFailure, sourcesFromPaths } from "../vendor/kit/sources"

const SIGNED_MESSAGE =
  "这是已签名的 .shortcut（AEA1）：技能里的本地检查只收 plist（XML 或二进制），拆已签名的文件是「快捷指令签名」脚本的活。" +
  "已签名的文件不用先检查，要换成本机签名就直接 sign。"

/** 参数和返回值的约定见 SKILL.md 的 operation: check。永远不抛：失败都变成 { ok: false, error }。 */
export function runLocalCheck(params: Record<string, unknown>): Record<string, unknown> {
  const requested = requestedPaths(params)
  if ("problem" in requested) return { ok: false, error: { type: "validation", message: requested.problem } }
  const strict = params.strict === true

  const items: CheckItem[] = []
  for (const source of sourcesFromPaths(requested.paths)) {
    if (isFailure(source)) {
      items.push(unreadableItem(source.name, source.error))
      continue
    }
    try {
      const plain = readPlainWorkflow(source.bytes)
      items.push(
        plain.source === "signed"
          ? unreadableItem(source.name, SIGNED_MESSAGE)
          : checkedItem(source.name, plain.source, plain.workflow, strict),
      )
    } catch (error) {
      items.push(unreadableItem(source.name, error instanceof Error ? error.message : String(error)))
    }
  }

  const summary = summarizeChecks(items)
  return {
    ok: true,
    action: "check",
    checkedCount: summary.checkedCount,
    passedCount: summary.passedCount,
    failedCount: summary.failedCount,
    items,
    nextStep: summary.nextStep,
  }
}
