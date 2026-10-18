// 首页的「电源」一节：重启、关机、睡眠。每个都要二次确认；执行后隧道会断，顺手断开会话。

import { Button, HStack, ProgressView, Text, useState } from "scripting";
import { describeError } from "../core/debug";
import { deviceHub } from "../kit/hub";
import { powerAction, type PowerAction } from "../kit/services";
import { FoldableSection, SectionLabel } from "./common";

interface PowerItem {
  action: PowerAction;
  title: string;
  systemImage: string;
  confirmTitle: string;
  confirmMessage: string;
}

const ITEMS: PowerItem[] = [
  {
    action: "Restart",
    title: "重启",
    systemImage: "arrow.clockwise",
    confirmTitle: "重启这台 iPhone？",
    confirmMessage: "正在进行的通话、录音、下载都会中断。重启后要先解锁一次，再回到 Scripting 重新连接。",
  },
  {
    action: "Shutdown",
    title: "关机",
    systemImage: "power",
    confirmTitle: "关闭这台 iPhone？",
    confirmMessage: "关机后只能长按侧边按钮开机。",
  },
  {
    action: "Sleep",
    title: "睡眠（锁屏）",
    systemImage: "moon.zzz",
    confirmTitle: "让屏幕睡眠？",
    confirmMessage: "效果和按一下侧边按钮一样。锁屏后隧道会断开，回来要重新连接。",
  },
];

export function PowerSection() {
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  async function run(item: PowerItem) {
    if (busy) return;
    const ok = await Dialog.confirm({ title: item.confirmTitle, message: item.confirmMessage, confirmLabel: item.title });
    if (!ok) return;
    setBusy(item.title);
    setError("");
    try {
      await powerAction(await deviceHub.get(), item.action);
      await deviceHub.disconnect();
    } catch (failure) {
      setError(`${item.title}失败：${describeError(failure)}`);
    } finally {
      setBusy("");
    }
  }

  return (
    <FoldableSection
      id="power"
      label={<SectionLabel title="电源" note={busy ? `${busy}…` : undefined} />}
      footer={
        <Text foregroundStyle={error ? "systemRed" : "tertiaryLabel"}>
          {error || "实体按键不好按、或者想重启一下解决卡顿时用。都会先弹窗确认。"}
        </Text>
      }
    >
      {busy ? (
        <HStack spacing={10}>
          <ProgressView />
          <Text foregroundStyle="secondaryLabel">{`${busy}…`}</Text>
        </HStack>
      ) : (
        ITEMS.map((item) => (
          <Button
            key={item.action}
            title={item.title}
            systemImage={item.systemImage}
            role={item.action === "Sleep" ? undefined : "destructive"}
            action={() => void run(item)}
          />
        ))
      )}
    </FoldableSection>
  );
}
