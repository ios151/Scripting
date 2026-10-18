// 硬件规格：把硬件树里编码过的数字解成人话，排成一页。
//
// 和「全部属性」的区别：那边是原样列 lockdown 的回包，这边是**跨节点聚合 + 解码**——
// 刷新率要拿设备自己的时基换算，亮度是 16.16 定点，GPU 核数要数掩码的位。
//
// **缺的字段整行不显示**，缺的那一节整节不显示。换台机器只会少几行，
// 不会出现一片「未知」。

import { Button, HStack, List, ProgressView, Section, Spacer, Text, useEffect, useState } from "scripting";
import { describeError } from "../core/debug";
import { buildSpec, specText, type SpecSection } from "../kit/hardwareSpec";
import { deviceHub } from "../kit/hub";
import { readNodes, type RegistryQuery } from "../kit/ioregistry";
import { readDeviceValues } from "../kit/services";
import { copyWithFeedback, exportText } from "./common";

/**
 * 每样东西给几个候选名，按顺序试。
 *
 * 2026-10-18 在 iPhone18,2 / iOS 27.2 上验过第一个候选都能中；
 * 后面那些是别的机型 / 系统版本可能用的叫法，**查不到就跳过，不报错**。
 */
const NODES: Record<string, RegistryQuery[]> = {
  platform: [{ label: "platform", entryClass: "IOPlatformExpertDevice" }],
  gpu: [
    { label: "gpu", entryClass: "AGXAccelerator" },
    { label: "gpu", entryClass: "IOAccelerator" },
    { label: "gpu", entryName: "gpu" },
  ],
  display: [
    { label: "display", entryClass: "IOMobileFramebuffer" },
    { label: "display", entryClass: "AppleCLCD2" },
    { label: "display", entryClass: "AppleCLCD" },
  ],
  touch: [{ label: "touch", entryClass: "AppleMultitouchDevice" }],
  media: [{ label: "media", entryClass: "IOMedia" }],
  network: [{ label: "network", entryClass: "IONetworkInterface" }],
  bluetooth: [{ label: "bluetooth", entryName: "bluetooth" }],
  isp: [
    { label: "isp", entryName: "isp" },
    { label: "isp", entryClass: "AppleISP" },
  ],
};

export function SpecPage() {
  const [sections, setSections] = useState<SpecSection[] | null>(null);
  const [busy, setBusy] = useState("");
  const [note, setNote] = useState("");

  async function load() {
    setBusy("连接设备…");
    setNote("");
    try {
      const session = await deviceHub.get();
      setBusy("读设备属性…");
      const lockdown = await readDeviceValues(session);
      const nodes = await readNodes(session, NODES, (label) => setBusy(`读 ${label}…`));
      setSections(buildSpec({ ...nodes, lockdown }));
    } catch (error) {
      setNote(`读不到：${describeError(error)}`);
    } finally {
      setBusy("");
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const total = (sections ?? []).reduce((sum, part) => sum + part.items.length, 0);

  return (
    <List navigationTitle="硬件规格" navigationBarTitleDisplayMode="inline" listStyle="insetGroup" refreshable={load}>
      <Section
        footer={
          <Text foregroundStyle={note ? "systemRed" : "tertiaryLabel"}>
            {note ||
              "从硬件树里挑出来解码的。刷新率按设备自己的时基换算，亮度是 16.16 定点数。" +
                "查不到的字段不显示——这台设备没有就是没有，不编默认值。"}
          </Text>
        }
      >
        {busy ? (
          <HStack spacing={10}>
            <ProgressView />
            <Text foregroundStyle="secondaryLabel">{busy}</Text>
          </HStack>
        ) : sections ? (
          <HStack>
            <Text>读到</Text>
            <Spacer />
            <Text foregroundStyle="secondaryLabel">{`${total} 项`}</Text>
          </HStack>
        ) : null}
        {sections && total > 0 && !busy
          ? [
              <Button
                key="export"
                title="导出成 txt"
                systemImage="square.and.arrow.up"
                action={() => void exportText("硬件规格", specText(sections)).then(setNote)}
              />,
              <Button
                key="copy"
                title="复制"
                systemImage="doc.on.doc"
                action={() => copyWithFeedback(specText(sections))}
              />,
            ]
          : null}
      </Section>

      {(sections ?? []).map((part) => (
        <Section key={part.title} header={<Text>{part.title}</Text>}>
          {part.items.map((row) => (
            <Button key={row.label} action={() => copyWithFeedback(row.value)}>
              <HStack>
                <Text foregroundStyle="label">{row.label}</Text>
                <Spacer />
                <Text foregroundStyle="secondaryLabel" lineLimit={1}>
                  {row.value}
                </Text>
              </HStack>
            </Button>
          ))}
        </Section>
      ))}

      {sections && total === 0 && !busy ? (
        <Section>
          <Text foregroundStyle="tertiaryLabel">这台设备一项都没读到。硬件树那页能看到具体哪些节点查得到。</Text>
        </Section>
      ) : null}
    </List>
  );
}
