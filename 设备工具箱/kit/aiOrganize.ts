// 主屏整理的 AI 对话：每一轮返回「给人看的回复」+「要执行的动作」。
//
// 走 Scripting 内置的 `Assistant.requestStreaming`（文档 assistant/request_streaming），
// 用的是用户在 Scripting 助手里配好的服务。只发 App 的名称、bundle ID、所在页和对话本身。
//
// 为什么从 requestStructuredData 换成流式：那是一次性请求，模型想完才回第一个字节。
// 真机上 150 多个 App 时连着三次「请求超时」（-1001），重试也是同样慢。流式边生成边回，
// 连接上一直有数据，不会因为等太久被断；还能显示进度、中途停止。
// 代价是没有 JSON Schema 约束：输出格式写在 OUTPUT_FORMAT 里，程序从回复里抠出 JSON，
// 再照旧交给 parseReply / resolvePlan / sanitizePlan 清洗——AI 的输出本来就一律当不可信。
//
// 为什么不用 Conversation API（startConversation / present）：那是系统托管的聊天页，
// 脚本拿不回模型的输出，没法据此改主屏。

import { debugLog, describeError } from "../core/debug";
import { delay, withTimeout } from "../core/stream";
import type { LooseApp } from "./homeOrganize";
import { FOLDER_NAME_LIMIT } from "./homeOrganize";

export interface ModelChoice {
  provider: Assistant.Provider;
  modelId?: string;
}

export interface ChatTurn {
  role: "user" | "assistant";
  text: string;
}

export type OrganizeAction = "group" | "sort" | "color" | "colorFolders" | "none";

export interface OrganizerReply {
  reply: string;
  action: OrganizeAction;
  /** action 为 sort / color / colorFolders 时：是否倒序。 */
  descending: boolean;
  /** action 为 colorFolders 时：是否先拆开选中页上的已有文件夹。 */
  dissolveFolders: boolean;
  /** action 为 group 时的原始方案，未清洗——交给 sanitizePlan。 */
  rawPlan: unknown;
}

/**
 * 输出格式，作为 systemPrompt 发出去。流式请求没有 Schema，字段约定全写在这里；
 * 字段含义和原来 requestStructuredData 的 Schema 一致，parseReply 照旧兜底。
 */
export const OUTPUT_FORMAT = [
  "你在一个 iPhone 主屏整理工具里工作。每一轮只输出一个 JSON 对象，不要输出任何别的文字，不要用代码块包起来。",
  '格式：{"reply": "…", "action": "…", "descending": false, "dissolveFolders": false, "folders": [{"name": "…", "apps": [1, 2]}]}',
  "- reply：给用户看的回复，简体中文，一到三句话，说明你打算怎么做；做不到的要求要直说做不到。",
  "- action：只能是 group、sort、color、colorFolders、none 之一。",
  "- descending：action 为 sort 时是否倒序（Z 到 A），为 color / colorFolders 时是否倒序（紫到红）；其他情况填 false。",
  "- dissolveFolders：action 为 colorFolders 且用户要求先把已有文件夹拆开（释放、解散、拆开文件夹）时填 true；其他情况填 false。",
  `- folders：action 为 group 时给出这一轮要建的文件夹，name 是简体中文文件夹名（不超过 ${FOLDER_NAME_LIMIT} 个字符），apps 是 App 的编号；其他情况填 []。`,
  "五个字段都要给出。",
].join("\n");

/** 只带最近几轮，长对话不至于把输入撑爆。 */
const HISTORY_TURNS = 8;

// ── 提示词：用户可改的「整理风格」+ 程序固定附加的「协议」 ────────────────
//
// 拆成两段，是为了让用户能调分类口味，又不至于把程序依赖的约定改坏：
//   - 风格段（可改）：角色、分几个文件夹、怎么命名、按什么标准归类
//   - 协议段（固定）：有哪几个动作、只能用列表里的 ID、每个 App 只能出现一次……
// 协议段永远附在风格段后面，并声明「与上面冲突时以这里为准」。
// 就算风格段被改得一塌糊涂，最坏也只是方案质量差：AI 的输出照样经过
// parseReply / sanitizePlan 清洗，写入前照样备份、写后照样核对。

export const STYLE_PROMPT_LIMIT = 2000;
const STYLE_PROMPT_KEY = "devicekit_organize_style_prompt_v1";

