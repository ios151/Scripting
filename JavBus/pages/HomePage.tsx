// 「最新」页：搜索框 + 有码 / 无码 / 欧美 + 全部 / 收录 + 影片网格，滚到底翻页。
//
// 对应原版的首页 searchView + getInitial。搜索的几个特殊行为都在这里：
// - 番号归一化（`ssis001` → `ssis-001`）；
// - 搜不到自动换站（kit/search.ts），切换后上面的分区按钮跟着变；
// - 全站都搜不到，但 MissAV / Jable 有片源时，打开「没有 JavBus 条目」的兜底详情；
// - 结果恰好一条，直接进详情。
// 其他页面（推荐、女优、启动时的剪贴板 / URL scheme）通过 kit/launch.ts 把请求递过来。

import {
  ContentUnavailableView,
  HStack,
  Navigation,
  ProgressView,
  ScrollView,
  Spacer,
  Text,
  VStack,
  NavigationStack,
  ZStack,
  useEffect,
  useRef,
  useState,
} from "scripting";

import { normalizeKeyword } from "../core/keyword";
import { parseMovieList } from "../core/parse";
import { fallbackRef, refFromCode, refFromItem } from "../core/refs";
import { listUrl, searchUrl } from "../core/site";
import type { MovieItem, MovieRef, SiteKind } from "../core/types";
import { describeError, getPage } from "../kit/http";
import { onLaunchRequest, takeLaunch, type LaunchRequest } from "../kit/launch";
import { findJable, findMissavPreview } from "../kit/previews";
import { recKindOf, useRecVersion } from "../kit/recommend";
import { searchAcrossKinds } from "../kit/search";
import { useLibrary } from "../kit/store";
import { showError } from "../kit/toast";
import { LoadFooter, MovieGrid, SearchBar } from "./components";
import { MovieDetailPage } from "./MovieDetailPage";
import { rootToolbar } from "./rootToolbar";
import { INK, PageBackdrop, SIDE, Segmented, TINT, columnWidth } from "./theme";
import { usePaged } from "./usePaged";

const KIND_ITEMS: { key: SiteKind; label: string }[] = [
  { key: "censored", label: "有码" },
  { key: "uncensored", label: "无码" },
  { key: "western", label: "欧美" },
];
const SCOPE_ITEMS: { key: "all" | "mag"; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "mag", label: "收录" },
];

type Query = { mode: "home" } | { mode: "search"; keyword: string };

