// 各功能页共用的：「连设备 → 读数据」的加载状态，以及几种通用的行。

import {
  Button,
  DisclosureGroup,
  HStack,
  ProgressView,
  Section,
  Spacer,
  Text,
  VStack,
  useEffect,
  useRef,
  useState,
  type Color,
  type VirtualNode,
} from "scripting";
import { describeError } from "../core/debug";
import { fileStamp } from "../kit/dates";
import { deviceHub } from "../kit/hub";
import type { DeviceSession, StatusReporter } from "../kit/session";

export interface DeviceTask<T> {
  data: T | null;
  error: string;
  status: string;
  loading: boolean;
  reload: () => Promise<void>;
}

/**
 * 进页就跑一次；`reload` 再跑。
 *
 * task 存进 ref 再调：effect 只在首帧挂一次，直接调传进来的 task 会永远拿着
 * 首帧那份闭包，reload 之后读到的还是旧值。
 */
export function useDeviceTask<T>(task: (session: DeviceSession, log: StatusReporter) => Promise<T>): DeviceTask<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(false);
  const taskRef = useRef(task);
  taskRef.current = task;
  const runningRef = useRef(false);

  async function reload(): Promise<void> {
    if (runningRef.current) return;
    runningRef.current = true;
    setLoading(true);
    setError("");
    try {
      const session = await deviceHub.get(setStatus);
      setStatus("读取中…");
      setData(await taskRef.current(session, setStatus));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : describeError(failure));
    } finally {
      runningRef.current = false;
      setLoading(false);
      setStatus("");
    }
  }

  useEffect(() => {
    void reload();
  }, []);

  return { data, error, status, loading, reload };
}

/** 加载中 / 出错时顶在列表最上面的那一节。都不是就不画。 */
export function TaskStateSection({ task }: { task: DeviceTask<unknown> }) {
  if (task.loading) {
    return (
      <Section>
        <HStack spacing={10}>
          <ProgressView />
          <Text foregroundStyle="secondaryLabel">{task.status || "连接设备…"}</Text>
        </HStack>
      </Section>
    );
  }
  if (task.error) {
    return (
      <Section
        footer={<Text foregroundStyle="secondaryLabel">锁屏、切网络都会让隧道断开，重试会自动重连。</Text>}
      >
        <VStack alignment="leading" spacing={8}>
          <Text foregroundStyle="systemRed">{task.error}</Text>
          <Button title="重试" action={() => void task.reload()} />
        </VStack>
      </Section>
    );
  }
  return null;
}

/**
 * 复制并给一下触感。点一下就复制时屏幕上没什么变化，不震一下的话
 * 用户不确定到底复制上没有。
 */
export function copyWithFeedback(value: string): void {
  Pasteboard.setString(value);
  HapticFeedback.notificationSuccess();
}

/** 长按菜单里的「复制」。点一下也能复制，但长按是 iOS 上更常见的做法，更好找。 */
function copyMenu(label: string, value: string, onCopied?: (label: string) => void) {
  return {
    menuItems: (
      <Button
        title="复制"
        systemImage="doc.on.doc"
        action={() => {
          copyWithFeedback(value);
          onCopied?.(label);
        }}
      />
    ),
  };
}

/** 标签 + 值，点一下或长按都能复制。 */
export function ValueRow({
  label,
  value,
  masked = false,
  onCopied,
}: {
  label: string;
  value: string;
  masked?: boolean;
  onCopied?: (label: string) => void;
}) {
  const copy = () => {
    copyWithFeedback(value);
    onCopied?.(label);
  };
  return (
    <Button action={copy} contextMenu={copyMenu(label, value, onCopied)}>
      <HStack spacing={12} frame={{ maxWidth: "infinity" }}>
        <Text foregroundStyle="label">{label}</Text>
        <Spacer />
        <Text foregroundStyle="secondaryLabel" multilineTextAlignment="trailing" lineLimit={2}>
          {masked ? "••••••••" : value}
        </Text>
      </HStack>
    </Button>
  );
}

