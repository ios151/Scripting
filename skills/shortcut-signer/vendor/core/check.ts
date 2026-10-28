// 快捷指令的结构检查：签名之前先查一遍，免得把一份「格式上就有问题」的草稿签成了文件。
//
// 规则和错误码移植自用户之前写的 shortcut-skill 里的检查器（tools/shortcut-check-core.ts）。那份用自己的受限 XML 解析器，
// 这里改成建在 core/plist.ts 的解析结果上，所以 XML / 二进制 / 已签名的快捷指令都能查；那份的三个 fixture
// 搬进了自测。
//
// 和原版有两处有意的不同，都是拿本机 24 个 Apple 签名的真实快捷指令一跑才发现原版会误杀它们：
//   1. 名字：真实导出的快捷指令里没有 WFWorkflowName（导入时名字取自文件名，24 个无一例外），原版把「没有名字」当错误，
//      24 个全判有错；这里只给警告 missing_name。
//   2. 变量引用的类型：不只认 ActionOutput，见 KNOWN_TOKEN_TYPES；不认识的类型只给警告。
// 自测里有一项会在有真实样本时把它们全跑一遍，要求没有错误（见 testCheck），免得以后又把真实文件判成有错。
//
// 它是「受限的结构检查」，不是 Shortcuts 的行为保证：
//   - 查：plist 外层、动作的标识和参数、动作 UUID 的形状和唯一性、变量引用（ActionOutput）能不能对上某个动作的 UUID、
//         attachmentsByRange 的键和占位符（U+FFFC）的位置、控制流分组（0 开始 / 1 中间 / 2 结束）、App Intent 描述是否自洽、
//         系统动作的标识在不在知识库里（KNOWN_ACTIONS，不在只给警告 unknown_action）
//   - 不保证：导入一定成功、动作一定能运行、动作的参数键名对不对（只核对标识）、第三方 App Intent 的真实序列化、
//         变量类型和接收它的参数是否匹配
// 检查通过只说明「结构上没发现问题」。
//
// 本文件在脚本（core/）和技能（vendor/core/）里各有一份逐字节相同的副本（共 7 个文件，清单和同步命令见 MAINTAINING.md 第 14 节）：
// 源头是脚本这边，改任何一份都要同步另一份，自测会比对。

import { isDict, type PlistDict, type PlistValue } from "./plist";

export interface Issue {
  severity: "error" | "warning";
  /** 稳定的错误码，调用方按它处理；message 是给人看的 */
  code: string;
  /** 出问题的位置，形如 `$.WFWorkflowActions[1].WFWorkflowActionParameters.UUID` */
  path: string;
  message: string;
}

export interface CheckResult {
  ok: boolean;
  errors: Issue[];
  warnings: Issue[];
  actionCount?: number;
  /** 每个动作自己的 UUID（没有 UUID 的动作不在里面） */
  actionUUIDs: string[];
}

export interface CheckOptions {
  /** 严格模式：警告也当成错误（错误码加 strict_ 前缀） */
  strict?: boolean;
}

