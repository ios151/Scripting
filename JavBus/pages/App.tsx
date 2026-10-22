// App 根视图与启动流程，index.tsx 和 intent.tsx 共用。
//
// 启动顺序（对应原版 start() → initial() → main()）：
//   18+ 提示（没通过过才出现）→ 预热站点会话、取推荐列表 → 处理启动请求：
//   URL scheme 的 code（原版 $context.query.code）、分享表单的文本（$context.textItems）、
//   或者剪贴板里的番号（原版默认行为），统统变成一个 LaunchRequest 交给首页。

import { Navigation, Script, Tab, TabView, useEffect, useObservable, useState } from "scripting";

import { detectCode, hasLink, normalizeCodeArg } from "../core/keyword";
import { onLaunchRequest, requestLaunch, type LaunchRequest } from "../kit/launch";
import {
  cachedRecLists,
  fetchRecLists,
  hasNewRecommendations,
  onRecommendChange,
} from "../kit/recommend";
import { warmSession } from "../kit/session";
import { getFlags, getSettings, setFlag } from "../kit/settings";
import { showError } from "../kit/toast";
import { GatePage } from "./GatePage";
import { GenresPage } from "./GenresPage";
import { HomePage } from "./HomePage";
import { LibraryPage } from "./LibraryPage";
import { RecommendPage } from "./RecommendPage";
import { StarsPage } from "./StarsPage";
import { showReleaseNotes } from "./TextSheet";
import { useToastHost } from "./useToastHost";

export interface StartSource {
  /** URL scheme：`scripting://run/JavBus?code=SSIS-001`。 */
  code?: string;
  /** 分享表单 / 快捷指令传来的文本。 */
  text?: string;
}

/** 启动来源 → 要不要去首页做点什么。 */
async function startupRequest(source: StartSource): Promise<LaunchRequest | null> {
  if (source.code) {
    const code = normalizeCodeArg(source.code);
    if (!code) {
      showError("💔 搜索无果,车牌无效");
      return null;
    }
    return { type: "movie", code };
  }
  if (source.text) {
    const detected = detectCode(source.text);
    return detected.mode === "search" ? { type: "search", keyword: detected.keyword } : null;
  }
  if (!getSettings().checkClipboard) return null;
  let clip: string | null = null;
  try {
    clip = await Pasteboard.getString();
  } catch {
    return null; // 没有剪贴板权限就当没有
  }
  // 剪贴板里是链接就不去抠番号（原版：有链接显示最新）
  if (!clip || hasLink(clip)) return null;
  const detected = detectCode(clip);
  return detected.mode === "search" ? { type: "search", keyword: detected.keyword } : null;
}

export function App({ source }: { source: StartSource }) {
  // 选中的 Tab 用 Observable，不用 useState：受控 tabIndex + useState 时根视图一重渲染
  // 就会把 TabView 按当时的 state 重新定位（网易云音乐里真机踩过：在别的页拨开关会被弹回首页），
  // 而我们的根视图会因 toast / 角标重渲染
  const selection = useObservable<number>(0);
  const [passed, setPassed] = useState(getFlags().adult);
  const toast = useToastHost();
  const [hasNew, setHasNew] = useState(hasNewRecommendations(cachedRecLists()));

  useEffect(() => onLaunchRequest(() => selection.setValue(0)), []); // 谁要首页做事，就把 Tab 切过去
  useEffect(() => onRecommendChange(() => setHasNew(hasNewRecommendations(cachedRecLists()))), []);

  useEffect(() => {
    if (!passed) return;
    void warmSession();
    if (!getFlags().readme) {
      setFlag("readme", true); // 原版首次运行弹一次更新说明（$cache 里的 samp）
      showReleaseNotes();
    }
    void fetchRecLists().catch(() => undefined); // 卡片上的推荐角标和 Tab 上的「新」要用
    void startupRequest(source).then((request) => {
      if (request) requestLaunch(request);
    });
  }, [passed]);

  if (!passed) return <GatePage onPass={() => setPassed(true)} />;

  return (
    // 整个脚本是深色设计（见 theme.tsx），不管系统明暗：根视图锁成深色，导航栏、Tab 栏、菜单、系统弹窗都跟着
    <TabView selection={selection} toast={toast} preferredColorScheme="dark">
      <Tab title="最新" systemImage="film.stack" value={0}>
        <HomePage />
      </Tab>
      <Tab title="女优" systemImage="person.2.fill" value={1}>
        <StarsPage />
      </Tab>
      <Tab title="分类" systemImage="square.grid.2x2.fill" value={2}>
        <GenresPage />
      </Tab>
      <Tab title="推荐" systemImage="star.fill" value={3} badge={hasNew ? "新" : 0}>
        <RecommendPage />
      </Tab>
      <Tab title="收藏" systemImage="heart.fill" value={4}>
        <LibraryPage />
      </Tab>
    </TabView>
  );
}

/** 弹出整个 App，关掉之后退出脚本。 */
export async function runApp(source: StartSource = {}): Promise<void> {
  await Navigation.present({
    element: <App source={source} />,
    modalPresentationStyle: "fullScreen",
  });
  Script.exit();
}
