// 各页面共用的小部件：搜索栏、徽章、影片卡片网格、演员卡片、列表尾部状态。
// 外观沿用详情页的语言（见 theme.tsx）：深色底，半透明白的胶囊，白字，封面卡片压一层底部渐变。

import {
  Button,
  HStack,
  Image,
  LazyVGrid,
  NavigationLink,
  ProgressView,
  Rectangle,
  ScrollView,
  Spacer,
  Text,
  TextField,
  VStack,
  ZStack,
  useMemo,
  type Color,
  type VirtualNode,
} from "scripting";

import { GRADIENTS } from "../core/constants";
import { hashIndex } from "../core/format";
import { shortCodeOf } from "../core/keyword";
import type { LibraryData, MovieItem, StarItem } from "../core/types";
import { RemoteImage } from "./RemoteImage";
import { DANGER, GLASS, INK, PillLabel, SIDE } from "./theme";

// ———— 搜索栏 ————

/**
 * 原版每个主页面顶部那个输入框：输入番号或演员，回车搜索。
 * `searchable` 没有提交回调，所以用 TextField + onSubmit。
 */
export function SearchBar({
  value,
  onChanged,
  onSubmit,
  prompt = "输入番号或演员进行搜索",
}: {
  value: string;
  onChanged: (v: string) => void;
  onSubmit: () => void;
  prompt?: string;
}) {
  return (
    <HStack spacing={8} padding={{ horizontal: 14, vertical: 10 }} background={{ style: GLASS, shape: "capsule" }}>
      <Image systemName="magnifyingglass" font={14} foregroundStyle={INK.soft} />
      <TextField
        title=""
        value={value}
        onChanged={onChanged}
        prompt={prompt}
        submitLabel="search"
        onSubmit={onSubmit}
        autocorrectionDisabled
        textInputAutocapitalization="never"
        foregroundStyle={INK.strong}
        tint="white"
        frame={{ maxWidth: "infinity" }}
      />
      {value ? (
        <Button buttonStyle="plain" action={() => onChanged("")}>
          <Image systemName="xmark.circle.fill" font={15} foregroundStyle={INK.faint} />
        </Button>
      ) : null}
    </HStack>
  );
}

// ———— 徽章与胶囊 ————

/**
 * 横向滚动的胶囊选择条：选项多、一行放不下时代替分段选择（分类小节 8 个、收藏子类 6 个）。
 * 选中的是白底黑字，其余是半透明白，和 Segmented 同一个语气。
 */
export function ChipBar<K extends string>({
  items,
  selected,
  onSelect,
}: {
  items: { key: K; label: string }[];
  selected: K;
  onSelect: (key: K) => void;
}) {
  return (
    <ScrollView axes="horizontal" scrollIndicator="hidden">
      <HStack spacing={8} padding={{ horizontal: SIDE }}>
        {items.map((item) => {
          const on = item.key === selected;
          return (
            <Button key={item.key} buttonStyle="plain" action={() => onSelect(item.key)}>
              <Text
                font="subheadline"
                fontWeight={on ? "semibold" : "regular"}
                foregroundStyle={on ? "black" : INK.strong}
                padding={{ horizontal: 14, vertical: 7 }}
                background={{ style: on ? "white" : GLASS, shape: "capsule" }}
              >
                {item.label}
              </Text>
            </Button>
          );
        })}
      </HStack>
    </ScrollView>
  );
}

export function Badge({ text, color }: { text: string; color: Color }) {
  return (
    <Text
      font={10}
      fontWeight="bold"
      foregroundStyle="white"
      padding={{ horizontal: 6, vertical: 2 }}
      background={{ style: color, shape: "capsule" }}
      opacity={0.92}
    >
      {text}
    </Text>
  );
}

/** 渐变色胶囊：分类、导演 / 系列 / 制作商 / 发行商都用它。颜色按文字哈希稳定取，不像原版每次随机。 */
export function GradientPill({ text, height = 40 }: { text: string; height?: number }) {
  const [from, to] = GRADIENTS[hashIndex(text, 12)];
  return (
    <ZStack
      frame={{ maxWidth: "infinity", height }}
      background={{
        style: { colors: [from, to], startPoint: "topLeading", endPoint: "bottomTrailing" },
        shape: { type: "rect", cornerRadius: 12 },
      }}
    >
      <Text font="subheadline" fontWeight="medium" foregroundStyle="white" lineLimit={2} padding={{ horizontal: 6 }}>
        {text}
      </Text>
    </ZStack>
  );
}

// ———— 影片卡片 ————