/** RFC 4122 的形状：第三段以 1–5 开头、第四段以 8 / 9 / A / B 开头。Shortcuts 自己生成的是版本 4。 */
const UUID_SHAPE = /^[0-9A-F]{8}-[0-9A-F]{4}-[1-5][0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/i;
/** 变量引用在文本里占的那一个字符（U+FFFC 对象替换字符，用 fromCharCode 写，免得源码里放一个看不见的字符）。attachmentsByRange 的范围必须盖住它。 */
const PLACEHOLDER = String.fromCharCode(0xfffc);
/** Scripting App 自己的动作（App Intent）：观察到的 Bundle ID 和团队 ID。 */
const SCRIPTING_BUNDLE = "com.scripting.ios";
const SCRIPTING_TEAM = "58P5F4LJ36";
/**
 * 变量引用的类型；别的类型只给警告、不报错（检查器不认识不等于它不对）。
 * 本机 24 个真实样本里见过 ActionOutput、Variable、ExtensionInput、Clipboard、AskEachTime；
 * Ask、CurrentDate 来自之前那份检查器的清单，样本里没碰到。
 */
const KNOWN_TOKEN_TYPES = new Set(["ActionOutput", "Variable", "ExtensionInput", "Ask", "AskEachTime", "CurrentDate", "Clipboard"]);
/**
 * 技能知识库（skills/shortcut-signer/references/actions*.md）里登记过的系统动作标识。草稿里出现 is.workflow.actions. 开头、
 * 却不在这里的标识，多半是拼错了或者凭记忆编的，给一条 unknown_action 警告（只是警告：用户给的现成文件里的别的系统动作不该被判有错）。
 * 第三方 App 的动作（com.…，带 AppIntentDescriptor）不归它管。
 * 自测核对三件事：它和知识库的目录一一对上；24 个真实样本里没有一个动作被它警告；目录里每个动作都有证据标签。
 */
export const KNOWN_ACTIONS: ReadonlySet<string> = new Set([
  // 输入输出
  "is.workflow.actions.alert",
  "is.workflow.actions.notification",
  "is.workflow.actions.ask",
  "is.workflow.actions.choosefromlist",
  "is.workflow.actions.getclipboard",
  "is.workflow.actions.url",
  "is.workflow.actions.openurl",
  "is.workflow.actions.downloadurl",
  "is.workflow.actions.getmapslink",
  "is.workflow.actions.searchlocalbusinesses",
  "is.workflow.actions.vpn.get",
  "is.workflow.actions.showresult",
  "is.workflow.actions.speaktext",
  "is.workflow.actions.vibrate",
  "is.workflow.actions.waittoreturn",
  "is.workflow.actions.setclipboard",
  "is.workflow.actions.share",
  "is.workflow.actions.openapp",
  "is.workflow.actions.runworkflow",
  "is.workflow.actions.getdevicedetails",
  "is.workflow.actions.getbatterylevel",
  "is.workflow.actions.getcurrentlocation",
  "is.workflow.actions.getipaddress",
  "is.workflow.actions.setbrightness",
  "is.workflow.actions.setvolume",
  "is.workflow.actions.runsshscript",
  // 文本
  "is.workflow.actions.gettext",
  "is.workflow.actions.text.replace",
  "is.workflow.actions.text.match",
  "is.workflow.actions.text.combine",
  "is.workflow.actions.urlencode",
  "is.workflow.actions.text.split",
  "is.workflow.actions.text.changecase",
  "is.workflow.actions.base64encode",
  "is.workflow.actions.hash",
  // 变量与数据
  "is.workflow.actions.setvariable",
  "is.workflow.actions.getvariable",
  "is.workflow.actions.list",
  "is.workflow.actions.getitemfromlist",
  "is.workflow.actions.count",
  "is.workflow.actions.math",
  "is.workflow.actions.dictionary",
  "is.workflow.actions.getvalueforkey",
  "is.workflow.actions.number",
  "is.workflow.actions.appendvariable",
  "is.workflow.actions.detect.dictionary",
  "is.workflow.actions.setvalueforkey",
  "is.workflow.actions.date",
  "is.workflow.actions.format.date",
  // 控制流与流程
  "is.workflow.actions.conditional",
  "is.workflow.actions.choosefrommenu",
  "is.workflow.actions.repeat.count",
  "is.workflow.actions.repeat.each",
  "is.workflow.actions.delay",
  "is.workflow.actions.comment",
  "is.workflow.actions.nothing",
  "is.workflow.actions.exit",
  "is.workflow.actions.output",
]);

function get(dict: PlistDict, key: string): PlistValue | undefined {
  return dict.get(key);
}

function text(value: PlistValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** 动作列表里每个动作的标识，按顺序；读不出来的是 "unknown"。 */
export function actionIdentifiers(actions: readonly PlistValue[]): string[] {
  return actions.map((action) => {
    const id = isDict(action) ? get(action, "WFWorkflowActionIdentifier") : undefined;
    return typeof id === "string" && id !== "" ? id : "unknown";
  });
}

/** 深度优先，挨个字典看一遍。 */
function walkDicts(value: PlistValue | undefined, visit: (dict: PlistDict) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) walkDicts(item, visit);
  } else if (isDict(value)) {
    visit(value);
    for (const child of value.values()) walkDicts(child, visit);
  }
}

/** `{起点, 长度}` 形式的键（NSRange 的写法），起点和长度按 UTF-16 码元数。 */
function parseRangeKey(key: string): { start: number; length: number } | undefined {
  const match = /^\{(\d+)\s*,\s*(\d+)\}$/.exec(key);
  return match ? { start: Number(match[1]), length: Number(match[2]) } : undefined;
}

/**
 * 检查一份解析好的快捷指令（`parsePlist` 的结果：字典是 Map）。
 * 只报告，不修改；问题按动作的先后顺序列出。
 */
