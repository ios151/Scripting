// 无界面入口：给别的脚本 / Scripting 里 AI 的技能用。
//
// 调用方式（Scripting 里）：
//   const result = await Script.run({
//     name: "快捷指令签名",
//     queryParameters: { action: "sign", paths: ["/…/a.plist"], outputDir: "/…/signed" },
//   });
// index.tsx 发现 queryParameters.action 是个字符串，就不弹界面，走这里，把结果交给 Script.exit。
// AI 技能（skills/shortcut-signer）就是靠它调用本脚本的。
//
// 设计上的几条：
//   - 永远不抛：所有失败都变成 { ok: false, error: { type, message } }，调用方（多半是 AI）按 type 处理。
//   - 三个 action：status（查证书状态）、check（签名前的结构检查，只读、不需要身份）、sign（签名）。
//     check 和 sign 互不依赖：检查没通过也能签，由调用方和用户决定。
//   - 只收文件路径，不收 plist 正文：整份 plist 塞进参数（尤其是经 shell 命令行）转义很容易出错，
//     而且文件留在工作区里，用户看得见、能检查自己到底在签什么。
//   - 签名身份没有就自动生成（和界面里第一次签名一致），但结果里明说「证书还没装好 / 没确认信任」，
//     免得 AI 告诉用户「签好了，能导入」——证书没信任的话导入会失败。
//   - 不碰界面的状态：不清临时目录（那是界面启动时的事）；结果写到 outputDir，不给就写到临时工作目录。
//   - 不装证书、不替用户点信任：这两件事系统不让脚本代劳，nextStep 里写明要用户自己做什么。
//
// 不 import "scripting"，Node 里塞假的全局对象就能测。

import { identityExpiry, rootFingerprint, type SigningIdentity } from "../core/identity";
import { stripExtension } from "../core/names";
import {
  checkedItem,
  MAX_ACTION_IDS,
  requestedPaths as validatedPaths,
  summarizeChecks,
  unreadableItem,
  type CheckItem,
} from "../core/report";
import { readWorkflow, type ShortcutKind } from "../core/sign";
import { commonNameOf } from "../core/x509";
import { writeShortcut } from "./files";
import { signChecked } from "./flow";
import { isFailure, sourcesFromPaths } from "./input";
import { nativeDecompress } from "./lzfse";
import { certificateReady, ensureIdentity, readIdentity } from "./store";

/**
 * 接口版本。字段有不兼容的改动、或者技能依赖了新的 action 时加一；技能那边靠它判断脚本够不够新。
 * 1：status / sign　　2：加了 check（技能的流程是「写草稿 → check → sign」，依赖它）
 */
export const API_VERSION = 2;
export const API_ACTIONS = ["status", "check", "sign"] as const;
export type ApiAction = (typeof API_ACTIONS)[number];

export type ApiErrorType = "validation" | "identity" | "internal";

export interface CertificateStatus {
  /** 有没有签名身份（第一次签名会自动生成） */
  generated: boolean;
  /** 用户在证书页自己打的勾——脚本检测不到系统里的信任状态，只能信用户的自述 */
  confirmedInstalled: boolean;
  /** 根证书名称（「证书信任设置」里列的就是它） */
  name: string | null;
  /** 根证书的 SHA-256 指纹 */
  fingerprint: string | null;
  /** 有效期，yyyy-mm-dd */
  expires: string | null;
  /** 生成了、并且用户确认装好信任了：签出来的文件才导得进去 */
  usable: boolean;
}

export interface ApiItemOk {
  ok: true;
  /** 快捷指令的名字（plist 里的 WFWorkflowName，没有就是文件名去掉扩展名） */
  name: string;
  /** 签好的 .shortcut 的绝对路径 */
  path: string;
  size: number;
  actionCount: number;
  /** 每个动作的标识，按顺序，最多 100 个 */
  actionIds: string[];
  actionIdsTruncated: boolean;
  /** 最终的文件里有没有真的压缩过的段 */
  compressed: boolean;
  /** 来料原本的样子：xml / bplist / signed */
  inputKind: ShortcutKind;
  /** 来料已经是签过名的，这次是换成本脚本的签名 */
  resigned: boolean;
}

