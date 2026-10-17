// AI 整理：对话式界面。用户说想怎么整理，AI 回一句话并附上方案卡片，
// 卡片上可以「调整」「应用到设备」；不满意就接着说，AI 在上一版基础上改。
//
// 写入走和 Dock 编辑同一套已在真机验证过的机制：写前自动备份、写后重读核对、
// 可从备份恢复（恢复入口在「编辑 Dock / 从备份恢复」页）。

import {
  Button,
  Circle,
  HStack,
  Image,
  List,
  NavigationLink,
  NavigationStack,
  ProgressView,
  ScrollView,
  Section,
  Spacer,
  Text,
  TextField,
  Toggle,
  VStack,
  ZStack,
  useRef,
  useState,
  type VirtualNode,
} from "scripting";
import type { PlistValue } from "../core/bplist";
import { describeError } from "../core/debug";
import {
  StoppedError,
  askOrganizer,
  isCustomStylePrompt,
  organizerErrorText,
  resolvePlan,
  type AskControl,
  type ChatTurn,
  type ModelChoice,
} from "../kit/aiOrganize";
import { PromptEditorPage } from "./PromptEditorPage";
import { saveBackup } from "../kit/backup";
import { compareLayouts } from "../kit/homeEdit";
import { logWidgetCheck } from "../kit/layoutCheck";
import { COLOR_BUCKETS, colorBucket, colorKey, compareColorKeys, type ColorKey } from "../kit/colorSort";
import {
  applyPlan,
  collectFolderApps,
  collectLooseApps,
  colorFolderLayout,
  reorderLooseApps,
  sanitizePlan,
  sortLooseApps,
  type FolderPlan,
  type LooseApp,
  type SanitizedPlan,
  type SortableApp,
} from "../kit/homeOrganize";
import { deviceHub } from "../kit/hub";
import { parseHomeLayout, readHomeLayout, writeHomeLayout, type HomeItem } from "../kit/services";
import { TaskStateSection, useDeviceTask } from "./common";
import { ItemIcon, WIDGET_WARNING, type IconMap } from "./homeShared";
import { PlanEditor } from "./PlanEditor";

type Proposal =
  | { kind: "group"; plan: SanitizedPlan }
  | {
      kind: "sort";
      descending: boolean;
      preview: string[];
      /** 选中页上已有文件夹里一并排序的 App 个数。 */
      folderApps: number;
    }
  | {
      kind: "color";
      descending: boolean;
      /** 每个 App 的颜色键；null 表示图标没取到。应用时照这份排，和预览一致。 */
      keys: Record<string, ColorKey | null>;
      /** 排好后的前若干个 bundle ID，卡片上画图标预览。 */
      preview: string[];
      missing: number;
      folderApps: number;
    }
  | {
      kind: "colorFolders";
      descending: boolean;
      /** 先拆开选中页上的已有文件夹。 */
      dissolve: boolean;
      /** 每个 App 的颜色键。应用时照这份重算，和预览一致。 */
      keys: Record<string, ColorKey | null>;
      plan: FolderPlan[];
      dissolved: number;
      released: number;
      leftLoose: number;
    };

type ProposalState = "pending" | "applying" | "applied" | "stale";

type Message =
  | { id: string; role: "user"; text: string }
  | { id: string; role: "assistant"; text: string; proposal?: Proposal; state?: ProposalState }
  | { id: string; role: "error"; text: string; retryText: string };

const SUGGESTIONS = ["按用途分进文件夹", "按名称排序", "按颜色排", "解散文件夹后按颜色建文件夹", "游戏单独一个文件夹"];

let messageCounter = 0;
const nextId = () => `m${++messageCounter}`;

function modelLabel(model: ModelChoice | null): string {
  if (!model) return "默认模型";
  const provider = typeof model.provider === "string" ? model.provider : model.provider.custom;
  return model.modelId ? `${provider} · ${model.modelId}` : provider;
}

function pagesLabel(pages: number[]): string {
  if (pages.length === 0) return "没选页";
  const sorted = [...pages].sort((a, b) => a - b);
  const contiguous = sorted.every((page, i) => i === 0 || page === sorted[i - 1] + 1);
  return contiguous && sorted.length > 1
    ? `第 ${sorted[0] + 1}–${sorted[sorted.length - 1] + 1} 页`
    : sorted.map((page) => page + 1).join("、") + " 页";
}