export function checkWorkflow(root: PlistValue, options: CheckOptions = {}): CheckResult {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  const error = (code: string, path: string, message: string) => errors.push({ severity: "error", code, path, message });
  const warn = (code: string, path: string, message: string) => warnings.push({ severity: "warning", code, path, message });

  if (!isDict(root)) {
    error("root_not_dict", "$", "plist 的顶层必须是字典（dict）");
    return { ok: false, errors, warnings, actionUUIDs: [] };
  }

  const actions = get(root, "WFWorkflowActions");
  if (!Array.isArray(actions)) error("missing_actions", "$.WFWorkflowActions", "WFWorkflowActions 必须是数组（array）");
  const name = get(root, "WFWorkflowName");
  if (typeof name !== "string" || name.trim() === "") {
    // 只是警告：真实导出的快捷指令里就没有这个键，名字取自文件名；签名时也是这样回退的（见 kit/api.ts）
    warn("missing_name", "$.WFWorkflowName", "没有 WFWorkflowName：签出的文件会用来料的文件名当名字（真实导出的快捷指令里本来就没有这个键）");
  }

  const seen = new Set<string>();
  const actionUUIDs: string[] = [];
  const outputRefs: { uuid: string; path: string }[] = [];
  const controlGroups = new Map<string, { mode: number; index: number }[]>();

  if (Array.isArray(actions)) {
    actions.forEach((action, index) => {
      const path = `$.WFWorkflowActions[${index}]`;
      if (!isDict(action)) {
        error("action_not_dict", path, "每个动作必须是字典（dict）");
        return;
      }

      const identifier = get(action, "WFWorkflowActionIdentifier");
      if (typeof identifier !== "string" || identifier.trim() === "") {
        error("missing_action_identifier", `${path}.WFWorkflowActionIdentifier`, "动作标识 WFWorkflowActionIdentifier 必须是非空字符串");
      } else if (identifier.startsWith("is.workflow.actions.") && !KNOWN_ACTIONS.has(identifier)) {
        warn(
          "unknown_action",
          `${path}.WFWorkflowActionIdentifier`,
          `动作标识 ${identifier} 不在知识库里（没核对过）：自己写的草稿多半是拼错了或凭记忆编的，换成知识库里登记过的动作；用户给的现成文件里的别的系统动作可以不管`,
        );
      }
      const params = get(action, "WFWorkflowActionParameters");
      if (!isDict(params)) {
        error("missing_action_parameters", `${path}.WFWorkflowActionParameters`, "动作参数 WFWorkflowActionParameters 必须是字典（dict），没有参数也要写空字典");
      }

      if (isDict(params)) {
        // 动作自己的 UUID：别的动作靠它引用这个动作的输出
        const uuid = text(get(params, "UUID"));
        if (uuid !== undefined && uuid !== "") {
          if (!UUID_SHAPE.test(uuid)) {
            error("invalid_uuid", `${path}.WFWorkflowActionParameters.UUID`, `动作 UUID 的形状不对（要 8-4-4-4-12 位十六进制，第三段以 1–5 开头、第四段以 8 / 9 / A / B 开头）：${uuid}`);
          }
          if (seen.has(uuid)) error("duplicate_uuid", `${path}.WFWorkflowActionParameters.UUID`, `动作 UUID 重复了：${uuid}`);
          seen.add(uuid);
          actionUUIDs.push(uuid);
        } else if (identifier !== "is.workflow.actions.comment") {
          warn("missing_uuid", `${path}.WFWorkflowActionParameters.UUID`, "这个动作没有 UUID：别的动作要引用它的结果就得有；结果没人引用的可以不管（真实文件里将近一半的动作都没有）");
        }

        // 控制流（如果 / 重复 / 从菜单选取）：同一组用 GroupingIdentifier 串起来，WFControlFlowMode 0 开始、1 中间、2 结束
        const group = text(get(params, "GroupingIdentifier"));
        const rawMode = get(params, "WFControlFlowMode");
        const mode = typeof rawMode === "number" ? rawMode : undefined;
        if (group !== undefined || rawMode !== undefined) {
          if (group === undefined || group === "") {
            error("control_missing_group", `${path}.WFWorkflowActionParameters.GroupingIdentifier`, "控制流动作需要 GroupingIdentifier（同一组的动作用同一个）");
          }
          if (mode === undefined || ![0, 1, 2].includes(mode)) {
            error("control_invalid_mode", `${path}.WFWorkflowActionParameters.WFControlFlowMode`, "WFControlFlowMode 必须是整数 0（开始）、1（中间）或 2（结束）");
          }
          if (group !== undefined && group !== "" && mode !== undefined) {
            const list = controlGroups.get(group) ?? [];
            list.push({ mode, index });
            controlGroups.set(group, list);
          }
        }

        // App Intent 动作：标识必须等于「Bundle ID.Intent ID」
        const descriptor = get(params, "AppIntentDescriptor");
        if (descriptor !== undefined) {
          const bundle = isDict(descriptor) ? get(descriptor, "BundleIdentifier") : undefined;
          const intent = isDict(descriptor) ? get(descriptor, "AppIntentIdentifier") : undefined;
          if (typeof bundle !== "string" || typeof intent !== "string" || identifier !== `${bundle}.${intent}`) {
            error("intent_descriptor_mismatch", path, "App Intent 动作的标识必须等于 AppIntentDescriptor 里的「BundleIdentifier.AppIntentIdentifier」");
          }
        }
        if (typeof identifier === "string" && identifier.startsWith(`${SCRIPTING_BUNDLE}.`)) {
          const scripting = get(params, "AppIntentDescriptor");
          if (!isDict(scripting) || get(scripting, "BundleIdentifier") !== SCRIPTING_BUNDLE || get(scripting, "TeamIdentifier") !== SCRIPTING_TEAM) {
            error("scripting_descriptor_invalid", path, `Scripting 的动作要带观察到的 BundleIdentifier（${SCRIPTING_BUNDLE}）和 TeamIdentifier（${SCRIPTING_TEAM}）`);
          }
        }
      }

      // 整个动作里的变量引用，不管藏在哪一层
      walkDicts(action, (dict) => {
        // 任何位置的 ActionOutput 引用：要有 OutputUUID（稍后核对它指向的动作存不存在），最好有 OutputName
        if (get(dict, "Type") === "ActionOutput") {
          const uuid = text(get(dict, "OutputUUID"));
          if (uuid === undefined || uuid === "") {
            error("invalid_output_token", path, "ActionOutput 引用必须有 OutputUUID（指向某个动作的 UUID）");
          } else {
            outputRefs.push({ uuid, path });
          }
          const outputName = get(dict, "OutputName");
          if (typeof outputName !== "string" || outputName.trim() === "") {
            warn("missing_output_name", path, "ActionOutput 引用没有非空的 OutputName");
          }
        }
        // 单独的变量附件
        if (get(dict, "WFSerializationType") === "WFTextTokenAttachment") {
          const value = get(dict, "Value");
          if (!isDict(value)) error("invalid_output_token", path, "单独的变量附件（WFTextTokenAttachment）的 Value 必须是字典");
          else checkTokenKind(value, path);
        }
        // 嵌在文本里的变量：键是 {起点, 长度}，那一段文本里必须有占位符
        const attachments = get(dict, "attachmentsByRange");
        if (isDict(attachments)) {
          const string = text(get(dict, "string"));
          for (const [key, token] of attachments) {
            const where = `${path}.attachmentsByRange.${key}`;
            const range = parseRangeKey(key);
            if (range === undefined) error("invalid_range", `${path}.attachmentsByRange`, `变量范围的键写法不对，要形如 {起点, 长度}：${key}`);
            if (!isDict(token)) {
              error("invalid_output_token", where, "attachmentsByRange 里的每一项必须是字典");
              continue;
            }
            checkTokenKind(token, where);
            if (range !== undefined && string !== undefined) {
              if (range.start + range.length > string.length) {
                error("range_out_of_bounds", where, `变量范围超出了文本长度（文本有 ${string.length} 个字符）`);
              } else if (!string.slice(range.start, range.start + range.length).includes(PLACEHOLDER)) {
                error("range_missing_placeholder", where, "变量范围没有盖住文本里的占位符 U+FFFC；起点应该是占位符在文本里的下标、长度 1");
              }
            }
          }
        }
      });
    });
  }

  /** 一个变量引用的类型：必须有；认得的不多问，不认得的只给警告（检查器不认识不等于它不对）。 */
  function checkTokenKind(token: PlistDict, where: string): void {
    const type = text(get(token, "Type"));
    if (type === undefined || type === "") error("missing_token_type", where, "变量引用必须有 Type（比如 ActionOutput）");
    else if (!KNOWN_TOKEN_TYPES.has(type)) warn("unknown_token_type", where, `没见过这种变量引用类型：${type}（检查器不会校验它）`);
  }

  for (const ref of outputRefs) {
    if (!seen.has(ref.uuid)) error("unknown_output_uuid", ref.path, `OutputUUID 对不上任何动作的 UUID：${ref.uuid}`);
  }

  for (const [group, entries] of controlGroups) {
    const starts = entries.filter((entry) => entry.mode === 0).length;
    const ends = entries.filter((entry) => entry.mode === 2).length;
    const where = `$.WFWorkflowActions[group=${group}]`;
    if (starts !== 1 || ends !== 1) {
      error("control_group_unbalanced", where, `一组控制流必须正好有一个开始（0）和一个结束（2），现在是 ${starts} 个开始、${ends} 个结束`);
    }
    const modes = [...entries].sort((a, b) => a.index - b.index).map((entry) => entry.mode);
    const inOrder = modes.length >= 2 && modes[0] === 0 && modes[modes.length - 1] === 2 && modes.slice(1, -1).every((mode) => mode === 1);
    if (!inOrder) error("control_group_order", where, `控制流的顺序必须是：0，然后零个或多个 1，最后 2；现在是 ${modes.join(",")}`);
  }

  if (options.strict === true && warnings.length > 0) {
    for (const warning of warnings) errors.push({ ...warning, severity: "error", code: `strict_${warning.code}` });
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    actionCount: Array.isArray(actions) ? actions.length : undefined,
    actionUUIDs,
  };
}
