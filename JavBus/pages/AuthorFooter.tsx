import { Button, HStack, Section, Text, VStack } from "scripting";

import { AUTHOR_TG } from "../core/constants";

function Handle({ text, url }: { text: string; url: string }) {
  return (
    <Button buttonStyle="borderless" action={() => void Safari.openURL(url)}>
      <Text font="footnote" foregroundStyle="systemBlue">{text}</Text>
    </Button>
  );
}

/**
 * 页面最底下的作者信息，样子像网页页脚：居中小字，没有背景、分隔线和图标，
 * 跟着内容滚到底才看得见。@ 点得开 Telegram（装了就直接进 App）。
 * 行背景和分隔线用 listRowBackground / listRowSeparator 去掉，才不会长成一张卡片。
 */
export function AuthorFooter() {
  return (
    <Section>
      <VStack
        spacing={6}
        padding={{ top: 8, bottom: 16 }}
        frame={{ maxWidth: "infinity" }}
        listRowBackground={<></>}
        listRowSeparator="hidden"
      >
        <HStack spacing={4}>
          <Text font="footnote" foregroundStyle="tertiaryLabel">作者</Text>
          <Handle text="@ios151" url={AUTHOR_TG} />
        </HStack>
        <Text font="caption2" foregroundStyle="tertiaryLabel">移植自 Nicked639 的 JSBox 脚本 JavBus</Text>
      </VStack>
    </Section>
  );
}