/** 写入确认框里的两句：要做什么、哪些不动。 */
function describeProposal(proposal: Proposal): { summary: string; scope: string } {
  const count = (folders: FolderPlan[]) => folders.reduce((n, folder) => n + folder.bundleIds.length, 0);
  switch (proposal.kind) {
    case "group":
      return {
        summary: `新建 ${proposal.plan.folders.length} 个文件夹，收进 ${count(proposal.plan.folders)} 个 App`,
        scope: "Dock、没选的页、小组件和已有文件夹都不动",
      };
    case "colorFolders":
      return {
        summary:
          (proposal.dissolve && proposal.dissolved > 0 ? `先拆开选中页上的 ${proposal.dissolved} 个文件夹，再` : "") +
          `按颜色新建 ${proposal.plan.length} 个文件夹，收进 ${count(proposal.plan)} 个 App`,
        scope: proposal.dissolve ? "Dock、没选的页、小组件都不动" : "Dock、没选的页、小组件和已有文件夹都不动",
      };
    default:
      return {
        summary:
          `把选中页上散放的 App 按${proposal.kind === "color" ? "图标颜色" : "名称"}重新排列` +
          (proposal.folderApps > 0 ? `，文件夹里的 ${proposal.folderApps} 个 App 也按同样规则排（文件夹本身不动不拆）` : ""),
        scope: "Dock、没选的页、小组件都不动，已有文件夹位置不动、不拆",
      };
  }
}

/**
 * 给 AI 看的上一版方案：一行一个文件夹，App 用这一轮列表里的编号（同 buildPrompt）。
 * 换了选页之后不在列表里的 App 直接略过。
 */
function planSummary(plan: SanitizedPlan, apps: LooseApp[]): string {
  const numberOf = new Map(apps.map((app, index) => [app.bundleId, index + 1]));
  return plan.folders
    .map((folder) => {
      const numbers = folder.bundleIds.map((id) => numberOf.get(id)).filter((number): number is number => number !== undefined);
      return `${folder.name}：${numbers.join("、")}`;
    })
    .join("\n");
}

/**
 * 每个图标的颜色键。主色由原生 `UIImage.dominantColors()` 算，挑代表色、排序规则见 kit/colorSort.ts。
 * 没取到图标的记 null，排在最后。
 */
function colorKeysFor(apps: { bundleId: string }[], icons: IconMap): Record<string, ColorKey | null> {
  const keys: Record<string, ColorKey | null> = {};
  for (const app of apps) {
    const image = icons.get(app.bundleId);
    const samples = image
      ? image.dominantColors(6).map((entry) => ({
          red: entry.color.red,
          green: entry.color.green,
          blue: entry.color.blue,
          fraction: entry.fraction,
        }))
      : [];
    keys[app.bundleId] = colorKey(samples);
  }
  return keys;
}

/**
 * 按颜色建文件夹。倒序只倒有颜色的那几组，黑白灰始终在最后（同 colorComparer 的规矩）。
 * 预览和应用都走这里、用同一份颜色键，两边建出来的一模一样。
 */
function colorFolderResult(
  original: PlistValue,
  pages: number[],
  keys: Record<string, ColorKey | null>,
  descending: boolean,
  dissolve: boolean,
) {
  const chromatic = COLOR_BUCKETS.filter((bucket) => bucket !== "黑白灰");
  const order = [...(descending ? [...chromatic].reverse() : chromatic), "黑白灰"];
  return colorFolderLayout(original, pages, (id) => colorBucket(keys[id] ?? null), { dissolve, order });
}

/** 倒序只倒有颜色的那部分顺序；取不到颜色的始终垫底。 */
function colorComparer(keys: Record<string, ColorKey | null>, descending: boolean) {
  return (a: SortableApp, b: SortableApp) => {
    const ka = keys[a.bundleId] ?? null;
    const kb = keys[b.bundleId] ?? null;
    if (!ka || !kb) return compareColorKeys(ka, kb);
    return compareColorKeys(ka, kb) * (descending ? -1 : 1);
  };
}

// ── 气泡 ──────────────────────────────────────────────────────────────────

