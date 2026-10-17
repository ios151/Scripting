// 编辑 Dock：调顺序、移回某一页；以及从备份恢复整份布局。
// （早先还有「从页面放进 Dock」，用户反馈用不上，删了。）
//
// 安全措施，一条都不能省：
//   1. 打开时重新读一次设备上的布局，不拿上一页缓存的那份改（期间可能手动挪过）
//   2. 改动先只在草稿里，点「应用到设备」才写
//   3. 写之前自动备份当前布局（kit/backup.ts）
//   4. 设备写完不回包，所以写后重读，对比 Dock 和「有没有东西丢了」，如实告诉用户
//   5. 恢复同样先备份当前的，再写

import { Button, HStack, List, Menu, Section, Spacer, Text, useState } from "scripting";
import type { PlistValue } from "../core/bplist";
import { describeError } from "../core/debug";
import { listBackups, loadBackup, saveBackup, type BackupEntry } from "../kit/backup";
import { arrangementKey, clonePlist, compareLayouts, dockToPage, DOCK_LIMIT, moveInDock } from "../kit/homeEdit";
import { logWidgetCheck } from "../kit/layoutCheck";
import { deviceHub } from "../kit/hub";
import { parseHomeLayout, readHomeLayout, writeHomeLayout } from "../kit/services";
import { TaskStateSection, useDeviceTask } from "./common";
import { BACKUP_SCOPE, ItemIcon, WIDGET_WARNING, type IconMap } from "./homeShared";

/** 写回、重读、核对。返回给人看的结论。 */
async function applyAndVerify(target: PlistValue): Promise<{ actual: PlistValue; message: string; ok: boolean }> {
  const session = await deviceHub.get();
  await writeHomeLayout(session, target);
  const actual = (await readHomeLayout(session)).raw;
  logWidgetCheck(target, actual);
  const check = compareLayouts(target, actual);
  if (check.dockMatches && check.nothingLost) return { actual, message: "✓ 已写入设备，重读核对一致", ok: true };
  const parts: string[] = [];
  if (!check.dockMatches) parts.push("设备上的 Dock 和预期不一样（可能被设备拒绝或自动调整了）");
  if (!check.nothingLost) parts.push(`有 ${check.missing.length} 个条目不见了`);
  return { actual, message: `${parts.join("；")}。可以在下面「从备份恢复」里还原。`, ok: false };
}

