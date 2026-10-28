// 把一份快捷指令签成可以导入的 .shortcut（AEA1）。
//
// 流程：
//   1. 认文件：XML plist / 二进制 plist / 已签名的 AEA1
//   2. 校验是快捷指令（顶层是字典、有 WFWorkflowActions），统一成二进制 plist
//   3. 打成 AA01 归档（目录 + Shortcut.wflow），再套 AEA1：
//      授权数据里放 {SigningCertificateChain: [叶证书, 根证书]}，用叶私钥做 ECDSA 签名
//
// 手机装了并信任根证书之后，系统校验这条链就会通过（见 core/x509.ts 的说明）。

import {
  buildAar,
  extractAar,
  packAea,
  parseAar,
  parseAea,
  type Compressor,
  type Decompressor,
  type RandomSource,
} from "./aea";
import { equalBytes } from "./bytes";
import { actionIdentifiers } from "./check";
import type { SigningIdentity } from "./identity";
import { ecdsaSign, encodeDerSignature, encodePoint } from "./p256";
import { encodeBplist, isDict, parsePlist, type PlistValue } from "./plist";
import { readPlainWorkflow, ShortcutError, type ShortcutKind } from "./read";
import { sha256 } from "./sha256";

// 认格式（sniff / 报错文案 / XML 与二进制的解析）搬到了 core/read.ts，好让技能里也能带一份；这里原样转出，老的导入路径照用
export { headPreview, ShortcutError, sniffShortcut, type ShortcutKind } from "./read";

const WORKFLOW_FILE = "Shortcut.wflow";

export interface PreparedShortcut {
  /** 快捷指令名；plist 里没有就是 null，调用方用文件名顶上 */
  name: string | null;
  actionCount: number;
  /** 每个动作的标识（`WFWorkflowActionIdentifier`），按顺序；读不出来的是 "unknown"。给 AI 核对「签的到底是什么」用 */
  actionIds: string[];
  /** 二进制 plist，就是要放进 Shortcut.wflow 的内容 */
  payload: Uint8Array;
  /** 来料原本的样子 */
  source: ShortcutKind;
}

function describe(workflow: PlistValue): { name: string | null; actionCount: number; actionIds: string[] } {
  if (!isDict(workflow)) throw new ShortcutError("这不是快捷指令：plist 顶层不是字典");
  const actions = workflow.get("WFWorkflowActions");
  if (!Array.isArray(actions)) throw new ShortcutError("这不是快捷指令：plist 里没有 WFWorkflowActions");
  const name = workflow.get("WFWorkflowName");
  return {
    name: typeof name === "string" && name.trim() !== "" ? name.trim() : null,
    actionCount: actions.length,
    actionIds: actionIdentifiers(actions),
  };
}

export interface PrepareOptions {
  /** 来料是已签名文件时用它解压；不给就只能处理没压缩过的 */
  decompress?: Decompressor;
}

export interface WorkflowInput {
  /** 来料原本的样子：xml / bplist / signed */
  source: ShortcutKind;
  /** 解析出来的 plist 值（字典是 Map） */
  workflow: PlistValue;
  /** 来料里现成的二进制 plist：二进制来料原样、已签名来料拆出来的；XML 来料没有，签名时要重新编码 */
  payload: Uint8Array | null;
}

/**
 * 认格式并解析成 plist 值（XML / 二进制 / 已签名的都行）。**不**校验它是不是快捷指令：
 * 签名走 prepareShortcut（要求有 WFWorkflowActions），检查器走 core/check.ts（逐条报问题）。
 * 认不出来、解析不了都抛 ShortcutError，信息能直接给用户看。
 */
export function readWorkflow(input: Uint8Array, options: PrepareOptions = {}): WorkflowInput {
  // XML / 二进制 plist 在 core/read.ts 里读（技能里的本地检查也用它）；已签名的要拆归档、解压，只能在这里
  const plain = readPlainWorkflow(input);
  if (plain.source !== "signed") return plain;
  const payload = extractWorkflow(input, options.decompress);
  try {
    return { source: "signed", workflow: parsePlist(payload), payload };
  } catch (error) {
    throw new ShortcutError(`签名文件里的 plist 解析失败：${(error as Error).message}`);
  }
}

/** 校验 + 统一成二进制 plist。已签名的文件会先拆出里面的 Shortcut.wflow。 */
export function prepareShortcut(input: Uint8Array, options: PrepareOptions = {}): PreparedShortcut {
  const { source, workflow, payload } = readWorkflow(input, options);
  return { ...describe(workflow), payload: payload ?? encodeBplist(workflow), source };
}

/** 从已签名的 .shortcut 里取出 Shortcut.wflow。不验签：这里只是为了换一份签名。 */
export function extractWorkflow(signed: Uint8Array, decompress?: Decompressor): Uint8Array {
  const refuse: Decompressor = () => {
    throw new ShortcutError("这个签名文件的内容是压缩过的，当前环境没有 LZFSE 解压能力");
  };
  let archive: Uint8Array;
  try {
    archive = extractAar(parseAea(signed), decompress ?? refuse);
  } catch (error) {
    if (error instanceof ShortcutError) throw error;
    throw new ShortcutError(`签名文件拆不开：${(error as Error).message}`);
  }
  const file = parseAar(archive).find((entry) => entry.type === "F" && entry.path === WORKFLOW_FILE);
  if (file === undefined) throw new ShortcutError(`签名文件里没有 ${WORKFLOW_FILE}`);
  return file.data;
}

export interface SignOptions {
  compress?: Compressor;
  random?: RandomSource;
  /** 归档里文件的修改时间（纳秒）；默认取现在，测试里固定它 */
  mtimeNs?: bigint;
}

/** 授权数据：二进制 plist，只有证书链一项，链首是叶证书。 */
export function authDataFor(identity: SigningIdentity): Uint8Array {
  return encodeBplist(
    new Map<string, PlistValue>([["SigningCertificateChain", [identity.leafCertificate, identity.rootCertificate]]]),
  );
}

export function signPrepared(
  prepared: PreparedShortcut,
  identity: SigningIdentity,
  options: SignOptions = {},
): Uint8Array {
  const mtimeNs = options.mtimeNs ?? BigInt(Date.now()) * 1_000_000n;
  const aar = buildAar(WORKFLOW_FILE, prepared.payload, mtimeNs);
  return packAea(aar, {
    authData: authDataFor(identity),
    signingPublicKey: encodePoint(identity.leafPublicKey),
    sign: (message) => {
      const { r, s } = ecdsaSign(identity.leafPrivateKey, sha256(message));
      return encodeDerSignature(r, s);
    },
    compress: options.compress,
    random: options.random,
  });
}

export interface SignedShortcut {
  data: Uint8Array;
  name: string | null;
  actionCount: number;
  actionIds: string[];
  source: ShortcutKind;
}

export function signShortcut(
  input: Uint8Array,
  identity: SigningIdentity,
  options: SignOptions & PrepareOptions = {},
): SignedShortcut {
  const prepared = prepareShortcut(input, options);
  return {
    data: signPrepared(prepared, identity, options),
    name: prepared.name,
    actionCount: prepared.actionCount,
    actionIds: prepared.actionIds,
    source: prepared.source,
  };
}

/** 这份签名文件是不是我们这个身份签的（授权数据里的证书链和身份一致）。 */
export function isSignedBy(signed: Uint8Array, identity: SigningIdentity): boolean {
  try {
    return equalBytes(parseAea(signed).authData, authDataFor(identity));
  } catch {
    return false;
  }
}
