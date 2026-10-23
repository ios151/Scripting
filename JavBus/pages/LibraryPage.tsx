// 「收藏」页：收藏（影片 / 演员 / 导演 / 系列 / 制作商 / 发行商）和归档。
//
// 原版是两个 menu（收藏、归档），收藏里再用 tab 切六类。这里合成一页：顶上「收藏 | 归档」，
// 收藏下面再切六类，每一类标出条数（原版的 placeholder「已收藏 N 部影片」）。
// 归档里的输入框按番号过滤；收藏里的输入框和其他页一样，敲回车去首页搜索。
// 影片卡片长按可以直接取消收藏 / 归档 / 删除，不用点进详情页。

import {
  Button,
  ContentUnavailableView,
  Label,
  LazyVGrid,
  Menu,
  Navigation,
  NavigationLink,
  NavigationStack,
  ScrollView,
  Text,
  VStack,
  ZStack,
  useMemo,
  useState,
} from "scripting";

import { pickedMovies } from "../core/library";
import { refFromFav } from "../core/refs";
import { namedLink, starLink } from "../core/site";
import type { FavMovie, MovieItem, NamedKind, StarItem } from "../core/types";
import { exportBackupFile, importBackupFromFile } from "../kit/backup";
import { describeError } from "../kit/http";
import { requestLaunch } from "../kit/launch";
import { recKindOf, useRecVersion } from "../kit/recommend";
import { store, useLibrary } from "../kit/store";
import { showError, showToast } from "../kit/toast";
import { ActressPage } from "./ActressPage";
import { CategoryMoviesPage } from "./CategoryMoviesPage";
import { ChipBar, GradientPill, MovieGrid, SearchBar, StarGrid } from "./components";
import { MovieDetailPage } from "./MovieDetailPage";
import { rootToolbar } from "./rootToolbar";
import { PageBackdrop, SIDE, Segmented, TINT } from "./theme";

type Seg = "favorite" | "archive";

const SEG_ITEMS: { key: Seg; label: string }[] = [
  { key: "favorite", label: "收藏" },
  { key: "archive", label: "归档" },
];
/** 归档里看全部，还是只看「我的精选」（core/library.ts 的 picks，在详情页点「加精选」标）。 */
type ArcFilter = "all" | "picks";
type Sub = "movie" | "actress" | NamedKind;

const SUBS: { key: Sub; label: string; unit: string }[] = [
  { key: "movie", label: "影片", unit: "部影片" },
  { key: "actress", label: "演员", unit: "位演员" },
  { key: "director", label: "导演", unit: "位导演" },
  { key: "series", label: "系列", unit: "个系列" },
  { key: "filmMaker", label: "制作商", unit: "个制作商" },
  { key: "filmEstab", label: "发行商", unit: "个发行商" },
];

const NAMED_COLUMNS = [
  { size: { type: "flexible" as const }, spacing: 10 },
  { size: { type: "flexible" as const } },
];

/** 收藏记录 → 影片卡片（旧数据没存链接就用 shortCode 拼）。 */
function asItem(fav: FavMovie): MovieItem {
  const ref = refFromFav(fav, "favorites");
  return { code: fav.code, link: ref.link, cover: fav.src, title: "", date: "", hd: false, sub: false };
}

/** 导入、导出的结果统一在这里收口：错误显示出来，别静默吞。 */
async function runBackup(task: () => Promise<string | null | boolean>, okMessage?: string): Promise<void> {
  try {
    const result = await task();
    if (typeof result === "string") showToast(result);
    else if (result === true && okMessage) showToast(okMessage);
  } catch (error) {
    showError(describeError(error));
  }
}