export interface ApiItemFailed {
  ok: false;
  /** 来料的文件名 */
  name: string;
  /** 能直接给用户看的原因 */
  error: string;
}

export type ApiItem = ApiItemOk | ApiItemFailed;

export interface ApiStatusResult {
  ok: true;
  action: "status";
  apiVersion: number;
  certificate: CertificateStatus;
  nextStep: string | null;
}

export interface ApiSignResult {
  ok: true;
  action: "sign";
  apiVersion: number;
  signedCount: number;
  failedCount: number;
  items: ApiItem[];
  certificate: CertificateStatus;
  nextStep: string | null;
}

/** check 的一条结果；形状和整形在 core/report.ts，技能里的本地检查也用它。 */
export type ApiCheckItem = CheckItem;

export interface ApiCheckResult {
  ok: true;
  action: "check";
  apiVersion: number;
  checkedCount: number;
  passedCount: number;
  failedCount: number;
  items: ApiCheckItem[];
  nextStep: string | null;
}

export interface ApiFailure {
  ok: false;
  apiVersion: number;
  error: { type: ApiErrorType; message: string };
}

export type ApiResult = ApiStatusResult | ApiCheckResult | ApiSignResult | ApiFailure;

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failure(type: ApiErrorType, message: string): ApiFailure {
  return { ok: false, apiVersion: API_VERSION, error: { type, message } };
}

function describeCertificate(identity: SigningIdentity | null): CertificateStatus {
  if (identity === null) {
    return { generated: false, confirmedInstalled: false, name: null, fingerprint: null, expires: null, usable: false };
  }
  const confirmed = certificateReady();
  return {
    generated: true,
    confirmedInstalled: confirmed,
    name: commonNameOf(identity.rootCertificate),
    fingerprint: rootFingerprint(identity),
    expires: identityExpiry(identity).toISOString().slice(0, 10),
    usable: confirmed,
  };
}

/** 下一步该做什么：写给 AI 看，由它转述给用户。 */
function nextStepFor(certificate: CertificateStatus, signedCount: number): string | null {
  if (!certificate.generated) {
    return "还没有签名身份。第一次签名会自动生成；之后要让用户打开「快捷指令签名」脚本，在「安装与信任证书」里装好证书并信任它，签出来的文件才导得进去。";
  }
  if (!certificate.usable) {
    return "证书还没确认装好并信任。让用户打开「快捷指令签名」脚本，进「安装与信任证书」把三步做完并打勾；在那之前，签出来的文件导入时会提示无法验证或未信任。";
  }
  return signedCount > 0 ? "签好了。让用户点「导入」，在系统分享面板里选「快捷指令」。" : null;
}

/** queryParameters 里有字符串 action，就是 API 调用，index.tsx 据此不弹界面。 */
export function isApiRequest(params: unknown): params is Record<string, unknown> {
  if (typeof params !== "object" || params === null) return false;
  const action = (params as { action?: unknown }).action;
  return typeof action === "string" && action.trim() !== "";
}

function status(): ApiResult {
  let identity: SigningIdentity | null;
  try {
    identity = readIdentity();
  } catch (error) {
    return failure("identity", describeError(error));
  }
  const certificate = describeCertificate(identity);
  return { ok: true, action: "status", apiVersion: API_VERSION, certificate, nextStep: nextStepFor(certificate, 0) };
}

/** check 和 sign 共用的文件路径校验：通过就是路径数组，不通过就是现成的 validation 错误。 */
function requestedPaths(params: Record<string, unknown>): string[] | ApiFailure {
  const checked = validatedPaths(params);
  return "problem" in checked ? failure("validation", checked.problem) : checked.paths;
}