/** 原始字段的长列表：键在上、值在下，值可能很长。 */
export function RawRow({ label, value }: { label: string; value: string }) {
  return (
    <Button action={() => copyWithFeedback(value)} contextMenu={copyMenu(label, value)}>
      <VStack alignment="leading" spacing={2} frame={{ maxWidth: "infinity", alignment: "leading" }}>
        <Text font="caption" foregroundStyle="secondaryLabel">{label}</Text>
        <Text font="footnote" fontDesign="monospaced" foregroundStyle="label" lineLimit={4}>
          {value}
        </Text>
      </VStack>
    </Button>
  );
}

// ── 可收起的分组 ──────────────────────────────────────────────────────────────

/** 哪几组被收起来了，按 id 记。 */
const FOLD_KEY = "devicekit_folded_sections_v1";

function loadFolds(): Record<string, boolean> {
  return Storage.get<Record<string, boolean>>(FOLD_KEY) ?? {};
}

/**
 * 分组标题那一行：名字后面跟一句摘要。
 *
 * 摘要**收起时也看得见**，所以状态类的信息（连上没有、里面有几项）要放这儿，
 * 不然一收起来整组就等于消失了。
 *
 * **别用 `Spacer` + `frame={{ maxWidth: "infinity" }}` 把它撑满宽度**：真机实测，
 * 这么写的 label 会让 DisclosureGroup 的 `isExpanded` 失效——同一个组件，没有 note 的
 * （label 里只有一个 Text）正常展开，有 note 的全被画成收起的右箭头。摘要就紧跟在
 * 标题后面，不right 对齐。
 */
export function SectionLabel({ title, note, tint }: { title: string; note?: string; tint?: Color }) {
  if (!note) return <Text>{title}</Text>;
  return (
    <HStack spacing={8}>
      <Text>{title}</Text>
      <Text font={13} foregroundStyle={tint ?? "secondaryLabel"}>
        {note}
      </Text>
    </HStack>
  );
}

/**
 * 可收起的一组，默认展开。
 *
 * 收起状态按 `id` 存 Storage：首页 Tab 虽然常驻，但脚本一重启就忘掉用户收起过什么的话，
 * 「能收起」这件事就没意义了。
 */
export function FoldableSection({
  id,
  label,
  footer,
  children,
}: {
  id: string;
  label: VirtualNode;
  footer?: VirtualNode;
  /** 照抄 DisclosureGroup 的 children 类型，一字不改地往下转——写窄了，三元里一支返回数组就过不了。 */
  children:
    | (VirtualNode | boolean | undefined | null | (VirtualNode | undefined | null | boolean)[])[]
    | VirtualNode
    | null
    | boolean
    | undefined;
}) {
  const [expanded, setExpanded] = useState(() => loadFolds()[id] ?? true);

  return (
    <Section footer={footer}>
      <DisclosureGroup
        label={label}
        isExpanded={expanded}
        onChanged={(value) => {
          setExpanded(value);
          Storage.set(FOLD_KEY, { ...loadFolds(), [id]: value });
        }}
      >
        {/*
          收起时**不把 children 交出去**。光靠 isExpanded 的话，SwiftUI 那边照样会把内容
          构建出来、只是不显示；功能组里挂着十一个页面元素，没必要在收着的时候也摆在那儿。
        */}
        {expanded ? children : null}
      </DisclosureGroup>
    </Section>
  );
}

/**
 * 把一段文本存成 txt 交出去。
 *
 * 长输出（服务表、硬件树、调试日志）复制到剪贴板再粘，内容一多就粘不全、
 * 聊天框也塞不下。存成文件走系统的「存储到…」，多长都无所谓。
 *
 * 文件名带时间戳：同一样东西导两次不会互相覆盖，事后也分得清先后。
 *
 * @returns 给界面显示的一句话。用户取消不算失败。
 */
export async function exportText(baseName: string, text: string): Promise<string> {
  const data = Data.fromString(text);
  if (!data) return "导出失败：这段文本没法编码";
  const name = `${baseName}-${fileStamp()}.txt`;
  try {
    const saved = await DocumentPicker.exportFiles({ files: [{ data, name }] });
    return saved.length > 0 ? `✓ 已导出 ${name}` : "已取消导出";
  } catch (error) {
    return `导出失败：${describeError(error)}`;
  }
}
