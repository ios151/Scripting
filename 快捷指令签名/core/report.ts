// check 的结果整形：路径参数的校验、把「读好的快捷指令 / 读不了的原因」变成一条条结果、再汇总。
// 纯函数，不碰文件和全局。脚本的无界面 API（kit/api.ts）和技能里的本地检查（技能的 scripts/localCheck.ts）共用这一份，
// 所以两边给 AI 的 check 结果长得一样、话也一样。
//
// 本文件在脚本（core/）和技能（vendor/core/）里各有一份逐字节相同的副本（共 7 个文件，清单和同步命令见 MAINTAINING.md 第 14 节）：
// 源头是脚本这边，改任何一份都要同步另一份，自测会比对。

import { actionIdentifiers, checkWorkflow, type Issue } from "./check";
import { isDict, type PlistValue } from "./plist";
import type { ShortcutKind } from "./read";

/** 一次最多处理多少份：AI 误传一整个目录的文件时，不至于算半天。 */
export const MAX_FILES = 20;
/** 每份结果里最多带多少个动作标识。 */
export const MAX_ACTION_IDS = 100;
/** check 每份结果里，错误和警告各最多列多少条（总数另有 errorCount / warningCount）。 */
export const MAX_ISSUES = 50;

export interface CheckItem {
  /** 来料的文件名 */
  name: string;
  /** 没有错误（严格模式下警告也算错误）。读不了、认不出的文件是 false，原因在 errors 里（code 为 unreadable） */
  ok: boolean;
  /** 来料原本的样子：xml / bplist / signed；读不出来时没有 */
  inputKind?: ShortcutKind;
  actionCount?: number;
  /** 每个动作的标识，按顺序，最多 100 个 */
  actionIds?: string[];
  errorCount: number;
  warningCount: number;
  /** 最多各 50 条，按动作的先后顺序 */
  errors: Issue[];
  warnings: Issue[];
}

/** paths 可以是字符串数组，也可以是单个字符串（path）；非字符串和空串丢掉。 */
function pathList(value: unknown): string[] {
  const raw: unknown[] = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  return raw
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

const isAbsolutePath = (path: string): boolean => path.startsWith("/") || /^file:\/\//i.test(path);

/** check 和 sign 共用的文件路径校验：通过是 { paths }，不通过是 { problem }（现成的、能直接给调用方看的中文）。 */
export function requestedPaths(params: Record<string, unknown>): { paths: string[] } | { problem: string } {
  const paths = pathList(params.paths ?? params.path);
  if (paths.length === 0) {
    return { problem: "没有给文件路径：用 paths（字符串数组）或 path（字符串）传文件的绝对路径" };
  }
  if (paths.length > MAX_FILES) return { problem: `一次最多处理 ${MAX_FILES} 份，收到 ${paths.length} 份` };
  const relative = paths.filter((path) => !isAbsolutePath(path));
  if (relative.length > 0) {
    return { problem: `文件路径要用绝对路径（以 / 开头），这几个不是：${relative.join("、")}` };
  }
  return { paths };
}

/** 读不了、认不出的来料：一条 unreadable 错误，原因写在 message 里。 */
export function unreadableItem(name: string, message: string): CheckItem {
  return {
    name,
    ok: false,
    errorCount: 1,
    warningCount: 0,
    errors: [{ severity: "error", code: "unreadable", path: "$", message }],
    warnings: [],
  };
}

/** 读好的快捷指令过一遍检查器（规则见 core/check.ts），整形成一条结果。 */
export function checkedItem(name: string, inputKind: ShortcutKind, workflow: PlistValue, strict: boolean): CheckItem {
  const result = checkWorkflow(workflow, { strict });
  const actions = isDict(workflow) ? workflow.get("WFWorkflowActions") : undefined;
  return {
    name,
    ok: result.ok,
    inputKind,
    actionCount: result.actionCount,
    actionIds: Array.isArray(actions) ? actionIdentifiers(actions).slice(0, MAX_ACTION_IDS) : undefined,
    errorCount: result.errors.length,
    warningCount: result.warnings.length,
    errors: result.errors.slice(0, MAX_ISSUES),
    warnings: result.warnings.slice(0, MAX_ISSUES),
  };
}

/** 汇总：几份通过、几份没通过，以及给 AI 的下一步提示。 */
export function summarizeChecks(items: readonly CheckItem[]): {
  checkedCount: number;
  passedCount: number;
  failedCount: number;
  nextStep: string;
} {
  const passedCount = items.filter((item) => item.ok).length;
  const failedCount = items.length - passedCount;
  return {
    checkedCount: items.length,
    passedCount,
    failedCount,
    nextStep:
      failedCount === 0
        ? "检查通过：结构上没发现问题，可以 sign。检查通过不保证导入后一定能运行，仍要让用户先小范围试跑。"
        : `有 ${failedCount} 份没通过：按各自 errors 里的 code 和 message 修改后重新 check。没改好就签的话，导入后很可能出问题。`,
  };
}
