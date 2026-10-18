// 硬件树：IORegistry 里能翻出什么。
//
// MobileGestalt 在 iOS 27 上被停用之后，这是剩下唯一能看到硬件内情的路。
// 预设那些类名**是猜的**，查不到是常态——IOKit 的类名按芯片代次会变。
// 所以界面上把「没有这个节点」和「出错」分开显示，前者不算失败。
//
// 只读：只发 IORegistry 查询。

import {
  Button,
  HStack,
  Image,
  List,
  NavigationLink,
  ProgressView,
  Section,
  Spacer,
  Text,
  TextField,
  VStack,
  useState,
} from "scripting";
import { describeError } from "../core/debug";
import { deviceHub } from "../kit/hub";
import {
  IO_PRESETS,
  isRegistryKey,
  queryText,
  readRegistry,
  resultsText,
  type RegistryQuery,
  type RegistryResult,
} from "../kit/ioregistry";
import { RawListPage } from "./RawListPage";
import { copyWithFeedback, exportText } from "./common";

/** 自己加的节点名存着，下次进来还在。 */
const CUSTOM_KEY = "ioRegistryCustom";

function loadCustom(): string[] {
  const saved = Storage.get<string[]>(CUSTOM_KEY);
  return Array.isArray(saved) ? saved.filter((name) => typeof name === "string" && isRegistryKey(name)) : [];
}

export function HardwarePage() {
  const [results, setResults] = useState<Map<string, RegistryResult>>(new Map());
  const [busy, setBusy] = useState("");
  const [note, setNote] = useState("");
  const [custom, setCustom] = useState<string[]>(() => loadCustom());
  const [draft, setDraft] = useState("");

  const customEntries: RegistryQuery[] = custom.map((name) => ({ label: name, entryClass: name }));
  const allEntries = [...IO_PRESETS.flatMap((group) => group.entries), ...customEntries];

  async function query(entries: RegistryQuery[]) {
    if (busy) return;
    setBusy("连接设备…");
    setNote("");
    try {
      const found = await readRegistry(await deviceHub.get(), entries, (done, total, label) =>
        setBusy(label ? `查 ${label}（${done + 1}/${total}）…` : "收尾…"),
      );
      setResults((current) => new Map([...current, ...found.map((item) => [queryText(item.query), item] as const)]));
      const hit = found.filter((item) => item.rows.length > 0).length;
      setNote(`查了 ${found.length} 个，${hit} 个有内容`);
    } catch (error) {
      setNote(`查不动：${describeError(error)}`);
    } finally {
      setBusy("");
    }
  }

  function addCustom() {
    const name = draft.trim();
    if (!isRegistryKey(name)) {
      setNote("节点名只能是字母开头的字母、数字、下划线。");
      return;
    }
    if (custom.includes(name)) {
      setNote(`「${name}」已经在列表里了。`);
      return;
    }
    const next = [...custom, name];
    setCustom(next);
    Storage.set(CUSTOM_KEY, next);
    setDraft("");
    void query([{ label: name, entryClass: name }]);
  }

  const done = [...results.values()];
  const hit = done.filter((item) => item.rows.length > 0);

  function Row({ entry }: { entry: RegistryQuery }) {
    const result = results.get(queryText(entry));
    const body = (
      <HStack spacing={10}>
        <Image
          systemName={
            !result ? "circle" : result.rows.length > 0 ? "checkmark.circle.fill" : result.error ? "exclamationmark.triangle" : "minus.circle"
          }
          foregroundStyle={
            !result ? "tertiaryLabel" : result.rows.length > 0 ? "systemGreen" : result.error ? "systemOrange" : "tertiaryLabel"
          }
          frame={{ width: 24 }}
        />
        <VStack alignment="leading" spacing={2}>
          <Text foregroundStyle="label" lineLimit={1}>
            {entry.label}
          </Text>
          <Text font="caption2" fontDesign="monospaced" foregroundStyle="tertiaryLabel" lineLimit={1}>
            {queryText(entry)}
          </Text>
        </VStack>
        <Spacer />
        <Text font="caption" foregroundStyle="secondaryLabel">
          {!result ? "" : result.rows.length > 0 ? `${result.rows.length} 项` : result.error ? "出错" : "没有"}
        </Text>
      </HStack>
    );
    return result && result.rows.length > 0 ? (
      <NavigationLink destination={<RawListPage title={entry.label} rows={result.rows} />}>{body}</NavigationLink>
    ) : (
      <Button action={() => void query([entry])}>{body}</Button>
    );
  }

  return (
    <List navigationTitle="硬件树" navigationBarTitleDisplayMode="inline" listStyle="insetGroup">
      <Section
        footer={
          <Text foregroundStyle="tertiaryLabel">
            {note ||
              "IORegistry 是设备的硬件树。预设的类名是按通行叫法猜的，" +
                "查不到很正常——IOKit 的类名按芯片代次会变。点一行单查，有内容的点进去看。"}
          </Text>
        }
      >
        {busy ? (
          <HStack spacing={10}>
            <ProgressView />
            <Text foregroundStyle="secondaryLabel" lineLimit={1}>
              {busy}
            </Text>
          </HStack>
        ) : (
          <Button
            title={`全部查一遍（${allEntries.length} 个）`}
            systemImage="play.circle"
            action={() => void query(allEntries)}
          />
        )}
        {hit.length > 0 && !busy
          ? [
              <Button
                key="export"
                title="导出成 txt"
                systemImage="square.and.arrow.up"
                action={() => void exportText("硬件树", resultsText(done)).then(setNote)}
              />,
              <Button
                key="copy"
                title={`复制（${hit.length} 个有内容）`}
                systemImage="doc.on.doc"
                action={() => copyWithFeedback(resultsText(done))}
              />,
            ]
          : null}
      </Section>

      {IO_PRESETS.map((group) => (
        <Section key={group.title} header={<Text>{group.title}</Text>}>
          {group.entries.map((entry) => (
            <Row key={queryText(entry)} entry={entry} />
          ))}
        </Section>
      ))}

      <Section
        header={<Text>自己加节点</Text>}
        footer={
          <Text foregroundStyle="tertiaryLabel">
            按 IOKit 类名查（EntryClass）。加完会立刻查一次。
            找名字的窍门：**别猜，从已经查到的节点里捡**——点进任意一个有内容的，
            里面的 `IOClass` / `IOProviderClass` / `IONameMatched` 都是设备自己报的真名字。
            类名试不中时试节点名（像 `isp`、`bluetooth` 这种小写短名）。
          </Text>
        }
      >
        <HStack>
          <TextField title="" value={draft} prompt="IOKit 类名" onChanged={setDraft} />
          <Button title="加" action={addCustom} disabled={draft.trim().length === 0} />
        </HStack>
        {customEntries.map((entry) => (
          <Row key={queryText(entry)} entry={entry} />
        ))}
      </Section>
    </List>
  );
}
