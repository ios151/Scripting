// 编辑 AI 整理的提示词（只有「整理风格」那一段可以改）。
//
// 程序依赖的约定（动作名、只能用列表里的 App……）在 FIXED_PROTOCOL 里，
// 永远附在用户这段后面，这里只读展示——让用户知道改的边界在哪。

import { Button, DisclosureGroup, HStack, Image, List, Section, Text, TextField, VStack, useState } from "scripting";
import {
  DEFAULT_STYLE_PROMPT,
  FIXED_PROTOCOL,
  STYLE_PROMPT_LIMIT,
  isCustomStylePrompt,
  loadStylePrompt,
  resetStylePrompt,
  saveStylePrompt,
} from "../kit/aiOrganize";

export function PromptEditorPage({ onChanged }: { onChanged?: () => void }) {
  const [text, setText] = useState(() => loadStylePrompt());
  const [custom, setCustom] = useState(() => isCustomStylePrompt());
  const [notice, setNotice] = useState("");

  const dirty = text !== loadStylePrompt();
  const overLimit = text.length > STYLE_PROMPT_LIMIT;

  async function save() {
    if (overLimit) {
      setNotice(`超过 ${STYLE_PROMPT_LIMIT} 字了，删减一些再保存`);
      return;
    }
    if (text.trim() && text !== DEFAULT_STYLE_PROMPT) {
      const ok = await Dialog.confirm({
        title: "使用自定义提示词？",
        message:
          "改过的提示词会直接影响 AI 怎么分类、怎么回复，效果可能变差，比如分得很乱、大量 App 被留在原位、AI 答非所问。\n\n" +
          "不会变的：程序的固定规则照样生效，AI 只能用你主屏上真有的 App；写入设备前照样要你确认、自动备份、写后核对。\n\n" +
          "觉得不对随时可以「恢复默认」。",
      });
      if (!ok) return;
    }
    saveStylePrompt(text);
    setCustom(isCustomStylePrompt());
    setText(loadStylePrompt());
    setNotice(isCustomStylePrompt() ? "✓ 已保存，下一条消息开始生效" : "✓ 已恢复为默认提示词");
    onChanged?.();
  }

  async function reset() {
    const ok = await Dialog.confirm({ title: "恢复默认提示词？", message: "你改过的内容会被丢掉。" });
    if (!ok) return;
    resetStylePrompt();
    setText(DEFAULT_STYLE_PROMPT);
    setCustom(false);
    setNotice("✓ 已恢复为默认提示词");
    onChanged?.();
  }

  return (
    <List
      navigationTitle="提示词"
      navigationBarTitleDisplayMode="inline"
      listStyle="insetGroup"
      toolbar={{ confirmationAction: <Button title="保存" action={() => void save()} /> }}
    >
      <Section>
        <HStack alignment="top" spacing={10}>
          <Image systemName="exclamationmark.triangle.fill" foregroundStyle="systemOrange" />
          <VStack alignment="leading" spacing={4}>
            <Text font="subheadline" fontWeight="semibold">改之前先看一下</Text>
            <Text font="footnote" foregroundStyle="secondaryLabel">
              默认的提示词是调过的，一般不用改。自己改可能让分类变乱、更多 App 留在原位，或者 AI 不按要求回复。
              程序的固定规则（见最下面）改不了，所以 AI 仍然只能用你主屏上真有的 App，写入前也照样要你确认、自动备份。
            </Text>
          </VStack>
        </HStack>
      </Section>

      <Section
        header={<Text>{custom ? "整理风格（已自定义）" : "整理风格（默认）"}</Text>}
        footer={
          <Text foregroundStyle={overLimit || notice.startsWith("超过") ? "systemRed" : "tertiaryLabel"}>
            {notice || `${text.length}/${STYLE_PROMPT_LIMIT} 字${dirty ? " · 有未保存的修改" : ""}`}
          </Text>
        }
      >
        <TextField
          title=""
          value={text}
          axis="vertical"
          prompt="比如：游戏单独一个文件夹；文件夹名用两个字"
          frame={{ minHeight: 240, alignment: "topLeading" }}
          font="callout"
          onChanged={(value: string) => {
            setText(value);
            setNotice("");
          }}
        />
      </Section>

      <Section>
        <Button title="恢复默认" role="destructive" action={() => void reset()} />
      </Section>

      <Section footer={<Text foregroundStyle="tertiaryLabel">这部分由程序固定附加在你的提示词后面，用来保证结果能被程序安全地执行。</Text>}>
        <DisclosureGroup title="程序固定附加的规则（不可改）">
          <Text font="footnote" foregroundStyle="secondaryLabel" textSelection>
            {FIXED_PROTOCOL}
          </Text>
        </DisclosureGroup>
      </Section>
    </List>
  );
}