export function DockEditPage({ icons }: { icons: IconMap }) {
  const [original, setOriginal] = useState<PlistValue | null>(null);
  const [draft, setDraft] = useState<PlistValue | null>(null);
  const [message, setMessage] = useState("");
  const [isError, setIsError] = useState(false);
  const [working, setWorking] = useState(false);
  const [backups, setBackups] = useState<BackupEntry[]>([]);

  const task = useDeviceTask(async (session) => {
    const layout = await readHomeLayout(session);
    setOriginal(layout.raw);
    setDraft(clonePlist(layout.raw));
    setBackups(await listBackups().catch(() => []));
    return true;
  });

  function report(text: string, error = false) {
    setMessage(text);
    setIsError(error);
  }

  function edit(change: (raw: PlistValue) => PlistValue) {
    if (!draft) return;
    try {
      setDraft(change(draft));
      report("");
    } catch (error) {
      report(describeError(error), true);
    }
  }

  const layout = draft ? parseHomeLayout(draft) : null;
  const dirty = draft !== null && original !== null && arrangementKey(original) !== arrangementKey(draft);

  async function apply() {
    if (!draft || !original || working) return;
    const ok = await Dialog.confirm({
      title: "写入设备？",
      message:
        "会先把现在的主屏布局自动备份一份，然后把新的 Dock 写到设备上，写完重新读一次核对。\n\n" +
        "最坏的情况是主屏排列被打乱（App 和数据不会丢），可以用「从备份恢复」还原，" +
        "或者在「设置 → 通用 → 传输或还原 iPhone → 还原 → 还原主屏幕布局」回到系统默认排列。\n\n" +
        WIDGET_WARNING,
    });
    if (!ok) return;
    setWorking(true);
    try {
      report("备份当前布局…");
      const name = await saveBackup(original, "写入前");
      report("写入设备…");
      const result = await applyAndVerify(draft);
      setOriginal(result.actual);
      setDraft(clonePlist(result.actual));
      setBackups(await listBackups().catch(() => []));
      report(`${result.message}（写入前的备份：${name}）`, !result.ok);
    } catch (error) {
      report(`写入失败：${describeError(error)}`, true);
    } finally {
      setWorking(false);
    }
  }

  async function restore(source: PlistValue, label: string) {
    if (!original || working) return;
    const ok = await Dialog.confirm({
      title: "从备份恢复？",
      message: `会用「${label}」覆盖设备上现在的主屏布局。恢复前会先把现在的布局再备份一份。\n\n${BACKUP_SCOPE}\n\n${WIDGET_WARNING}`,
    });
    if (!ok) return;
    setWorking(true);
    try {
      report("备份当前布局…");
      await saveBackup(original, "恢复前");
      report("恢复中…");
      const result = await applyAndVerify(source);
      setOriginal(result.actual);
      setDraft(clonePlist(result.actual));
      setBackups(await listBackups().catch(() => []));
      report(result.ok ? "✓ 已恢复，重读核对一致" : result.message, !result.ok);
    } catch (error) {
      report(`恢复失败：${describeError(error)}`, true);
    } finally {
      setWorking(false);
    }
  }

  async function restoreFromFile() {
    try {
      const files = await DocumentPicker.pickFiles({ types: ["public.data", "public.item"] });
      if (!files || files.length === 0) return;
      const source = await loadBackup(files[0]);
      await restore(source, files[0].split("/").pop() ?? "所选文件");
    } catch (error) {
      report(`读取备份失败：${describeError(error)}`, true);
    }
  }

  const pageCount = layout?.pages.length ?? 0;

  return (
    <List navigationTitle="编辑 Dock" navigationBarTitleDisplayMode="inline" listStyle="insetGroup">
      <TaskStateSection task={task} />

      {layout ? (
        <Section
          header={<Text>{`Dock（${layout.dock.length}/${DOCK_LIMIT}）`}</Text>}
          footer={<Text foregroundStyle="tertiaryLabel">改动先只在这里，点下面「应用到设备」才会写进去。</Text>}
        >
          {layout.dock.length === 0 ? <Text foregroundStyle="tertiaryLabel">Dock 是空的</Text> : null}
          {layout.dock.map((item, index) => (
            <HStack key={`dock-${index}`} spacing={10}>
              <ItemIcon item={item} icons={icons} size={30} />
              <Text lineLimit={1}>{item.name}</Text>
              <Spacer />
              <Button
                title=""
                systemImage="arrow.up"
                buttonStyle="borderless"
                action={() => edit((raw) => moveInDock(raw, index, index - 1))}
              />
              <Button
                title=""
                systemImage="arrow.down"
                buttonStyle="borderless"
                action={() => edit((raw) => moveInDock(raw, index, index + 1))}
              />
              <Menu title="" systemImage="ellipsis.circle">
                {Array.from({ length: pageCount }, (_, page) => (
                  <Button key={page} title={`移到第 ${page + 1} 页`} action={() => edit((raw) => dockToPage(raw, index, page))} />
                ))}
              </Menu>
            </HStack>
          ))}
        </Section>
      ) : null}

      {layout ? (
        <Section
          footer={
            <Text foregroundStyle={isError ? "systemRed" : "secondaryLabel"}>
              {message || (dirty ? "有未写入的改动。" : "还没有改动。")}
            </Text>
          }
        >
          <Button title={working ? "处理中…" : "应用到设备"} systemImage="checkmark.circle" action={() => void apply()} />
          {dirty ? (
            <Button title="撤销未应用的改动" action={() => original && setDraft(clonePlist(original))} />
          ) : null}
        </Section>
      ) : null}

      {layout ? (
        <Section
          header={<Text>从备份恢复</Text>}
          footer={
            <Text foregroundStyle="tertiaryLabel">
              每次写入、恢复之前都会自动备份，保留最近 20 份，这里列最近 5 份。也可以选「主屏布局」页导出的 plist。
              {BACKUP_SCOPE}
            </Text>
          }
        >
          {backups.slice(0, 5).map((entry) => (
            <Button
              key={entry.path}
              title={entry.name.replace(/\.plist$/, "")}
              systemImage="clock.arrow.circlepath"
              action={() =>
                void loadBackup(entry.path)
                  .then((source) => restore(source, entry.name))
                  .catch((error) => report(`读取备份失败：${describeError(error)}`, true))
              }
            />
          ))}
          <Button title="从文件恢复…" systemImage="doc" action={() => void restoreFromFile()} />
        </Section>
      ) : null}
    </List>
  );
}