function Avatar() {
  return (
    <ZStack frame={{ width: 30, height: 30 }}>
      <Circle fill="systemIndigo" />
      <Image systemName="sparkles" foregroundStyle="white" font={14} />
    </ZStack>
  );
}

function UserBubble({ text }: { text: string }) {
  return (
    <HStack frame={{ maxWidth: "infinity" }}>
      <Spacer minLength={48} />
      <Text
        foregroundStyle="white"
        padding={{ horizontal: 14, vertical: 10 }}
        background={{ style: "systemBlue", shape: { type: "rect", cornerRadius: 18 } }}
      >
        {text}
      </Text>
    </HStack>
  );
}

function AssistantRow({ children }: { children: VirtualNode | (VirtualNode | null | undefined | boolean)[] }) {
  return (
    <HStack alignment="top" spacing={8} frame={{ maxWidth: "infinity", alignment: "leading" }}>
      <Avatar />
      <VStack alignment="leading" spacing={8}>
        {children}
      </VStack>
      <Spacer minLength={24} />
    </HStack>
  );
}

function AssistantText({ text }: { text: string }) {
  return (
    <Text
      foregroundStyle="label"
      padding={{ horizontal: 14, vertical: 10 }}
      background={{ style: "secondarySystemBackground", shape: { type: "rect", cornerRadius: 18 } }}
    >
      {text}
    </Text>
  );
}

function folderItem(name: string, ids: string[], apps: LooseApp[]): HomeItem {
  return {
    kind: "folder",
    name,
    pages: [ids.map((id) => ({ kind: "app", bundleId: id, name: apps.find((app) => app.bundleId === id)?.name ?? id }))],
  };
}

/** 文件夹方案的预览：三个一行，每个画成九宫格图标 + 名字 + 个数。 */
function FolderGrid({ folders, apps, icons }: { folders: FolderPlan[]; apps: LooseApp[]; icons: IconMap }) {
  const rows: FolderPlan[][] = [];
  for (let i = 0; i < folders.length; i += 3) rows.push(folders.slice(i, i + 3));
  return (
    <VStack alignment="leading" spacing={12}>
      {rows.map((row, rowIndex) => (
        <HStack key={rowIndex} spacing={12} alignment="top">
          {row.map((folder) => (
            <VStack key={folder.name} spacing={4} frame={{ width: 76 }}>
              <ItemIcon item={folderItem(folder.name, folder.bundleIds, apps)} icons={icons} size={56} />
              <Text font="caption" lineLimit={1}>{folder.name}</Text>
              <Text font="caption2" foregroundStyle="secondaryLabel">{`${folder.bundleIds.length} 个`}</Text>
            </VStack>
          ))}
        </HStack>
      ))}
    </VStack>
  );
}

