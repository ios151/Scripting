// 类目影片列表：分类（类别）/ 导演 / 系列 / 制作商 / 发行商 点进去都是这一页。
//
// 原版 pushCat + catCover：底部「全部 / 收录」切换（独立于首页那个，所以状态放在页面自己里）；
// 导演 / 系列 / 制作商 / 发行商多一个「收藏」按钮，类别（genre）没有；
// 取消收藏后不退出本页（原版会 `$ui.pop()`，Scripting 里推进来的页面调 useDismiss 关掉的是整个脚本）。

import { Button, ContentUnavailableView, ScrollView, VStack, ZStack, useState } from "scripting";

import { hasNamed } from "../core/library";
import { parseMovieList } from "../core/parse";
import { refFromItem } from "../core/refs";
import { namedShortCode, pagedUrl } from "../core/site";
import type { MovieItem, NamedKind } from "../core/types";
import { getPage } from "../kit/http";
import { recKindOf, useRecVersion } from "../kit/recommend";
import { store, useLibrary } from "../kit/store";
import { LoadFooter, MovieGrid } from "./components";
import { MovieDetailPage } from "./MovieDetailPage";
import { PageBackdrop, SIDE, Segmented, TINT } from "./theme";
import { usePaged } from "./usePaged";

export type CategoryKind = "genre" | NamedKind;

const SCOPE_ITEMS: { key: "all" | "mag"; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "mag", label: "收录" },
];

export function CategoryMoviesPage({ title, link, kind }: { title: string; link: string; kind: CategoryKind }) {
  const lib = useLibrary();
  useRecVersion();
  const [all, setAll] = useState(false);

  const paged = usePaged<MovieItem>(
    `${link}|${all}`,
    async (page) => {
      const res = await getPage(pagedUrl(link, page), { all });
      const list = parseMovieList(res.html, res.url);
      if (list.ended || list.noResult) return { items: [], done: true };
      return { items: list.items, done: false };
    },
    (item) => item.link,
  );

  const shortCode = namedShortCode(link);
  const favorited = kind !== "genre" && hasNamed(lib, kind, shortCode);

  const toggleFavorite = () => {
    if (kind === "genre") return;
    if (favorited) {
      store.removeNamed(kind, shortCode);
    } else {
      store.addNamed(kind, { name: title, shortCode });
      HapticFeedback.lightImpact();
    }
  };

  return (
    <ZStack
      navigationTitle={title}
      navigationBarTitleDisplayMode="inline"
      toolbar={{
        topBarTrailing:
          kind === "genre"
            ? []
            : [<Button key="fav" title={favorited ? "取消收藏" : "收藏"} systemImage={favorited ? "heart.slash" : "heart"} action={toggleFavorite} />],
      }}
      frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
    >
      <PageBackdrop tint={kind === "genre" ? TINT.genres : TINT.library} />
      <ScrollView>
        <VStack spacing={14} padding={{ top: 8, bottom: 24 }}>
          <VStack padding={{ horizontal: SIDE }}>
            <Segmented items={SCOPE_ITEMS} selected={all ? "all" : "mag"} onSelect={(next) => setAll(next === "all")} />
          </VStack>
          {paged.items.length === 0 && !paged.loading && !paged.error ? (
            <ContentUnavailableView
              title="没有影片"
              systemImage="film"
              description={all ? "这个类目下没有影片" : "试试切换到「全部」，把没有磁链的也列出来"}
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
          <LoadFooter loading={paged.loading} error={paged.error} done={paged.done} count={paged.items.length} onRetry={paged.retry} />
        </VStack>
      </ScrollView>
    </ZStack>
  );
}
