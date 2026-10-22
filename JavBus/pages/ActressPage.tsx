// 演员页：头像 + 资料 + 收藏按钮 + 她的作品（全部 / 收录，分页）。
//
// 资料只在第 1 页里有（生日 / 年龄 / 身高 / 罩杯 / 胸围 / 腰围 / 臀围），缺哪项显示问号占位。
// 作品翻页地址是 `<演员链接>/<页>`。取消收藏后不退出本页（原版会 `$ui.pop()`，Scripting 里
// 推进来的页面调 useDismiss 关掉的是整个脚本，见 MovieDetailPage 里 PHASE_VIEW 的说明）。
//
// 外观同影片详情页：头像糊成背景，头像和资料在上，收藏用半透明白的胶囊。

import { ContentUnavailableView, HStack, ScrollView, Spacer, Text, VStack, ZStack, useState } from "scripting";

import { hasActress } from "../core/library";
import { shortCodeOf } from "../core/keyword";
import { BLANK_ACTRESS_INFO, parseActressInfo, parseMovieList } from "../core/parse";
import { refFromItem } from "../core/refs";
import { isUncensoredLink, pagedUrl } from "../core/site";
import type { ActressInfo, MovieItem, StarItem } from "../core/types";
import { getPage } from "../kit/http";
import { recKindOf, useRecVersion } from "../kit/recommend";
import { store, useLibrary } from "../kit/store";
import { LoadFooter, MovieGrid } from "./components";
import { CollectCapsule } from "./DetailParts";
import { MovieDetailPage } from "./MovieDetailPage";
import { RemoteImage } from "./RemoteImage";
import { CARD, CoverBackdrop, INK, SIDE, Segmented } from "./theme";
import { usePaged } from "./usePaged";

const SCOPE_ITEMS: { key: "all" | "mag"; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "mag", label: "收录" },
];

function InfoLine({ label, value }: { label: string; value: string }) {
  return (
    <HStack spacing={6}>
      <Text font="footnote" foregroundStyle={INK.soft}>
        {label}
      </Text>
      <Text font="footnote" fontWeight="semibold" foregroundStyle={INK.strong}>
        {value}
      </Text>
    </HStack>
  );
}

export function ActressPage({ star }: { star: StarItem }) {
  const lib = useLibrary();
  useRecVersion();
  const [all, setAll] = useState(false);
  const [info, setInfo] = useState<ActressInfo>(BLANK_ACTRESS_INFO);

  const shortCode = shortCodeOf(star.link);
  const un = isUncensoredLink(star.link) ? "uncensored/" : "";
  const favorited = hasActress(lib, shortCode);

  const paged = usePaged<MovieItem>(
    `${star.link}|${all}`,
    async (page) => {
      const res = await getPage(pagedUrl(star.link, page), { all });
      if (page === 1) setInfo(parseActressInfo(res.html));
      const list = parseMovieList(res.html, res.url);
      if (list.ended || list.noResult) return { items: [], done: true };
      return { items: list.items, done: false };
    },
    (item) => item.link,
  );

  const toggleFavorite = () => {
    if (favorited) {
      store.removeActress(shortCode);
    } else {
      store.addActress({ src: star.avatar, info: star.name, shortCode, un });
      HapticFeedback.lightImpact();
    }
  };

  return (
    <ZStack navigationTitle={star.name} navigationBarTitleDisplayMode="inline" frame={{ maxWidth: "infinity", maxHeight: "infinity" }}>
      <CoverBackdrop cover={star.avatar} />
      <ScrollView>
        <VStack spacing={14} padding={{ top: 8, bottom: 24 }}>
          <HStack alignment="top" spacing={14} padding={{ horizontal: SIDE }}>
            <RemoteImage url={star.avatar} maxSide={300} width={110} height={110} radius={16} mode="fit" />
            <VStack
              alignment="leading"
              spacing={6}
              padding={12}
              frame={{ maxWidth: "infinity", alignment: "leading" }}
              background={{ style: CARD, shape: { type: "rect", cornerRadius: 14 } }}
            >
              <InfoLine label="生日" value={info.birthday} />
              <InfoLine label="年龄" value={info.age} />
              <InfoLine label="身高" value={info.height} />
              <InfoLine label="罩杯" value={info.cup} />
              <HStack spacing={10}>
                <InfoLine label="胸围" value={info.bust} />
                <InfoLine label="腰围" value={info.waist} />
                <InfoLine label="臀围" value={info.hip} />
              </HStack>
            </VStack>
          </HStack>

          <HStack padding={{ horizontal: SIDE }}>
            <CollectCapsule
              icon={favorited ? "heart.fill" : "heart"}
              title={favorited ? "取消收藏" : "收藏演员"}
              color={favorited ? "#ff6b6b" : INK.strong}
              disabled={false}
              width={150}
              onPress={toggleFavorite}
            />
            <Spacer />
          </HStack>

          <VStack padding={{ horizontal: SIDE }}>
            <Segmented items={SCOPE_ITEMS} selected={all ? "all" : "mag"} onSelect={(next) => setAll(next === "all")} />
          </VStack>

          {paged.items.length === 0 && !paged.loading && !paged.error ? (
            <ContentUnavailableView
              title="没有作品"
              systemImage="film"
              description={all ? "这位演员下没有作品" : "试试切换到「全部」，把没有磁链的也列出来"}
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