function ProposalCard({
  proposal,
  state,
  apps,
  icons,
  onEdit,
  onApply,
}: {
  proposal: Proposal;
  state: ProposalState;
  apps: LooseApp[];
  icons: IconMap;
  onEdit: () => void;
  onApply: () => void;
}) {
  let body: VirtualNode;
  let title: string;
  if (proposal.kind === "group") {
    const total = proposal.plan.folders.reduce((sum, folder) => sum + folder.bundleIds.length, 0);
    title = `${proposal.plan.folders.length} 个文件夹 · 收进 ${total} 个 App`;
    body = (
      <VStack alignment="leading" spacing={12}>
        <FolderGrid folders={proposal.plan.folders} apps={apps} icons={icons} />
        {proposal.plan.unassigned.length > 0 ? (
          <Text font="caption" foregroundStyle="secondaryLabel">{`另有 ${proposal.plan.unassigned.length} 个留在原位`}</Text>
        ) : null}
      </VStack>
    );
  } else if (proposal.kind === "colorFolders") {
    const total = proposal.plan.reduce((sum, folder) => sum + folder.bundleIds.length, 0);
    title = `按颜色建 ${proposal.plan.length} 个文件夹 · 收进 ${total} 个 App`;
    body = (
      <VStack alignment="leading" spacing={12}>
        <FolderGrid folders={proposal.plan} apps={apps} icons={icons} />
        {proposal.dissolve ? (
          <Text font="caption" foregroundStyle="secondaryLabel">
            {proposal.dissolved > 0
              ? `先拆开选中页上的 ${proposal.dissolved} 个文件夹，放出 ${proposal.released} 个`
              : "选中页上没有文件夹可拆"}
          </Text>
        ) : (
          <Text font="caption" foregroundStyle="secondaryLabel">已有文件夹不动</Text>
        )}
        {proposal.leftLoose > 0 ? (
          <Text font="caption" foregroundStyle="secondaryLabel">{`另有 ${proposal.leftLoose} 个留在原位（同色不足 2 个，或图标没取到）`}</Text>
        ) : null}
      </VStack>
    );
  } else if (proposal.kind === "color") {
    title = proposal.descending ? "按颜色倒序排列（紫到红）" : "按颜色排列（彩虹顺序）";
    const rows: string[][] = [];
    for (let i = 0; i < proposal.preview.length; i += 8) rows.push(proposal.preview.slice(i, i + 8));
    body = (
      <VStack alignment="leading" spacing={6}>
        {rows.map((row, rowIndex) => (
          <HStack key={rowIndex} spacing={6}>
            {row.map((id) => (
              <ItemIcon key={id} item={{ kind: "app", bundleId: id, name: id }} icons={icons} size={28} />
            ))}
          </HStack>
        ))}
        <Text font="caption" foregroundStyle="secondaryLabel">
          {proposal.missing > 0 ? `排好后开头这样；另有 ${proposal.missing} 个图标没取到，会排在最后` : "排好后开头这样，黑白灰的图标在最后"}
        </Text>
        {proposal.folderApps > 0 ? (
          <Text font="caption" foregroundStyle="secondaryLabel">{`文件夹里的 ${proposal.folderApps} 个 App 也按同样规则排，文件夹本身不动`}</Text>
        ) : null}
      </VStack>
    );
  } else {
    title = proposal.descending ? "按名称倒序排列" : "按名称排序（拼音 / 字母）";
    body = (
      <VStack alignment="leading" spacing={4}>
        <Text font="footnote" foregroundStyle="secondaryLabel" lineLimit={3}>
          {`排好后开头是：${proposal.preview.join("、")}…`}
        </Text>
        {proposal.folderApps > 0 ? (
          <Text font="caption" foregroundStyle="secondaryLabel">{`文件夹里的 ${proposal.folderApps} 个 App 也按同样规则排，文件夹本身不动`}</Text>
        ) : null}
      </VStack>
    );
  }

  return (
    <VStack
      alignment="leading"
      spacing={12}
      padding={14}
      frame={{ maxWidth: 300, alignment: "leading" }}
      background={{ style: "secondarySystemBackground", shape: { type: "rect", cornerRadius: 18 } }}
    >
      <HStack spacing={6}>
        <Image
          systemName={
            proposal.kind === "group"
              ? "folder.fill"
              : proposal.kind === "color" || proposal.kind === "colorFolders"
                ? "paintpalette.fill"
                : "textformat.abc"
          }
          foregroundStyle="systemIndigo"
        />
        <Text font="subheadline" fontWeight="semibold">{title}</Text>
      </HStack>
      {body}
      {state === "applied" ? (
        <Label text="已应用到设备" systemImage="checkmark.circle.fill" color="systemGreen" />
      ) : state === "stale" ? (
        <Label text="布局已变，这个方案作废了" systemImage="clock.arrow.circlepath" color="secondaryLabel" />
      ) : state === "applying" ? (
        <HStack spacing={8}>
          <ProgressView />
          <Text font="footnote" foregroundStyle="secondaryLabel">写入设备…</Text>
        </HStack>
      ) : (
        <HStack spacing={10}>
          {proposal.kind === "group" ? <Button title="调整" buttonStyle="bordered" action={onEdit} /> : null}
          <Button title="应用到设备" buttonStyle="borderedProminent" action={onApply} />
        </HStack>
      )}
    </VStack>
  );
}

function Label({ text, systemImage, color }: { text: string; systemImage: string; color: "systemGreen" | "secondaryLabel" }) {
  return (
    <HStack spacing={6}>
      <Image systemName={systemImage} foregroundStyle={color} />
      <Text font="footnote" foregroundStyle={color}>{text}</Text>
    </HStack>
  );
}