export const DEFAULT_STYLE_PROMPT = [
  "你是 iPhone 主屏整理助手，在一个整理工具里和用户对话。",
  "分文件夹时：",
  "- 用户没指定时，文件夹数量控制在 4 到 12 个；每个文件夹至少 2 个 App。",
  "- 实在不好归类、或者只有它一个同类的 App，不要放进任何文件夹。",
  `- 文件夹名用简体中文，简短直观，不超过 ${FOLDER_NAME_LIMIT} 个字符，不要用表情符号。`,
  "- 按 App 的实际用途分类；拿不准的根据 bundle ID 判断开发商和用途。",
  "- 用户要调整上一版方案时，在上一版的基础上改，并给出改完后的完整方案。",
  "回复用简体中文，一到三句话，语气友好、直接。",
].join("\n");

/** 程序依赖的约定。不给用户改，设置页里只读展示。 */
export const FIXED_PROTOCOL = [
  "以下是程序的固定规则，与上面的要求冲突时以这里为准：",
  "你只能让程序做下面四件事之一，通过 action 字段表达：",
  "- group：把列出的散放 App 分进新建的文件夹，在 folders 里给出这一轮要建的全部文件夹（调整上一版时给改完后的完整方案，不是增量）。" +
    "用户只要处理某一类 App（比如「把代理工具放进一个文件夹」）时，folders 里只放那一类，其他 App 不要放，也不要顺手给别的 App 分文件夹。",
  "- sort：把这些 App 按名称排序（中文按拼音、英文按字母），由程序执行，你不用给出顺序。",
  "- color：把这些 App 按图标颜色排成彩虹顺序，颜色由程序从图标里算，你不用给出顺序。",
  "- colorFolders：按图标颜色把 App 分进「红色」「蓝色」「黑白灰」这样的文件夹，归类和文件夹名都由程序从图标里算，你不用给出 folders。" +
    "用户要求先把已有文件夹拆开（释放、解散、拆开文件夹）时 dissolveFolders 填 true。",
  "用户的要求不属于这四类（比如删除 App、改图标或名字、动 Dock 或小组件），action 填 none，并在 reply 里说明做不到、能做什么。",
  "用户只是在聊天、提问或者要求不清楚时，action 也填 none，在 reply 里回答或追问。",
  "folders 里用列表每行开头的编号表示 App，只能用列表里出现的编号，不要编造；每个 App 最多出现在一个文件夹里。",
  "列表里每个 App 都标了在第几页。用户只要整理某几页时，只把那几页的 App 放进文件夹，其他页的一个都不要放。",
].join("\n");

/** 当前生效的风格段：用户改过且非空就用用户的，否则用默认。 */
export function loadStylePrompt(): string {
  const custom = Storage.get<string>(STYLE_PROMPT_KEY);
  return typeof custom === "string" && custom.trim() ? custom : DEFAULT_STYLE_PROMPT;
}

export function isCustomStylePrompt(): boolean {
  const custom = Storage.get<string>(STYLE_PROMPT_KEY);
  return typeof custom === "string" && custom.trim() !== "" && custom !== DEFAULT_STYLE_PROMPT;
}

/** 存自定义风格段；空白或和默认一模一样就等于恢复默认。超长截断。 */
export function saveStylePrompt(text: string): void {
  const trimmed = text.slice(0, STYLE_PROMPT_LIMIT);
  if (!trimmed.trim() || trimmed === DEFAULT_STYLE_PROMPT) Storage.remove(STYLE_PROMPT_KEY);
  else Storage.set(STYLE_PROMPT_KEY, trimmed);
}

export function resetStylePrompt(): void {
  Storage.remove(STYLE_PROMPT_KEY);
}

export function buildPrompt(
  apps: LooseApp[],
  history: ChatTurn[],
  currentPlan: string | null,
  stylePrompt: string = DEFAULT_STYLE_PROMPT,
  folderApps = 0,
): string {
  const recent = history.slice(-HISTORY_TURNS);
  return [
    stylePrompt.slice(0, STYLE_PROMPT_LIMIT).trim() || DEFAULT_STYLE_PROMPT,
    "",
    FIXED_PROTOCOL,
    "",
    currentPlan ? `上一版方案（数字是下面列表里的编号）：\n${currentPlan}\n` : "",
    "散放的 App（每行「编号 | 显示名称 | bundle ID | 所在页」）：",
    ...apps.map((app, index) => `${index + 1} | ${app.name} | ${app.bundleId} | 第 ${app.page + 1} 页`),
    // 选中页大多是文件夹时散放的很少，不说一声 AI 会以为没东西可整理
    folderApps > 0 ? `另外，选中页上已有的文件夹里还有 ${folderApps} 个 App（只有 colorFolders 且 dissolveFolders 为 true 时会动它们）。` : "",
    "",
    "对话记录（最后一条是用户这一轮的消息）：",
    ...recent.map((turn) => `${turn.role === "user" ? "用户" : "助手"}：${turn.text}`),
  ]
    .filter((line, index, all) => !(line === "" && all[index - 1] === ""))
    .join("\n");
}

