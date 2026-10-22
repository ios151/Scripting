// 「分类」页：有码 / 无码两套类目，按小节（主題 / 角色 / 服裝…）分组，点类目进影片列表。
//
// 小节标题按页面实际出现的 <h4> 解析，不像原版写死标题表——站点加了新小节会自动出现。
// 颜色按类目名哈希稳定取，原版每次随机，列表一刷新颜色就跳。

import {
  Button,
  ContentUnavailableView,
  HStack,
  LazyVGrid,
  Navigation,
  NavigationLink,
  NavigationStack,
  ProgressView,
  ScrollView,
  Spacer,
  Text,
  VStack,
  ZStack,
  useEffect,
  useState,
} from "scripting";

import { parseGenreSections } from "../core/parse";
import { genreIndexUrl } from "../core/site";
import type { GenreSection } from "../core/types";
import { describeError, getPage } from "../kit/http";
import { CategoryMoviesPage } from "./CategoryMoviesPage";
import { ChipBar, GradientPill } from "./components";
import { rootToolbar } from "./rootToolbar";
import { DANGER, PageBackdrop, PillLabel, SIDE, Segmented, TINT } from "./theme";

type Kind = "censored" | "uncensored";

const KIND_ITEMS: { key: Kind; label: string }[] = [
  { key: "censored", label: "有码" },
  { key: "uncensored", label: "无码" },
];

const COLUMNS = [
  { size: { type: "flexible" as const }, spacing: 10 },
  { size: { type: "flexible" as const }, spacing: 10 },
  { size: { type: "flexible" as const } },
];

export function GenresPage() {
  const dismiss = Navigation.useDismiss();
  const [kind, setKind] = useState<Kind>("censored");
  const [sections, setSections] = useState<GenreSection[]>([]);
  const [selected, setSelected] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError("");
    setSelected(0);
    void (async () => {
      try {
        const res = await getPage(genreIndexUrl(kind));
        const parsed = parseGenreSections(res.html, res.url);
        if (!alive) return;
        if (parsed.length === 0) throw new Error("没有解析到分类，站点页面可能改版了");
        setSections(parsed);
      } catch (e) {
        if (alive) {
          setSections([]);
          setError(describeError(e));
        }
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [kind, reloadToken]);

  const section = sections[Math.min(selected, Math.max(0, sections.length - 1))];

  return (
    <NavigationStack>
      <ZStack>
        <PageBackdrop tint={TINT.genres} />
        <ScrollView
          navigationTitle="分类"
          navigationBarTitleDisplayMode="inline"
          toolbar={rootToolbar(() => dismiss())}
          refreshable={async () => {
            setReloadToken((n) => n + 1);
          }}
        >
          <VStack spacing={14} padding={{ top: 8, bottom: 24 }}>
            <VStack padding={{ horizontal: SIDE }}>
              <Segmented items={KIND_ITEMS} selected={kind} onSelect={setKind} />
            </VStack>

            {sections.length > 0 ? (
              <ChipBar
                items={sections.map((s) => ({ key: s.title, label: s.title }))}
                selected={section?.title ?? ""}
                onSelect={(title) => setSelected(Math.max(0, sections.findIndex((s) => s.title === title)))}
              />
            ) : null}

            {loading ? (
              <HStack padding={30}>
                <Spacer />
                <ProgressView progressViewStyle="circular" tint="white" />
                <Spacer />
              </HStack>
            ) : error ? (
              <VStack spacing={10} padding={20}>
                <Text foregroundStyle={DANGER} multilineTextAlignment="center">
                  {error}
                </Text>
                <Button buttonStyle="plain" action={() => setReloadToken((n) => n + 1)}>
                  <PillLabel icon="arrow.clockwise" text="重试" />
                </Button>
              </VStack>
            ) : section ? (
              <LazyVGrid columns={COLUMNS} spacing={10} padding={{ horizontal: SIDE }}>
                {section.items.map((item) => (
                  <NavigationLink
                    key={item.link}
                    destination={<CategoryMoviesPage title={item.name} link={item.link} kind="genre" />}
                    buttonStyle="plain"
                  >
                    <GradientPill text={item.name} />
                  </NavigationLink>
                ))}
              </LazyVGrid>
            ) : (
              <ContentUnavailableView title="暂无分类" systemImage="square.grid.2x2" />
            )}
          </VStack>
        </ScrollView>
      </ZStack>
    </NavigationStack>
  );
}
