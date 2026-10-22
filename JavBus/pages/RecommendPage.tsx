// 「推荐」页：作者推荐 / 网友推荐两份列表（原作者在 gitlab 上维护的 JSON）。
//
// 原版：顶部输入框（placeholder 是「总推荐 N 作者推荐 A 网友推荐 B」，敲回车当搜索用），
// 3 列封面，左上「推荐」角标（作者橙、网友紫），下拉打开 JavLibrary 高分榜；
// 第一次进来弹一次提示；进来之后清掉 Tab 上的「新」。
// 封面下面的时间是收藏时间，不是上映时间——进详情页后收藏时会改用详情页里的上映日期。

import {
  Button,
  ContentUnavailableView,
  HStack,
  Navigation,
  NavigationStack,
  ProgressView,
  ScrollView,
  Spacer,
  Text,
  VStack,
  ZStack,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "scripting";

import { JAVLIB_BEST_URL } from "../core/constants";
import { refFromRec } from "../core/refs";
import type { MovieItem, RecItem } from "../core/types";
import { describeError } from "../kit/http";
import { requestLaunch } from "../kit/launch";
import { cachedRecLists, fetchRecLists, markRecommendationsSeen, type RecLists } from "../kit/recommend";
import { takeTip } from "../kit/settings";
import { useLibrary } from "../kit/store";
import { MovieGrid, SearchBar } from "./components";
import { MovieDetailPage } from "./MovieDetailPage";
import { rootToolbar } from "./rootToolbar";
import { DANGER, PageBackdrop, PillLabel, SIDE, Segmented, TINT } from "./theme";

type Tab = "author" | "user";

const TAB_ITEMS: { key: Tab; label: string }[] = [
  { key: "author", label: "作者推荐" },
  { key: "user", label: "网友推荐" },
];

/** 推荐条目借用影片卡片展示：只有封面和一行「info」文字。 */
function asItem(rec: RecItem): MovieItem {
  return { code: rec.code, link: rec.link, cover: rec.src, title: "", date: "", hd: false, sub: false };
}

export function RecommendPage() {
  const dismiss = Navigation.useDismiss();
  const lib = useLibrary();
  const [lists, setLists] = useState<RecLists | null>(cachedRecLists());
  const [error, setError] = useState("");
  const [tab, setTab] = useState<Tab>("author");
  const [input, setInput] = useState("");
  // 页面此刻是不是在屏幕上。「新」角标和首次提示必须等用户真的看到这个 Tab 才处理，
  // 不能放在挂载时：Tab 内容如果启动时就全部挂载，角标会在没人看见的时候被清掉
  const visible = useRef(false);

  const load = async (force: boolean) => {
    setError("");
    try {
      const fresh = await fetchRecLists(force);
      setLists(fresh);
      if (visible.current) markRecommendationsSeen(fresh);
    } catch (e) {
      setError(describeError(e));
    }
  };

  useEffect(() => {
    void load(false);
  }, []);

  const onAppear = () => {
    visible.current = true;
    const loaded = cachedRecLists();
    if (loaded) markRecommendationsSeen(loaded); // 进来看了，清掉 Tab 上的「新」
    if (takeTip("Rec")) {
      void Dialog.alert({ title: "推荐", message: "众口难调，欢迎投稿\n\n注:本界面封面时间为收藏时间而非上映时间" });
    }
  };

  const shown = tab === "author" ? (lists?.author ?? []) : (lists?.user ?? []);
  const items = useMemo(() => shown.map(asItem), [lists, tab]);
  // 按番号查：列表里偶有不同番号共用一个链接的脏数据（网友推荐 1254 条里有 5 处），按链接查会串
  const recByCode = useMemo(() => new Map(shown.map((r) => [r.code, r])), [lists, tab]);

  const submit = () => {
    const text = input.trim();
    if (!text) return;
    requestLaunch({ type: "search", keyword: text });
    setInput("");
  };

  const total = (lists?.author.length ?? 0) + (lists?.user.length ?? 0);

  return (
    <NavigationStack>
      <ZStack>
        <PageBackdrop tint={TINT.recommend} />
        <ScrollView
          navigationTitle="推荐"
          navigationBarTitleDisplayMode="inline"
          onAppear={onAppear}
          onDisappear={() => {
            visible.current = false;
          }}
          // 原版下拉打开 JavLibrary 高分榜；下拉在这里留给刷新，高分榜放到导航栏
          toolbar={rootToolbar(() => dismiss(), [
            <Button key="best" title="高分榜" systemImage="trophy" action={() => void Safari.openURL(JAVLIB_BEST_URL)} />,
          ])}
          refreshable={async () => {
            await load(true);
          }}
        >
          <VStack spacing={14} padding={{ top: 8, bottom: 24 }}>
            <VStack spacing={10} padding={{ horizontal: SIDE }}>
              <SearchBar
                value={input}
                onChanged={setInput}
                onSubmit={submit}
                prompt={lists ? `总推荐 ${total}  作者推荐 ${lists.author.length}  网友推荐 ${lists.user.length}` : "输入番号或演员进行搜索"}
              />
              <Segmented items={TAB_ITEMS} selected={tab} onSelect={setTab} />
            </VStack>

            {!lists && !error ? (
              <HStack padding={30}>
                <Spacer />
                <ProgressView progressViewStyle="circular" tint="white" />
                <Spacer />
              </HStack>
            ) : error && !lists ? (
              <VStack spacing={10} padding={20}>
                <Text foregroundStyle={DANGER} multilineTextAlignment="center">
                  {error}
                </Text>
                <Button buttonStyle="plain" action={() => void load(true)}>
                  <PillLabel icon="arrow.clockwise" text="重试" />
                </Button>
              </VStack>
            ) : items.length === 0 ? (
              <ContentUnavailableView title="暂无推荐" systemImage="star" />
            ) : (
              <MovieGrid
                items={items}
                lib={lib}
                destinationFor={(item) => (
                  <MovieDetailPage movie={refFromRec(recByCode.get(item.code) ?? { code: item.code, link: item.link, src: item.cover, info: item.code })} />
                )}
                recFor={() => tab}
                infoFor={(item) => recByCode.get(item.code)?.info}
              />
            )}
          </VStack>
        </ScrollView>
      </ZStack>
    </NavigationStack>
  );
}
