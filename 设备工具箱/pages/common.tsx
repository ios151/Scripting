// 各功能页共用的：「连设备 → 读数据」的加载状态，以及几种通用的行。

import { Button, HStack, ProgressView, Section, Spacer, Text, VStack, useEffect, useRef, useState } from "scripting";
import { describeError } from "../core/debug";
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