/** 模型的输出一律当不可信：action 不认识就当 none，reply 为空给个兜底。 */
export function parseReply(raw: unknown): OrganizerReply {
  const record = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const action = typeof record.action === "string" ? record.action.trim().toLowerCase() : "";
  const known: OrganizeAction =
    action === "group" || action === "sort" || action === "color"
      ? action
      : action === "colorfolders" || action === "color_folders"
        ? "colorFolders"
        : "none";
  const reply = typeof record.reply === "string" && record.reply.trim() ? record.reply.trim() : "（模型没有给出回复）";
  return {
    reply,
    action: known,
    descending: record.descending === true,
    dissolveFolders: known === "colorFolders" && record.dissolveFolders === true,
    rawPlan: known === "group" ? { folders: record.folders } : null,
  };
}

/**
 * 把模型回的编号换回 bundle ID，给 sanitizePlan 清洗。
 *
 * 为什么让模型回编号：要它逐个写出完整的 bundle ID，八九十个 App 的方案就是一大段 JSON，
 * 真机上用户的自定义模型直接报「Response exceeded the output token limit」。编号短得多。
 *
 * 编号从 1 起，对应 buildPrompt 里列表的顺序。数字字符串也认；超出范围的换成一个
 * 不可能存在的 ID，让 sanitizePlan 照常丢掉并计数；模型要是还回了 bundle ID 字符串，
 * 原样交给 sanitizePlan 校验。
 */
export function resolvePlan(rawPlan: unknown, apps: LooseApp[]): { folders: { name: unknown; bundleIds: string[] }[] } {
  const folders = rawPlan && typeof rawPlan === "object" ? (rawPlan as { folders?: unknown }).folders : undefined;
  if (!Array.isArray(folders)) return { folders: [] };
  return {
    folders: folders.map((entry) => {
      const record = entry && typeof entry === "object" ? (entry as { name?: unknown; apps?: unknown; bundleIds?: unknown }) : {};
      const refs = Array.isArray(record.apps) ? record.apps : Array.isArray(record.bundleIds) ? record.bundleIds : [];
      const bundleIds = refs.map((ref) => {
        const number = typeof ref === "number" ? ref : typeof ref === "string" && /^\d+$/.test(ref.trim()) ? Number(ref) : NaN;
        if (Number.isInteger(number)) return apps[number - 1]?.bundleId ?? `#${number}`;
        return typeof ref === "string" ? ref : "";
      });
      return { name: record.name, bundleIds };
    }),
  };
}

/** 超出模型输出上限：说人话，告诉用户怎么绕过去。脚本这边调不了这个上限。 */
export function isOutputLimitError(error: unknown): boolean {
  return /output token limit|max(imum)?[_ ]?tokens|exceeded.*token/i.test(describeError(error));
}

/** AI 那一轮失败时给用户看的话。 */
export function organizerErrorText(error: unknown): string {
  if (isOutputLimitError(error)) {
    return "这次的方案太长，超出了所选模型的输出上限。可以在右上角少选几页再试，或者换一个模型。";
  }
  if (isTimeout(error)) {
    return "AI 太久没回复（超时）。可以在右上角少选几页、把要求说得具体些，或者换一个快一点的模型。";
  }
  if (error instanceof ReplyFormatError) return "AI 的回复格式不对，换个说法或换个模型再试。";
  return `没连上 AI：${describeError(error)}`;
}

/** 用户点了「停止等待」。 */
export class StoppedError extends Error {
  constructor() {
    super("已停止等待");
  }
}

/** 模型回的不是能解析的 JSON。 */
export class ReplyFormatError extends Error {}

/** 从模型的回复里抠出 JSON：容忍前后多了几句话、用代码块包起来。 */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end <= start) throw new ReplyFormatError("AI 的回复里没有找到 JSON");
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    throw new ReplyFormatError("AI 的回复格式不对，没法解析");
  }
}

function isTimeout(error: unknown): boolean {
  return /-1001|timed out|超时|没有动静/i.test(describeError(error));
}

/**
 * 值得自动重试的：连接中途断了、连不上、离线、回复格式不对。
 * 超时不重试——同样的请求再来一次还是那么慢，真机上三次都超时，白等了好几分钟。
 */
function isRetryable(error: unknown): boolean {
  if (error instanceof ReplyFormatError) return true;
  if (error instanceof StoppedError || isTimeout(error)) return false;
  return /-100[459]|network connection was lost|could not connect|中断|离线/i.test(describeError(error));
}