export function LibraryPage() {
  const dismiss = Navigation.useDismiss();
  const lib = useLibrary();
  useRecVersion();
  const [seg, setSeg] = useState<Seg>("favorite");
  const [sub, setSub] = useState<Sub>("movie");
  const [input, setInput] = useState("");
  const [arcFilter, setArcFilter] = useState<ArcFilter>("all");

  const favItems = useMemo(() => lib.favorite.map(asItem), [lib.favorite]);
  const arcItems = useMemo(() => {
    const keyword = input.trim().toUpperCase();
    const base = arcFilter === "picks" ? pickedMovies(lib) : lib.archive;
    const list = keyword ? base.filter((m) => m.code.toUpperCase().includes(keyword)) : base;
    return list.map(asItem);
  }, [lib, input, arcFilter]);
  const pickedSet = useMemo(() => new Set(lib.picks), [lib.picks]);

  const favByLink = useMemo(() => new Map(lib.favorite.map((m) => [asItem(m).link, m])), [lib.favorite]);
  const arcByLink = useMemo(() => new Map(lib.archive.map((m) => [asItem(m).link, m])), [lib.archive]);

  const stars: StarItem[] = useMemo(
    () => lib.actress.map((a) => ({ name: a.info, link: starLink(a.shortCode, a.un), avatar: a.src })),
    [lib.actress],
  );

  const counts: Record<Sub, number> = {
    movie: lib.favorite.length,
    actress: lib.actress.length,
    director: lib.director.length,
    series: lib.series.length,
    filmMaker: lib.filmMaker.length,
    filmEstab: lib.filmEstab.length,
  };
  const subMeta = SUBS.find((s) => s.key === sub) ?? SUBS[0];

  const submit = () => {
    const text = input.trim();
    if (!text || seg === "archive") return; // 归档里的输入是过滤，不是搜索
    requestLaunch({ type: "search", keyword: text });
    setInput("");
  };

  const emptyView = (title: string, description?: string, withImport = false) => (
    <ContentUnavailableView
      label={<Label title={title} systemImage="heart" />}
      description={description ? <Text>{description}</Text> : null}
      actions={
        withImport
          ? [<Button key="import" title="导入备份" systemImage="square.and.arrow.down" action={() => void runBackup(importBackupFromFile)} />]
          : []
      }
    />
  );

  const body = (() => {
    if (seg === "archive") {
      if (arcItems.length === 0) {
        if (input) return emptyView(arcFilter === "picks" ? "没有匹配的精选" : "没有匹配的归档", "换个番号试试");
        if (arcFilter === "picks") return emptyView("还没有精选", "在已归档影片的详情页点「加精选」，或长按归档里的影片");
        return emptyView("没有归档", "在收藏的影片详情页点「归档」即可");
      }
      return (
        <MovieGrid
          items={arcItems}
          lib={lib}
          showStatus={false}
          destinationFor={(item) => {
            const fav = arcByLink.get(item.link);
            return <MovieDetailPage movie={fav ? refFromFav(fav, "archive") : { link: item.link, code: item.code, cover: item.cover, info: item.code, context: "archive" }} />;
          }}
          recFor={(item) => recKindOf(item.code)}
          pickedFor={(item) => {
            const fav = arcByLink.get(item.link);
            return !!fav && pickedSet.has(fav.shortCode);
          }}
          infoFor={(item) => arcByLink.get(item.link)?.info}
          menuFor={(item) => {
            const fav = arcByLink.get(item.link);
            const picked = !!fav && pickedSet.has(fav.shortCode);
            return (
              <>
                <Button
                  title={picked ? "移出我的精选" : "加入我的精选"}
                  systemImage={picked ? "star.slash" : "star"}
                  action={() => {
                    if (!fav) return;
                    store.setPicked(fav.shortCode, fav.code, !picked);
                    showToast(picked ? "已移出我的精选" : "已加入我的精选");
                  }}
                />
                <Button
                  title="删除归档"
                  systemImage="trash"
                  role="destructive"
                  action={() => {
                    if (fav) store.deleteArchived(fav.shortCode, fav.code);
                  }}
                />
              </>
            );
          }}
        />
      );
    }
    switch (sub) {
      case "movie":
        if (favItems.length === 0) {
          return emptyView(
            "收藏夹为空",
            "如果之前在 JSBox 版做过收藏，可以导入原来的 JavBusBackup.json 接续",
            true,
          );
        }
        return (
          <MovieGrid
            items={favItems}
            lib={lib}
            showStatus={false}
            destinationFor={(item) => {
              const fav = favByLink.get(item.link);
              return <MovieDetailPage movie={fav ? refFromFav(fav, "favorites") : { link: item.link, code: item.code, cover: item.cover, info: item.code, context: "favorites" }} />;
            }}
            recFor={(item) => recKindOf(item.code)}
            infoFor={(item) => favByLink.get(item.link)?.info}
            menuFor={(item) => (
              <>
                <Button
                  title="归档"
                  systemImage="archivebox"
                  action={() => {
                    const fav = favByLink.get(item.link);
                    if (fav) store.archive(fav);
                  }}
                />
                <Button
                  title="取消收藏"
                  systemImage="heart.slash"
                  role="destructive"
                  action={() => {
                    const fav = favByLink.get(item.link);
                    if (fav) store.cancelFavorite(fav.shortCode, fav.code);
                  }}
                />
              </>
            )}
          />
        );
      case "actress":
        return stars.length === 0 ? (
          emptyView("还没有收藏的演员", "在演员页点「收藏演员」")
        ) : (
          <StarGrid stars={stars} destinationFor={(star) => <ActressPage star={star} />} />
        );
      default: {
        const list = lib[sub];
        return list.length === 0 ? (
          emptyView(`还没有收藏的${subMeta.label}`, `在${subMeta.label}的影片列表里点「收藏」`)
        ) : (
          <LazyVGrid columns={NAMED_COLUMNS} spacing={10} padding={{ horizontal: SIDE }}>
            {list.map((item) => (
              <NavigationLink
                key={item.shortCode}
                destination={<CategoryMoviesPage title={item.name} link={namedLink(sub, item.shortCode)} kind={sub} />}
                buttonStyle="plain"
              >
                <GradientPill text={item.name} height={56} />
              </NavigationLink>
            ))}
          </LazyVGrid>
        );
      }
    }
  })();

  return (
    <NavigationStack>
      <ZStack>
        <PageBackdrop tint={TINT.library} />
        <ScrollView
          navigationTitle="收藏"
          navigationBarTitleDisplayMode="inline"
          toolbar={rootToolbar(() => dismiss(), [
            <Menu key="backup" title="备份" systemImage="externaldrive">
              <Button title="导入备份" systemImage="square.and.arrow.down" action={() => void runBackup(importBackupFromFile)} />
              <Button title="导出备份" systemImage="square.and.arrow.up" action={() => void runBackup(exportBackupFile, "已导出")} />
            </Menu>,
          ])}
        >
          <VStack spacing={14} padding={{ top: 8, bottom: 24 }}>
            <VStack spacing={10} padding={{ horizontal: SIDE }}>
              <SearchBar
                value={input}
                onChanged={setInput}
                onSubmit={submit}
                prompt={
                  seg === "archive"
                    ? arcFilter === "picks"
                      ? `我的精选 ${lib.picks.length} 部影片，输入番号过滤`
                      : `已归档 ${lib.archive.length} 部影片，输入番号过滤`
                    : `已收藏 ${counts[sub]} ${subMeta.unit}`
                }
              />
              <Segmented
                items={SEG_ITEMS}
                selected={seg}
                onSelect={(next) => {
                  setSeg(next);
                  setInput("");
                }}
              />
            </VStack>
            {seg === "favorite" ? (
              <ChipBar items={SUBS.map((s) => ({ key: s.key, label: `${s.label} ${counts[s.key]}` }))} selected={sub} onSelect={setSub} />
            ) : (
              <ChipBar
                items={[
                  { key: "all" as const, label: `全部 ${lib.archive.length}` },
                  { key: "picks" as const, label: `我的精选 ${lib.picks.length}` },
                ]}
                selected={arcFilter}
                onSelect={setArcFilter}
              />
            )}
            {body}
          </VStack>
        </ScrollView>
      </ZStack>
    </NavigationStack>
  );
}
