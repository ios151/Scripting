// 连接设置：隧道来源、对端地址。改动即时保存，并断开现有会话（下次取用按新设置重连）。
// 页尾是调试日志：开关、复制、清空。

import { Button, List, Picker, Section, Text, TextField, Toggle, useState } from "scripting";
import { clearDebugLog, debugEcho, debugLogCount, debugLogText, setDebugEcho } from "../core/debug";
import { copyWithFeedback, exportText } from "./common";
import { deviceHub } from "../kit/hub";
import {
  DEFAULT_HOST,
  loadConnectionSettings,
  saveConnectionSettings,
  type ConnectionSettings,
} from "../kit/settings";

export function SettingsPage() {
  const [settings, setSettings] = useState<ConnectionSettings>(() => loadConnectionSettings());
  const [note, setNote] = useState("");
  const [echo, setEcho] = useState(() => debugEcho());
  /** 条数是环形缓冲里的，不会自己变——进页面时读一次，清空后手动归零。 */
  const [count, setCount] = useState(() => debugLogCount());

  function update(patch: Partial<ConnectionSettings>) {
    const next = { ...settings, ...patch };
    setSettings(next);
    saveConnectionSettings(next);
    void deviceHub.disconnect();
  }

  return (
    <List navigationTitle="连接设置" navigationBarTitleDisplayMode="inline" listStyle="insetGroup">
      <Section
        header={<Text>隧道来源</Text>}
        footer={
          <Text foregroundStyle="tertiaryLabel">
            Scripting 自身：由 Scripting 的 VPN 提供回环，首次会弹系统授权。
            代理工具提供：回环由 Surge / Loon 这类工具提供，本脚本不会去启动 Scripting 的 VPN（那样会把代理顶掉）。
            iOS 同时只允许一条 VPN。
          </Text>
        }
      >
        <Picker
          title="隧道来源"
          pickerStyle="segmented"
          value={settings.source}
          onChanged={(value: string) => update({ source: value === "proxyApp" ? "proxyApp" : "builtIn" })}
        >
          <Text tag="builtIn">Scripting 自身</Text>
          <Text tag="proxyApp">代理工具提供</Text>
        </Picker>
      </Section>

      <Section
        header={<Text>对端地址</Text>}
        footer={
          <Text foregroundStyle="tertiaryLabel">
            {`设备配对服务所在的回环地址，默认 ${DEFAULT_HOST}。填错或留空会自动退回默认值。`}
          </Text>
        }
      >
        <TextField
          title=""
          value={settings.host}
          prompt={DEFAULT_HOST}
          keyboardType="numbersAndPunctuation"
          onChanged={(value: string) => update({ host: value })}
        />
      </Section>

      <Section
        header={<Text>调试日志</Text>}
        footer={
          <Text foregroundStyle="tertiaryLabel">
            {note ||
              "日志一直在后台记着，开关只管要不要同时往终端刷——不开也能复制。" +
                "复制出来的已经打码，不含密钥和地址。反馈卡顿、连不上时附上这个。"}
          </Text>
        }
      >
        {/* 开关立刻生效，不用重跑脚本：以前要改一行代码再重来一遍，现场早没了 */}
        <Toggle
          title="输出到终端"
          value={echo}
          onChanged={(on: boolean) => {
            setDebugEcho(on);
            setEcho(on);
            setNote(on ? "✓ 新日志会同时打到 scripting-cli 的终端" : "✓ 已停止往终端刷");
          }}
        />
        {/* 日志动辄上千行，复制粘贴到哪里都截断。导出放在前面 */}
        <Button
          title={`导出成 txt（${count} 条）`}
          systemImage="square.and.arrow.up"
          disabled={count === 0}
          action={() => void exportText("调试日志", debugLogText()).then(setNote)}
        />
        <Button
          title={`复制日志（${count} 条）`}
          systemImage="doc.on.doc"
          disabled={count === 0}
          action={() => {
            copyWithFeedback(debugLogText());
            setNote("✓ 已复制");
          }}
        />
        <Button
          title="清空日志"
          systemImage="trash"
          role="destructive"
          disabled={count === 0}
          action={() => {
            clearDebugLog();
            setCount(0);
            setNote("✓ 已清空");
          }}
        />
      </Section>
    </List>
  );
}
