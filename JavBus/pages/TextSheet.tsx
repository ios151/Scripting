// 长文案页：作者声明、更新说明。
//
// 系统 alert 的正文不滚动、行数一多就压字号甚至截断，长文案一律用这种整页（可滚动、能用 Markdown）。

import { Button, Markdown, Navigation, NavigationStack, ProgressView, ScrollView, VStack, ZStack, useEffect, useState } from "scripting";

import { README_URL } from "../core/constants";
import { DECLARATION, RELEASE_NOTES } from "../core/texts";
import { getText } from "../kit/http";
import { PageBackdrop } from "./theme";
import { useToastHost } from "./useToastHost";

function Sheet({ title, content, loading }: { title: string; content: string; loading?: boolean }) {
  const dismiss = Navigation.useDismiss();
  const toast = useToastHost();
  return (
    // 这是单独 present 出来的 modal：不去赌它继承不继承 App 根视图的深色，自己也锁一次
    <NavigationStack preferredColorScheme="dark">
      <ZStack>
        <PageBackdrop />
        <ScrollView
          toast={toast}
          navigationTitle={title}
          navigationBarTitleDisplayMode="inline"
          toolbar={{ topBarLeading: [<Button key="close" title="完成" action={() => dismiss()} />] }}
        >
          <VStack padding={16} alignment="leading">
            {loading ? <ProgressView progressViewStyle="circular" tint="white" /> : <Markdown content={content} scrollable={false} />}
          </VStack>
        </ScrollView>
      </ZStack>
    </NavigationStack>
  );
}

export function DeclarationSheet() {
  // 声明里有 URL 和编号列表，用 Markdown 渲染比纯文本好读
  return <Sheet title="作者声明" content={DECLARATION.replace(/^声明\n\n/, "## 声明\n\n")} />;
}

/** 原版先读远程 README；现在那个地址已经 404，读不到就显示内置的更新说明。 */
export function ReleaseNotesSheet() {
  const [content, setContent] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const { text, status } = await getText(README_URL, { timeout: 8 });
        if (alive) setContent(status === 200 && text.trim() ? text : RELEASE_NOTES);
      } catch {
        if (alive) setContent(RELEASE_NOTES);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  return <Sheet title="更新说明" content={content ?? ""} loading={content === null} />;
}

export function showDeclaration(): void {
  void Navigation.present({ element: <DeclarationSheet /> });
}

export function showReleaseNotes(): void {
  void Navigation.present({ element: <ReleaseNotesSheet /> });
}