/** 列表封面解码后的最长边（像素）。详情页的海报首帧用同一个值才能命中缓存、不转圈。 */
export const COVER_THUMB_SIDE = 360;
const CELL_HEIGHT = 178;
const CELL_RADIUS = 10;
const COLUMNS = [
  { size: { type: "flexible" as const }, spacing: 8 },
  { size: { type: "flexible" as const }, spacing: 8 },
  { size: { type: "flexible" as const } },
];

export type CardStatus = "none" | "favorite" | "archived";

/** 收藏 / 归档里所有 shortCode 的集合：网格里几十上千张卡片逐张查，不能每张都线性扫一遍库。 */
export interface LibraryIndex {
  favorite: Set<string>;
  archive: Set<string>;
}

export function indexLibrary(lib: LibraryData): LibraryIndex {
  return {
    favorite: new Set(lib.favorite.map((m) => m.shortCode)),
    archive: new Set(lib.archive.map((m) => m.shortCode)),
  };
}

/** 在库里的状态：编号既可能是列表上的识别码，也可能是链接最后一段，两个都查（原版只查识别码）。 */
export function statusIn(index: LibraryIndex, item: Pick<MovieItem, "code" | "link">): CardStatus {
  const tail = shortCodeOf(item.link);
  if (index.favorite.has(item.code) || index.favorite.has(tail)) return "favorite";
  if (index.archive.has(item.code) || index.archive.has(tail)) return "archived";
  return "none";
}

export function cardStatus(lib: LibraryData, item: Pick<MovieItem, "code" | "link">): CardStatus {
  return statusIn(indexLibrary(lib), item);
}

/**
 * 影片卡片：封面 + 底部渐变，渐变上是番号（粗）和日期（淡）。
 * 已收藏在右下角点一颗红心，已归档把封面压暗虚化再点一个归档盒（原版是整张染渐变色 / 盖白膜，深色底上不好看）。
 */
export function MovieCell({
  item,
  status,
  rec,
  infoText,
  menu,
  onAppear,
}: {
  item: MovieItem;
  status: CardStatus;
  /** 推荐角标：作者橙、网友紫。 */
  rec?: "author" | "user" | null;
  /** 底部那行字，默认「番号 | 日期」；按「 | 」拆成两行。 */
  infoText?: string;
  /** 长按菜单（收藏页里用来取消收藏 / 归档 / 删除）。 */
  menu?: VirtualNode;
  onAppear?: () => void;
}) {
  const archived = status === "archived";
  const [first, ...rest] = (infoText ?? `${item.code} | ${item.date}`).split(" | ");
  const second = rest.join(" | ");
  return (
    <ZStack
      frame={{ maxWidth: "infinity", height: CELL_HEIGHT }}
      clipShape={{ type: "rect", cornerRadius: CELL_RADIUS }}
      onAppear={onAppear}
      contextMenu={menu ? { menuItems: menu } : undefined}
    >
      <RemoteImage url={item.cover} maxSide={COVER_THUMB_SIDE} height={CELL_HEIGHT} radius={CELL_RADIUS} blurred={archived} />
      {archived ? <Rectangle fill="rgba(0,0,0,0.5)" frame={{ maxWidth: "infinity", maxHeight: "infinity" }} /> : null}
      <Rectangle
        fill={{ colors: ["rgba(0,0,0,0)", "rgba(0,0,0,0.78)"], startPoint: "center", endPoint: "bottom" }}
        frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
      />
      <VStack spacing={0} frame={{ maxWidth: "infinity", maxHeight: "infinity" }}>
        <HStack alignment="top" padding={{ top: 5, horizontal: 5 }}>
          {item.hd ? <Badge text="高清" color="#7294b1" /> : null}
          <Spacer />
          <VStack spacing={3} alignment="trailing">
            {item.sub ? <Badge text="字幕" color="#f2b867" /> : null}
            {rec ? <Badge text="推荐" color={rec === "author" ? "#f68b1f" : "#b20083"} /> : null}
          </VStack>
        </HStack>
        <Spacer />
        <HStack alignment="bottom" spacing={4} padding={{ horizontal: 7, bottom: 6 }}>
          <VStack alignment="leading" spacing={1}>
            <Text font={11} fontWeight="semibold" foregroundStyle="white" lineLimit={1} minScaleFactor={0.7}>
              {first}
            </Text>
            {second ? (
              <Text font={10} foregroundStyle={INK.soft} lineLimit={1}>
                {second}
              </Text>
            ) : null}
          </VStack>
          <Spacer />
          {status === "favorite" ? <Image systemName="heart.fill" font={13} foregroundStyle="#ff6b81" /> : null}
          {archived ? <Image systemName="archivebox.fill" font={12} foregroundStyle={INK.soft} /> : null}
        </HStack>
      </VStack>
    </ZStack>
  );
}