// ── 页面 ──────────────────────────────────────────────────────────────────

export function OrganizePage({ icons }: { icons: IconMap }) {
  const [original, setOriginal] = useState<PlistValue | null>(null);
  const [pageCount, setPageCount] = useState(0);
  const [selected, setSelected] = useState<number[]>([]);
  const [model, setModel] = useState<ModelChoice | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [thinking, setThinking] = useState("");
  /** 正在读的那条流的取消开关。放 ref 里：按钮的回调可能是早先渲染时的闭包。 */
  const askControl = useRef<AskControl>({});
  const [showSettings, setShowSettings] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [customPrompt, setCustomPrompt] = useState(() => isCustomStylePrompt());

  const task = useDeviceTask(async (session) => {
    const layout = await readHomeLayout(session);
    setOriginal(layout.raw);
    setPageCount(layout.pages.length);
    // 默认不动第 1 页：小组件和最常用的 App 多半在那儿
    setSelected(layout.pages.map((_, index) => index).filter((index) => index > 0));
    return true;
  });

  const loose = original ? collectLooseApps(original, selected) : [];
  /** 选中页上已有文件夹里的 App 数。「解散文件夹」时它们也参与整理，所以够不够整理要连它们一起算。 */
  const folderAppCount = original ? collectFolderApps(original, selected).length : 0;
  const lastId = messages.length > 0 ? messages[messages.length - 1].id : "welcome";

  function update(id: string, patch: Partial<Extract<Message, { role: "assistant" }>>) {
    setMessages((list) => list.map((m) => (m.id === id && m.role === "assistant" ? { ...m, ...patch } : m)));
  }

  /** 布局一变，之前的方案全部作废——它们是照旧布局算的。 */
  function markAllStale(except?: string) {
    setMessages((list) =>
      list.map((m) =>
        m.role === "assistant" && m.proposal && m.id !== except && m.state !== "applied" ? { ...m, state: "stale" } : m,
      ),
    );
  }

  function latestGroupPlan(list: Message[]): SanitizedPlan | null {
    for (let i = list.length - 1; i >= 0; i--) {
      const m = list[i];
      if (m.role === "assistant" && m.proposal?.kind === "group" && m.state === "pending") return m.proposal.plan;
    }
    return null;
  }

  async function send(raw: string) {
    const text = raw.trim();
    if (!text || thinking || !original) return;
    if (loose.length + folderAppCount < 2) {
      setMessages((list) => [...list, { id: nextId(), role: "assistant", text: "选中的页上 App 不到 2 个，没什么可整理的。点右上角换几页试试。" }]);
      return;
    }
    const userMessage: Message = { id: nextId(), role: "user", text };
    const history: ChatTurn[] = [...messages, userMessage]
      .filter((m): m is Extract<Message, { role: "user" | "assistant" }> => m.role === "user" || m.role === "assistant")
      .map((m) => ({ role: m.role, text: m.text }));
    const previous = latestGroupPlan(messages);
    setMessages((list) => [...list, userMessage]);
    setInput("");
    setThinking("正在思考…");
    try {
      const reply = await askOrganizer(loose, history, previous ? planSummary(previous, loose) : null, model, {
        folderApps: folderAppCount,
        control: askControl.current,
        onRetry: (attempt, reason) => setThinking(`${reason}，第 ${attempt} 次重试…`),
        // 流式回来的进度：先是推理（有的模型才给），再是正文
        onProgress: ({ textChars, reasoningChars }) =>
          setThinking(
            textChars > 0 ? `正在写方案…已收到 ${textChars} 字` : reasoningChars > 0 ? `正在思考…（${reasoningChars} 字）` : "正在思考…",
          ),
      });
      let proposal: Proposal | undefined;
      let note = "";
      if (reply.action === "group") {
        // 模型回的是编号，先换回 bundle ID，再照常清洗
        const plan = sanitizePlan(resolvePlan(reply.rawPlan, loose), loose.map((app) => app.bundleId));
        if (plan.folders.length > 0) proposal = { kind: "group", plan };
        else note = "（模型给的方案里没有可用的文件夹，换个说法再试试。）";
        if (plan.dropped > 0) note = `（已丢掉 ${plan.dropped} 个列表里不存在的 App。）`;
      } else if (reply.action === "color") {
        const inFolders = collectFolderApps(original, selected);
        const keys = colorKeysFor([...loose, ...inFolders], icons);
        const missing = Object.values(keys).filter((key) => key === null).length;
        if (missing === Object.keys(keys).length) {
          note = "（图标还没载入，没法按颜色排。回上一页等图标载入完再来。）";
        } else {
          const sorted = reorderLooseApps(original, selected, colorComparer(keys, reply.descending), { insideFolders: true });
          proposal = {
            kind: "color",
            descending: reply.descending,
            keys,
            preview: collectLooseApps(sorted, selected).slice(0, 16).map((app) => app.bundleId),
            missing,
            folderApps: inFolders.length,
          };
        }
      } else if (reply.action === "colorFolders") {
        // 拆不拆文件夹都把文件夹里的 App 一起算颜色：拆的话要用，不拆也不浪费多少
        const keys = colorKeysFor([...loose, ...collectFolderApps(original, selected)], icons);
        if (Object.values(keys).every((key) => key === null)) {
          note = "（图标还没载入，没法按颜色分。回上一页等图标载入完再来。）";
        } else {
          const result = colorFolderResult(original, selected, keys, reply.descending, reply.dissolveFolders);
          if (result.plan.length === 0) {
            note = "（同一种颜色的 App 都不到 2 个，建不出文件夹。）";
          } else {
            proposal = {
              kind: "colorFolders",
              descending: reply.descending,
              dissolve: reply.dissolveFolders,
              keys,
              plan: result.plan,
              dissolved: result.dissolved,
              released: result.released,
              leftLoose: result.leftLoose,
            };
          }
        }
      } else if (reply.action === "sort") {
        const sorted = sortLooseApps(original, selected, reply.descending, true);
        proposal = {
          kind: "sort",
          descending: reply.descending,
          preview: collectLooseApps(sorted, selected).slice(0, 8).map((app) => app.name),
          folderApps: collectFolderApps(original, selected).length,
        };
      }
      setMessages((list) => [
        ...list,
        { id: nextId(), role: "assistant", text: note ? `${reply.reply}\n${note}` : reply.reply, proposal, state: proposal ? "pending" : undefined },
      ]);
    } catch (error) {
      setMessages((list) => [
        ...list,
        error instanceof StoppedError
          ? { id: nextId(), role: "assistant", text: "好的，不等了。可以在右上角少选几页，或者把要求说得具体些再试。" }
          : { id: nextId(), role: "error", text: organizerErrorText(error), retryText: text },
      ]);
    } finally {
      setThinking("");
    }
  }

  async function apply(messageId: string) {
    const target = messages.find((m) => m.id === messageId);
    if (!original || !target || target.role !== "assistant" || !target.proposal) return;
    const proposal = target.proposal;
    const { summary, scope } = describeProposal(proposal);
    const ok = await Dialog.confirm({
      title: "写入设备？",
      message:
        `${summary}；${scope}。\n\n` +
        "写之前自动备份当前布局，写完重读核对。不满意可以在「编辑 Dock / 从备份恢复」里还原，" +
        "或者「设置 → 通用 → 传输或还原 iPhone → 还原 → 还原主屏幕布局」。\n\n" +
        WIDGET_WARNING,
    });
    if (!ok) return;
    update(messageId, { state: "applying" });
    try {
      const expected =
        proposal.kind === "group"
          ? applyPlan(original, selected, proposal.plan.folders)
          : proposal.kind === "colorFolders"
            ? colorFolderResult(original, selected, proposal.keys, proposal.descending, proposal.dissolve).layout
            : proposal.kind === "color"
              ? reorderLooseApps(original, selected, colorComparer(proposal.keys, proposal.descending), { insideFolders: true })
              : sortLooseApps(original, selected, proposal.descending, true);
      const backup = await saveBackup(original, "整理前");
      const session = await deviceHub.get();
      await writeHomeLayout(session, expected);
      const actual = (await readHomeLayout(session)).raw;
      logWidgetCheck(expected, actual);
      const check = compareLayouts(expected, actual);
      setOriginal(actual);
      setPageCount(parseHomeLayout(actual).pages.length);
      update(messageId, { state: "applied" });
      markAllStale(messageId);
      setMessages((list) => [
        ...list,
        check.nothingLost && check.dockMatches
          ? { id: nextId(), role: "assistant", text: `好了，已经写进设备，重新读了一遍核对过，一个 App 都没少。回主屏看看效果。写入前的备份是「${backup}」。` }
          : {
              id: nextId(),
              role: "assistant",
              text: `写进去了，但重读后和预期对不上（${check.dockMatches ? "" : "Dock 变了；"}${check.missing.length} 个条目对不上）。建议去「编辑 Dock / 从备份恢复」还原「${backup}」。`,
            },
      ]);
    } catch (error) {
      update(messageId, { state: "pending" });
      setMessages((list) => [...list, { id: nextId(), role: "error", text: `写入失败：${describeError(error)}`, retryText: "" }]);
    }
  }

  async function pickModel() {
    try {
      const choice = await Assistant.presentModelPicker(model ? { provider: model.provider, modelId: model.modelId } : undefined);
      if (choice) setModel({ provider: choice.provider, modelId: choice.modelId });
    } catch (error) {
      setMessages((list) => [...list, { id: nextId(), role: "error", text: `选择模型失败：${describeError(error)}`, retryText: "" }]);
    }
  }

  function togglePage(page: number, on: boolean) {
    setSelected(on ? [...new Set([...selected, page])].sort((a, b) => a - b) : selected.filter((p) => p !== page));
    markAllStale();
  }

  const editingMessage = messages.find((m) => m.id === editing);
  const editingPlan = editingMessage?.role === "assistant" && editingMessage.proposal?.kind === "group" ? editingMessage.proposal.plan : null;

  const settingsSheet = (
    <NavigationStack>
      <List
        navigationTitle="整理设置"
        navigationBarTitleDisplayMode="inline"
        listStyle="insetGroup"
        toolbar={{ confirmationAction: <Button title="完成" action={() => setShowSettings(false)} /> }}
      >
        <Section
          header={<Text>提示词</Text>}
          footer={
            <Text foregroundStyle="tertiaryLabel">
              可以改 AI 的整理风格（分几个文件夹、怎么命名等）。默认的是调过的，自己改可能让效果变差，进去有详细说明。
            </Text>
          }
        >
          <NavigationLink destination={<PromptEditorPage onChanged={() => setCustomPrompt(isCustomStylePrompt())} />}>
            <HStack>
              <Text>整理风格</Text>
              <Spacer />
              <Text foregroundStyle={customPrompt ? "systemOrange" : "secondaryLabel"}>{customPrompt ? "已自定义" : "默认"}</Text>
            </HStack>
          </NavigationLink>
        </Section>
        <Section header={<Text>模型</Text>} footer={<Text foregroundStyle="tertiaryLabel">用的是 Scripting 助手里配好的服务。只发送 App 的名称、bundle ID 和对话内容。</Text>}>
          <HStack>
            <Text>{modelLabel(model)}</Text>
            <Spacer />
            <Button title="更换" action={() => void pickModel()} />
          </HStack>
        </Section>
        <Section
          header={<Text>整理哪几页</Text>}
          footer={<Text foregroundStyle="tertiaryLabel">{`选中页上散放的 App 共 ${loose.length} 个。Dock、小组件、已有文件夹都不动。`}</Text>}
        >
          {Array.from({ length: pageCount }, (_, page) => (
            <Toggle key={page} title={`第 ${page + 1} 页`} value={selected.includes(page)} onChanged={(on: boolean) => togglePage(page, on)} />
          ))}
        </Section>
      </List>
    </NavigationStack>
  );

  if (!original) {
    return (
      <List navigationTitle="AI 整理" navigationBarTitleDisplayMode="inline" listStyle="insetGroup">
        <TaskStateSection task={task} />
      </List>
    );
  }

  return (
    <ScrollView
      navigationTitle="AI 整理"
      navigationBarTitleDisplayMode="inline"
      defaultScrollAnchor="bottom"
      scrollTargetLayout
      scrollDismissesKeyboard="interactively"
      scrollPosition={{ value: lastId, onChanged: () => {}, anchor: "bottom" }}
      toolbar={{
        topBarTrailing: <Button title="设置" systemImage="slider.horizontal.3" action={() => setShowSettings(true)} />,
      }}
      sheet={[
        { isPresented: showSettings, onChanged: setShowSettings, content: settingsSheet },
        {
          isPresented: editingPlan !== null,
          onChanged: (open: boolean) => {
            if (!open) setEditing(null);
          },
          content: editingPlan ? (
            <PlanEditor
              initial={editingPlan}
              apps={loose}
              icons={icons}
              onDone={(plan) => {
                if (editing) {
                  setMessages((list) =>
                    list.map((m) => (m.id === editing && m.role === "assistant" && m.proposal?.kind === "group" ? { ...m, proposal: { kind: "group", plan } } : m)),
                  );
                }
                setEditing(null);
              }}
            />
          ) : (
            <Text>…</Text>
          ),
        },
      ]}
      safeAreaInset={{
        bottom: {
          content: (
            <VStack spacing={8} padding={{ horizontal: 12, vertical: 8 }}>
              {messages.length === 0 ? (
                <ScrollView axes="horizontal">
                  <HStack spacing={8}>
                    {SUGGESTIONS.map((suggestion) => (
                      <Button key={suggestion} title={suggestion} buttonStyle="bordered" action={() => void send(suggestion)} />
                    ))}
                  </HStack>
                </ScrollView>
              ) : null}
              <HStack spacing={8} padding={{ leading: 16, trailing: 6, vertical: 6 }} glassEffect={{ type: "rect", cornerRadius: 22 }}>
                <TextField title="" value={input} prompt="说说想怎么整理…" onChanged={setInput} onSubmit={() => void send(input)} />
                <Button
                  title=""
                  systemImage="arrow.up.circle.fill"
                  buttonStyle="borderless"
                  font={28}
                  foregroundStyle={input.trim() && !thinking ? "systemIndigo" : "tertiaryLabel"}
                  action={() => void send(input)}
                />
              </HStack>
            </VStack>
          ),
        },
      }}
    >
      <VStack spacing={14} padding={{ horizontal: 14, top: 12, bottom: 8 }}>
        <HStack key="welcome" frame={{ maxWidth: "infinity" }}>
          <AssistantRow>
            <AssistantText
              text={`我看到${pagesLabel(selected)}上有 ${loose.length} 个散放的 App。可以帮你按用途分进文件夹，或者按名称、按图标颜色排序；方案出来先给你看，确认了才写进设备。`}
            />
            <Text font="caption" foregroundStyle="tertiaryLabel">
              {`模型：${modelLabel(model)}${customPrompt ? " · 提示词：已自定义" : ""} · 右上角可改范围、模型和提示词`}
            </Text>
          </AssistantRow>
        </HStack>

        {messages.map((message) => (
          <VStack key={message.id} frame={{ maxWidth: "infinity" }}>
            {message.role === "user" ? (
              <UserBubble text={message.text} />
            ) : message.role === "error" ? (
              <AssistantRow>
                <Text foregroundStyle="systemRed" font="footnote">{message.text}</Text>
                {message.retryText ? <Button title="重试" buttonStyle="bordered" action={() => void send(message.retryText)} /> : null}
              </AssistantRow>
            ) : (
              <AssistantRow>
                <AssistantText text={message.text} />
                {message.proposal ? (
                  <ProposalCard
                    proposal={message.proposal}
                    state={message.state ?? "pending"}
                    apps={loose}
                    icons={icons}
                    onEdit={() => setEditing(message.id)}
                    onApply={() => void apply(message.id)}
                  />
                ) : null}
              </AssistantRow>
            )}
          </VStack>
        ))}

        {thinking ? (
          <AssistantRow>
            <HStack
              spacing={8}
              padding={{ horizontal: 14, vertical: 10 }}
              background={{ style: "secondarySystemBackground", shape: { type: "rect", cornerRadius: 18 } }}
            >
              <ProgressView />
              <Text foregroundStyle="secondaryLabel">{thinking}</Text>
            </HStack>
            <Button title="停止等待" buttonStyle="bordered" action={() => askControl.current.cancel?.()} />
          </AssistantRow>
        ) : null}
      </VStack>
    </ScrollView>
  );
}
