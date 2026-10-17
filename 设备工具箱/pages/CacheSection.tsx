// 首页的「缓存」一节：占了多少、一键清掉。
//
// 只清「重算得出来」的东西（图标、占用空间统计）。配对记录、连接设置、
// 主屏备份都不在这儿——那些丢了要重新配或者再也找不回来，不是缓存。

import { Button, HStack, ProgressView, Section, Spacer, Text, useEffect, useState } from "scripting";
import { describeError } from "../core/debug";
import { cacheSizeText, cacheSummary, clearAllCaches, type CacheEntry } from "../kit/cache";

export function CacheSection() {
  const [entries, setEntries] = useState<CacheEntry[] | null>(null);
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState("");

  async function refresh() {
    try {
      setEntries(await cacheSummary());
    } catch (error) {
      setMessage(`读不到缓存信息：${describeError(error)}`);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function clear() {
    if (working) return;
    const ok = await Dialog.confirm({
      title: "清除全部缓存？",
      message:
        "会删掉 App 图标和占用空间的统计，下次打开时重新从设备读。\n\n配对记录、连接设置和主屏备份不受影响。",
      confirmLabel: "清除",
    });
    if (!ok) return;
    setWorking(true);
    setMessage("");
    try {
      await clearAllCaches();
      await refresh();
      setMessage("✓ 缓存已清除");
    } catch (error) {
      setMessage(`清不掉：${describeError(error)}`);
    } finally {
      setWorking(false);
    }
  }

  const empty = entries !== null && entries.every((entry) => (entry.bytes ?? 0) === 0 && entry.detail === "没有缓存");

  return (
    <Section
      header={<Text>缓存</Text>}
      footer={
        <Text foregroundStyle={message.startsWith("清不掉") || message.startsWith("读不到") ? "systemRed" : "tertiaryLabel"}>
          {message || "图标和占用空间会存下来，下次打开直接用，不用每次重读。清掉之后会重新从设备取。"}
        </Text>
      }
    >
      {entries === null ? (
        <HStack spacing={10}>
          <ProgressView />
          <Text foregroundStyle="secondaryLabel">统计中…</Text>
        </HStack>
      ) : (
        entries.map((entry) => (
          <HStack key={entry.name}>
            <Text>{entry.name}</Text>
            <Spacer />
            <Text foregroundStyle="secondaryLabel">
              {entry.bytes !== null && entry.bytes > 0 ? `${entry.detail} · ${cacheSizeText([entry])}` : entry.detail}
            </Text>
          </HStack>
        ))
      )}
      {working ? (
        <HStack spacing={10}>
          <ProgressView />
          <Text foregroundStyle="secondaryLabel">清除中…</Text>
        </HStack>
      ) : (
        <Button
          title={entries !== null && !empty ? `清除全部缓存（${cacheSizeText(entries)}）` : "清除全部缓存"}
          systemImage="trash"
          role="destructive"
          disabled={empty}
          action={() => void clear()}
        />
      )}
    </Section>
  );
}