/** 3 列影片网格。每张卡片用 destinationFor 给出点开后的页面；快滚到底时调 onNearEnd 取下一页。 */
export function MovieGrid({
  items,
  lib,
  destinationFor,
  recFor,
  infoFor,
  menuFor,
  showStatus = true,
  onNearEnd,
}: {
  items: MovieItem[];
  lib: LibraryData;
  destinationFor: (item: MovieItem) => VirtualNode;
  recFor?: (item: MovieItem) => "author" | "user" | null;
  infoFor?: (item: MovieItem) => string | undefined;
  menuFor?: (item: MovieItem) => VirtualNode;
  /** 按收藏 / 归档状态给封面标记或虚化。收藏页、归档页本身就是库，不能再标（原版那两个列表不染）。 */
  showStatus?: boolean;
  onNearEnd?: () => void;
}) {
  const index = useMemo(() => indexLibrary(lib), [lib]);
  return (
    <LazyVGrid columns={COLUMNS} spacing={8} padding={{ horizontal: SIDE }}>
      {items.map((item, position) => (
        // 推荐列表里偶有不同番号共用一个链接的脏数据，key 带上番号才不会撞
        <NavigationLink key={`${item.link}#${item.code}`} destination={destinationFor(item)} buttonStyle="plain">
          <MovieCell
            item={item}
            status={showStatus ? statusIn(index, item) : "none"}
            rec={recFor?.(item) ?? null}
            infoText={infoFor?.(item)}
            menu={menuFor?.(item)}
            onAppear={onNearEnd && position >= items.length - 6 ? onNearEnd : undefined}
          />
        </NavigationLink>
      ))}
    </LazyVGrid>
  );
}

// ———— 演员卡片 ————

export function StarCell({ star, height = 140 }: { star: StarItem; height?: number }) {
  return (
    <ZStack frame={{ maxWidth: "infinity", height }} clipShape={{ type: "rect", cornerRadius: CELL_RADIUS }}>
      <RemoteImage url={star.avatar} maxSide={300} height={height} radius={CELL_RADIUS} />
      <Rectangle
        fill={{ colors: ["rgba(0,0,0,0)", "rgba(0,0,0,0.75)"], startPoint: "center", endPoint: "bottom" }}
        frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
      />
      <VStack spacing={0} frame={{ maxWidth: "infinity", maxHeight: "infinity" }}>
        <Spacer />
        <Text
          font={12}
          fontWeight="semibold"
          foregroundStyle="white"
          lineLimit={1}
          minScaleFactor={0.6}
          padding={{ horizontal: 7, bottom: 6 }}
          frame={{ maxWidth: "infinity", alignment: "leading" }}
        >
          {star.name}
        </Text>
      </VStack>
    </ZStack>
  );
}

export function StarGrid({
  stars,
  destinationFor,
  onNearEnd,
}: {
  stars: StarItem[];
  destinationFor: (star: StarItem) => VirtualNode;
  onNearEnd?: () => void;
}) {
  return (
    <LazyVGrid columns={COLUMNS} spacing={8} padding={{ horizontal: SIDE }}>
      {stars.map((star, index) => (
        <NavigationLink key={star.link} destination={destinationFor(star)} buttonStyle="plain">
          <ZStack onAppear={onNearEnd && index >= stars.length - 6 ? onNearEnd : undefined}>
            <StarCell star={star} />
          </ZStack>
        </NavigationLink>
      ))}
    </LazyVGrid>
  );
}

// ———— 列表尾部状态 ————

/** 列表底部：加载中转圈、出错给重试、到底了提示；空列表由页面自己给空状态。 */
export function LoadFooter({
  loading,
  error,
  done,
  count,
  onRetry,
}: {
  loading: boolean;
  error: string;
  done: boolean;
  count: number;
  onRetry: () => void;
}) {
  if (loading) {
    return (
      <HStack padding={16}>
        <Spacer />
        <ProgressView progressViewStyle="circular" tint="white" />
        <Spacer />
      </HStack>
    );
  }
  if (error) {
    return (
      <VStack spacing={10} padding={16} frame={{ maxWidth: "infinity" }}>
        <Text font="footnote" foregroundStyle={DANGER} multilineTextAlignment="center">
          {error}
        </Text>
        <Button buttonStyle="plain" action={onRetry}>
          <PillLabel icon="arrow.clockwise" text="重试" />
        </Button>
      </VStack>
    );
  }
  if (done && count > 0) {
    return (
      <Text font="footnote" foregroundStyle={INK.faint} frame={{ maxWidth: "infinity" }} padding={16}>
        🙈 到底了
      </Text>
    );
  }
  return <Spacer />;
}