/** 重试时的那句提示，说清楚是哪种问题。 */
export function transientReason(error: unknown): string {
  if (error instanceof ReplyFormatError) return "回复格式不对";
  const text = describeError(error);
  if (/-1001|timed out|超时/i.test(text)) return "请求超时";
  if (/-1005|中断/i.test(text)) return "连接中断";
  if (/-1009|offline|离线/i.test(text)) return "没有网络";
  if (/-1004|could not connect|连不上/i.test(text)) return "连不上 AI 服务";
  return "网络出错";
}

export interface AskProgress {
  /** 已收到的正文字数。 */
  textChars: number;
  /** 已收到的推理过程字数（有的模型才给）。 */
  reasoningChars: number;
}

/** 页面持有一份，读流期间 askOrganizer 往里填 cancel，「停止等待」就调它。 */
export interface AskControl {
  cancel?: () => void;
}

/** 这么久一个数据块都没收到就当超时。流式下模型在干活时会陆续有数据回来。 */
const IDLE_TIMEOUT_MS = 90000;
/** 进度回调最快多久一次，免得每个小数据块都让页面重绘。 */
const PROGRESS_INTERVAL_MS = 250;

async function streamOnce(
  prompt: string,
  model: ModelChoice | null,
  onProgress: ((progress: AskProgress) => void) | undefined,
  control: AskControl | undefined,
): Promise<string> {
  const stream = await Assistant.requestStreaming({
    systemPrompt: OUTPUT_FORMAT,
    messages: { role: "user", content: prompt },
    ...(model ? { provider: model.provider, modelId: model.modelId } : {}),
  });
  const reader = stream.getReader();
  let stopped = false;
  if (control) {
    control.cancel = () => {
      stopped = true;
      void reader.cancel().catch(() => undefined);
    };
  }
  let text = "";
  let reasoning = 0;
  let lastProgress = 0;
  try {
    for (;;) {
      const result = await withTimeout(reader.read(), IDLE_TIMEOUT_MS, `AI 超过 ${IDLE_TIMEOUT_MS / 1000} 秒没有动静`);
      if (stopped) throw new StoppedError();
      if (result.done) break;
      const chunk = result.value;
      if (!chunk) continue;
      if (chunk.type === "text" && typeof chunk.content === "string") text += chunk.content;
      else if (chunk.type === "reasoning" && typeof chunk.content === "string") reasoning += chunk.content.length;
      const now = Date.now();
      if (onProgress && now - lastProgress >= PROGRESS_INTERVAL_MS) {
        lastProgress = now;
        onProgress({ textChars: text.length, reasoningChars: reasoning });
      }
    }
  } catch (error) {
    // 看门狗超时、读失败时主动收掉这条流，别让它在后台继续烧 token（文档的建议）
    void reader.cancel().catch(() => undefined);
    throw stopped ? new StoppedError() : error;
  } finally {
    if (control) control.cancel = undefined;
  }
  debugLog("ai", `流式收完：正文 ${text.length} 字，推理 ${reasoning} 字`);
  return text;
}

export async function askOrganizer(
  apps: LooseApp[],
  history: ChatTurn[],
  currentPlan: string | null,
  model: ModelChoice | null,
  options: {
    folderApps?: number;
    onRetry?: (attempt: number, reason: string) => void;
    onProgress?: (progress: AskProgress) => void;
    control?: AskControl;
  } = {},
): Promise<OrganizerReply> {
  if (!Assistant.isAvailable) {
    throw new Error("Scripting 助手当前不可用。确认已在 Scripting 设置里开通助手并配置好 AI 服务。");
  }
  const prompt = buildPrompt(apps, history, currentPlan, loadStylePrompt(), options.folderApps ?? 0);
  const modelText = model ? `${typeof model.provider === "string" ? model.provider : model.provider.custom}${model.modelId ? ` · ${model.modelId}` : ""}` : "默认模型";
  debugLog("ai", `发请求（流式）：${apps.length} 个散放 App，提示词 ${prompt.length} 字，模型 ${modelText}`);
  const MAX_ATTEMPTS = 2;
  for (let attempt = 1; ; attempt++) {
    const started = Date.now();
    try {
      const reply = parseReply(extractJson(await streamOnce(prompt, model, options.onProgress, options.control)));
      debugLog("ai", `第 ${attempt} 次成功，用了 ${Date.now() - started} ms，动作 ${reply.action}`);
      return reply;
    } catch (error) {
      debugLog("ai", `第 ${attempt} 次失败，用了 ${Date.now() - started} ms：${describeError(error)}`);
      if (attempt >= MAX_ATTEMPTS || !isRetryable(error)) throw error;
      options.onRetry?.(attempt + 1, transientReason(error));
      await delay(1500);
    }
  }
}