export function HomePage() {
  const dismiss = Navigation.useDismiss();
  const lib = useLibrary();
  useRecVersion();
  // 分区和搜索词放在同一个状态里：换站搜索时两个一起变，不会冒出「新分区 + 旧关键词」的半截请求
  const [view, setView] = useState<{ kind: SiteKind; query: Query }>({ kind: "censored", query: { mode: "home" } });
  const { kind, query } = view;
  const [all, setAll] = useState(false);
  const [input, setInput] = useState("");
  const [auto, setAuto] = useState<MovieRef | null>(null);
  const [searching, setSearching] = useState(false);
  // 换站搜索时，命中站点的第一页已经取到了，铺列表时直接用，别再请求一遍
  const seed = useRef<{ key: string; items: MovieItem[] } | null>(null);

  const keyword = query.mode === "search" ? query.keyword : "";
  const key = `${kind}|${all}|${keyword}`;

  const paged = usePaged<MovieItem>(
    key,
    async (page) => {
      if (page === 1 && seed.current?.key === key) {
        const items = seed.current.items;
        seed.current = null;
        return { items, done: false };
      }
      const url = query.mode === "search" ? searchUrl(kind, query.keyword, page) : listUrl(kind, page);
      const res = await getPage(url, { all });
      const list = parseMovieList(res.html, res.url);
      if (list.ended || list.noResult) return { items: [], done: true };
      return { items: list.items, done: false };
    },
    (item) => item.link,
  );

  /** 搜一个词。空串 = 退出搜索回到最新。 */
  const runSearch = async (raw: string) => {
    const text = raw.trim();
    if (!text) {
      setInput("");
      setView((v) => ({ ...v, query: { mode: "home" } }));
      return;
    }
    const word = normalizeKeyword(text);
    setInput(word);
    setSearching(true);
    try {
      const hit = await searchAcrossKinds(word, kind, all);
      if (hit) {
        const nextKey = `${hit.kind}|${all}|${word}`;
        seed.current = { key: nextKey, items: hit.items };
        setView({ kind: hit.kind, query: { mode: "search", keyword: word } });
        if (nextKey === key) paged.reload(); // 同一个搜索再搜一遍：key 没变，手动重载才会吃到新结果
        if (hit.items.length === 1) setAuto(refFromItem(hit.items[0]));
        return;
      }
      // JavBus 没有，看看别的站有没有片源（原版靠开搜时就并行探测的 Missav / Jable 结果）
      const [missav, jable] = await Promise.all([findMissavPreview(word), findJable(word)]);
      if (missav || jable) setAuto(fallbackRef(word));
      else showError("💔 搜索无果,车牌无效");
    } catch (e) {
      showError(describeError(e));
    } finally {
      setSearching(false);
    }
  };

  // 其他页面递来的请求。ref 存最新闭包，订阅只挂一次
  const handle = useRef<(request: LaunchRequest) => void>(() => undefined);
  handle.current = (request) => {
    switch (request.type) {
      case "kind":
        setView({ kind: request.kind, query: { mode: "home" } });
        setInput("");
        break;
      case "search":
        void runSearch(request.keyword);
        break;
      case "movie":
        setAuto(refFromCode(request.code));
        break;
    }
  };
  useEffect(() => {
    const run = () => {
      const request = takeLaunch();
      if (request) handle.current(request);
    };
    run();
    return onLaunchRequest(run);
  }, []);

  // 分区和范围两个分段并排放：分区三段、范围两段，按 3:2 分内容列宽
  const kindWidth = Math.floor((columnWidth() - 8) * 0.6);
  const scopeWidth = columnWidth() - 8 - kindWidth;

  return (
    <NavigationStack>
      <ZStack>
        <PageBackdrop tint={TINT.home} />
        <ScrollView
          navigationTitle="JavBus"
          navigationBarTitleDisplayMode="inline"
          toolbar={rootToolbar(() => dismiss())}
          refreshable={async () => {
            paged.reload();
          }}
          navigationDestination={{
            isPresented: auto !== null,
            onChanged: (presented: boolean) => {
              if (!presented) setAuto(null);
            },
            // 带 key：新的搜索结果替换自动打开的详情时，是一个新的详情页，不沿用上一部的播放器、片源和翻译
            content: auto ? <MovieDetailPage key={`${auto.link}#${auto.code}`} movie={auto} /> : <Spacer />,
          }}
        >
          <VStack spacing={14} padding={{ top: 8, bottom: 24 }}>
            <VStack spacing={10} padding={{ horizontal: SIDE }}>
              <SearchBar value={input} onChanged={setInput} onSubmit={() => void runSearch(input)} />
              <HStack spacing={8}>
                <Segmented
                  width={kindWidth}
                  items={KIND_ITEMS}
                  selected={kind}
                  onSelect={(next) => {
                    // 原版 tabC 一变就清掉关键词、回到该分区的最新列表；搜索后自动换了站、再点回原分区也是这样
                    setInput("");
                    setView({ kind: next, query: { mode: "home" } });
                  }}
                />
                <Segmented width={scopeWidth} items={SCOPE_ITEMS} selected={all ? "all" : "mag"} onSelect={(next) => setAll(next === "all")} />
              </HStack>
            </VStack>

            {searching ? (
              <HStack spacing={8} padding={12}>
                <Spacer />
                <ProgressView progressViewStyle="circular" tint="white" />
                <Text font="footnote" foregroundStyle={INK.soft}>
                  搜索中…
                </Text>
                <Spacer />
              </HStack>
            ) : paged.items.length === 0 && !paged.loading && !paged.error ? (
              <ContentUnavailableView
                title={keyword ? `没有找到「${keyword}」` : "暂无影片"}
                systemImage="film"
                description={all ? undefined : "「收录」只显示有磁链的，试试切到「全部」"}
              />
            ) : (
              <MovieGrid
                items={paged.items}
                lib={lib}
                destinationFor={(item) => <MovieDetailPage movie={refFromItem(item)} />}
                recFor={(item) => recKindOf(item.code)}
                onNearEnd={paged.loadMore}
              />
            )}
            {searching ? null : (
              <LoadFooter loading={paged.loading} error={paged.error} done={paged.done} count={paged.items.length} onRetry={paged.retry} />
            )}
          </VStack>
        </ScrollView>
      </ZStack>
    </NavigationStack>
  );
}