/**
 * 只读的结构检查（规则见 core/check.ts）。不需要签名身份，不会生成任何东西。
 * 和 sign 互不依赖：检查没通过也能签，要不要签由调用方（和用户）决定——别人给的快捷指令里，
 * 检查器不认识的写法会被报成问题，那不代表文件有错。
 */
function check(params: Record<string, unknown>): ApiResult {
  const paths = requestedPaths(params);
  if (!Array.isArray(paths)) return paths;
  const strict = params.strict === true;

  const items: ApiCheckItem[] = [];
  for (const source of sourcesFromPaths(paths)) {
    if (isFailure(source)) {
      items.push(unreadableItem(source.name, source.error));
      continue;
    }
    try {
      const { source: inputKind, workflow } = readWorkflow(source.bytes, { decompress: nativeDecompress });
      items.push(checkedItem(source.name, inputKind, workflow, strict));
    } catch (error) {
      items.push(unreadableItem(source.name, describeError(error)));
    }
  }

  const summary = summarizeChecks(items);
  return {
    ok: true,
    action: "check",
    apiVersion: API_VERSION,
    checkedCount: summary.checkedCount,
    passedCount: summary.passedCount,
    failedCount: summary.failedCount,
    items,
    nextStep: summary.nextStep,
  };
}

async function sign(params: Record<string, unknown>): Promise<ApiResult> {
  const paths = requestedPaths(params);
  if (!Array.isArray(paths)) return paths;

  let outputDir: string | undefined;
  if (params.outputDir !== undefined && params.outputDir !== null && params.outputDir !== "") {
    if (typeof params.outputDir !== "string" || !params.outputDir.trim().startsWith("/")) {
      return failure("validation", "outputDir 要是绝对路径（以 / 开头）的目录；不给就写到临时工作目录");
    }
    outputDir = params.outputDir.trim();
  }

  let identity: SigningIdentity;
  try {
    identity = ensureIdentity();
  } catch (error) {
    return failure("identity", describeError(error));
  }

  const items: ApiItem[] = [];
  for (const source of sourcesFromPaths(paths)) {
    if (isFailure(source)) {
      items.push({ ok: false, name: source.name, error: source.error });
      continue;
    }
    const outcome = signChecked(source.bytes, identity);
    if (!outcome.ok) {
      items.push({ ok: false, name: source.name, error: outcome.message });
      continue;
    }
    const name = outcome.name ?? stripExtension(source.name);
    try {
      const path = await writeShortcut(name, outcome.data, outputDir);
      items.push({
        ok: true,
        name,
        path,
        size: outcome.data.length,
        actionCount: outcome.actionCount,
        actionIds: outcome.actionIds.slice(0, MAX_ACTION_IDS),
        actionIdsTruncated: outcome.actionIds.length > MAX_ACTION_IDS,
        compressed: outcome.compressed,
        inputKind: outcome.source,
        resigned: outcome.source === "signed",
      });
    } catch (error) {
      items.push({ ok: false, name, error: `签好了但写不进目录：${describeError(error)}` });
    }
  }

  const signedCount = items.filter((item) => item.ok).length;
  const certificate = describeCertificate(identity);
  return {
    ok: true,
    action: "sign",
    apiVersion: API_VERSION,
    signedCount,
    failedCount: items.length - signedCount,
    items,
    certificate,
    nextStep: nextStepFor(certificate, signedCount),
  };
}

/** 处理一次 API 调用。不会抛：出了任何问题都变成 { ok: false, error }。 */
export async function handleApiRequest(params: Record<string, unknown>): Promise<ApiResult> {
  try {
    const action = String(params.action ?? "").trim();
    if (action === "status") return status();
    if (action === "check") return check(params);
    if (action === "sign") return await sign(params);
    return failure("validation", `不认识的 action：${action}。可用：${API_ACTIONS.join("、")}`);
  } catch (error) {
    return failure("internal", describeError(error));
  }
}
